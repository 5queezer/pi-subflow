import { aggregateStatus, enforceBudget, namedTask, runTask } from "../execution.js";
import type { ChainStep, ExecutionOptions, FlowResult, SubagentResult, TraceEvent } from "../types.js";

export async function runChain(input: { chain: ChainStep[] }, options: ExecutionOptions): Promise<FlowResult> {
	const trace: TraceEvent[] = [];
	const results: SubagentResult[] = [];
	let previous = "";
	for (let index = 0; index < input.chain.length; index++) {
		const step = input.chain[index];
		const taskText = step.task.replaceAll("{previous}", previous);
		const result = await runTask(namedTask({ ...step, task: taskText }, index), options, trace);
		results.push(result);
		if (result.status !== "completed") break;
		previous = result.output;
		try {
			enforceBudget(results, options);
		} catch (error) {
			results.push({ agent: "budget", task: "budget enforcement", status: "failed", output: "", error: error instanceof Error ? error.message : String(error), usage: {} });
			break;
		}
	}
	return { status: aggregateStatus(results), output: results.at(-1)?.output ?? "", results, trace };
}
