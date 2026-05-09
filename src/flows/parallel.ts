import { ParallelBatchNode } from "pocketflow";
import { aggregateStatus, enforceBudget, mapLimit, namedTask, runTask } from "../execution.js";
import type { ExecutionOptions, FlowResult, SubagentResult, SubagentTask, TraceEvent } from "../types.js";

class TaskBatchNode extends ParallelBatchNode<{ tasks: SubagentTask[]; options: ExecutionOptions; trace: TraceEvent[] }> {}

export async function runParallel(input: { tasks: SubagentTask[] }, options: ExecutionOptions): Promise<FlowResult> {
	void TaskBatchNode;
	const trace: TraceEvent[] = [];
	const results = await mapLimit(input.tasks, options.maxConcurrency ?? 4, (task, index) => runTask(namedTask(task, index), options, trace));
	let status = aggregateStatus(results);
	try {
		enforceBudget(results, options);
	} catch (error) {
		status = "failed";
		results.push(budgetFailure(error));
	}
	return { status, output: results.map((result) => result.output).filter(Boolean).join("\n"), results, trace };
}

function budgetFailure(error: unknown): SubagentResult {
	return { agent: "budget", task: "budget enforcement", status: "failed", output: "", error: error instanceof Error ? error.message : String(error), usage: {} };
}
