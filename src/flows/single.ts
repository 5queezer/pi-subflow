import { Flow, Node } from "pocketflow";
import { aggregateStatus, enforceBudget, namedTask, runTask } from "../execution.js";
import type { ExecutionOptions, FlowResult, SubagentTask, TraceEvent } from "../types.js";

class SingleTaskNode extends Node<{ task: SubagentTask; options: ExecutionOptions; trace: TraceEvent[]; result?: FlowResult }> {
	async prep(shared: { task: SubagentTask }): Promise<SubagentTask> {
		return shared.task;
	}
	async exec(task: SubagentTask): Promise<SubagentTask> {
		return task;
	}
	async post(shared: { task: SubagentTask; options: ExecutionOptions; trace: TraceEvent[]; result?: FlowResult }, _prep: unknown, task: unknown): Promise<string | undefined> {
		const result = await runTask(namedTask(task as SubagentTask), shared.options, shared.trace);
		const results = [result];
		try {
			enforceBudget(results, shared.options);
		} catch (error) {
			results.push({ agent: "budget", task: "budget enforcement", status: "failed", output: "", error: error instanceof Error ? error.message : String(error), usage: {} });
		}
		shared.result = { status: aggregateStatus(results), output: result.output, results, trace: shared.trace };
		return undefined;
	}
}

export async function runSingle(task: SubagentTask, options: ExecutionOptions): Promise<FlowResult> {
	const trace: TraceEvent[] = [];
	const shared = { task, options, trace, result: undefined as FlowResult | undefined };
	await new Flow(new SingleTaskNode()).run(shared);
	if (!shared.result) throw new Error("single flow produced no result");
	return shared.result;
}
