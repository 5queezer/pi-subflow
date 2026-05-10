import { Flow, Node } from "pocketflow";
import type { ExecutionOptions, FlowResult, SubagentResult, SubagentTask, TraceEvent } from "../types.js";
import { dagStatus, executeDagStages, runVerifierRepairs } from "./dag.js";
import { validateDagTasks, type NormalizedDagTask } from "./dag-validation.js";

export const POCKETFLOW_DAG_NODE_TRACE_TYPE = "pocketflow_node" as const;

type DagShared = {
	input: { tasks: SubagentTask[] };
	options: ExecutionOptions;
	trace: TraceEvent[];
	tasks?: NormalizedDagTask[];
	results: SubagentResult[];
	byName: Map<string, SubagentResult>;
	result?: FlowResult;
};

abstract class DagNode extends Node<DagShared> {
	constructor(private readonly nodeName: string) {
		super();
	}

	protected mark(shared: DagShared): void {
		shared.trace.push({ type: POCKETFLOW_DAG_NODE_TRACE_TYPE, name: this.nodeName, timestamp: Date.now() });
	}
}

class ValidateDagNode extends DagNode {
	constructor() {
		super("validate-dag");
	}

	async post(shared: DagShared, _prep: unknown, _exec: unknown): Promise<string | undefined> {
		this.mark(shared);
		const validation = validateDagTasks(shared.input.tasks);
		if (validation.issues.length > 0) throw new Error(validation.issues[0].message);
		shared.tasks = validation.tasks;
		return "max-turns-guard";
	}
}

class MaxTurnsGuardNode extends DagNode {
	constructor() {
		super("max-turns-guard");
	}

	async post(shared: DagShared, _prep: unknown, _exec: unknown): Promise<string | undefined> {
		this.mark(shared);
		const tasks = shared.tasks ?? [];
		const hasLoop = tasks.some((task) => Boolean(task.loop));
		if (!hasLoop && shared.options.maxTurns !== undefined) {
			const runnableTaskCount = tasks.filter((task) => task.synthetic !== "workflow_summary").length;
			if (shared.options.maxTurns < runnableTaskCount) {
				throw new Error(`maxTurns ${shared.options.maxTurns} is too low for ${runnableTaskCount} DAG tasks; increase maxTurns or remove the limit`);
			}
		}
		return "execute-dag-stages";
	}
}

class ExecuteDagStagesNode extends DagNode {
	constructor() {
		super("execute-dag-stages");
	}

	async post(shared: DagShared, _prep: unknown, _exec: unknown): Promise<string | undefined> {
		this.mark(shared);
		if (!shared.tasks) throw new Error("DAG validation did not produce tasks");
		await executeDagStages(shared.tasks, shared.options, shared.trace, shared.results, shared.byName);
		return "verifier-repair";
	}
}

class VerifierRepairNode extends DagNode {
	constructor() {
		super("verifier-repair");
	}

	async post(shared: DagShared, _prep: unknown, _exec: unknown): Promise<string | undefined> {
		this.mark(shared);
		if (!shared.tasks) throw new Error("DAG validation did not produce tasks");
		if (!hasBudgetFailure(shared.results)) await runVerifierRepairs(shared.tasks, shared.byName, shared.results, shared.trace, shared.options);
		return "aggregate-dag-result";
	}
}

class AggregateDagResultNode extends DagNode {
	constructor() {
		super("aggregate-dag-result");
	}

	async post(shared: DagShared, _prep: unknown, _exec: unknown): Promise<string | undefined> {
		this.mark(shared);
		shared.result = {
			status: dagStatus(shared.results),
			output: shared.results.at(-1)?.output ?? "",
			results: shared.results,
			trace: shared.trace,
		};
		return undefined;
	}
}

function hasBudgetFailure(results: SubagentResult[]): boolean {
	return results.some((result) => result.agent === "budget" && result.status === "failed");
}

export async function runPocketFlowDag(input: { tasks: SubagentTask[] }, options: ExecutionOptions): Promise<FlowResult> {
	const shared: DagShared = { input, options, trace: [], results: [], byName: new Map() };
	const validate = new ValidateDagNode();
	const maxTurnsGuard = new MaxTurnsGuardNode();
	const executeDagStagesNode = new ExecuteDagStagesNode();
	const verifierRepairNode = new VerifierRepairNode();
	const aggregateDagResultNode = new AggregateDagResultNode();
	validate.on("max-turns-guard", maxTurnsGuard);
	maxTurnsGuard.on("execute-dag-stages", executeDagStagesNode);
	executeDagStagesNode.on("verifier-repair", verifierRepairNode);
	verifierRepairNode.on("aggregate-dag-result", aggregateDagResultNode);
	await new Flow(validate).run(shared);
	if (!shared.result) throw new Error("PocketFlow DAG produced no result");
	return shared.result;
}
