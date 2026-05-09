import { Flow } from "pocketflow";
import { aggregateStatus, enforceBudget, mapLimit, namedTask, runTask } from "../execution.js";
import { expandDagTaskList, validateDagTasks } from "./dag-validation.js";
import { evaluateWhenExpression, type WhenPlaceholderReference, WhenExpressionError } from "./dag-when.js";
import type { ExecutionOptions, FlowResult, SubagentResult, SubagentTask, TraceEvent } from "../types.js";
import type { NormalizedDagTask } from "./dag-validation.js";

export async function runDag(input: { tasks: SubagentTask[] }, options: ExecutionOptions): Promise<FlowResult> {
	void Flow;
	const trace: TraceEvent[] = [];
	const validation = validateDagTasks(input.tasks);
	if (validation.issues.length > 0) throw new Error(validation.issues[0].message);
	const tasks = validation.tasks;
	const hasLoop = tasks.some((task) => Boolean(task.loop));
	if (!hasLoop && options.maxTurns !== undefined) {
		const runnableTaskCount = tasks.filter((task) => task.synthetic !== "workflow_summary").length;
		if (options.maxTurns < runnableTaskCount) {
			throw new Error(`maxTurns ${options.maxTurns} is too low for ${runnableTaskCount} DAG tasks; increase maxTurns or remove the limit`);
		}
	}
	const byName = new Map<string, SubagentResult>();
	const results: SubagentResult[] = [];
	await executeDagGraph(tasks, options, trace, results, byName, new Set());
	return { status: dagStatus(results), output: results.at(-1)?.output ?? "", results, trace };
}

async function executeDagGraph(
	tasks: NormalizedDagTask[],
	options: ExecutionOptions,
	trace: TraceEvent[],
	results: SubagentResult[],
	byName: Map<string, SubagentResult>,
	precompleted: Set<string>,
): Promise<void> {
	const remaining = new Map(tasks.map((task) => [task.name, task]));
	const completed = new Set(precompleted);
	let stageIndex = 0;

	while (remaining.size > 0) {
		const ready = [...remaining.values()].filter((task) => (task.dependsOn ?? []).every((dependency) => completed.has(dependency)));
		if (ready.length === 0) {
			const blocked = [...remaining.values()].filter((task) => (task.dependsOn ?? []).some((dependency) => {
				const dependencyResult = byName.get(dependency);
				return dependencyResult !== undefined && dependencyResult.status !== "completed";
			}));
			if (blocked.length === 0) throw new Error(`dependency cycle: ${[...remaining.keys()].join(" -> ")}`);
			trace.push({ type: "stage_start", stage: stageIndex, timestamp: Date.now() });
			for (const task of blocked) {
				const failedDependency = (task.dependsOn ?? []).find((dependency) => byName.get(dependency)?.status !== "completed");
				const result = skippedTask(task, `dependency did not complete: ${failedDependency ?? "unknown"}`);
				remaining.delete(task.name);
				results.push(result);
				if (result.name) byName.set(result.name, result);
			}
			try {
				enforceBudget(results, options);
			} catch (error) {
				results.push(budgetFailedResult(error));
				return;
			}
			trace.push({ type: "stage_end", stage: stageIndex, timestamp: Date.now() });
			stageIndex += 1;
			continue;
		}

		trace.push({ type: "stage_start", stage: stageIndex, timestamp: Date.now() });
		const stageResults = await mapLimit(ready, options.maxConcurrency ?? 4, async (task) => executeDagTask(task, options, trace, results, byName, completed));
		for (const result of stageResults) {
			if (result.name) {
				byName.set(result.name, result);
				if (result.status === "completed") completed.add(result.name);
			}
			results.push(result);
			if (result.name) remaining.delete(result.name);
		}
		try {
			enforceBudget(results, options);
		} catch (error) {
			results.push(budgetFailedResult(error));
			return;
		}
		trace.push({ type: "stage_end", stage: stageIndex, timestamp: Date.now() });
		stageIndex += 1;
	}

	await runVerifierRepairs(tasks, byName, results, trace, options);
}

async function executeDagTask(
	task: NormalizedDagTask,
	options: ExecutionOptions,
	trace: TraceEvent[],
	results: SubagentResult[],
	byName: Map<string, SubagentResult>,
	completed: Set<string>,
): Promise<SubagentResult> {
	const failedDependency = (task.dependsOn ?? []).find((dependency) => byName.get(dependency)?.status !== "completed" && !completed.has(dependency));
	if (failedDependency) return skippedTask(task, `dependency did not complete: ${failedDependency}`);
	if (task.when) {
		try {
			const passed = evaluateWhenExpression(task.when, (reference) => resolveWhenReference(reference, byName));
			if (!passed) return skippedTask(task, `condition false: ${task.when}`);
		} catch (error) {
			const message = error instanceof WhenExpressionError ? error.message : error instanceof Error ? error.message : String(error);
			return failedTask(task, `condition failed: ${message}`);
		}
	}
	if (task.synthetic === "workflow_summary") return synthesizeWorkflowSummary(task, byName, trace);
	if (task.loop) return runLoopTask(task as NormalizedDagTask & { loop: NonNullable<NormalizedDagTask["loop"]> }, options, trace, results, byName);
	const runnable = task.role === "verifier" ? appendDependencyOutputs(task, byName) : task;
	return runTask(runnable, options, trace);
}

async function runLoopTask(
	task: NormalizedDagTask & { loop: NonNullable<NormalizedDagTask["loop"]> },
	options: ExecutionOptions,
	trace: TraceEvent[],
	results: SubagentResult[],
	byName: Map<string, SubagentResult>,
): Promise<SubagentResult> {
	const bodyTasks = normalizeLoopBodyTasks(task.loop.body, task.name);
	if (bodyTasks.length === 0) throw new Error(`task ${task.name} loop requires body tasks`);
	let previousIterationTerminalNames = [...(task.dependsOn ?? [])];
	let iterationsCompleted = 0;
	let stoppedEarly = false;
	for (let iteration = 1; iteration <= task.loop.maxIterations; iteration += 1) {
		const iterationPrefix = `${task.name}.${iteration}`;
		const iterationTasks = expandDagTaskList(bodyTasks, previousIterationTerminalNames, iterationPrefix);
		const iterationStart = results.length;
		await executeDagGraph(iterationTasks, options, trace, results, byName, new Set(previousIterationTerminalNames));
		const iterationResults = results.slice(iterationStart);
		const iterationTaskNames = new Set(iterationTasks.map((item) => item.name));
		const iterationFailed = iterationResults.some((result) => result.agent === "budget" && result.status === "failed") || [...iterationTaskNames].some((name) => {
			const result = byName.get(name);
			return result?.status === "failed" || (result?.status === "skipped" && skippedBecauseFailedDependency(result, byName));
		});
		if (iterationFailed) {
			return synthesizeLoopTaskResult(task, iteration, task.loop.maxIterations, false, "failed");
		}
		iterationsCompleted = iteration;
		previousIterationTerminalNames = getTerminalNodeNames(iterationTasks);
		if (!task.loop.until) continue;
		const aliasMap = new Map(bodyTasks.map((bodyTask) => [bodyTask.name, `${iterationPrefix}.${bodyTask.name}`]));
		try {
			if (evaluateWhenExpression(task.loop.until, (reference) => resolveLoopReference(reference, aliasMap, byName))) {
				stoppedEarly = true;
				break;
			}
		} catch (error) {
			throw new Error(`task ${task.name} loop until failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return synthesizeLoopTaskResult(task, iterationsCompleted, task.loop.maxIterations, stoppedEarly, "completed");
}

async function runVerifierRepairs(
	tasks: NormalizedDagTask[],
	byName: Map<string, SubagentResult>,
	results: SubagentResult[],
	trace: TraceEvent[],
	options: ExecutionOptions,
): Promise<void> {
	const rounds = options.maxVerificationRounds ?? 0;
	for (let round = 1; round <= rounds; round++) {
		const failedVerifiers = tasks.filter((task) => task.role === "verifier" && byName.get(task.name)?.status === "failed");
		if (failedVerifiers.length === 0) return;
		for (const verifier of failedVerifiers) {
			const repair = namedTask({ name: `repair-${verifier.name}-${round}`, agent: verifier.agent, task: `Repair verifier failure for ${verifier.name}: ${byName.get(verifier.name)?.error ?? "unknown failure"}` });
			const repairResult = await runTask(repair, options, trace);
			byName.set(repair.name, repairResult);
			results.push(repairResult);
			try {
				enforceBudget(results, options);
			} catch (error) {
				results.push(budgetFailedResult(error));
				return;
			}
			if (repairResult.status !== "completed") continue;
			const rerunTask = appendDependencyOutputs({ ...verifier, dependsOn: [...(verifier.dependsOn ?? []), repair.name] }, byName);
			const rerun = await runTask(rerunTask, options, trace);
			byName.set(verifier.name, rerun);
			results.push(rerun);
			try {
				enforceBudget(results, options);
			} catch (error) {
				results.push(budgetFailedResult(error));
				return;
			}
		}
	}
}

function dagStatus(results: SubagentResult[]): "completed" | "failed" {
	const latestByName = new Map<string, SubagentResult>();
	for (const result of results) {
		if (result.name?.startsWith("repair-")) continue;
		latestByName.set(result.name ?? `${result.agent}:${result.task}`, result);
	}
	return aggregateStatus([...latestByName.values()]);
}

function skippedTask(task: SubagentTask, error: string): SubagentResult {
	return { name: task.name, agent: task.agent ?? "workflow", task: task.task ?? "summary", role: task.role, model: task.model, dependsOn: task.dependsOn, status: "skipped", output: "", error, usage: {} };
}

function failedTask(task: SubagentTask, error: string): SubagentResult {
	return { name: task.name, agent: task.agent ?? "workflow", task: task.task ?? "summary", role: task.role, model: task.model, dependsOn: task.dependsOn, status: "failed", output: "", error, usage: {} };
}

function budgetFailedResult(error: unknown): SubagentResult {
	return { agent: "budget", task: "budget enforcement", status: "failed", output: "", error: error instanceof Error ? error.message : String(error), usage: {} };
}

function skippedBecauseFailedDependency(result: SubagentResult, byName: Map<string, SubagentResult>): boolean {
	const dependency = /^dependency did not complete: (.+)$/.exec(result.error ?? "")?.[1];
	return dependency ? byName.get(dependency)?.status === "failed" : false;
}

function synthesizeWorkflowSummary(task: NormalizedDagTask, byName: Map<string, SubagentResult>, trace: TraceEvent[]): SubagentResult {
	trace.push({ type: "task_complete", name: task.name, timestamp: Date.now() });
	const sections = task.dependsOn.map((dependency) => `### ${dependency}\n${byName.get(dependency)?.output ?? ""}`);
	return { name: task.name, agent: task.agent, task: task.task, dependsOn: task.dependsOn, status: "completed", output: sections.join("\n\n"), usage: {} };
}

function synthesizeLoopTaskResult(
	task: NormalizedDagTask & { loop: NonNullable<NormalizedDagTask["loop"]> },
	iterationsCompleted: number,
	maxIterations: number,
	stoppedEarly: boolean,
	status: "completed" | "failed",
): SubagentResult {
	return {
		name: task.name,
		agent: task.agent,
		task: task.task,
		dependsOn: task.dependsOn,
		status,
		output: JSON.stringify({ iterationsCompleted, maxIterations, status, stoppedEarly }),
		usage: {},
	};
}

function resolveWhenReference(reference: WhenPlaceholderReference, byName: Map<string, SubagentResult>): unknown {
	const result = byName.get(reference.task);
	if (!result) throw new WhenExpressionError(`task ${reference.task} has not completed yet`);
	if (result.status !== "completed") throw new WhenExpressionError(`task ${reference.task} is ${result.status}; cannot read output`);
	let value: unknown;
	try {
		value = JSON.parse(result.output);
	} catch (error) {
		throw new WhenExpressionError(`task ${reference.task} output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (reference.path.length === 0) return value;
	for (let index = 0; index < reference.path.length; index += 1) {
		const segment = reference.path[index];
		if (value === null || (typeof value !== "object" && !Array.isArray(value))) {
			throw new WhenExpressionError(`task ${reference.task} output is missing path ${reference.path.join(".")}`);
		}
		if (!(segment in value)) throw new WhenExpressionError(`task ${reference.task} output is missing path ${reference.path.join(".")}`);
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

function resolveLoopReference(reference: WhenPlaceholderReference, aliasMap: Map<string, string>, byName: Map<string, SubagentResult>): unknown {
	const actualName = aliasMap.get(reference.task);
	if (!actualName) throw new WhenExpressionError(`loop until references missing body task ${reference.task}`);
	const result = byName.get(actualName);
	if (!result) throw new WhenExpressionError(`task ${reference.task} has not completed yet`);
	if (result.status !== "completed") throw new WhenExpressionError(`task ${reference.task} is ${result.status}; cannot read output`);
	let value: unknown;
	try {
		value = JSON.parse(result.output);
	} catch (error) {
		throw new WhenExpressionError(`task ${reference.task} output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (reference.path.length === 0) return value;
	for (let index = 0; index < reference.path.length; index += 1) {
		const segment = reference.path[index];
		if (value === null || (typeof value !== "object" && !Array.isArray(value))) {
			throw new WhenExpressionError(`task ${reference.task} output is missing path ${reference.path.join(".")}`);
		}
		if (!(segment in value)) throw new WhenExpressionError(`task ${reference.task} output is missing path ${reference.path.join(".")}`);
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

function appendDependencyOutputs<T extends { task: string; dependsOn?: string[] }>(task: T, byName: Map<string, SubagentResult>): T {
	const sections = (task.dependsOn ?? []).map((dependency) => `### ${dependency}\n${byName.get(dependency)?.output ?? ""}`);
	return { ...task, task: `${task.task}\n\nDependency outputs:\n\n${sections.join("\n\n")}` };
}

function normalizeLoopBodyTasks(tasks: SubagentTask[] | Record<string, SubagentTask>, context: string): Array<SubagentTask & { name: string }> {
	if (Array.isArray(tasks)) return tasks.map((task, index) => namedTask(task, index));
	if (isRecord(tasks)) return Object.entries(tasks).map(([name, task]) => ({ ...task, name: task.name ?? name }));
	throw new Error(`task ${context} loop body must be an array or mapping`);
}

function getTerminalNodeNames(tasks: NormalizedDagTask[]): string[] {
	const dependentNames = new Set<string>();
	for (const task of tasks) {
		for (const dependency of task.dependsOn ?? []) dependentNames.add(dependency);
	}
	return tasks.filter((task) => !dependentNames.has(task.name)).map((task) => task.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
