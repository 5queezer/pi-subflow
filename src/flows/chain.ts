import { Flow, Node } from "pocketflow";
import { aggregateStatus, enforceBudget, namedTask, runTask } from "../execution.js";
import type { ChainStep, ExecutionOptions, FlowResult, SubagentResult, TraceEvent } from "../types.js";

interface ChainShared {
	chain: ChainStep[];
	options: ExecutionOptions;
	trace: TraceEvent[];
	results: SubagentResult[];
}

const CHAIN_NODE_TRACE_TYPE = "pocketflow_node" as const;

function budgetFailure(error: unknown): SubagentResult {
	return {
		agent: "budget",
		task: "budget enforcement",
		status: "failed",
		output: "",
		error: error instanceof Error ? error.message : String(error),
		usage: {},
	};
}

class PrepareChainNode extends Node<ChainShared> {
	private mark(shared: ChainShared): void {
		shared.trace.push({ type: CHAIN_NODE_TRACE_TYPE, name: "prepare-chain", timestamp: Date.now() });
	}

	async post(shared: ChainShared): Promise<string | undefined> {
		this.mark(shared);
		shared.results = [];
		return "run-chain";
	}
}

class ExecuteChainNode extends Node<ChainShared> {
	private mark(shared: ChainShared): void {
		shared.trace.push({ type: CHAIN_NODE_TRACE_TYPE, name: "run-chain", timestamp: Date.now() });
	}

	async post(shared: ChainShared): Promise<string | undefined> {
		this.mark(shared);
		let previous = "";
		for (let index = 0; index < shared.chain.length; index++) {
			const step = shared.chain[index];
			const taskText = step.task.replaceAll("{previous}", previous);
			const result = await runTask(namedTask({ ...step, task: taskText }, index), shared.options, shared.trace);
			shared.results.push(result);
			if (result.status !== "completed") break;
			previous = result.output;
			try {
				enforceBudget(shared.results, shared.options);
			} catch (error) {
				shared.results.push(budgetFailure(error));
				break;
			}
		}
		return "aggregate-chain-result";
	}
}

class AggregateChainResultNode extends Node<ChainShared & { result?: FlowResult }> {
	private mark(shared: ChainShared): void {
		shared.trace.push({ type: CHAIN_NODE_TRACE_TYPE, name: "aggregate-chain-result", timestamp: Date.now() });
	}

	async post(shared: ChainShared & { result?: FlowResult }): Promise<string | undefined> {
		this.mark(shared);
		shared.result = {
			status: aggregateStatus(shared.results),
			output: shared.results.at(-1)?.output ?? "",
			results: shared.results,
			trace: shared.trace,
		};
		return undefined;
	}
}

export async function runChain(input: { chain: ChainStep[] }, options: ExecutionOptions): Promise<FlowResult> {
	const trace: TraceEvent[] = [];
	const shared: ChainShared & { result?: FlowResult } = {
		chain: input.chain,
		options,
		trace,
		results: [],
		result: undefined,
	};
	const prepare = new PrepareChainNode();
	const execute = new ExecuteChainNode();
	const aggregate = new AggregateChainResultNode();
	prepare.on("run-chain", execute);
	execute.on("aggregate-chain-result", aggregate);
	await new Flow(prepare).run(shared);
	if (!shared.result) throw new Error("chain flow produced no result");
	return shared.result;
}
