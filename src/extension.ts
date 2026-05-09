import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentDefinition, type AgentScope } from "./agents.js";
import { appendRunHistory } from "./history.js";
import { validateExecutionPolicy } from "./policy.js";
import { PiSdkRunner } from "./runner.js";
import type { ChainStep, ExecutionOptions, FlowMode, FlowResult, SubagentResult, SubagentRunner, SubagentTask } from "./types.js";
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
	dagYaml?: string;
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

export function registerPiSubflowExtension(pi: Pick<ExtensionAPI, "registerTool" | "registerCommand" | "on">, options: PiSubflowExtensionOptions = {}): void {
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
			"For concise LLM-authored DAGs, prefer dagYaml: a small YAML subset whose keys are task names; use needs as an alias for dependsOn.",
			"Repo-local .pi/subflow/workflows/*.yaml files are registered as immediate slash commands named after the file stem, such as /code-review; they are listed in a startup [Workflows] section, text after the command is injected as workflow command arguments, and the final result is shown in an editor.",
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
			dagYaml: Type.Optional(Type.String({ description: "YAML shorthand for DAG tasks. Root is a mapping of task names to task fields; needs is an alias for dependsOn." })),
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
			const details = result.details as (FlowResult & { mode?: FlowMode }) | undefined;
			const text = details?.mode ? formatResult(details, details.mode) : result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
			return new Text(text, 0, 0);
		},
		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			return executeSubflow(rawParams as SubflowToolParams, ctx, options, signal);
		},
	});

	const registeredWorkflowCommands = new Set<string>();
	pi.on("session_start", async (_event, ctx) => {
		const workflowDir = join(ctx.cwd, ".pi", "subflow", "workflows");
		let entries: string[];
		try {
			entries = await readdir(workflowDir);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return;
			throw error;
		}
		const workflowCommands: string[] = [];
		for (const entry of entries.sort()) {
			const extension = extname(entry);
			if (extension !== ".yaml" && extension !== ".yml") continue;
			const commandName = basename(entry, extension);
			if (!isSafeWorkflowCommandName(commandName)) continue;
			workflowCommands.push(commandName);
			if (registeredWorkflowCommands.has(commandName)) continue;
			registeredWorkflowCommands.add(commandName);
			pi.registerCommand(commandName, {
				description: `Run .pi/subflow/workflows/${entry} as a pi-subflow DAG`,
				handler: async (args, commandCtx) => {
					const dagYaml = await readFile(join(commandCtx.cwd, ".pi", "subflow", "workflows", entry), "utf8");
					const workflowParams = normalizeDagYaml({ dagYaml, agentScope: "both" });
					const { dagYaml: _dagYaml, ...normalizedParams } = workflowParams;
					const executableParams = addWorkflowCommandArguments(normalizedParams, args);
					validateWorkflowCommandCwds(executableParams.tasks ?? []);
					const result = await executeSubflow(executableParams, commandCtx, options, commandCtx.signal);
					commandCtx.ui.notify(`Workflow /${commandName} ${result.isError ? "failed" : "completed"}`, result.isError ? "error" : "info");
					await commandCtx.ui.editor(`Workflow /${commandName} result`, formatWorkflowEditorResult(result));
				},
			});
		}
		if (workflowCommands.length > 0) {
			ctx.ui.notify(formatWorkflowStartupSection(workflowCommands));
		}
	});
}

export default function piSubflowExtension(pi: ExtensionAPI): void {
	registerPiSubflowExtension(pi);
}

async function executeSubflow(rawParams: SubflowToolParams, ctx: ExtensionContext, options: PiSubflowExtensionOptions, signal?: AbortSignal) {
	const params = normalizeDagYaml(rawParams);
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
}

function isSafeWorkflowCommandName(name: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

function formatWorkflowStartupSection(commandNames: string[]): string {
	const commands = commandNames.map((name) => `/${name}`).sort((a, b) => a.localeCompare(b));
	return `[Workflows]\n ${commands.join(", ")}`;
}

function formatWorkflowEditorResult(result: Awaited<ReturnType<typeof executeSubflow>>): string {
	const summary = result.content.map((item) => item.type === "text" ? item.text : "").filter(Boolean).join("\n");
	const finalOutput = result.details.output.trim();
	return finalOutput ? `${summary}\n\n${finalOutput}` : summary;
}

function validateWorkflowCommandCwds(tasks: SubagentTask[]): void {
	for (const task of tasks) {
		if (!task.cwd) continue;
		if (isAbsolute(task.cwd) || task.cwd.split(/[\\/]+/).includes("..")) {
			throw new Error(`workflow command task ${task.name ?? task.agent} cwd must stay inside the project`);
		}
	}
}

function addWorkflowCommandArguments(params: SubflowToolParams, args: string): SubflowToolParams {
	const workflowArgs = args.trim() || "(none provided)";
	return {
		...params,
		tasks: params.tasks?.map((task) => ({
			...task,
			task: [`Workflow command arguments:`, workflowArgs, "", "Workflow task:", task.task].join("\n"),
		})),
	};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
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

function inferMode(params: SubflowToolParams): FlowMode {
	if (params.chain) return "chain";
	if (params.dagYaml) return "dag";
	if (params.tasks) return params.tasks.some((task) => task.dependsOn?.length || task.role === "verifier") ? "dag" : "parallel";
	if (params.agent && params.task) return "single";
	throw new Error("subflow requires either agent+task, chain, dagYaml, or tasks");
}

function normalizeDagYaml(params: SubflowToolParams): SubflowToolParams {
	if (!params.dagYaml) return params;
	if (params.tasks) throw new Error("subflow accepts either dagYaml or tasks, not both");
	return { ...params, tasks: parseDagYaml(params.dagYaml) };
}

function parseDagYaml(source: string): SubagentTask[] {
	const root: Record<string, Record<string, unknown>> = {};
	let currentName: string | undefined;
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index];
		if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
		if (rawLine.includes("\t")) throw new Error("invalid dagYaml: tabs are not supported");
		const indent = countIndent(rawLine);
		const line = rawLine.trim();
		const match = /^([^:]+):(.*)$/.exec(line);
		if (!match) throw new Error(`invalid dagYaml line ${index + 1}: expected key: value`);
		const key = match[1].trim();
		const rest = match[2].trim();
		if (!key) throw new Error(`invalid dagYaml line ${index + 1}: empty key`);
		if (indent === 0) {
			if (rest) throw new Error(`dagYaml task ${key} must be a mapping`);
			if (root[key]) throw new Error(`duplicate DAG task name: ${key}`);
			currentName = key;
			root[currentName] = {};
			continue;
		}
		if (!currentName) throw new Error("dagYaml root must be a mapping of task names to task definitions");
		if (indent !== 2) throw new Error(`invalid dagYaml line ${index + 1}: only two-space task fields are supported`);
		if (rest === "|" || rest === ">") {
			const block: string[] = [];
			while (index + 1 < lines.length) {
				const nextLine = lines[index + 1];
				if (nextLine.trim() && countIndent(nextLine) <= indent) break;
				index += 1;
				block.push(nextLine.startsWith("    ") ? nextLine.slice(4) : nextLine.trimStart());
			}
			root[currentName][key] = rest === ">" ? block.join(" ").trimEnd() : block.join("\n").trimEnd();
			continue;
		}
		if (!rest) {
			const nested: Record<string, unknown> = {};
			while (index + 1 < lines.length) {
				const nextLine = lines[index + 1];
				if (!nextLine.trim() || nextLine.trimStart().startsWith("#")) {
					index += 1;
					continue;
				}
				if (countIndent(nextLine) <= indent) break;
				index += 1;
				const nestedMatch = /^([^:]+):(.*)$/.exec(nextLine.trim());
				if (!nestedMatch || countIndent(nextLine) !== 4) throw new Error(`invalid dagYaml line ${index + 1}: only one nested mapping level is supported`);
				nested[nestedMatch[1].trim()] = parseYamlScalar(nestedMatch[2].trim());
			}
			root[currentName][key] = nested;
			continue;
		}
		root[currentName][key] = parseYamlScalar(rest);
	}
	if (!Object.keys(root).length) throw new Error("dagYaml root must be a mapping of task names to task definitions");
	return Object.entries(root).map(([name, value]) => parseDagYamlTask(name, value));
}

function countIndent(line: string): number {
	return line.length - line.trimStart().length;
}

function parseYamlScalar(value: string): unknown {
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		return inner ? inner.split(",").map((item) => unquoteYamlString(item.trim())) : [];
	}
	return unquoteYamlString(value);
}

function unquoteYamlString(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
	return value;
}

function parseDagYamlTask(name: string, value: unknown): SubagentTask {
	if (!isRecord(value) || Array.isArray(value)) throw new Error(`dagYaml task ${name} must be a mapping`);
	const agent = value.agent;
	const task = value.task;
	if (typeof agent !== "string" || typeof task !== "string") throw new Error(`dagYaml task ${name} requires agent and task strings`);
	if (value.dependsOn !== undefined && value.needs !== undefined) throw new Error(`dagYaml task ${name} cannot set both needs and dependsOn`);
	const dependsOn = parseStringArray(value.dependsOn ?? value.needs, `dagYaml task ${name} dependsOn`);
	return {
		name,
		agent,
		task,
		cwd: optionalString(value.cwd, `dagYaml task ${name} cwd`),
		dependsOn,
		role: optionalRole(value.role, name),
		authority: optionalAuthority(value.authority, name),
		tools: parseStringArray(value.tools, `dagYaml task ${name} tools`),
		model: optionalString(value.model, `dagYaml task ${name} model`),
		thinking: optionalThinking(value.thinking, name),
		expectedSections: parseStringArray(value.expectedSections, `dagYaml task ${name} expectedSections`),
		jsonSchema: isRecord(value.jsonSchema) ? { required: parseStringArray(value.jsonSchema.required, `dagYaml task ${name} jsonSchema.required`) } : undefined,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	return value;
}

function parseStringArray(value: unknown, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${field} must be an array of strings`);
	return value;
}

function optionalRole(value: unknown, name: string): SubagentTask["role"] | undefined {
	if (value === undefined) return undefined;
	if (value === "worker" || value === "verifier") return value;
	throw new Error(`dagYaml task ${name} role must be worker or verifier`);
}

function optionalAuthority(value: unknown, name: string): SubagentTask["authority"] | undefined {
	if (value === undefined) return undefined;
	if (value === "read_only" || value === "internal_mutation" || value === "external_side_effect") return value;
	throw new Error(`dagYaml task ${name} authority must be read_only, internal_mutation, or external_side_effect`);
}

function optionalThinking(value: unknown, name: string): SubagentTask["thinking"] | undefined {
	if (value === undefined) return undefined;
	if (value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
	throw new Error(`dagYaml task ${name} thinking must be off, minimal, low, medium, high, or xhigh`);
}

function validateNonEmptyStrings(params: SubflowToolParams): void {
	for (const task of tasksForPolicy(params)) {
		if (!task.agent?.trim()) throw new Error("agent must be a non-empty string");
		if (!task.task?.trim()) throw new Error("task must be a non-empty string");
	}
}

function tasksForPolicy(params: SubflowToolParams): SubagentTask[] {
	if (params.tasks) return params.tasks;
	if (params.dagYaml) return parseDagYaml(params.dagYaml);
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

async function runSelectedFlow(mode: FlowMode, params: SubflowToolParams, options: ExecutionOptions): Promise<FlowResult> {
	if (mode === "single") return runSingle({ agent: params.agent ?? "", task: params.task ?? "", cwd: (params as SubagentTask).cwd, role: (params as SubagentTask).role, tools: (params as SubagentTask).tools, model: (params as SubagentTask).model, thinking: (params as SubagentTask).thinking }, options);
	if (mode === "chain") return runChain({ chain: params.chain ?? [] }, options);
	if (mode === "dag") return runDag({ tasks: params.tasks ?? [] }, options);
	return runParallel({ tasks: params.tasks ?? [] }, options);
}

function resolveHistoryPath(path: PiSubflowExtensionOptions["historyPath"], ctx: ExtensionContext): string {
	if (typeof path === "function") return path(ctx);
	return path ?? join(ctx.cwd, ".pi", "subflow", "runs.jsonl");
}

function truncate(value: string, width: number): string {
	return truncateToWidth(value, width, "…");
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

function formatResult(result: FlowResult, mode: FlowMode): string {
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

function formatResultBody(result: FlowResult, mode: FlowMode): string[] {
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
