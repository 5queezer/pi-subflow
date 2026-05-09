export type TaskStatus = "completed" | "failed" | "skipped" | "running";
export type FlowMode = "single" | "chain" | "parallel" | "dag";
export type TaskRole = "worker" | "verifier";

export interface UsageStats {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	turns?: number;
}

export interface WorkflowTask {
	tasks?: SubagentTask[] | Record<string, SubagentTask>;
	dagYaml?: string;
	uses?: string;
}

export interface LoopTask {
	maxIterations: number;
	body: SubagentTask[] | Record<string, SubagentTask>;
	until?: string;
}

export interface SubagentTask {
	name?: string;
	agent?: string;
	task?: string;
	workflow?: WorkflowTask;
	loop?: LoopTask;
	cwd?: string;
	dependsOn?: string[];
	when?: string;
	role?: TaskRole;
	authority?: "read_only" | "internal_mutation" | "external_side_effect";
	tools?: string[];
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	expectedSections?: string[];
	jsonSchema?: { required?: string[] };
}

export interface ChainStep {
	agent: string;
	task: string;
	cwd?: string;
	tools?: string[];
	model?: string;
	thinking?: SubagentTask["thinking"];
}

export interface RunnerInput extends SubagentTask {
	name: string;
}

export interface SubagentRunner {
	run(input: RunnerInput, signal?: AbortSignal): Promise<SubagentResult>;
}

export interface SubagentResult {
	name?: string;
	agent: string;
	task: string;
	role?: SubagentTask["role"];
	model?: string;
	dependsOn?: string[];
	status: TaskStatus;
	output: string;
	error?: string;
	usage: UsageStats;
}

export interface FlowResult {
	status: "completed" | "failed";
	output: string;
	results: SubagentResult[];
	trace: TraceEvent[];
	usage?: UsageStats;
}

export interface TraceEvent {
	type: string;
	name?: string;
	stage?: number;
	error?: string;
	timestamp: number;
}

export interface ExecutionOptions {
	runner: SubagentRunner;
	maxConcurrency?: number;
	timeoutSeconds?: number;
	maxRetries?: number;
	maxCost?: number;
	maxTokens?: number;
	maxTurns?: number;
	maxVerificationRounds?: number;
	signal?: AbortSignal;
}
