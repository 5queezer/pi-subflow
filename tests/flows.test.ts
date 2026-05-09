import assert from "node:assert/strict";
import { test } from "node:test";
import {
	MockSubagentRunner,
	runChain,
	runDag,
	runParallel,
	runSingle,
} from "../src/index.js";
import { planDagStages, validateDagTasks } from "../src/flows/dag-validation.js";
import type { RunnerInput, SubagentResult, SubagentRunner } from "../src/index.js";

const task = (name: string, taskText = name) => ({
	name,
	agent: "mock",
	task: taskText,
});

test("runSingle delegates one task through the runner", async () => {
	const runner = new MockSubagentRunner({ mock: async ({ task }) => `done:${task}` });

	const result = await runSingle({ agent: "mock", task: "inspect auth" }, { runner });

	assert.equal(result.status, "completed");
	assert.equal(result.output, "done:inspect auth");
	assert.equal(runner.calls.length, 1);
	assert.equal(runner.calls[0].agent, "mock");
});

test("runChain passes previous output into later {previous} placeholders", async () => {
	const runner = new MockSubagentRunner({ mock: async ({ task }) => `out(${task})` });

	const result = await runChain(
		{
			chain: [
				{ agent: "mock", task: "first" },
				{ agent: "mock", task: "second sees {previous}" },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.equal(result.results[1].task, "second sees out(first)");
	assert.equal(result.output, "out(second sees out(first))");
});

test("runParallel fans out tasks and marks partial failure as failed", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ task }) => {
			if (task === "bad") throw new Error("boom");
			return `ok:${task}`;
		},
	});

	const result = await runParallel(
		{ tasks: [task("a", "good"), task("b", "bad")] },
		{ runner, maxConcurrency: 2 },
	);

	assert.equal(result.status, "failed");
	assert.equal(result.results[0].status, "completed");
	assert.equal(result.results[1].status, "failed");
	assert.match(result.results[1].error ?? "", /boom/);
});

test("runDag executes dependencies before verifier and injects dependency outputs", async () => {
	const seen: string[] = [];
	const runner = new MockSubagentRunner({
		mock: async ({ task }) => {
			seen.push(task);
			return `result:${task}`;
		},
	});

	const result = await runDag(
		{
			tasks: [
				task("front", "frontend"),
				task("back", "backend"),
				{ name: "verify", agent: "mock", role: "verifier", task: "verify" },
			],
		},
		{ runner, maxConcurrency: 2 },
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(seen.slice(0, 2).sort(), ["backend", "frontend"]);
	assert.match(seen[2], /Dependency outputs/);
	assert.match(seen[2], /front/);
	assert.match(seen[2], /result:frontend/);
	assert.deepEqual(result.results[2].dependsOn, ["front", "back"]);
});

test("validateDagTasks normalizes verifier fan-in before execution", () => {
	const normalized = validateDagTasks([
		task("front", "frontend"),
		task("back", "backend"),
		{ name: "verify", agent: "mock", role: "verifier" as const, task: "verify" },
	]);

	assert.deepEqual(normalized.tasks.map((item) => ({ name: item.name, dependsOn: item.dependsOn })), [
		{ name: "front", dependsOn: [] },
		{ name: "back", dependsOn: [] },
		{ name: "verify", dependsOn: ["front", "back"] },
	]);
	assert.deepEqual(normalized.issues, []);
});

test("validateDagTasks reports duplicate task names", () => {
	const result = validateDagTasks([task("dup", "first"), task("dup", "second")]);

	assert.deepEqual(result.issues, [
		{
			code: "duplicate_name",
			message: "duplicate DAG task name: dup",
			task: "dup",
		},
	]);
});

test("runDag rejects duplicate task names before execution", async () => {
	const runner = new MockSubagentRunner({ mock: async ({ task }) => `done:${task}` });

	await assert.rejects(
		runDag(
			{ tasks: [task("dup", "first"), task("dup", "second")] },
			{ runner },
		),
		/duplicate DAG task name: dup/,
	);
	assert.equal(runner.calls.length, 0);
});

test("runDag rejects missing dependencies with the exact task and dependency", async () => {
	const runner = new MockSubagentRunner({ mock: async ({ task }) => `done:${task}` });

	await assert.rejects(
		runDag(
			{ tasks: [{ ...task("verify"), dependsOn: ["missing"] }] },
			{ runner },
		),
		/task verify depends on missing task missing/,
	);
	assert.equal(runner.calls.length, 0);
});

test("runDag rejects self-dependencies with the exact task name", async () => {
	const runner = new MockSubagentRunner({ mock: async ({ task }) => `done:${task}` });

	await assert.rejects(
		runDag(
			{ tasks: [{ ...task("loop"), dependsOn: ["loop"] }] },
			{ runner },
		),
		/task loop cannot depend on itself/,
	);
	assert.equal(runner.calls.length, 0);
});

test("runDag rejects dependency cycles with the cycle path", async () => {
	const runner = new MockSubagentRunner({ mock: async ({ task }) => `done:${task}` });

	await assert.rejects(
		runDag(
			{ tasks: [{ ...task("a"), dependsOn: ["b"] }, { ...task("b"), dependsOn: ["a"] }] },
			{ runner },
		),
		/dependency cycle: a -> b -> a/,
	);
	assert.equal(runner.calls.length, 0);
});

test("planDagStages rejects duplicate task names when called directly", () => {
	assert.throws(
		() => planDagStages([{ ...task("dup"), dependsOn: [] }, { ...task("dup"), dependsOn: [] }]),
		/duplicate DAG task name: dup/,
	);
});

test("planDagStages returns dependency stages for validated tasks", () => {
	const validation = validateDagTasks([
		task("front"),
		task("back"),
		{ ...task("verify"), dependsOn: ["front", "back"] },
	]);

	const stages = planDagStages(validation.tasks);

	assert.deepEqual(stages.map((stage) => stage.map((item) => item.name).sort()), [["back", "front"], ["verify"]]);
});

test("runDag validates expected markdown sections", async () => {
	const runner = new MockSubagentRunner({ mock: async () => "## Summary\nOnly summary" });

	const result = await runDag(
		{
			tasks: [
				{
					name: "review",
					agent: "mock",
					task: "review",
					expectedSections: ["Summary", "Evidence"],
				},
			],
		},
		{ runner },
	);

	assert.equal(result.status, "failed");
	assert.match(result.results[0].error ?? "", /missing expected section: Evidence/);
});

test("runSingle retries read-only failures up to maxRetries", async () => {
	let attempts = 0;
	const runner: SubagentRunner = {
		async run(input: RunnerInput): Promise<SubagentResult> {
			attempts += 1;
			if (attempts < 3) throw new Error("transient");
			return { name: input.name, agent: input.agent, task: input.task, status: "completed", output: "ok", usage: {} };
		},
	};

	const result = await runSingle({ agent: "mock", task: "inspect", authority: "read_only" }, { runner, maxRetries: 3 });

	assert.equal(result.status, "completed");
	assert.equal(attempts, 3);
});

test("runSingle does not retry mutating or external side-effect tasks", async () => {
	let attempts = 0;
	const runner: SubagentRunner = {
		async run(): Promise<SubagentResult> {
			attempts += 1;
			throw new Error("do not repeat");
		},
	};

	const result = await runSingle({ agent: "mock", task: "publish", authority: "external_side_effect" }, { runner, maxRetries: 3 });

	assert.equal(result.status, "failed");
	assert.equal(attempts, 1);
	assert.match(result.results[0].error ?? "", /do not repeat/);
});

test("runSingle aborts the active runner attempt when a task times out", async () => {
	let aborted = false;
	const runner: SubagentRunner = {
		async run(input: RunnerInput, signal?: AbortSignal): Promise<SubagentResult> {
			signal?.addEventListener("abort", () => {
				aborted = true;
			});
			return new Promise(() => undefined);
		},
	};

	const result = await runSingle({ agent: "mock", task: "slow" }, { runner, timeoutSeconds: 0.01 });

	assert.equal(result.status, "failed");
	assert.match(result.results[0].error ?? "", /timed out/);
	assert.equal(aborted, true);
});
