import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { normalizeDagYaml, normalizeNestedWorkflows } from "../dag-yaml.js";
import { validateOutput } from "../validation.js";
import { runDag } from "../flows/dag.js";
import { validateDagTasks } from "../flows/dag-validation.js";
import type { ExecutionOptions, RunnerInput, SubagentRunner, SubagentTask, UsageStats } from "../types.js";
import { loadEvalSet } from "./eval-set.js";
import { computeGraphMetrics } from "./graph-metrics.js";
import { computeUtility, summarizeRuns } from "./objective.js";
import type { CandidateEvaluation, EvalSetInput, EvalCase, OptimizerReport, WorkflowCandidate } from "./types.js";

export interface EvaluateOptimizerRunInput {
	cwd: string;
	workflowPath?: string;
	dagYaml?: string;
	evalSet: EvalSetInput;
	candidateDagYamls?: string[];
	runner: SubagentRunner;
	validateCandidateTasks?: (tasks: SubagentTask[]) => void;
	maxCandidateRuns?: number;
	maxCost?: number;
	maxRunCost?: number;
	maxCandidateCost?: number;
	maxTotalCost?: number;
	maxConcurrency?: number;
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

interface BudgetState {
	totalCost: number;
}

export async function evaluateOptimizerRun(input: EvaluateOptimizerRunInput): Promise<OptimizerReport> {
	validateOptimizerInput(input);
	const loadedEval = await loadEvalSet({ cwd: input.cwd, evalSet: input.evalSet });
	const scorerTasks = collectScorerTasks(loadedEval.evalSet.cases);
	if (scorerTasks.length > 0) input.validateCandidateTasks?.(scorerTasks);
	const baselineTasks = await loadWorkflowTasks(input);
	assertValidDag(baselineTasks);
	const budget: BudgetState = { totalCost: 0 };
	const baseline = await evaluateCandidate({ id: "baseline", label: "Baseline", tasks: baselineTasks }, input, loadedEval.evalSet.objective, loadedEval.evalSet.cases, loadedEval.evalSet.scoring.minRunsPerCase, budget);
	const candidates: CandidateEvaluation[] = [];
	for (const [index, dagYaml] of (input.candidateDagYamls ?? []).entries()) {
		try {
			const tasks = normalizeOptimizerDagYaml(dagYaml);
			assertValidDag(tasks);
			input.validateCandidateTasks?.(tasks);
			candidates.push(await evaluateCandidate(
				{ id: `candidate-${index + 1}`, label: `Candidate ${index + 1}`, tasks, dagYaml },
				input,
				loadedEval.evalSet.objective,
				loadedEval.evalSet.cases,
				Math.min(loadedEval.evalSet.scoring.minRunsPerCase, input.maxCandidateRuns ?? loadedEval.evalSet.scoring.minRunsPerCase),
				budget,
			));
		} catch (error) {
			candidates.push({ id: `candidate-${index + 1}`, label: `Candidate ${index + 1}`, status: "invalid", dagYaml, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return {
		reportId: `opt-${randomUUID()}`,
		createdAt: new Date().toISOString(),
		evalSetName: loadedEval.evalSet.name,
		source: loadedEval.source,
		persistenceRecommendation: loadedEval.persistenceRecommendation,
		baseline,
		candidates,
		recommendation: recommend(baseline, candidates, loadedEval.evalSet.scoring, loadedEval.evalSet.cases),
		warnings: warnings(loadedEval.evalSet.scoring.minRunsPerCase, loadedEval.evalSet.cases, loadedEval.persistenceRecommendation),
	};
}

export async function loadWorkflowTasks(input: Pick<EvaluateOptimizerRunInput, "cwd" | "workflowPath" | "dagYaml">): Promise<SubagentTask[]> {
	if (Boolean(input.workflowPath) === Boolean(input.dagYaml)) throw new Error("subflow_optimize requires exactly one of workflowPath or dagYaml");
	if (input.dagYaml) return normalizeOptimizerDagYaml(input.dagYaml);
	const workflowPath = await resolveWorkflowPath(input.cwd, input.workflowPath ?? "");
	const source = await readFile(workflowPath, "utf8");
	return normalizeOptimizerDagYaml(source);
}

function normalizeOptimizerDagYaml(dagYaml: string): SubagentTask[] {
	return normalizeNestedWorkflows(normalizeDagYaml({ dagYaml })).tasks ?? [];
}

async function resolveWorkflowPath(cwd: string, path: string): Promise<string> {
	if (typeof path !== "string" || path.trim() === "") throw new Error("workflowPath must be a non-empty string");
	if (isAbsolute(path)) throw new Error("workflowPath must be relative to the project");
	const resolved = resolve(cwd, path);
	if (!isSubpath(cwd, resolved)) throw new Error("workflowPath must stay inside the project");
	const realCwd = await realpath(cwd);
	const realWorkflowPath = await realpath(resolved);
	if (!isSubpath(realCwd, realWorkflowPath)) throw new Error("workflowPath must stay inside the project");
	return realWorkflowPath;
}

async function evaluateCandidate(
	candidate: WorkflowCandidate,
	input: EvaluateOptimizerRunInput,
	objective: Parameters<typeof computeUtility>[2],
	cases: EvalCase[],
	runsPerCase: number,
	budget: BudgetState,
): Promise<CandidateEvaluation> {
	assertValidDag(candidate.tasks);
	const graph = computeGraphMetrics(candidate.tasks);
	const runs = [];
	let abortedByCost = false;
	let error: string | undefined;
	const candidateStartCost = budget.totalCost;
	for (const evalCase of cases) {
		for (let index = 0; index < runsPerCase; index += 1) {
			if (input.maxTotalCost !== undefined && budget.totalCost >= input.maxTotalCost) {
				abortedByCost = true;
				error = "maxTotalCost exceeded";
				break;
			}
			if (input.maxCandidateCost !== undefined && budget.totalCost - candidateStartCost >= input.maxCandidateCost) {
				abortedByCost = true;
				error = "maxCandidateCost exceeded";
				break;
			}
			const started = Date.now();
			let result = await runDag({ tasks: applyEvalCaseInput(candidate.tasks, evalCase) }, executionOptions(input, budget, candidateStartCost));
			let structuralPassed = result.status === "completed";
			let taskScore = structuralPassed && !evalCase.scorer ? 1 : 0;
			let qualityAssessed = false;
			let scorerOutput: unknown;
			if (result.status === "completed" && (evalCase.expectedSections ?? evalCase.jsonSchema)) {
				try {
					validateOutput(result.output, { expectedSections: evalCase.expectedSections, jsonSchema: evalCase.jsonSchema });
				} catch {
					structuralPassed = false;
					result = { ...result, status: "failed" };
					taskScore = 0;
				}
			}
			if (structuralPassed && evalCase.scorer) {
				const scorer = await scoreOutput(input.runner, evalCase, result.output, input.signal);
				scorerOutput = scorer.output;
				result = { ...result, usage: addUsage(result.usage, scorer.usage) };
				if (scorer.ok) {
					taskScore = scorer.score;
					qualityAssessed = true;
				} else {
					result = { ...result, status: "failed" };
					structuralPassed = false;
					taskScore = 0;
				}
			}
			const run = { caseName: evalCase.name, split: evalCase.split, result, wallTimeMs: Date.now() - started, taskScore, structuralPassed, qualityAssessed, scorerOutput };
			runs.push(run);
			const runCost = run.result.usage?.cost ?? 0;
			budget.totalCost += runCost;
			const candidateCost = budget.totalCost - candidateStartCost;
			if (input.maxRunCost !== undefined && runCost > input.maxRunCost) {
				abortedByCost = true;
				error = "maxRunCost exceeded";
				break;
			}
			if (input.maxCost !== undefined && candidateCost > input.maxCost) {
				abortedByCost = true;
				error = "maxCost exceeded";
				break;
			}
			if (input.maxCandidateCost !== undefined && candidateCost > input.maxCandidateCost) {
				abortedByCost = true;
				error = "maxCandidateCost exceeded";
				break;
			}
			if (input.maxTotalCost !== undefined && budget.totalCost > input.maxTotalCost) {
				abortedByCost = true;
				error = "maxTotalCost exceeded";
				break;
			}
		}
		if (abortedByCost) break;
	}
	const metrics = summarizeRuns(runs);
	const trainRuns = runs.filter((run) => run.split === "train");
	const holdoutRuns = runs.filter((run) => run.split === "holdout");
	const trainMetrics = summarizeRuns(trainRuns);
	const holdoutMetrics = holdoutRuns.length > 0 ? summarizeRuns(holdoutRuns) : undefined;
	const utility = computeUtility(metrics, graph, objective);
	const trainUtility = computeUtility(trainMetrics, graph, objective);
	const holdoutUtility = holdoutMetrics ? computeUtility(holdoutMetrics, graph, objective) : undefined;
	const failed = metrics.failures > 0 || abortedByCost;
	return { ...candidate, status: failed ? "failed" : "completed", error, metrics, trainMetrics, holdoutMetrics, utility, trainUtility, holdoutUtility, graph };
}

async function scoreOutput(runner: SubagentRunner, evalCase: EvalCase, output: string, signal?: AbortSignal): Promise<{ ok: boolean; score: number; output: unknown; usage?: UsageStats }> {
	const scorer = evalCase.scorer;
	if (!scorer) return { ok: false, score: 0, output: "missing scorer" };
	const rubric = scorer.rubric.map((criterion) => `- ${criterion.name} (weight ${criterion.weight}): ${criterion.description}`).join("\n");
	const task = `Score the workflow output for eval case ${JSON.stringify(evalCase.name)}.\n\nEval input:\n${evalCase.input}\n\nRubric:\n${rubric}\n\nWorkflow output:\n${output}\n\nReturn only JSON with numeric score in [0,1], rationale, and optional criterionScores. Example: {"score":0.75,"rationale":"...","criterionScores":{"correctness":0.75}}`;
	const result = await runner.run({ name: `score-${evalCase.name}-${randomUUID()}`, agent: scorer.agent, task, model: scorer.model, thinking: scorer.thinking, tools: scorer.tools } as RunnerInput, signal);
	try {
		const parsed = JSON.parse(result.output) as { score?: unknown };
		if (typeof parsed.score !== "number" || !Number.isFinite(parsed.score) || parsed.score < 0 || parsed.score > 1) {
			return { ok: false, score: 0, output: parsed, usage: result.usage };
		}
		return { ok: result.status === "completed", score: parsed.score, output: parsed, usage: result.usage };
	} catch {
		return { ok: false, score: 0, output: result.output, usage: result.usage };
	}
}

function assertValidDag(tasks: SubagentTask[]): void {
	const validation = validateDagTasks(tasks);
	if (validation.issues.length > 0) throw new Error(validation.issues.map((issue) => issue.message).join("; "));
}

function collectScorerTasks(cases: EvalCase[]): SubagentTask[] {
	return cases
		.filter((evalCase) => evalCase.scorer)
		.map((evalCase) => ({
			name: `score-${evalCase.name}`,
			agent: evalCase.scorer!.agent,
			task: "Quality scorer for optimizer eval case",
			model: evalCase.scorer!.model,
			thinking: evalCase.scorer!.thinking,
			tools: evalCase.scorer!.tools,
		}));
}

function applyEvalCaseInput(tasks: SubagentTask[], evalCase: EvalCase): SubagentTask[] {
	const targets = evalCase.entryTasks ?? defaultEntryTasks(tasks);
	const known = new Set(collectTaskNames(tasks));
	for (const target of targets) {
		if (!known.has(target)) throw new Error(`eval case ${evalCase.name} entryTasks references unknown task ${target}`);
	}
	return injectTargets(tasks, evalCase.input, new Set(targets), "", false) as SubagentTask[];
}

function defaultEntryTasks(tasks: SubagentTask[]): string[] {
	return collectRootRunnableNames(tasks);
}

function collectRootRunnableNames(tasks: SubagentTask[] | Record<string, SubagentTask>, prefix = ""): string[] {
	const entries = Array.isArray(tasks) ? tasks.map((task, index) => [task.name ?? `${task.agent}-${index + 1}`, task] as const) : Object.entries(tasks).map(([name, task]) => [task.name ?? name, task] as const);
	const localRoots = entries.filter(([, task]) => (task.dependsOn ?? []).length === 0);
	return localRoots.flatMap(([name, task]) => {
		const qualified = prefix ? `${prefix}.${name}` : name;
		if (task.workflow?.tasks) return collectRootRunnableNames(task.workflow.tasks, qualified);
		if (task.loop?.body) return collectRootRunnableNames(task.loop.body, qualified);
		return [qualified];
	});
}

function collectTaskNames(tasks: SubagentTask[] | Record<string, SubagentTask>, prefix = ""): string[] {
	const entries = Array.isArray(tasks) ? tasks.map((task, index) => [task.name ?? `${task.agent}-${index + 1}`, task] as const) : Object.entries(tasks).map(([name, task]) => [task.name ?? name, task] as const);
	return entries.flatMap(([name, task]) => {
		const qualified = prefix ? `${prefix}.${name}` : name;
		const children = task.workflow?.tasks ? collectTaskNames(task.workflow.tasks, qualified) : task.loop?.body ? collectTaskNames(task.loop.body, qualified) : [];
		return [qualified, ...children];
	});
}

function injectTargets(tasks: SubagentTask[] | Record<string, SubagentTask>, caseInput: string, targets: Set<string>, prefix: string, parentTargeted: boolean): SubagentTask[] | Record<string, SubagentTask> {
	if (Array.isArray(tasks)) return tasks.map((task, index) => injectTargetTask(task, task.name ?? `${task.agent}-${index + 1}`, caseInput, targets, prefix, parentTargeted));
	return Object.fromEntries(Object.entries(tasks).map(([name, task]) => [name, injectTargetTask(task, task.name ?? name, caseInput, targets, prefix, parentTargeted)]));
}

function injectTargetTask(task: SubagentTask, name: string, caseInput: string, targets: Set<string>, prefix: string, parentTargeted: boolean): SubagentTask {
	const qualified = prefix ? `${prefix}.${name}` : name;
	const explicitlyTargeted = targets.has(qualified);
	const withInput: SubagentTask = { ...task };
	if (task.workflow?.tasks) {
		const childTargets = explicitlyTargeted || parentTargeted ? new Set([...targets, ...collectRootRunnableNames(task.workflow.tasks, qualified)]) : targets;
		withInput.workflow = { ...task.workflow, tasks: injectTargets(task.workflow.tasks, caseInput, childTargets, qualified, false) };
		return withInput;
	}
	if (task.loop?.body) {
		const childTargets = explicitlyTargeted || parentTargeted ? new Set([...targets, ...collectRootRunnableNames(task.loop.body, qualified)]) : targets;
		withInput.loop = { ...task.loop, body: injectTargets(task.loop.body, caseInput, childTargets, qualified, false) };
		return withInput;
	}
	if (typeof task.task === "string" && (explicitlyTargeted || parentTargeted)) {
		withInput.task = `Eval case input:\n${caseInput}\n\n${task.task}`;
	}
	return withInput;
}

function executionOptions(input: EvaluateOptimizerRunInput, budget: BudgetState, candidateStartCost: number): ExecutionOptions {
	const caps = [input.maxRunCost, input.maxCandidateCost === undefined ? undefined : input.maxCandidateCost - (budget.totalCost - candidateStartCost), input.maxTotalCost === undefined ? undefined : input.maxTotalCost - budget.totalCost].filter((value): value is number => typeof value === "number");
	const maxCost = caps.length > 0 ? Math.max(0, Math.min(...caps)) : input.maxCost;
	return { runner: input.runner, maxConcurrency: input.maxConcurrency, timeoutSeconds: input.timeoutSeconds, maxCost, signal: input.signal };
}

function recommend(baseline: CandidateEvaluation, candidates: CandidateEvaluation[], scoring: { minRunsPerCase: number; minUtilityDelta: number; maxFailureRateRegression: number }, cases: EvalCase[]): string {
	if (cases.some((evalCase) => !evalCase.scorer)) return "Eval set has structural-only cases; baseline/candidates are profile-only and no candidate can be recommended without quality scorers for every case.";
	if (scoring.minRunsPerCase < 2) return "Single-run comparisons are too noisy for recommendations; profile only until repeated runs are configured.";
	if (candidates.some((candidate) => candidate.metrics !== undefined && candidate.metrics.runs < cases.length * 2)) return "Candidate comparisons used fewer than two runs per case; profile only until repeated candidate runs are configured.";
	const valid = candidates.filter((candidate) => candidate.status !== "invalid" && candidate.trainUtility !== undefined && baseline.trainUtility !== undefined && candidate.trainMetrics !== undefined && baseline.trainMetrics !== undefined);
	if (valid.length === 0) return candidates.length === 0 ? "No candidates supplied; baseline profile only." : "No valid candidates to recommend.";
	const allowed = valid.filter((candidate) => (candidate.trainMetrics?.failureRate ?? 0) - (baseline.trainMetrics?.failureRate ?? 0) <= scoring.maxFailureRateRegression);
	if (allowed.length === 0) return "No candidate cleared the train failure-rate regression policy; keep the baseline.";
	const best = [...allowed].sort((a, b) => (b.trainUtility ?? -Infinity) - (a.trainUtility ?? -Infinity))[0];
	const trainDelta = (best.trainUtility ?? 0) - (baseline.trainUtility ?? 0);
	if (trainDelta < scoring.minUtilityDelta) return "No candidate cleared the minimum train utility delta; keep the baseline.";
	if (baseline.holdoutMetrics && best.holdoutMetrics && baseline.holdoutUtility !== undefined && best.holdoutUtility !== undefined) {
		const holdoutFailureDelta = best.holdoutMetrics.failureRate - baseline.holdoutMetrics.failureRate;
		const holdoutUtilityDelta = best.holdoutUtility - baseline.holdoutUtility;
		if (holdoutFailureDelta > scoring.maxFailureRateRegression || holdoutUtilityDelta < scoring.minUtilityDelta) return "Best train candidate did not clear holdout utility/failure gates; keep the baseline.";
	}
	return `${best.label} improves train utility by ${trainDelta.toFixed(4)}; dry-run recommendation only.`;
}

function validateOptimizerInput(input: EvaluateOptimizerRunInput): void {
	for (const [name, value] of Object.entries({ maxCandidateRuns: input.maxCandidateRuns, maxRunCost: input.maxRunCost, maxCandidateCost: input.maxCandidateCost, maxTotalCost: input.maxTotalCost, maxCost: input.maxCost })) {
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
	}
	if (input.maxCandidateRuns !== undefined && !Number.isInteger(input.maxCandidateRuns)) throw new Error("maxCandidateRuns must be a positive integer");
}

function isSubpath(parent: string, child: string): boolean {
	const relation = relative(parent, child);
	if (relation === "" || relation === ".") return true;
	return !isAbsolute(relation) && !relation.startsWith("..");
}

function warnings(minRunsPerCase: number, cases: EvalCase[], persistenceRecommendation?: string): string[] {
	const warnings: string[] = [];
	if (minRunsPerCase === 1) warnings.push("Single-run comparisons are noisy; recommendations are disabled until repeated runs are configured.");
	if (cases.some((evalCase) => !evalCase.scorer)) warnings.push("At least one eval case has no quality scorer; this eval set is profile-only and cannot recommend candidates.");
	if (!cases.some((evalCase) => evalCase.split === "holdout")) warnings.push("No holdout cases configured; recommendations are train-only when other gates allow them.");
	if (persistenceRecommendation) warnings.push(persistenceRecommendation);
	return warnings;
}

function addUsage(a: UsageStats | undefined, b: UsageStats | undefined): UsageStats | undefined {
	if (!a && !b) return undefined;
	return {
		input: (a?.input ?? 0) + (b?.input ?? 0),
		output: (a?.output ?? 0) + (b?.output ?? 0),
		cacheRead: (a?.cacheRead ?? 0) + (b?.cacheRead ?? 0),
		cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0),
		cost: (a?.cost ?? 0) + (b?.cost ?? 0),
		turns: (a?.turns ?? 0) + (b?.turns ?? 0),
	};
}
