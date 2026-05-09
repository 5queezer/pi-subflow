import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerPiSubflowExtension } from "../src/extension.js";
import type { RunnerInput, SubagentResult, SubagentRunner } from "../src/index.js";

class RecordingRunner implements SubagentRunner {
	calls: RunnerInput[] = [];
	async run(input: RunnerInput): Promise<SubagentResult> {
		this.calls.push(input);
		return { name: input.name, agent: input.agent, task: input.task, role: input.role, model: input.model, status: "completed", output: `ran ${input.agent}: ${input.task}`, usage: {} };
	}
}

test("subflow extension registers a Pi tool that runs a single task and appends history", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const userDir = join(cwd, "agents");
	await writeFile(join(await mkdirp(userDir), "worker.md"), "---\nname: worker\ndescription: Worker agent\n---\nUse tests.\n");
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { userDir, runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", { agent: "worker", task: "Inspect auth" }, undefined, undefined, fakeCtx(cwd));

	assert.equal(runner.calls.length, 1);
	assert.equal(runner.calls[0].agent, "worker");
	assert.equal(runner.calls[0].task, "Inspect auth");
	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /completed/);
	const history = await readFile(join(cwd, ".pi", "subflow-runs.jsonl"), "utf8");
	assert.match(history, /"mode":"single"/);
});

test("subflow extension runs DAG tasks and confirms project-local agents in UI", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const projectDir = join(cwd, ".pi", "agents");
	await writeFile(join(await mkdirp(projectDir), "reviewer.md"), "---\nname: reviewer\ndescription: Project reviewer\n---\nReview carefully.\n");
	const runner = new RecordingRunner();
	const pi = fakePi();
	const ctx = fakeCtx(cwd);
	registerPiSubflowExtension(pi, { projectDir, runnerFactory: ({ agents }) => {
		assert.equal(agents.get("reviewer")?.source, "project");
		return runner;
	} });

	const result = await pi.tool.execute("call-1", {
		agentScope: "project",
		tasks: [
			{ name: "work", agent: "reviewer", task: "work" },
			{ name: "verify", agent: "reviewer", role: "verifier", task: "verify" },
		],
	}, undefined, undefined, ctx);

	assert.equal(ctx.confirmations.length, 1);
	assert.equal(result.isError, false);
	assert.deepEqual(runner.calls.map((call) => call.name), ["work", "verify"]);
});

test("subflow extension applies agent model, thinking, tools, and cwd as enforced runner inputs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const userDir = join(cwd, "agents");
	await writeFile(join(await mkdirp(userDir), "worker.md"), "---\nname: worker\ndescription: Worker agent\ntools:\n  - read\n  - bash\nmodel: openai/gpt-5-mini\nthinking: low\n---\nUse tools carefully.\n");
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { userDir, runnerFactory: () => runner });

	await pi.tool.execute("call-1", { agent: "worker", task: "Inspect auth" }, undefined, undefined, fakeCtx(cwd));

	assert.deepEqual(runner.calls[0].tools, ["read", "bash"]);
	assert.equal(runner.calls[0].model, "openai/gpt-5-mini");
	assert.equal(runner.calls[0].thinking, "low");
	assert.equal(runner.calls[0].cwd, cwd);
});

test("subflow extension lets explicit task model, thinking, tools, and cwd override agent defaults", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const userDir = join(cwd, "agents");
	await writeFile(join(await mkdirp(userDir), "worker.md"), "---\nname: worker\ndescription: Worker agent\ntools: [read, bash]\nmodel: openai/gpt-5-mini\nthinking: low\n---\nUse tools carefully.\n");
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { userDir, runnerFactory: () => runner });

	await pi.tool.execute("call-1", { tasks: [{ agent: "worker", task: "Inspect auth", cwd: "/tmp/elsewhere", tools: ["read"], model: "anthropic/claude-haiku", thinking: "minimal" }] }, undefined, undefined, fakeCtx(cwd));

	assert.deepEqual(runner.calls[0].tools, ["read"]);
	assert.equal(runner.calls[0].model, "anthropic/claude-haiku");
	assert.equal(runner.calls[0].thinking, "minimal");
	assert.equal(runner.calls[0].cwd, "/tmp/elsewhere");
});

test("subflow extension defaults chain step cwd to the Pi context cwd", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await pi.tool.execute("call-1", { chain: [{ agent: "worker", task: "one" }, { agent: "worker", task: "two" }] }, undefined, undefined, fakeCtx(cwd));

	assert.deepEqual(runner.calls.map((call) => call.cwd), [cwd, cwd]);
});

test("subflow extension rejects external side effects before asking for confirmation when risk is too low", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	const ctx = fakeCtx(cwd);
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await assert.rejects(
		() => pi.tool.execute("call-1", { tasks: [{ agent: "worker", task: "publish", authority: "external_side_effect" }] }, undefined, undefined, ctx),
		/riskTolerance must be high/,
	);

	assert.deepEqual(ctx.confirmations, []);
});

test("subflow extension shows task-level progress with mode, counts, timeout, and symbols", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	const ctx = fakeCtx(cwd);
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await pi.tool.execute("call-1", { tasks: [{ name: "one", agent: "worker", task: "one" }, { name: "two", agent: "worker", task: "two" }], timeoutSeconds: 120 }, undefined, undefined, ctx);

	const rendered = ctx.widgets
		.filter((entry) => entry.key === "pi-subflow-progress" && Array.isArray(entry.value))
		.map((entry) => (entry.value as string[]).join("\n"))
		.join("\n---\n");
	assert.match(rendered, /subflow · parallel · running/);
	assert.match(rendered, /2 tasks · \d+ running · 2 completed · 0 failed/);
	assert.match(rendered, /120s timeout/);
	assert.match(rendered, /✓ one/);
	assert.match(rendered, /⏳ two|✓ two/);
	assert(ctx.widgets.some((entry) => entry.key === "pi-subflow-progress" && entry.value === undefined));
});

test("subflow extension refreshes progress while tasks are still running", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	let release!: () => void;
	const started = Promise.withResolvers<void>();
	const runner: SubagentRunner = {
		async run(input) {
			started.resolve();
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { name: input.name, agent: input.agent, task: input.task, status: "completed", output: "ok", usage: {} };
		},
	};
	const pi = fakePi();
	const ctx = fakeCtx(cwd);
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const execution = pi.tool.execute("call-1", { agent: "worker", task: "slow", timeoutSeconds: 10 }, undefined, undefined, ctx);
	await started.promise;
	await new Promise((resolve) => setTimeout(resolve, 1100));

	const renderedWhileRunning = ctx.widgets
		.filter((entry) => entry.key === "pi-subflow-progress" && Array.isArray(entry.value))
		.map((entry) => (entry.value as string[]).join("\n"))
		.join("\n---\n");
	assert.match(renderedWhileRunning, /1 task · 1 running · 0 completed · 0 failed · 0 skipped · [1-9]\d*s elapsed/);
	assert.match(renderedWhileRunning, /⏳ worker-1 · [1-9]\d*s elapsed/);

	release();
	await execution;
});

test("subflow extension formats successful chain results with summary card and task outputs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", { chain: [{ agent: "worker", task: "alpha" }, { agent: "worker", task: "beta" }] }, undefined, undefined, fakeCtx(cwd));

	assert.match(result.content[0].text, /subflow · chain · completed/);
	assert.match(result.content[0].text, /2 tasks · 2 completed · 0 failed/);
	assert.match(result.content[0].text, /✓ worker-1 \[worker · default\] → ran worker: alpha/);
	assert.match(result.content[0].text, /✓ worker-2 \[worker · default\] → ran worker: beta/);
	assert.match(result.content[0].text, /final: ran worker: beta/);
});

test("subflow extension formats failed results with inline error reason", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner: SubagentRunner = {
		async run(input) {
			return { name: input.name, agent: input.agent, task: input.task, status: "failed", output: "", error: "boom", usage: {} };
		},
	};
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", { agent: "worker", task: "fail" }, undefined, undefined, fakeCtx(cwd));

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /subflow · single · failed/);
	assert.match(result.content[0].text, /✗ worker-1 \[worker · default\]: boom/);
});

test("subflow extension formats DAG results as an indented dependency tree with agent roles and models", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", { tasks: [{ name: "base", agent: "worker", task: "base", model: "openrouter/free" }, { name: "verify", agent: "worker", role: "verifier", dependsOn: ["base"], task: "verify", model: "openai/gpt-mini" }] }, undefined, undefined, fakeCtx(cwd));

	assert.match(result.content[0].text, /DAG graph/);
	assert.match(result.content[0].text, /base \[worker · worker · openrouter\/free\] ✓/);
	assert.match(result.content[0].text, /└─ verify \[worker · verifier · openai\/gpt-mini\] ✓/);
});

test("subflow extension provides a custom result renderer for the visible Pi tool card", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", { agent: "worker", task: "visible", model: "openrouter/free" }, undefined, undefined, fakeCtx(cwd));
	const rendered = pi.tool.renderResult(result, { expanded: true, isPartial: false }, fakeTheme(), fakeRenderContext()).render(80).join("\n");

	assert.equal(pi.tool.renderShell, "self");
	assert.match(rendered, /subflow · single · completed/);
	assert.match(rendered, /✓ worker-1 \[worker · openrouter\/free\] → ran worker: visible/);
});

test("subflow extension history detail shows task models and DAG graph", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const historyPath = join(cwd, "runs.jsonl");
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { historyPath, runnerFactory: () => runner });

	await pi.tool.execute("call-1", { tasks: [{ name: "base", agent: "worker", task: "base", model: "openrouter/free" }, { name: "verify", agent: "worker", role: "verifier", dependsOn: ["base"], task: "verify", model: "openai/gpt-mini" }] }, undefined, undefined, fakeCtx(cwd));
	const ctx = fakeCtx(cwd);
	await pi.commands.get("subflow-runs").handler("", ctx);

	const browser = ctx.customCalls[0].component;
	browser.handleInput("\r");
	const detail = browser.render(100).join("\n");

	assert.match(detail, /DAG graph/);
	assert.match(detail, /base \[worker · worker · openrouter\/free\] ✓/);
	assert.match(detail, /└─ verify \[worker · verifier · openai\/gpt-mini\] ✓/);
});

test("/subflow-runs opens an interactive history browser", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	await mkdirp(join(cwd, ".pi"));
	await writeFile(join(cwd, ".pi", "subflow-runs.jsonl"), `${JSON.stringify({ runId: "r1", createdAt: "2026-05-08T00:00:00.000Z", mode: "single", status: "completed", output: "ok", results: [{ name: "worker-1", agent: "worker", task: "do", status: "completed", output: "ok", usage: {} }], trace: [] })}\n`);
	const pi = fakePi();
	const ctx = fakeCtx(cwd);
	registerPiSubflowExtension(pi);

	await pi.commands.get("subflow-runs").handler("", ctx);

	assert.equal(ctx.customCalls.length, 1);
	const lines = ctx.customCalls[0].component.render(80).join("\n");
	assert.match(lines, /r1/);
	assert.match(lines, /completed/);
	ctx.customCalls[0].component.handleInput("\r");
	assert.match(ctx.customCalls[0].component.render(80).join("\n"), /worker-1/);
});

test("subflow extension rejects empty agent or task strings", async () => {
	const pi = fakePi();
	registerPiSubflowExtension(pi);

	await assert.rejects(
		() => pi.tool.execute("call-1", { agent: " ", task: "Inspect" }, undefined, undefined, fakeCtx("/tmp")),
		/agent must be a non-empty string/,
	);
	await assert.rejects(
		() => pi.tool.execute("call-1", { tasks: [{ agent: "worker", task: "" }] }, undefined, undefined, fakeCtx("/tmp")),
		/task must be a non-empty string/,
	);
});

test("subflow extension reports failed flow results as tool errors", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner: SubagentRunner = {
		async run(input) {
			return { name: input.name, agent: input.agent, task: input.task, status: "failed", output: "", error: "boom", usage: {} };
		},
	};
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", { agent: "worker", task: "fail" }, undefined, undefined, fakeCtx(cwd));

	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /failed/);
});

async function mkdirp(path: string): Promise<string> {
	await import("node:fs/promises").then((fs) => fs.mkdir(path, { recursive: true }));
	return path;
}

function fakeTheme() {
	return { fg: (_name: string, text: string) => text, bold: (text: string) => text };
}

function fakeRenderContext() {
	return { lastComponent: undefined, expanded: true, isPartial: false, isError: false, showImages: false };
}

function fakePi() {
	const state: { tool?: any; commands: Map<string, any> } = { commands: new Map() };
	return Object.assign(state, {
		registerTool(tool: any) {
			state.tool = tool;
		},
		registerCommand(name: string, command: any) {
			state.commands.set(name, command);
		},
	});
}

function fakeCtx(cwd: string) {
	const confirmations: string[] = [];
	const widgets: Array<{ key: string; value: unknown }> = [];
	const customCalls: Array<{ component: any; options: unknown }> = [];
	return {
		cwd,
		hasUI: true,
		signal: undefined,
		confirmations,
		widgets,
		customCalls,
		ui: {
			confirm: async (title: string, message: string) => {
				confirmations.push(`${title}: ${message}`);
				return true;
			},
			notify: () => {},
			setWidget: (key: string, value: unknown) => {
				widgets.push({ key, value });
			},
			custom: async (factory: any, options: unknown) => {
				let resolved = false;
				const component = factory({ requestRender: () => {} }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }, {}, () => { resolved = true; });
				customCalls.push({ component, options });
				return resolved ? undefined : undefined;
			},
		},
	};
}
