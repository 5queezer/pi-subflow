import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentDefinition, type AgentScope } from "./agents.js";
import { appendRunHistory } from "./history.js";
import { validateExecutionPolicy } from "./policy.js";
import { PiSdkRunner } from "./runner.js";
import type { ChainStep, ExecutionOptions, FlowResult, SubagentResult, SubagentRunner, SubagentTask } from "./types.js";
import { runChain } from "./flows/chain.js";
import { runDag } from "./flows/dag.js";
import { runParallel } from "./flows/parallel.js";
import { runSingle } from "./flows/single.js";

export interface PiSubflowExtensionOptions {
	userDir?: string;
	projectDir?: string;
	historyPath?: string | ((ctx: ExtensionContext) => string);
	allowedTools?: string[];
	runnerFactory?: (input: { agents: Map<string, AgentDefinition>; ctx: ExtensionContext; params: SubflowToolParams }) => SubagentRunner;
}

type RiskTolerance = "low" | "medium" | "high";

const DEFAULT_ALLOWED_TOOLS = new Set(["read", "bash", "grep", "find", "ls", "edit", "write"]);

interface SubflowToolParams {
	agent?: string;
	task?: string;
	role?: SubagentTask["role"];
	tools?: string[];
	model?: string;
	thinking?: SubagentTask["thinking"];
	tasks?: SubagentTask[];
	chain?: ChainStep[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	riskTolerance?: RiskTolerance;
	allowExternalSideEffectWithoutConfirmation?: boolean;
	maxConcurrency?: number;
	timeoutSeconds?: number;
	maxRetries?: number;
	maxCost?: number;
	maxTokens?: number;
	maxTurns?: number;
	maxVerificationRounds?: number;
}

const taskSchema = Type.Object({
	name: Type.Optional(Type.String({ minLength: 1 })),
	agent: Type.String({ minLength: 1 }),
	task: Type.String({ minLength: 1 }),
	cwd: Type.Optional(Type.String()),
	dependsOn: Type.Optional(Type.Array(Type.String())),
	role: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("verifier")])),
	authority: Type.Optional(Type.Union([Type.Literal("read_only"), Type.Literal("internal_mutation"), Type.Literal("external_side_effect")])),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")])),
	expectedSections: Type.Optional(Type.Array(Type.String())),
	jsonSchema: Type.Optional(Type.Object({ required: Type.Optional(Type.Array(Type.String())) })),
});

const chainStepSchema = Type.Object({
	agent: Type.String({ minLength: 1 }),
	task: Type.String({ minLength: 1 }),
	cwd: Type.Optional(Type.String()),
	tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	model: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")])),
});

export function registerPiSubflowExtension(pi: Pick<ExtensionAPI, "registerTool" | "registerCommand">, options: PiSubflowExtensionOptions = {}): void {
	pi.registerTool({
		name: "subflow",
		label: "Pi Subflow",
		description: "Delegate bounded work to isolated Pi subagents using the pi-subflow orchestration core.",
		promptSnippet: "subflow: delegate bounded work to isolated Pi subagents; supports single, chain, parallel, and DAG task execution.",
		promptGuidelines: [
			"Use subflow for bounded multi-agent work with clear inputs and expected outputs; do not use subflow for small direct tasks you can do yourself.",
			"Use subflow single mode when exactly one focused subagent task is needed.",
			"Use subflow chain mode when later steps must consume the previous step via {previous}.",
			"Use subflow parallel mode when 2+ independent tasks can run concurrently and do not depend on each other.",
			"Use subflow DAG mode when tasks have explicit dependsOn relationships; set role: \"verifier\" for synthesis or validation nodes that need dependency outputs.",
			"For subflow task roles, only use \"worker\" or \"verifier\". Omit role to default to worker; do not invent roles like \"researcher\".",
			"For subflow DAGs, task names must be unique; missing dependencies, self-dependencies, and dependency cycles are rejected before execution.",
			"Set subflow tools to the minimum tool subset each subagent needs. Omit tools only when the default Pi tool set is appropriate.",
			"Set subflow model and thinking per task when quality/cost tradeoffs differ across subagents.",
		],
		renderShell: "self",
		parameters: Type.Object({
			agent: Type.Optional(Type.String({ minLength: 1, description: "Agent name for single-task mode." })),
			task: Type.Optional(Type.String({ minLength: 1, description: "Task text for single-task mode." })),
			tasks: Type.Optional(Type.Array(taskSchema, { description: "Parallel or DAG tasks. dependsOn enables DAG mode." })),
			chain: Type.Optional(Type.Array(chainStepSchema, { description: "Sequential chain steps; later steps may use {previous}." })),
			agentScope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], { default: "user" })),
			confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
			riskTolerance: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { default: "low" })),
			allowExternalSideEffectWithoutConfirmation: Type.Optional(Type.Boolean({ default: false })),
			maxConcurrency: Type.Optional(Type.Number()),
			timeoutSeconds: Type.Optional(Type.Number()),
			maxRetries: Type.Optional(Type.Number()),
			maxCost: Type.Optional(Type.Number()),
			maxTokens: Type.Optional(Type.Number()),
			maxTurns: Type.Optional(Type.Number()),
			maxVerificationRounds: Type.Optional(Type.Number()),
			model: Type.Optional(Type.String()),
			thinking: Type.Optional(Type.Union([Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("xhigh")])),
			role: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("verifier")])),
			tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		}),
		renderCall(args) {
			return new Text(formatCall(args as SubflowToolParams), 0, 0);
		},
		renderResult(result) {
			const details = result.details as (FlowResult & { mode?: "single" | "chain" | "parallel" | "dag" }) | undefined;
			const text = details?.mode ? formatResult(details, details.mode) : result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = rawParams as SubflowToolParams;
			const mode = inferMode(params);
			validateNonEmptyStrings(params);
			const flowTasks = tasksForPolicy(params);
			validateExecutionPolicy({
				agentScope: params.agentScope,
				confirmProjectAgents: params.confirmProjectAgents,
				hasUI: ctx.hasUI,
				riskTolerance: params.riskTolerance,
				allowExternalSideEffectWithoutConfirmation: params.allowExternalSideEffectWithoutConfirmation,
				tasks: flowTasks,
			});
			await confirmPolicies(params, flowTasks, ctx);
			const agents = await discoverAgents({
				scope: params.agentScope ?? "user",
				userDir: options.userDir ?? join(homedir(), ".pi", "agent", "agents"),
				projectDir: options.projectDir ?? join(ctx.cwd, ".pi", "agents"),
			});
			const effectiveParams = applyAgentDefaults(params, agents, ctx.cwd);
			validateToolAllowlist(tasksForPolicy(effectiveParams), options.allowedTools);
			const baseRunner = options.runnerFactory?.({ agents, ctx, params: effectiveParams }) ?? new PiSdkRunner({ agentDefinitions: agents });
			const progress = createProgressReporter(ctx, mode, tasksForPolicy(effectiveParams).length, params.timeoutSeconds);
			const runner = progress ? new ProgressRunner(baseRunner, progress) : baseRunner;
			progress?.start();
			const executionOptions: ExecutionOptions = {
				runner,
				maxConcurrency: params.maxConcurrency,
				timeoutSeconds: params.timeoutSeconds,
				maxRetries: params.maxRetries,
				maxCost: params.maxCost,
				maxTokens: params.maxTokens,
				maxTurns: params.maxTurns,
				maxVerificationRounds: params.maxVerificationRounds,
				signal: signal ?? ctx.signal,
			};
			let result: FlowResult;
			try {
				result = await runSelectedFlow(mode, effectiveParams, executionOptions);
			} finally {
				progress?.clear();
			}
			await appendRunHistory(resolveHistoryPath(options.historyPath, ctx), { ...result, mode });
			const details = { ...result, mode };
			return {
				content: [{ type: "text" as const, text: formatResult(result, mode) }],
				details,
				isError: result.status !== "completed",
			};
		},
	});

	pi.registerCommand("subflow-runs", {
		description: "Browse pi-subflow run history",
		handler: async (_args: string, ctx: ExtensionContext) => {
			const path = resolveHistoryPath(options.historyPath, ctx);
			const runs = await readRunHistory(path);
			if (runs.length === 0) {
				ctx.ui.notify(`No pi-subflow runs found at ${path}`, "info");
				return;
			}
			await ctx.ui.custom((tui: { requestRender?: () => void }, _theme: unknown, _keybindings: unknown, done: (result?: unknown) => void) => new RunHistoryBrowser(runs, path, () => {
				done(undefined);
			}, () => tui.requestRender?.()), { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", minWidth: 60 } });
		},
	});
}

export default function piSubflowExtension(pi: ExtensionAPI): void {
	registerPiSubflowExtension(pi);
}

async function confirmPolicies(params: SubflowToolParams, tasks: SubagentTask[], ctx: ExtensionContext): Promise<void> {
	const scope = params.agentScope ?? "user";
	if ((scope === "project" || scope === "both") && params.confirmProjectAgents !== false && ctx.hasUI) {
		const ok = await ctx.ui.confirm("Use project-local agents?", "Project-local agent definitions can override user agents. Continue?");
		if (!ok) throw new Error("project-local agent use declined");
	}
	const needsExternalConfirmation = tasks.some((task) => task.authority === "external_side_effect") && !params.allowExternalSideEffectWithoutConfirmation && ctx.hasUI;
	if (needsExternalConfirmation) {
		const ok = await ctx.ui.confirm("Allow external side effects?", "One or more subagent tasks requested authority: external_side_effect. Continue?");
		if (!ok) throw new Error("external_side_effect authority declined");
	}
}

function inferMode(params: SubflowToolParams): "single" | "chain" | "parallel" | "dag" {
	if (params.chain) return "chain";
	if (params.tasks) return params.tasks.some((task) => task.dependsOn?.length || task.role === "verifier") ? "dag" : "parallel";
	if (params.agent && params.task) return "single";
	throw new Error("subflow requires either agent+task, chain, or tasks");
}

function validateNonEmptyStrings(params: SubflowToolParams): void {
	for (const task of tasksForPolicy(params)) {
		if (!task.agent?.trim()) throw new Error("agent must be a non-empty string");
		if (!task.task?.trim()) throw new Error("task must be a non-empty string");
	}
}

function tasksForPolicy(params: SubflowToolParams): SubagentTask[] {
	if (params.tasks) return params.tasks;
	if (params.chain) return params.chain.map((step) => ({ ...step }));
	if (params.agent && params.task) return [{ ...(params as SubagentTask), agent: params.agent, task: params.task }];
	return [];
}

function validateToolAllowlist(tasks: SubagentTask[], allowedTools?: string[]): void {
	const allowlist = allowedTools ? new Set(allowedTools) : DEFAULT_ALLOWED_TOOLS;
	for (const task of tasks) {
		for (const tool of task.tools ?? []) {
			if (!allowlist.has(tool)) throw new Error(`unknown or unavailable tool: ${tool}`);
		}
	}
}

function applyAgentDefaults(params: SubflowToolParams, agents: Map<string, AgentDefinition>, defaultCwd: string): SubflowToolParams {
	const apply = <T extends SubagentTask | ChainStep>(task: T): T => {
		const agent = agents.get(task.agent);
		return {
			...task,
			cwd: task.cwd ?? defaultCwd,
			tools: task.tools ?? agent?.tools,
			model: task.model ?? agent?.model,
			thinking: task.thinking ?? (agent?.thinking as SubagentTask["thinking"] | undefined),
		};
	};
	return {
		...params,
		tasks: params.tasks?.map(apply),
		chain: params.chain?.map(apply),
		...(params.agent && params.task ? apply({ ...(params as SubagentTask), agent: params.agent, task: params.task }) : {}),
	};
}

class ProgressRunner implements SubagentRunner {
	constructor(private readonly inner: SubagentRunner, private readonly progress: ProgressReporter) {}

	async run(input: import("./types.js").RunnerInput, signal?: AbortSignal): Promise<SubagentResult> {
		this.progress.taskStarted(input.name);
		try {
			const result = await this.inner.run(input, signal);
			this.progress.taskFinished(result);
			return result;
		} catch (error) {
			this.progress.taskFinished({ name: input.name, agent: input.agent, task: input.task, status: "failed", output: "", error: error instanceof Error ? error.message : String(error), usage: {} });
			throw error;
		}
	}
}

interface ProgressReporter {
	start(): void;
	taskStarted(name: string): void;
	taskFinished(result: SubagentResult): void;
	clear(): void;
}

function createProgressReporter(ctx: ExtensionContext, mode: string, total: number, timeoutSeconds?: number): ProgressReporter | undefined {
	if (!ctx.hasUI) return undefined;
	const ui = ctx.ui as unknown;
	if (typeof ui !== "object" || ui === null || !("setWidget" in ui) || typeof ui.setWidget !== "function") return undefined;
	const setWidget = ui.setWidget;
	const startedAt = Date.now();
	const running = new Map<string, number>();
	const results = new Map<string, SubagentResult>();
	let interval: ReturnType<typeof setInterval> | undefined;
	const render = () => {
		const completed = [...results.values()].filter((result) => result.status === "completed").length;
		const failed = [...results.values()].filter((result) => result.status === "failed").length;
		const skipped = [...results.values()].filter((result) => result.status === "skipped").length;
		const runningCount = [...running.keys()].filter((name) => !results.has(name)).length;
		const status = failed > 0 ? "failed" : completed + skipped >= total && total > 0 ? "completed" : "running";
		const timeout = timeoutSeconds ? ` · ${timeoutSeconds}s timeout` : "";
		const elapsed = formatDuration(Date.now() - startedAt);
		const taskLines = [
			...[...results.values()].map((result) => `${statusIcon(result.status)} ${result.name ?? result.agent}${result.error ? `: ${result.error}` : result.output ? ` → ${firstLine(result.output)}` : ""}`),
			...[...running.entries()].filter(([name]) => !results.has(name)).map(([name, start]) => `⏳ ${name} · ${formatDuration(Date.now() - start)} elapsed`),
		];
		const lines = [
			`subflow · ${mode} · ${status}`,
			`${total} task${total === 1 ? "" : "s"} · ${runningCount} running · ${completed} completed · ${failed} failed · ${skipped} skipped · ${elapsed} elapsed${timeout}`,
			...(taskLines.length ? taskLines : ["waiting to start"]),
		];
		setWidget.call(ctx.ui, "pi-subflow-progress", lines, { placement: "belowEditor" });
	};
	return {
		start() {
			render();
			interval = setInterval(render, 1000);
			interval.unref?.();
		},
		taskStarted(name) {
			running.set(name, Date.now());
			render();
		},
		taskFinished(result) {
			results.set(result.name ?? result.agent, result);
			running.delete(result.name ?? result.agent);
			render();
		},
		clear() {
			if (interval) clearInterval(interval);
			setWidget.call(ctx.ui, "pi-subflow-progress", undefined);
		},
	};
}

async function runSelectedFlow(mode: "single" | "chain" | "parallel" | "dag", params: SubflowToolParams, options: ExecutionOptions): Promise<FlowResult> {
	if (mode === "single") return runSingle({ agent: params.agent ?? "", task: params.task ?? "", cwd: (params as SubagentTask).cwd, role: (params as SubagentTask).role, tools: (params as SubagentTask).tools, model: (params as SubagentTask).model, thinking: (params as SubagentTask).thinking }, options);
	if (mode === "chain") return runChain({ chain: params.chain ?? [] }, options);
	if (mode === "dag") return runDag({ tasks: params.tasks ?? [] }, options);
	return runParallel({ tasks: params.tasks ?? [] }, options);
}

function resolveHistoryPath(path: PiSubflowExtensionOptions["historyPath"], ctx: ExtensionContext): string {
	if (typeof path === "function") return path(ctx);
	return path ?? join(ctx.cwd, ".pi", "subflow-runs.jsonl");
}

interface StoredRun extends FlowResult {
	runId?: string;
	createdAt?: string;
	mode: "single" | "chain" | "parallel" | "dag";
}

async function readRunHistory(path: string): Promise<StoredRun[]> {
	try {
		const text = await readFile(path, "utf8");
		return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as StoredRun).reverse();
	} catch {
		return [];
	}
}

class RunHistoryBrowser {
	private selected = 0;
	private detail = false;

	constructor(private readonly runs: StoredRun[], private readonly path: string, private readonly close: () => void, private readonly requestRender: () => void) {}

	render(width: number): string[] {
		const lines = this.detail ? this.renderDetail(width) : this.renderList(width);
		return lines.map((line) => truncate(line, width));
	}

	handleInput(data: string): void {
		if (data === "\u001b" || data === "q") {
			if (this.detail) this.detail = false;
			else this.close();
		} else if (!this.detail && (data === "\u001b[A" || data === "k")) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (!this.detail && (data === "\u001b[B" || data === "j")) {
			this.selected = Math.min(this.runs.length - 1, this.selected + 1);
		} else if (!this.detail && (data === "\r" || data === "\n")) {
			this.detail = true;
		}
		this.requestRender();
	}

	invalidate(): void {}

	private renderList(width: number): string[] {
		return [
			"pi-subflow runs",
			`history: ${this.path}`,
			"↑↓/j/k navigate • enter details • q/esc close",
			"",
			...this.runs.slice(0, 50).map((run, index) => {
				const prefix = index === this.selected ? ">" : " ";
				return `${prefix} ${run.createdAt ?? "unknown-time"} ${run.status} ${run.mode} ${run.runId ?? "no-run-id"} (${run.results?.length ?? 0} results)`;
			}),
		].map((line) => truncate(line, width));
	}

	private renderDetail(width: number): string[] {
		const run = this.runs[this.selected];
		if (!run) return ["No run selected"];
		const resultLines = run.mode === "dag" ? formatDagResult(run.results ?? []) : (run.results ?? []).flatMap((result) => [
			formatTaskResult(result),
			`  task: ${result.task}`,
			...(result.error ? [`  error: ${result.error}`] : []),
			...(result.output ? [`  output: ${result.output}`] : []),
		]);
		const lines = [
			`pi-subflow run ${run.runId ?? "no-run-id"}`,
			`${run.createdAt ?? "unknown-time"} • ${run.status} • ${run.mode}`,
			"esc/q back • results:",
			"",
			...resultLines,
		];
		return lines.map((line) => truncate(line, width));
	}
}

function truncate(value: string, width: number): string {
	return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}

function formatCall(params: SubflowToolParams): string {
	const mode = inferMode(params);
	const tasks = tasksForPolicy(params);
	const names = tasks.map((task, index) => task.name ?? `${task.agent}-${index + 1}`).slice(0, 4);
	return [
		`subflow · ${mode} · queued`,
		`${tasks.length} task${tasks.length === 1 ? "" : "s"}${params.timeoutSeconds ? ` · ${params.timeoutSeconds}s timeout` : ""}`,
		...names.map((name) => `• ${name}`),
		...(tasks.length > names.length ? [`… ${tasks.length - names.length} more`] : []),
	].join("\n");
}

function formatResult(result: FlowResult, mode: "single" | "chain" | "parallel" | "dag"): string {
	const completed = result.results.filter((item) => item.status === "completed").length;
	const failed = result.results.filter((item) => item.status === "failed").length;
	const skipped = result.results.filter((item) => item.status === "skipped").length;
	const lines = [
		`subflow · ${mode} · ${result.status}`,
		`${result.results.length} task${result.results.length === 1 ? "" : "s"} · ${completed} completed · ${failed} failed · ${skipped} skipped`,
		...formatResultBody(result, mode),
	];
	if (result.output) lines.push(`final: ${firstLine(result.output)}`);
	return lines.join("\n");
}

function formatResultBody(result: FlowResult, mode: "single" | "chain" | "parallel" | "dag"): string[] {
	if (mode === "dag") return formatDagResult(result.results);
	return result.results.map((item) => formatTaskResult(item));
}

function formatTaskResult(result: SubagentResult): string {
	const name = result.name ?? result.agent;
	const identity = formatTaskIdentity(result);
	if (result.status === "failed") return `✗ ${name} ${identity}: ${result.error ?? "failed"}`;
	if (result.status === "skipped") return `- ${name} ${identity}: skipped`;
	const summary = result.output ? firstLine(result.output) : "completed";
	return `✓ ${name} ${identity} → ${summary}`;
}

function formatDagResult(results: SubagentResult[]): string[] {
	const roots = results.filter((result) => (result.dependsOn ?? []).length === 0);
	const lines = ["DAG graph"];
	for (const root of roots.length ? roots : results) {
		const rootName = root.name ?? root.agent;
		lines.push(`${rootName} ${formatDagNodeMeta(root)} ${statusIcon(root.status)}`);
		for (const child of results.filter((candidate) => (candidate.dependsOn ?? []).includes(rootName))) {
			lines.push(`  └─ ${child.name ?? child.agent} ${formatDagNodeMeta(child)} ${statusIcon(child.status)}`);
		}
	}
	if (lines.length === 1) lines.push(...results.map((result) => `${result.name ?? result.agent} ${formatDagNodeMeta(result)} ${statusIcon(result.status)}`));
	return lines;
}

function formatTaskIdentity(result: SubagentResult): string {
	return `[${[result.agent, result.model ?? "default"].join(" · ")}]`;
}

function formatDagNodeMeta(result: SubagentResult): string {
	return `[${[result.agent, result.role ?? "worker", result.model ?? "default"].join(" · ")}]`;
}

function statusIcon(status: SubagentResult["status"]): string {
	if (status === "completed") return "✓";
	if (status === "failed") return "✗";
	if (status === "running") return "⏳";
	return "-";
}

function firstLine(value: string): string {
	const line = value.trim().split(/\r?\n/).find((item) => item.trim())?.trim() ?? "";
	return truncate(line, 120);
}

function formatDuration(ms: number): string {
	return `${Math.max(0, Math.round(ms / 1000))}s`;
}
