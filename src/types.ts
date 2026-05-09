export type TaskStatus = "completed" | "failed" | "skipped" | "running";
export type FlowMode = "single" | "chain" | "parallel" | "dag";

export interface UsageStats {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: number;
	turns?: number;
}

export interface SubagentTask {
	name?: string;
	agent: string;
	task: string;
	cwd?: string;
	dependsOn?: string[];
	role?: "worker" | "verifier";
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
