import { Flow } from "pocketflow";
import { aggregateStatus, enforceBudget, mapLimit, namedTask, runTask } from "../execution.js";
import { planDagStages, validateDagTasks } from "./dag-validation.js";
import { evaluateWhenExpression, type WhenPlaceholderReference, WhenExpressionError } from "./dag-when.js";
import type { ExecutionOptions, FlowResult, SubagentResult, SubagentTask, TraceEvent } from "../types.js";
import type { NormalizedDagTask } from "./dag-validation.js";

export async function runDag(input: { tasks: SubagentTask[] }, options: ExecutionOptions): Promise<FlowResult> {
	void Flow;
	const trace: TraceEvent[] = [];
	const validation = validateDagTasks(input.tasks);
	if (validation.issues.length > 0) throw new Error(validation.issues[0].message);
	const tasks = validation.tasks;
	if (options.maxTurns !== undefined && options.maxTurns < tasks.length) {
		throw new Error(`maxTurns ${options.maxTurns} is too low for ${tasks.length} DAG tasks; increase maxTurns or remove the limit`);
	}
	const stages = planDagStages(tasks);
	const byName = new Map<string, SubagentResult>();
	const results: SubagentResult[] = [];
	let budgetExceeded = false;

	for (let stageIndex = 0; stageIndex < stages.length; stageIndex++) {
		trace.push({ type: "stage_start", stage: stageIndex, timestamp: Date.now() });
		const stageResults = await mapLimit(stages[stageIndex], options.maxConcurrency ?? 4, async (task) => {
			const failedDependency = (task.dependsOn ?? []).find((dep) => byName.get(dep)?.status !== "completed");
			if (failedDependency) {
				return skippedTask(task, `dependency did not complete: ${failedDependency}`);
			}
			if (task.when) {
				try {
					const passed = evaluateWhenExpression(task.when, (reference) => resolveWhenReference(reference, byName));
					if (!passed) return skippedTask(task, `condition false: ${task.when}`);
				} catch (error) {
					const message = error instanceof WhenExpressionError ? error.message : error instanceof Error ? error.message : String(error);
					return failedTask(task, `condition failed: ${message}`);
				}
			}
			const runnable = task.role === "verifier" ? appendDependencyOutputs(task, byName) : task;
			return runTask(runnable, options, trace);
		});
		for (const result of stageResults) {
			if (result.name) byName.set(result.name, result);
			results.push(result);
		}
		try {
			enforceBudget(results, options);
		} catch (error) {
			budgetExceeded = true;
			results.push({ agent: "budget", task: "budget enforcement", status: "failed", output: "", error: error instanceof Error ? error.message : String(error), usage: {} });
			break;
		}
		trace.push({ type: "stage_end", stage: stageIndex, timestamp: Date.now() });
	}

	if (!budgetExceeded) await runVerifierRepairs(tasks, byName, results, trace, options);

	return { status: dagStatus(results), output: results.at(-1)?.output ?? "", results, trace };
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
				results.push({ agent: "budget", task: "budget enforcement", status: "failed", output: "", error: error instanceof Error ? error.message : String(error), usage: {} });
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
				results.push({ agent: "budget", task: "budget enforcement", status: "failed", output: "", error: error instanceof Error ? error.message : String(error), usage: {} });
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
	return { name: task.name, agent: task.agent, task: task.task, role: task.role, model: task.model, dependsOn: task.dependsOn, status: "skipped", output: "", error, usage: {} };
}

function failedTask(task: SubagentTask, error: string): SubagentResult {
	return { name: task.name, agent: task.agent, task: task.task, role: task.role, model: task.model, dependsOn: task.dependsOn, status: "failed", output: "", error, usage: {} };
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
	for (let index = 0; index < reference.path.length; index++) {
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
	const sections = (task.dependsOn ?? []).map((dep) => `### ${dep}\n${byName.get(dep)?.output ?? ""}`);
	return { ...task, task: `${task.task}\n\nDependency outputs:\n\n${sections.join("\n\n")}` };
}
