import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { normalizeDagYaml, normalizeNestedWorkflows } from "../dag-yaml.js";
import { validateOutput } from "../validation.js";
import { runDag } from "../flows/dag.js";
import { validateDagTasks } from "../flows/dag-validation.js";
import type { ExecutionOptions, SubagentRunner, SubagentTask } from "../types.js";
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
	maxCandidateRuns?: number;
	maxCost?: number;
	maxConcurrency?: number;
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

export async function evaluateOptimizerRun(input: EvaluateOptimizerRunInput): Promise<OptimizerReport> {
	const loadedEval = await loadEvalSet({ cwd: input.cwd, evalSet: input.evalSet });
	const baselineTasks = await loadWorkflowTasks(input);
	assertValidDag(baselineTasks);
	const baseline = await evaluateCandidate({ id: "baseline", label: "Baseline", tasks: baselineTasks }, input, loadedEval.evalSet.objective, loadedEval.evalSet.cases, loadedEval.evalSet.scoring.minRunsPerCase);
	const candidates: CandidateEvaluation[] = [];
	for (const [index, dagYaml] of (input.candidateDagYamls ?? []).entries()) {
		try {
			const tasks = normalizeOptimizerDagYaml(dagYaml);
			assertValidDag(tasks);
			candidates.push(await evaluateCandidate(
				{ id: `candidate-${index + 1}`, label: `Candidate ${index + 1}`, tasks, dagYaml },
				input,
				loadedEval.evalSet.objective,
				loadedEval.evalSet.cases,
				Math.min(loadedEval.evalSet.scoring.minRunsPerCase, input.maxCandidateRuns ?? loadedEval.evalSet.scoring.minRunsPerCase),
			));
		} catch (error) {
			candidates.push({ id: `candidate-${index + 1}`, label: `Candidate ${index + 1}`, status: "invalid", dagYaml, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return {
		reportId: `opt-${Date.now().toString(36)}`,
		createdAt: new Date().toISOString(),
		evalSetName: loadedEval.evalSet.name,
		source: loadedEval.source,
		persistenceRecommendation: loadedEval.persistenceRecommendation,
		baseline,
		candidates,
		recommendation: recommend(baseline, candidates, loadedEval.evalSet.scoring),
		warnings: warnings(loadedEval.evalSet.scoring.minRunsPerCase, loadedEval.persistenceRecommendation),
	};
}

async function loadWorkflowTasks(input: EvaluateOptimizerRunInput): Promise<SubagentTask[]> {
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
): Promise<CandidateEvaluation> {
	assertValidDag(candidate.tasks);
	const graph = computeGraphMetrics(candidate.tasks);
	const runs = [];
	let abortedByCost = false;
	for (const evalCase of cases) {
		for (let index = 0; index < runsPerCase; index += 1) {
			const started = Date.now();
			let result = await runDag({ tasks: applyEvalCaseInput(candidate.tasks, evalCase.input) }, executionOptions(input));
			if (result.status === "completed" && (evalCase.expectedSections ?? evalCase.jsonSchema)) {
				try {
					validateOutput(result.output, { expectedSections: evalCase.expectedSections, jsonSchema: evalCase.jsonSchema });
				} catch {
					result = { ...result, status: "failed" };
				}
			}
			runs.push({ caseName: evalCase.name, result, wallTimeMs: Date.now() - started });
			if (input.maxCost !== undefined && summarizeRuns(runs).dollarCost > input.maxCost) {
				abortedByCost = true;
				break;
			}
		}
		if (abortedByCost) break;
	}
	const metrics = summarizeRuns(runs);
	return { ...candidate, status: metrics.failures > 0 ? "failed" : "completed", metrics, utility: computeUtility(metrics, graph, objective), graph };
}

function assertValidDag(tasks: SubagentTask[]): void {
	const validation = validateDagTasks(tasks);
	if (validation.issues.length > 0) throw new Error(validation.issues.map((issue) => issue.message).join("; "));
}

function applyEvalCaseInput(tasks: SubagentTask[], caseInput: string): SubagentTask[] {
	return tasks.map((task) => applyEvalCaseInputToTask(task, caseInput));
}

function applyEvalCaseInputToTask(task: SubagentTask, caseInput: string): SubagentTask {
	const withInput: SubagentTask = { ...task };
	if (typeof task.task === "string" && !task.workflow && !task.loop) {
		withInput.task = `Eval case input:\n${caseInput}\n\n${task.task}`;
	}
	if (task.workflow?.tasks) {
		withInput.workflow = { ...task.workflow, tasks: applyEvalCaseInputToTaskCollection(task.workflow.tasks, caseInput) };
	}
	if (task.loop?.body) {
		withInput.loop = { ...task.loop, body: applyEvalCaseInputToTaskCollection(task.loop.body, caseInput) };
	}
	return withInput;
}

function applyEvalCaseInputToTaskCollection(tasks: SubagentTask[] | Record<string, SubagentTask>, caseInput: string): SubagentTask[] | Record<string, SubagentTask> {
	if (Array.isArray(tasks)) return tasks.map((task) => applyEvalCaseInputToTask(task, caseInput));
	return Object.fromEntries(Object.entries(tasks).map(([name, task]) => [name, applyEvalCaseInputToTask(task, caseInput)]));
}

function executionOptions(input: EvaluateOptimizerRunInput): ExecutionOptions {
	return { runner: input.runner, maxConcurrency: input.maxConcurrency, timeoutSeconds: input.timeoutSeconds, maxCost: input.maxCost, signal: input.signal };
}

function recommend(baseline: CandidateEvaluation, candidates: CandidateEvaluation[], scoring: { minUtilityDelta: number; maxFailureRateRegression: number }): string {
	const valid = candidates.filter((candidate) => candidate.status !== "invalid" && candidate.utility !== undefined && baseline.utility !== undefined && candidate.metrics !== undefined && baseline.metrics !== undefined);
	if (valid.length === 0) return candidates.length === 0 ? "No candidates supplied; baseline profile only." : "No valid candidates to recommend.";
	const allowed = valid.filter((candidate) => (candidate.metrics?.failureRate ?? 0) - (baseline.metrics?.failureRate ?? 0) <= scoring.maxFailureRateRegression);
	if (allowed.length === 0) return "No candidate cleared the failure-rate regression policy; keep the baseline.";
	const best = [...allowed].sort((a, b) => (b.utility ?? -Infinity) - (a.utility ?? -Infinity))[0];
	const delta = (best.utility ?? 0) - (baseline.utility ?? 0);
	return delta >= scoring.minUtilityDelta ? `${best.label} improves utility by ${delta.toFixed(4)}; dry-run recommendation only.` : "No candidate cleared the minimum utility delta; keep the baseline.";
}

function isSubpath(parent: string, child: string): boolean {
	const relation = relative(parent, child);
	if (relation === "" || relation === ".") return true;
	return !isAbsolute(relation) && !relation.startsWith("..");
}

function warnings(minRunsPerCase: number, persistenceRecommendation?: string): string[] {
	const warnings: string[] = [];
	if (minRunsPerCase === 1) warnings.push("Single-run comparisons are noisy; treat utility deltas as directional until repeated runs are configured.");
	if (persistenceRecommendation) warnings.push(persistenceRecommendation);
	return warnings;
}
