import { Flow, Node } from "pocketflow";
import { aggregateStatus, enforceBudget, mapLimit, namedTask, runTask } from "../execution.js";
import type { ExecutionOptions, FlowResult, SubagentResult, SubagentTask, TraceEvent } from "../types.js";

interface ParallelShared {
	tasks: SubagentTask[];
	options: ExecutionOptions;
	trace: TraceEvent[];
	results: SubagentResult[];
}

const PARALLEL_NODE_TRACE_TYPE = "pocketflow_node" as const;

class PrepareParallelNode extends Node<ParallelShared> {
	private mark(shared: ParallelShared): void {
		shared.trace.push({ type: PARALLEL_NODE_TRACE_TYPE, name: "prepare-parallel", timestamp: Date.now() });
	}

	async post(shared: ParallelShared): Promise<string | undefined> {
		this.mark(shared);
		shared.results = [];
		return "run-parallel";
	}
}

class RunParallelNode extends Node<ParallelShared> {
	private mark(shared: ParallelShared): void {
		shared.trace.push({ type: PARALLEL_NODE_TRACE_TYPE, name: "run-parallel", timestamp: Date.now() });
	}

	async post(shared: ParallelShared): Promise<string | undefined> {
		this.mark(shared);
		shared.results = await mapLimit(shared.tasks, shared.options.maxConcurrency ?? 4, (task, index) => runTask(namedTask(task, index), shared.options, shared.trace));
		return "aggregate-parallel-result";
	}
}

class EnforceParallelBudgetNode extends Node<ParallelShared> {
	private mark(shared: ParallelShared): void {
		shared.trace.push({ type: PARALLEL_NODE_TRACE_TYPE, name: "enforce-parallel-budget", timestamp: Date.now() });
	}

	async post(shared: ParallelShared): Promise<string | undefined> {
		this.mark(shared);
		try {
			enforceBudget(shared.results, shared.options);
		} catch (error) {
			shared.results.push(budgetFailure(error));
		}
		return "finalize-parallel";
	}
}

class AggregateParallelResultNode extends Node<ParallelShared & { result?: FlowResult }> {
	private mark(shared: ParallelShared): void {
		shared.trace.push({ type: PARALLEL_NODE_TRACE_TYPE, name: "aggregate-parallel-result", timestamp: Date.now() });
	}

	async post(shared: ParallelShared & { result?: FlowResult }): Promise<string | undefined> {
		this.mark(shared);
		shared.result = {
			status: aggregateStatus(shared.results),
			output: shared.results.map((result) => result.output).filter(Boolean).join("\n"),
			results: shared.results,
			trace: shared.trace,
		};
		return undefined;
	}
}

export async function runParallel(input: { tasks: SubagentTask[] }, options: ExecutionOptions): Promise<FlowResult> {
	const trace: TraceEvent[] = [];
	const shared: ParallelShared & { result?: FlowResult } = {
		tasks: input.tasks,
		options,
		trace,
		results: [],
		result: undefined,
	};
	const prepare = new PrepareParallelNode();
	const runParallelNode = new RunParallelNode();
	const enforceBudgetNode = new EnforceParallelBudgetNode();
	const aggregate = new AggregateParallelResultNode();
	prepare.on("run-parallel", runParallelNode);
	runParallelNode.on("aggregate-parallel-result", enforceBudgetNode);
	enforceBudgetNode.on("finalize-parallel", aggregate);
	await new Flow(prepare).run(shared);
	if (!shared.result) throw new Error("parallel flow produced no result");
	return shared.result;
}

function budgetFailure(error: unknown): SubagentResult {
	return { agent: "budget", task: "budget enforcement", status: "failed", output: "", error: error instanceof Error ? error.message : String(error), usage: {} };
}
