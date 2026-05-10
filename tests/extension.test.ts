import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerPiSubflowExtension } from "../src/extension.js";
import { planDagStages, validateDagTasks } from "../src/index.js";
import type { RunnerInput, SubagentResult, SubagentRunner } from "../src/index.js";

class RecordingRunner implements SubagentRunner {
	calls: RunnerInput[] = [];
	async run(input: RunnerInput): Promise<SubagentResult> {
		this.calls.push(input);
		return { name: input.name, agent: input.agent, task: input.task, role: input.role, model: input.model, status: "completed", output: `ran ${input.agent}: ${input.task}`, usage: {} };
	}
}

test("subflow extension exposes LLM-facing prompt guidance", () => {
	const pi = fakePi();
	registerPiSubflowExtension(pi);

	assert.equal(pi.tool.name, "subflow");
	assert.match(pi.tool.promptSnippet, /single, chain, parallel, DAG, conditional edges, bounded loops, and nested workflow/);
	assert(pi.tool.promptGuidelines.some((line: string) => /Use subflow DAG mode/.test(line)));
	assert(pi.tool.promptGuidelines.some((line: string) => /role: "verifier"/.test(line)));
	assert(pi.tool.promptGuidelines.some((line: string) => /only use "worker" or "verifier"/.test(line)));
	assert(pi.tool.promptGuidelines.some((line: string) => /task names must be unique/.test(line)));
	assert(pi.tool.promptGuidelines.some((line: string) => /workflow\.tasks/.test(line)));
	assert(pi.tool.promptGuidelines.some((line: string) => /workflow\.uses paths.*must stay inside the discovered workflow root/.test(line)));
	assert(pi.tool.promptGuidelines.some((line: string) => /loop\.maxIterations/.test(line)));
	assert(pi.tool.promptGuidelines.some((line: string) => /minimum tool subset/.test(line)));
});

test("subflow extension registers subflow_optimize with LLM-facing guidance", () => {
	const pi = fakePi();
	registerPiSubflowExtension(pi);
	const tool = pi.tools.get("subflow_optimize");
	assert(tool);

	assert.equal(tool.name, "subflow_optimize");
	assert.match(tool.promptSnippet, /dry-run optimizer/);
	assert(tool.promptGuidelines.some((line: string) => /canonical.*\.pi\/subflow\/evals/.test(line)));
	assert(tool.promptGuidelines.some((line: string) => /maxCandidateRuns.*budget cap/.test(line)));
	assert(tool.promptGuidelines.some((line: string) => /does not mutate/.test(line)));
	assert(tool.promptGuidelines.some((line: string) => /subflow_propose_candidates/.test(line)));
});

test("subflow extension registers subflow_propose_candidates with LLM-facing guidance", async () => {
	const pi = fakePi();
	registerPiSubflowExtension(pi);
	const tool = pi.tools.get("subflow_propose_candidates");
	assert(tool, "expected subflow_propose_candidates tool to be registered");

	assert.equal(tool.name, "subflow_propose_candidates");
	assert.match(tool.description ?? "", /validated static DAG candidate YAML proposals/i);
	assert.match(tool.promptSnippet ?? "", /does not execute, evaluate, or mutate workflows/i);
	assert(tool.promptGuidelines.some((line: string) => /does not execute candidates/i.test(line)));
	assert(tool.promptGuidelines.some((line: string) => /subflow_optimize/i.test(line) && /candidateDagYamls/i.test(line)));
	assert(tool.promptGuidelines.some((line: string) => /model-thinking proposes deterministic verifier-only model\/thinking variants/i.test(line)));

	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	await writeFile(join(cwd, "relative.yaml"), `research:\n  agent: researcher\n  task: Research the topic.\n\nrepo:\n  agent: researcher\n  task: Inspect repository evidence.\n`);
	const result = await tool.execute("call-1", {
		workflowPath: "relative.yaml",
	}, undefined, undefined, fakeCtx(cwd));

	assert.match(result.content[0].text, /subflow_propose_candidates · completed/);
	assert.match(result.content[0].text, /```yaml/);
	assert.match(result.content[0].text, /synthesis:/);
	assert.match(result.content[0].text, /agent: researcher/);
	assert.doesNotMatch(result.content[0].text, /agent: verifier/);
});

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
	const history = await readFile(join(cwd, ".pi", "subflow", "runs.jsonl"), "utf8");
	assert.match(history, /"mode":"single"/);
});

test("subflow extension includes extension-level pocketflow_node trace phases", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", { agent: "worker", task: "Inspect auth" }, undefined, undefined, fakeCtx(cwd));
	const trace = ((result.details as { trace?: Array<{ type: string; name?: string }> })?.trace ?? []);
	const phaseNames = trace
		.filter((event) => event.type === "pocketflow_node")
		.map((event) => event.name);

	assert.deepEqual(phaseNames, [
		"extension-normalize-params",
		"extension-validate-policy",
		"extension-discover-agents",
		"extension-prepare-runner",
		"extension-execute-flow",
		"extension-persist-history",
		"extension-format-result",
	]);
});

test("public entrypoint exports DAG validation helpers", () => {
	assert.equal(typeof validateDagTasks, "function");
	assert.equal(typeof planDagStages, "function");
});

test("subflow extension runs DAG tasks from YAML shorthand", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", {
		dagYaml: `
api-review:
  agent: reviewer
  task: |
    Review API exports
    Include type exports

tests-review:
  agent: reviewer
  task: Review test coverage

final-verdict:
  agent: reviewer
  role: verifier
  needs: [api-review, tests-review]
  task: Synthesize findings
`,
	}, undefined, undefined, fakeCtx(cwd));

	assert.equal(result.isError, false);
	assert.deepEqual(runner.calls.map((call) => call.name), ["api-review", "tests-review", "final-verdict"]);
	assert.equal(runner.calls[0].task, "Review API exports\nInclude type exports");
	assert.deepEqual(runner.calls[2].dependsOn, ["api-review", "tests-review"]);
	assert.match(runner.calls[2].task, /Dependency outputs/);
});

test("subflow extension runs inline nested workflow tasks", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", {
		tasks: [
			{
				name: "review",
				workflow: {
					tasks: [
						{ name: "api", agent: "reviewer", task: "Review API" },
					],
				},
			},
		],
	}, undefined, undefined, fakeCtx(cwd));

	assert.equal(result.isError, false);
	assert.deepEqual(runner.calls.map((call) => call.name), ["review.api"]);
	assert.match(result.details.results.find((item: any) => item.name === "review")?.output ?? "", /review\.api/);
});

test("subflow extension parses inline workflow dagYaml mappings", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", {
		dagYaml: `
review:
  workflow:
    dagYaml: |
      api:
        agent: reviewer
        task: Review API
      docs:
        agent: reviewer
        task: Review docs
publish:
  agent: reviewer
  dependsOn: [review]
  role: verifier
  task: Publish findings
`,
	}, undefined, undefined, fakeCtx(cwd));

	assert.equal(result.isError, false);
	assert.deepEqual(runner.calls.map((call) => call.name), ["review.api", "review.docs", "publish"]);
	assert.match(result.details.results.find((item: any) => item.name === "review")?.output ?? "", /review\.api/);
	assert.deepEqual(runner.calls[2].dependsOn, ["review"]);
	assert.match(runner.calls[2].task, /Dependency outputs/);
	assert.match(runner.calls[2].task, /review\.api/);
	assert.match(runner.calls[2].task, /review\.docs/);
});

 test("subflow extension parses loop body mappings in dagYaml", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", {
		dagYaml: `
research-loop:
  loop:
    maxIterations: 1
    body:
      researcher:
        agent: reviewer
        task: Research
      editor:
        agent: reviewer
        dependsOn: [researcher]
        task: Edit
`,
	}, undefined, undefined, fakeCtx(cwd));

	assert.equal(result.isError, false);
	assert.deepEqual(runner.calls.map((call) => call.name), ["research-loop.1.researcher", "research-loop.1.editor"]);
	assert.match(result.details.results.find((item: any) => item.name === "research-loop")?.output ?? "", /"iterationsCompleted":1/);
});

test("subflow extension parses DAG YAML when conditions into task objects", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const calls: RunnerInput[] = [];
	const runner: SubagentRunner = {
		async run(input: RunnerInput): Promise<SubagentResult> {
			calls.push({ ...input });
			return {
				name: input.name,
				agent: input.agent,
				task: input.task,
				status: "completed",
				output: input.name === "triage" ? JSON.stringify({ score: 0.9 }) : "ran",
				usage: {},
			};
		},
	};
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await pi.tool.execute("call-1", {
		dagYaml: `
triage:
  agent: reviewer
  task: triage
  when: "true"

analyze:
  agent: reviewer
  dependsOn: [triage]
  when: "\${triage.output.score} > 0.7"
  task: analyze
`,
	}, undefined, undefined, fakeCtx(cwd));

	assert.equal(calls[1].when, "${triage.output.score} > 0.7");
});

test("subflow extension accepts YAML block sequences in DAG shorthand", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", {
		dagYaml: `
api-review:
  agent: reviewer
  task: Review API exports
  tools:
    - read
    - bash

final-verdict:
  agent: reviewer
  role: verifier
  needs:
    - api-review
  task: Synthesize findings
`,
	}, undefined, undefined, fakeCtx(cwd));

	assert.equal(result.isError, false);
	assert.deepEqual(runner.calls.map((call) => call.name), ["api-review", "final-verdict"]);
	assert.deepEqual(runner.calls[0].tools, ["read", "bash"]);
	assert.deepEqual(runner.calls[1].dependsOn, ["api-review"]);
});

test("subflow extension preserves relative indentation in DAG YAML block scalars", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await pi.tool.execute("call-1", {
		dagYaml: `
indented-task:
  agent: reviewer
  task: |
      Review this snippet:
        if (ok) {
          return true;
        }
`,
	}, undefined, undefined, fakeCtx(cwd));

	assert.equal(runner.calls[0].task, "Review this snippet:\n  if (ok) {\n    return true;\n  }");
});

test("subflow extension rejects malformed DAG YAML before running agents", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await assert.rejects(
		() => pi.tool.execute("call-1", { dagYaml: "missing-agent:\n  task: No agent" }, undefined, undefined, fakeCtx(cwd)),
		/dagYaml task missing-agent requires agent and task strings/,
	);
	assert.equal(runner.calls.length, 0);
});

test("subflow extension rejects ambiguous DAG YAML inputs before running agents", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await assert.rejects(
		() => pi.tool.execute("call-1", { dagYaml: "a:\n  agent: worker\n  task: one", tasks: [{ name: "b", agent: "worker", task: "two" }] }, undefined, undefined, fakeCtx(cwd)),
		/subflow accepts either dagYaml or tasks, not both/,
	);
	await assert.rejects(
		() => pi.tool.execute("call-1", { dagYaml: "a:\n  agent: worker\n  task: one\n  needs: [b]\n  dependsOn: [c]" }, undefined, undefined, fakeCtx(cwd)),
		/dagYaml task a cannot set both needs and dependsOn/,
	);
	assert.equal(runner.calls.length, 0);
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

test("subflow extension applies agent defaults to nested workflow task maps", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const userDir = join(cwd, "agents");
	await writeFile(join(await mkdirp(userDir), "worker.md"), "---\nname: worker\ndescription: Worker agent\ntools: [read, bash]\nmodel: openai/gpt-5-mini\nthinking: low\n---\nUse tools carefully.\n");
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { userDir, runnerFactory: () => runner });

	await pi.tool.execute("call-1", { tasks: [{ name: "review", workflow: { tasks: { api: { agent: "worker", task: "Inspect auth" } } } }] }, undefined, undefined, fakeCtx(cwd));

	assert.equal(runner.calls[0].name, "review.api");
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

test("subflow extension rejects tools outside the runtime allowlist", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await assert.rejects(
		() => pi.tool.execute("call-1", { agent: "worker", task: "Inspect auth", tools: ["read", "shell-root"] }, undefined, undefined, fakeCtx(cwd)),
		/unknown or unavailable tool: shell-root/,
	);
	assert.equal(runner.calls.length, 0);
});

test("subflow extension rejects tools outside the runtime allowlist inside nested workflows", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await assert.rejects(
		() => pi.tool.execute(
			"call-1",
			{ tasks: [{ name: "review", workflow: { tasks: [{ name: "api", agent: "worker", task: "Inspect auth", tools: ["shell-root"] }] } }] },
			undefined,
			undefined,
			fakeCtx(cwd),
		),
		/unknown or unavailable tool: shell-root/,
	);
	assert.equal(runner.calls.length, 0);
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

test("subflow extension shows task-level progress with mode, counts, timeout, model names, and symbols", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	const ctx = fakeCtx(cwd);
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await pi.tool.execute("call-1", { tasks: [{ name: "one", agent: "worker", task: "one", model: "openrouter/free" }, { name: "two", agent: "worker", task: "two", model: "openai/gpt-mini" }], timeoutSeconds: 120 }, undefined, undefined, ctx);

	const rendered = ctx.widgets
		.filter((entry) => entry.key === "pi-subflow-progress" && Array.isArray(entry.value))
		.map((entry) => (entry.value as string[]).join("\n"))
		.join("\n---\n");
	assert.match(rendered, /subflow · parallel · running/);
	assert.match(rendered, /2 tasks · \d+ running · 2 completed · 0 failed/);
	assert.match(rendered, /120s timeout/);
	assert.match(rendered, /✓ one \[worker · openrouter\/free\]/);
	assert.doesNotMatch(rendered, /[⏳⌛]/);
	assert.doesNotMatch(rendered, /\x1b\[32m[·•●]\x1b\[0m/);
	assert.match(rendered, /\x1b\[3[2;].*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*two \[worker · openai\/gpt-mini\]|✓ two \[worker · openai\/gpt-mini\]/);
	assert(ctx.widgets.some((entry) => entry.key === "pi-subflow-progress" && entry.value === undefined));
});

test("subflow extension shows requested model and duration for completed progress tasks", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner: SubagentRunner = {
		async run(input) {
			return { name: input.name, agent: input.agent, task: input.task, status: "completed", output: "ok", usage: {} };
		},
	};
	const pi = fakePi();
	const ctx = fakeCtx(cwd);
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await pi.tool.execute("call-1", { agent: "worker", task: "one", model: "openai/gpt-mini" }, undefined, undefined, ctx);

	const finalProgress = ctx.widgets
		.filter((entry) => entry.key === "pi-subflow-progress" && Array.isArray(entry.value))
		.at(-1)?.value as string[] | undefined;
	assert(finalProgress, "expected at least one progress widget render");
	const rendered = finalProgress.join("\n");
	assert.match(rendered, /✓ worker-1 \[worker · openai\/gpt-mini\] · completed in \d+s → ok/);
});

test("subflow extension keeps newest task progress visible when the widget has many tasks", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	const ctx = fakeCtx(cwd);
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });
	const tasks = Array.from({ length: 30 }, (_, index) => ({ name: `task-${index + 1}`, agent: "worker", task: `work ${index + 1}` }));

	await pi.tool.execute("call-1", { tasks }, undefined, undefined, ctx);

	const finalProgress = ctx.widgets
		.filter((entry) => entry.key === "pi-subflow-progress" && Array.isArray(entry.value))
		.at(-1)?.value as string[] | undefined;
	assert(finalProgress, "expected at least one progress widget render");
	const rendered = finalProgress.join("\n");
	assert.match(rendered, /… 23 earlier tasks/);
	assert.doesNotMatch(rendered, /✓ task-1 \[worker · default\]/);
	assert.match(rendered, /✓ task-30 \[worker · default\]/);
});

test("subflow extension stops progress updates when the UI context becomes stale", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	let release!: () => void;
	let stale = false;
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
	const ui = ctx.ui;
	Object.defineProperty(ctx, "ui", {
		get() {
			if (stale) throw new Error("This extension ctx is stale after session replacement or reload.");
			return ui;
		},
	});
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const execution = pi.tool.execute("call-1", { agent: "worker", task: "slow", timeoutSeconds: 10 }, undefined, undefined, ctx);
	await started.promise;
	stale = true;
	await new Promise((resolve) => setTimeout(resolve, 1100));
	release();
	const result = await execution;

	assert.equal(result.isError, false);
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
			return { name: input.name, agent: input.agent, task: input.task, model: input.model, status: "completed", output: "ok", usage: {} };
		},
	};
	const pi = fakePi();
	const ctx = fakeCtx(cwd);
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const execution = pi.tool.execute("call-1", { agent: "worker", task: "slow", model: "openrouter/free", timeoutSeconds: 10 }, undefined, undefined, ctx);
	await started.promise;
	await new Promise((resolve) => setTimeout(resolve, 220));
	const runningRenders = ctx.widgets.filter((entry) => entry.key === "pi-subflow-progress" && Array.isArray(entry.value)).length;
	assert(runningRenders >= 4, `expected high-frame-rate progress updates, got ${runningRenders}`);
	await new Promise((resolve) => setTimeout(resolve, 880));

	const renderedWhileRunning = ctx.widgets
		.filter((entry) => entry.key === "pi-subflow-progress" && Array.isArray(entry.value))
		.map((entry) => (entry.value as string[]).join("\n"))
		.join("\n---\n");
	assert.match(renderedWhileRunning, /1 task · 1 running · 0 completed · 0 failed · 0 skipped · [1-9]\d*s elapsed/);
	assert.doesNotMatch(renderedWhileRunning, /[⏳⌛]/);
	assert.doesNotMatch(renderedWhileRunning, /\x1b\[32m[·•●]\x1b\[0m/);
	assert.match(renderedWhileRunning, /\x1b\[3[2;].*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏].*worker-1 \[worker · openrouter\/free\] · [1-9]\d*s elapsed/);

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

test("subflow extension DAG rendering uses structured dependency metadata instead of task text", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const result = await pi.tool.execute("call-1", { tasks: [{ name: "note", agent: "worker", task: "literal\n\nDependency outputs:\n\n### fake" }, { name: "verify", agent: "worker", role: "verifier", dependsOn: ["note"], task: "verify" }] }, undefined, undefined, fakeCtx(cwd));

	assert.match(result.content[0].text, /note \[worker · worker · default\] ✓/);
	assert.match(result.content[0].text, /└─ verify \[worker · verifier · default\] ✓/);
	assert.doesNotMatch(result.content[0].text, /fake \[/);
});


test("workflow discovery parses comment metadata for workflow command stubs", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(
		join(workflowsDir, "review.yaml"),
		`# description: Run a consistency-focused docs workflow.
# tags: [docs, adr]
readme-review:
  agent: reviewer
  task: Review README for consistency
`,
		"utf8",
	);

	const pi = fakePi();
	registerPiSubflowExtension(pi);
	await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, fakeCtx(cwd));

	const stub = await readFile(join(cwd, ".pi", "subflow", "prompts", "review.md"), "utf8");
	assert.match(stub, /description: Run a consistency-focused docs workflow\./);
});

test("subflow extension keeps the visible Pi tool call card empty because statusline shows progress", () => {
	const pi = fakePi();
	registerPiSubflowExtension(pi);

	const rendered = pi.tool.renderCall({ tasks: [{ name: "one", agent: "worker", task: "one" }], timeoutSeconds: 120 }, { expanded: true, isPartial: false }, fakeTheme(), fakeRenderContext()).render(80).join("\n");

	assert.equal(rendered, "");
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

test("workflow prompt stub discovery leaves manual prompt files intact when no workflows exist", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const promptDir = join(cwd, ".pi", "subflow", "prompts");
	await mkdir(promptDir, { recursive: true });
	await writeFile(join(promptDir, "manual.md"), "# Manual prompt\n", "utf8");
	const pi = fakePi();
	registerPiSubflowExtension(pi);

	const discoverResults = await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, fakeCtx(cwd));

	assert.deepEqual(discoverResults, [{}]);
	assert.equal(await readFile(join(promptDir, "manual.md"), "utf8"), "# Manual prompt\n");
});

test("workflow prompt stub discovery preserves manual prompt files that share workflow command names", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	const promptDir = join(cwd, ".pi", "subflow", "prompts");
	await mkdir(workflowsDir, { recursive: true });
	await mkdir(promptDir, { recursive: true });
	await writeFile(join(workflowsDir, "code-review.yaml"), "review:\n  agent: reviewer\n  task: Review code\n", "utf8");
	await writeFile(join(promptDir, "code-review.md"), "# Manual prompt\n", "utf8");
	const pi = fakePi();
	registerPiSubflowExtension(pi);

	const discoverResults = await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, fakeCtx(cwd));

	assert.deepEqual(discoverResults, [{ promptPaths: [promptDir] }]);
	assert.equal(await readFile(join(promptDir, "code-review.md"), "utf8"), "# Manual prompt\n");
});

test("workflow slash command expands nested workflow.uses with a workflow-relative include", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await mkdir(join(workflowsDir, "patterns"), { recursive: true });
	await writeFile(
		join(workflowsDir, "patterns", "api-tasks.yaml"),
		`api:
  agent: reviewer
  task: Review APIs
ui:
  agent: reviewer
  task: Review UI flows
`,
		"utf8",
	);
	await writeFile(
		join(workflowsDir, "review.yaml"),
		`review:
  workflow:
    uses: ./patterns/api-tasks.yaml
`,
		"utf8",
	);

	const runnerCalls: RunnerInput[] = [];
	const runner: SubagentRunner = {
		async run(input) {
			runnerCalls.push(input);
			return { name: input.name, agent: input.agent, task: input.task, role: input.role, model: input.model, dependsOn: input.dependsOn, status: "completed", output: `ran ${input.name}`, usage: {} };
		},
	};
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, fakeCtx(cwd));
	await pi.emit("session_start", {}, fakeCtx(cwd));

	await pi.commands.get("review").handler("", fakeCtx(cwd));

	assert.deepEqual(runnerCalls.map((call) => call.name), ["review.api", "review.ui"]);
	assert.equal(runnerCalls[0].task, "Review APIs");
	assert.equal(runnerCalls[1].task, "Review UI flows");
});

test("workflow.uses cannot mix with workflow.tasks or workflow.dagYaml in command YAML", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(
		join(workflowsDir, "review.yaml"),
		`review:
  workflow:
    uses: ./api-tasks.yaml
    tasks:
      api:
        agent: reviewer
        task: Review APIs
`,
		"utf8",
	);

	const pi = fakePi();
	registerPiSubflowExtension(pi);
	await pi.emit("session_start", {}, fakeCtx(cwd));

	await assert.rejects(() => pi.commands.get("review").handler("", fakeCtx(cwd)), /workflow cannot set uses with dagYaml or tasks/);
});

test("missing workflow.uses include fails deterministically", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(
		join(workflowsDir, "review.yaml"),
		`review:
  workflow:
    uses: ./missing.yaml
`,
		"utf8",
	);

	const pi = fakePi();
	registerPiSubflowExtension(pi);
	await pi.emit("session_start", {}, fakeCtx(cwd));

	await assert.rejects(() => pi.commands.get("review").handler("", fakeCtx(cwd)), /failed to read workflow\.uses include \.\/missing\.yaml/);
});

test("workflow.uses include cycles fail deterministically", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(
		join(workflowsDir, "review.yaml"),
		`review:
  workflow:
    uses: ./cycle.yaml
`,
		"utf8",
	);
	await writeFile(
		join(workflowsDir, "cycle.yaml"),
		`again:
  workflow:
    uses: ./review.yaml
`,
		"utf8",
	);

	const pi = fakePi();
	registerPiSubflowExtension(pi);
	await pi.emit("session_start", {}, fakeCtx(cwd));

	await assert.rejects(() => pi.commands.get("review").handler("", fakeCtx(cwd)), /workflow\.uses cycle detected/);
});

test("subflow extension registers repo-local workflow YAML files as slash commands", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(join(workflowsDir, "code-review.yaml"), `
api-review:
  agent: reviewer
  task: Review APIs

final-verdict:
  agent: reviewer
  role: verifier
  needs: [api-review]
  task: Synthesize findings
`);
	await writeFile(join(workflowsDir, "notes.txt"), "not a workflow");
	const runnerCalls: RunnerInput[] = [];
	const runner: SubagentRunner = {
		async run(input) {
			runnerCalls.push(input);
			const output = input.name === "final-verdict" ? "## Required fixes\n\nNone.\n\n## Optional polish\n\nClarify examples." : `ran ${input.agent}: ${input.task}`;
			return { name: input.name, agent: input.agent, task: input.task, role: input.role, model: input.model, dependsOn: input.dependsOn, status: "completed", output, usage: {} };
		},
	};
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	const discoverCtx = fakeCtx(cwd);
	const discoverResults = await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, discoverCtx);
	assert.deepEqual(discoverResults, [{ promptPaths: [join(cwd, ".pi", "subflow", "prompts")] }]);
	const promptStub = await readFile(join(cwd, ".pi", "subflow", "prompts", "code-review.md"), "utf8");
	assert.match(promptStub, /description: Run \.pi\/subflow\/workflows\/code-review\.yaml as a pi-subflow DAG/);
	assert.match(promptStub, /^\/code-review \$ARGUMENTS$/m);
	assert.deepEqual(discoverCtx.widgets, []);

	const startupCtx = fakeCtx(cwd);
	await pi.emit("session_start", {}, startupCtx);
	assert(pi.commands.has("code-review"));
	assert.equal(pi.commands.has("notes"), false);
	assert.deepEqual(startupCtx.widgets, []);
	assert.deepEqual(startupCtx.notifications, []);

	const ctx = fakeCtx(cwd, [{ type: "custom_message", customType: "pi-subflow.workflow-result", content: [{ type: "text", text: "Previous docs consistency result" }, { type: "ignored", value: 1 }], display: true }]);
	await pi.commands.get("code-review").handler("Investigate auth regression", ctx);

	assert.deepEqual(runnerCalls.map((call) => call.name), ["api-review", "final-verdict"]);
	assert.match(runnerCalls[0].task, /Workflow command arguments:\nInvestigate auth regression/);
	assert.match(runnerCalls[1].task, /Workflow command arguments:\nInvestigate auth regression/);
	assert.match(runnerCalls[0].task, /Recent conversation context:/);
	assert.match(runnerCalls[0].task, /Previous docs consistency result/);
	assert.deepEqual(runnerCalls[1].dependsOn, ["api-review"]);
	assert.deepEqual(ctx.editors, []);
	assert.deepEqual(ctx.notifications, ["Workflow /code-review completed"]);
	assert.equal(pi.messages.length, 1);
	assert.equal(pi.messages[0].message.customType, "pi-subflow.workflow-result");
	assert.equal(pi.messages[0].options?.deliverAs, "followUp");
	assert.equal(pi.messages[0].options?.triggerTurn, false);
	assert.match(pi.messages[0].message.content, /Workflow \/code-review completed/);
	assert.match(pi.messages[0].message.content, /subflow · dag · completed/);
	assert.match(pi.messages[0].message.content, /## Required fixes\n\nNone\./);
	assert.match(pi.messages[0].message.content, /## Optional polish\n\nClarify examples\./);
	const history = await readFile(join(cwd, ".pi", "subflow", "runs.jsonl"), "utf8");
	assert.match(history, /"mode":"dag"/);
});

test("workflow slash command runs without UI and skips project-agent confirmation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(join(workflowsDir, "code-review.yaml"), "review:\n  agent: reviewer\n  task: Review code\n", "utf8");
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });
	await pi.emit("session_start", {}, fakeCtx(cwd));
	const ctx = fakeCtx(cwd);
	ctx.hasUI = false;
	await pi.commands.get("code-review").handler("noop", ctx);
	assert.equal(runner.calls.length, 1);
	assert.deepEqual(ctx.confirmations, []);
	assert.deepEqual(ctx.notifications, ["Workflow /code-review completed"]);
});

test("user subflow workflows are discovered from the pi agent subflow directory", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const userSubflowDir = await mkdtemp(join(tmpdir(), "pi-subflow-user-"));
	const workflowsDir = join(userSubflowDir, "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(join(workflowsDir, "global-review.yaml"), "global:\n  agent: reviewer\n  task: Review globally\n", "utf8");
	const runnerCalls: RunnerInput[] = [];
	const runner: SubagentRunner = {
		async run(input) {
			runnerCalls.push(input);
			return { name: input.name, agent: input.agent, task: input.task, role: input.role, model: input.model, dependsOn: input.dependsOn, status: "completed", output: `ran ${input.name}`, usage: {} };
		},
	};
	const pi = fakePi();
	registerPiSubflowExtension(pi, { userSubflowDir, runnerFactory: () => runner });

	const discoverResults = await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, fakeCtx(cwd));
	assert.deepEqual(discoverResults, [{ promptPaths: [join(userSubflowDir, "prompts")] }]);
	assert.match(await readFile(join(userSubflowDir, "prompts", "global-review.md"), "utf8"), /description: Run ~\/\.pi\/agent\/subflow\/workflows\/global-review\.yaml as a pi-subflow DAG/);

	await pi.emit("session_start", {}, fakeCtx(cwd));
	assert(pi.commands.has("global-review"));
	await pi.commands.get("global-review").handler("", fakeCtx(cwd));
	assert.deepEqual(runnerCalls.map((call) => call.name), ["global"]);
});

test("project and user subflow workflows both return prompt paths when command names differ", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const userSubflowDir = await mkdtemp(join(tmpdir(), "pi-subflow-user-"));
	await mkdir(join(cwd, ".pi", "subflow", "workflows"), { recursive: true });
	await mkdir(join(userSubflowDir, "workflows"), { recursive: true });
	await writeFile(join(cwd, ".pi", "subflow", "workflows", "project-only.yaml"), "project-task:\n  agent: reviewer\n  task: From project\n", "utf8");
	await writeFile(join(userSubflowDir, "workflows", "user-only.yaml"), "user-task:\n  agent: reviewer\n  task: From user\n", "utf8");
	const pi = fakePi();
	registerPiSubflowExtension(pi, { userSubflowDir });

	const discoverResults = await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, fakeCtx(cwd));

	assert.deepEqual(discoverResults, [{ promptPaths: [join(cwd, ".pi", "subflow", "prompts"), join(userSubflowDir, "prompts")] }]);
	assert.match(await readFile(join(cwd, ".pi", "subflow", "prompts", "project-only.md"), "utf8"), /project-only/);
	assert.match(await readFile(join(userSubflowDir, "prompts", "user-only.md"), "utf8"), /user-only/);
});

test("project subflow workflows override user workflows with the same command name", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const userSubflowDir = await mkdtemp(join(tmpdir(), "pi-subflow-user-"));
	await mkdir(join(cwd, ".pi", "subflow", "workflows"), { recursive: true });
	await mkdir(join(userSubflowDir, "workflows"), { recursive: true });
	await writeFile(join(userSubflowDir, "workflows", "same.yaml"), "user-task:\n  agent: reviewer\n  task: From user\n", "utf8");
	await writeFile(join(cwd, ".pi", "subflow", "workflows", "same.yaml"), "project-task:\n  agent: reviewer\n  task: From project\n", "utf8");
	const runnerCalls: RunnerInput[] = [];
	const runner: SubagentRunner = {
		async run(input) {
			runnerCalls.push(input);
			return { name: input.name, agent: input.agent, task: input.task, role: input.role, model: input.model, dependsOn: input.dependsOn, status: "completed", output: `ran ${input.name}`, usage: {} };
		},
	};
	const pi = fakePi();
	registerPiSubflowExtension(pi, { userSubflowDir, runnerFactory: () => runner });

	const discoverResults = await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, fakeCtx(cwd));
	assert.deepEqual(discoverResults, [{ promptPaths: [join(cwd, ".pi", "subflow", "prompts"), join(userSubflowDir, "prompts")] }]);
	assert.match(await readFile(join(userSubflowDir, "prompts", "same.md"), "utf8"), /~\/\.pi\/agent\/subflow\/workflows\/same\.yaml/);
	await pi.emit("session_start", {}, fakeCtx(cwd));
	await pi.commands.get("same").handler("", fakeCtx(cwd));

	assert.deepEqual(runnerCalls.map((call) => call.name), ["project-task"]);
});

test("workflow prompt stub discovery removes stale generated stubs after deleting the last workflow", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	const promptDir = join(cwd, ".pi", "subflow", "prompts");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(join(workflowsDir, "temporary.yaml"), "temporary:\n  agent: reviewer\n  task: Temporary\n", "utf8");
	const pi = fakePi();
	registerPiSubflowExtension(pi);
	await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "startup" }, fakeCtx(cwd));
	assert.match(await readFile(join(promptDir, "temporary.md"), "utf8"), /temporary/);

	await rm(join(workflowsDir, "temporary.yaml"));
	const discoverResults = await pi.emit("resources_discover", { type: "resources_discover", cwd, reason: "reload" }, fakeCtx(cwd));

	assert.deepEqual(discoverResults, [{}]);
	await assert.rejects(() => readFile(join(promptDir, "temporary.md"), "utf8"), /ENOENT/);
});

test("workflow slash command registration refreshes when a command stem switches yaml filenames", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(join(workflowsDir, "same.yaml"), "first:\n  agent: reviewer\n  task: From yaml\n", "utf8");
	const runnerCalls: RunnerInput[] = [];
	const runner: SubagentRunner = {
		async run(input) {
			runnerCalls.push(input);
			return { name: input.name, agent: input.agent, task: input.task, role: input.role, model: input.model, dependsOn: input.dependsOn, status: "completed", output: `ran ${input.name}`, usage: {} };
		},
	};
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });

	await pi.emit("session_start", {}, fakeCtx(cwd));
	await rm(join(workflowsDir, "same.yaml"));
	await writeFile(join(workflowsDir, "same.yml"), "second:\n  agent: reviewer\n  task: From yml\n", "utf8");
	await pi.emit("session_start", {}, fakeCtx(cwd));
	await pi.commands.get("same").handler("", fakeCtx(cwd));

	assert.deepEqual(runnerCalls.map((call) => call.name), ["second"]);
	assert.match(runnerCalls[0].task, /From yml/);
});

test("repo-local workflow slash commands reject cwd values outside the project", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-ext-"));
	const workflowsDir = join(cwd, ".pi", "subflow", "workflows");
	await mkdir(workflowsDir, { recursive: true });
	await writeFile(join(workflowsDir, "unsafe.yaml"), `
unsafe:
  agent: reviewer
  cwd: /tmp
  task: Do work elsewhere
`);
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });
	await pi.emit("session_start", {}, fakeCtx(cwd));

	await assert.rejects(
		() => pi.commands.get("unsafe").handler("", fakeCtx(cwd)),
		/workflow command task unsafe cwd must stay inside the project/,
	);
	assert.equal(runner.calls.length, 0);
});

test("subflow extension does not register the experimental /subflow-runs UI", () => {
	const pi = fakePi();
	registerPiSubflowExtension(pi);

	assert.equal(pi.commands.has("subflow-runs"), false);
});

test("subflow_optimize runs a baseline dry-run and writes a report", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-opt-tool-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });
	const tool = pi.tools.get("subflow_optimize");
	assert(tool);

	const result = await tool.execute("call-1", {
		dagYaml: "review:\n  agent: worker\n  task: Review docs\n",
		evalSet: {
			inline: {
				name: "inline-docs",
				objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0 },
				scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 },
				cases: [{ name: "one", input: "Check docs" }],
			},
		},
	}, undefined, undefined, fakeCtx(cwd));

	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /subflow_optimize dry-run report/);
	assert.match(result.content[0].text, /Report artifact: .*\.pi\/subflow\/optimizer-reports\/opt-[a-z0-9-]+\.json/);
	const match = result.content[0].text.match(/Report artifact: (.*\.json)$/m);
	assert(match);
	assert.match(await readFile(match[1], "utf8"), /"evalSetName": "inline-docs"/);
	assert.equal(runner.calls.length, 1);
});

test("subflow_optimize reports disallowed candidate tools without aborting baseline", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-opt-tool-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { allowedTools: ["read"], runnerFactory: () => runner });
	const tool = pi.tools.get("subflow_optimize");
	assert(tool);

	const result = await tool.execute("call-1", {
		dagYaml: "review:\n  agent: worker\n  task: Review docs\n",
		candidateDagYamls: ["review:\n  agent: worker\n  tools: [write]\n  task: Review docs\n"],
		evalSet: {
			inline: {
				name: "inline-docs",
				objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0 },
				scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 },
				cases: [{ name: "one", input: "Check docs" }],
			},
		},
	}, undefined, undefined, fakeCtx(cwd));

	assert.equal(result.isError, false);
	assert.match(result.content[0].text, /Candidate 1 invalid \(unknown or unavailable tool: write\)/);
	assert.equal(runner.calls.length, 1);
});

test("subflow_optimize discovers project agents when agentScope is both", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-opt-tool-"));
	const userDir = join(cwd, "user-agents");
	await writeFile(join(await mkdirp(userDir), "worker.md"), "---\nname: worker\ndescription: User worker\n---\nUse tests.\n");
	const projectDir = join(cwd, ".pi", "agents");
	await writeFile(join(await mkdirp(projectDir), "project-reviewer.md"), "---\nname: project-reviewer\ndescription: Project-only reviewer\n---\nReview.\n");

	const captured: { names: string[]; sources: string[] } = { names: [], sources: [] };
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, {
		userDir,
		projectDir,
		runnerFactory: ({ agents }) => {
			const list = Array.from(agents.values());
			captured.names = list.map((agent) => agent.name);
			captured.sources = list.map((agent) => agent.source);
			return runner;
		},
	});
	const tool = pi.tools.get("subflow_optimize");
	assert(tool);

	await tool.execute("call-1", {
		agentScope: "both",
		dagYaml: "review:\n  agent: project-reviewer\n  task: Review docs\n",
		evalSet: {
			inline: {
				name: "inline-docs",
				objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0 },
				scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 },
				cases: [{ name: "one", input: "Check docs" }],
			},
		},
	}, undefined, undefined, fakeCtx(cwd));

	assert(captured.names.includes("worker"), `expected worker in ${captured.names.join(",")}`);
	assert(captured.names.includes("project-reviewer"), `expected project-reviewer in ${captured.names.join(",")}`);
	assert(captured.sources.includes("project"));
});

test("subflow_optimize rejects scorer tools outside the allowlist before any run", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-opt-tool-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { allowedTools: ["read"], runnerFactory: () => runner });
	const tool = pi.tools.get("subflow_optimize");
	assert(tool);

	await assert.rejects(
		() => tool.execute("call-1", {
			dagYaml: "review:\n  agent: worker\n  task: Review docs\n",
			evalSet: {
				inline: {
					name: "inline-docs",
					objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0 },
					scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 },
					cases: [{
						name: "one",
						input: "Check docs",
						scorer: { type: "judge", agent: "worker", tools: ["write"], rubric: [{ name: "x", description: "y", weight: 1 }] },
					}],
				},
			},
		}, undefined, undefined, fakeCtx(cwd)),
		/unknown or unavailable tool: write/,
	);
	assert.equal(runner.calls.length, 0);
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
	const state: { tool?: any; tools: Map<string, any>; commands: Map<string, any>; handlers: Map<string, any[]>; messages: Array<{ message: any; options: any }> } = { tools: new Map(), commands: new Map(), handlers: new Map(), messages: [] };
	return Object.assign(state, {
		registerTool(tool: any) {
			state.tools.set(tool.name, tool);
			if (tool.name === "subflow") state.tool = tool;
		},
		registerCommand(name: string, command: any) {
			state.commands.set(name, command);
		},
		sendMessage(message: any, options: any) {
			state.messages.push({ message, options });
		},
		on(event: string, handler: any) {
			const handlers = state.handlers.get(event) ?? [];
			handlers.push(handler);
			state.handlers.set(event, handlers);
		},
		async emit(event: string, payload: unknown, ctx: unknown) {
			const results = [];
			for (const handler of state.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
			return results;
		},
	});
}

function fakeCtx(cwd: string, branchEntries: any[] = []) {
	const confirmations: string[] = [];
	const widgets: Array<{ key: string; value: unknown }> = [];
	const customCalls: Array<{ component: any; options: unknown; renderRequests: number; closed: boolean }> = [];
	const editors: Array<{ title: string; prefill?: string }> = [];
	const notifications: string[] = [];
	return {
		cwd,
		sessionManager: { getBranch: () => branchEntries },
		hasUI: true,
		signal: undefined,
		confirmations,
		widgets,
		customCalls,
		editors,
		notifications,
		ui: {
			confirm: async (title: string, message: string) => {
				confirmations.push(`${title}: ${message}`);
				return true;
			},
			notify: (message: string) => {
				notifications.push(message);
			},
			setWidget: (key: string, value: unknown) => {
				widgets.push({ key, value });
			},
			custom: async (factory: any, options: unknown) => {
				let resolved = false;
				const call = { component: undefined as any, options, renderRequests: 0, closed: false };
				const component = factory({ requestRender: () => { call.renderRequests += 1; } }, { fg: (_name: string, text: string) => text, bold: (text: string) => text }, {}, () => { resolved = true; call.closed = true; });
				call.component = component;
				customCalls.push(call);
				return resolved ? undefined : undefined;
			},
			editor: async (title: string, prefill?: string) => {
				editors.push({ title, prefill });
				return prefill;
			},
		},
	};
}
