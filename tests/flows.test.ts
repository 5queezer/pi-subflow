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

test("runChain emits pocketflow_node phases", async () => {
	const runner = new MockSubagentRunner({ mock: async ({ task }) => `out(${task})` });

	const result = await runChain(
		{ chain: [{ agent: "mock", task: "one" }, { agent: "mock", task: "two" }] },
		{ runner },
	);

	assert.deepEqual(
		result.trace.filter((event) => event.type === "pocketflow_node").map((event) => event.name),
		["prepare-chain", "run-chain", "aggregate-chain-result"],
	);
	assert.equal(result.status, "completed");
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

test("runParallel emits pocketflow_node phases and preserves bounded concurrency", async () => {
	let running = 0;
	let maxRunning = 0;
	const runner = new MockSubagentRunner({
		mock: async () => {
			running += 1;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((resolve) => setTimeout(resolve, 12));
			running -= 1;
			return "ok";
		},
	});

	const result = await runParallel(
		{ tasks: [task("a", "a"), task("b", "b"), task("c", "c"), task("d", "d")] },
		{ runner, maxConcurrency: 2 },
	);

	assert.equal(maxRunning, 2);
	assert.deepEqual(
		result.trace.filter((event) => event.type === "pocketflow_node").map((event) => event.name),
		["prepare-parallel", "run-parallel", "enforce-parallel-budget", "aggregate-parallel-result"],
	);
	assert.equal(result.status, "completed");
	assert.equal(result.results.length, 4);
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


test("runDag executes through PocketFlow DAG node phases", async () => {
	const runner = new MockSubagentRunner({
		planner: async () => "plan",
		reviewer: async () => "review",
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "plan", agent: "planner", task: "plan" },
				{ name: "review", agent: "reviewer", task: "review", dependsOn: ["plan"] },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(
		result.trace.filter((event) => event.type === "pocketflow_node").map((event) => event.name),
		[
			"validate-dag",
			"max-turns-guard",
			"execute-dag-stages",
			"verifier-repair",
			"aggregate-dag-result",
		],
	);
});

test("runDag expands nested workflow tasks with namespaced names", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name, task }) => `done:${name}:${task}`,
	});

	const result = await runDag(
		{
			tasks: [
				{
					name: "review",
					workflow: {
						tasks: [
							{ name: "api", agent: "mock", task: "review api" },
						],
					},
				},
			],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(runner.calls.map((call) => call.name), ["review.api"]);
	assert.deepEqual(result.results.map((item) => item.name), ["review.api", "review"]);
	assert.match(result.results[1].output, /done:review.api:review api/);
});

test("runDag flows parent dependencies into first nested tasks and exposes a summary for downstream dependents", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name, task }) => `done:${name}:${task}`,
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "prep", agent: "mock", task: "prep" },
				{
					name: "review",
					dependsOn: ["prep"],
					workflow: {
						tasks: [
							{ name: "api", agent: "mock", task: "review api" },
						],
					},
				},
				{ name: "publish", agent: "mock", role: "verifier", dependsOn: ["review"], task: "publish" },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(runner.calls.map((call) => ({ name: call.name, dependsOn: call.dependsOn })), [
		{ name: "prep", dependsOn: [] },
		{ name: "review.api", dependsOn: ["prep"] },
		{ name: "publish", dependsOn: ["review"] },
	]);
	assert.match(result.results.find((item) => item.name === "review")?.output ?? "", /done:review\.api:review api/);
	assert.match(runner.calls[2].task, /### review/);
	assert.match(runner.calls[2].task, /done:review\.api:review api/);
});


test("runDag evaluates when expressions inside nested workflow children against namespaced dependencies", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name.endsWith(".triage") ? JSON.stringify({ score: 0.9 }) : "ran",
	});

	const result = await runDag(
		{
			tasks: [{
				name: "review",
				workflow: {
					tasks: {
						triage: { agent: "mock", task: "triage" },
						analyze: { agent: "mock", dependsOn: ["triage"], when: "${triage.output.score} > 0.7", task: "analyze" },
					},
				},
			}],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.equal(result.results.find((item) => item.name === "review.analyze")?.status, "completed");
	assert.deepEqual(runner.calls.map((call) => call.name), ["review.triage", "review.analyze"]);
});

test("runDag executes bounded loops until the until expression becomes true", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name.endsWith(".editor") ? JSON.stringify({ continue: false }) : "research",
	});

	const result = await runDag(
		{
			tasks: [{
				name: "research-loop",
				loop: {
					maxIterations: 3,
					body: {
						researcher: { agent: "mock", task: "research" },
						editor: { agent: "mock", dependsOn: ["researcher"], task: "edit" },
					},
					until: "${editor.output.continue} == false",
				},
			}],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(runner.calls.map((call) => call.name), ["research-loop.1.researcher", "research-loop.1.editor"]);
	assert.match(result.results.find((item) => item.name === "research-loop")?.output ?? "", /"iterationsCompleted":1/);
});

test("runDag repeats bounded loops to maxIterations when until stays false", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name.endsWith(".editor") ? JSON.stringify({ continue: true }) : "research",
	});

	const result = await runDag(
		{
			tasks: [{
				name: "research-loop",
				loop: {
					maxIterations: 3,
					body: {
						researcher: { agent: "mock", task: "research" },
						editor: { agent: "mock", dependsOn: ["researcher"], task: "edit" },
					},
					until: "${editor.output.continue} == false",
				},
			}],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(runner.calls.map((call) => call.name), [
		"research-loop.1.researcher",
		"research-loop.1.editor",
		"research-loop.2.researcher",
		"research-loop.2.editor",
		"research-loop.3.researcher",
		"research-loop.3.editor",
	]);
	assert.deepEqual(runner.calls[2].dependsOn, ["research-loop.1.editor"]);
	assert.match(result.results.find((item) => item.name === "research-loop")?.output ?? "", /"iterationsCompleted":3/);
});



test("runDag allows condition-skipped tasks inside bounded loop bodies", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name.endsWith(".researcher") ? JSON.stringify({ runAnalysis: false }) : "analysis",
	});

	const result = await runDag(
		{
			tasks: [{
				name: "research-loop",
				loop: {
					maxIterations: 1,
					body: {
						researcher: { agent: "mock", task: "research" },
						analysis: { agent: "mock", dependsOn: ["researcher"], when: "${researcher.output.runAnalysis} == true", task: "analysis" },
					},
				},
			}],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.equal(result.results.find((item) => item.name === "research-loop.1.analysis")?.status, "skipped");
	assert.match(result.results.find((item) => item.name === "research-loop")?.output ?? "", /"status":"completed"/);
	assert.equal(runner.calls.length, 1);
});


test("runDag isolates concurrent bounded loop iteration results", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => {
			if (name === "loop-a.1.first") await new Promise((resolve) => setTimeout(resolve, 5));
			return JSON.stringify({ runNext: name !== "loop-b.1.first" });
		},
	});

	const result = await runDag(
		{
			tasks: ["loop-a", "loop-b"].map((name) => ({
				name,
				loop: {
					maxIterations: 1,
					body: {
						first: { agent: "mock", task: "first" },
						second: { agent: "mock", dependsOn: ["first"], when: "${first.output.runNext} == true", task: "second" },
					},
				},
			})),
		},
		{ runner, maxConcurrency: 2 },
	);

	assert.equal(result.status, "completed");
	assert.equal(result.results.find((item) => item.name === "loop-b.1.second")?.status, "skipped");
	assert.match(result.results.find((item) => item.name === "loop-a")?.output ?? "", /"status":"completed"/);
	assert.match(result.results.find((item) => item.name === "loop-b")?.output ?? "", /"status":"completed"/);
});

test("runDag fails a bounded loop when a body dependency fails and a downstream body task is skipped", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => {
			if (name.endsWith(".researcher")) throw new Error("research failed");
			return JSON.stringify({ continue: false });
		},
	});

	const result = await runDag(
		{
			tasks: [{
				name: "research-loop",
				loop: {
					maxIterations: 3,
					body: {
						researcher: { agent: "mock", task: "research" },
						editor: { agent: "mock", dependsOn: ["researcher"], task: "edit" },
					},
					until: "${editor.output.continue} == false",
				},
			}],
		},
		{ runner },
	);

	assert.equal(result.status, "failed");
	assert.equal(result.results.find((item) => item.name === "research-loop.1.researcher")?.status, "failed");
	assert.equal(result.results.find((item) => item.name === "research-loop.1.editor")?.status, "skipped");
	assert.match(result.results.find((item) => item.name === "research-loop")?.output ?? "", /"status":"failed"/);
	assert.equal(runner.calls.length, 1);
});

test("runDag rejects missing or non-positive loop maxIterations before running", async () => {
	const runner = new MockSubagentRunner({ mock: async ({ task }) => `done:${task}` });

	await assert.rejects(
		runDag(
			{ tasks: [{ name: "loop", loop: { body: { editor: task("editor") } } }] },
			{ runner },
		),
		/maxIterations must be a positive integer/,
	);
	await assert.rejects(
		runDag(
			{ tasks: [{ name: "loop", loop: { maxIterations: 0, body: { editor: task("editor") } } }] },
			{ runner },
		),
		/maxIterations must be a positive integer/,
	);
	assert.equal(runner.calls.length, 0);
});



test("runDag rejects invalid loop bodies and until references before running", async () => {
	const runner = new MockSubagentRunner({ mock: async ({ task }) => `done:${task}` });

	await assert.rejects(
		runDag(
			{ tasks: [{ name: "loop", loop: { maxIterations: 1, body: {}, until: "${editor.output.continue} == false" } }] },
			{ runner },
		),
		/loop requires body tasks/,
	);
	await assert.rejects(
		runDag(
			{ tasks: [{ name: "loop", loop: { maxIterations: 1, body: { editor: task("editor") }, until: "${missing.output.continue} == false" } }] },
			{ runner },
		),
		/loop until references missing body task missing/,
	);
	await assert.rejects(
		runDag(
			{ tasks: [{ name: "loop", loop: { maxIterations: 101, body: { editor: task("editor") } } }] },
			{ runner },
		),
		/loop maxIterations must be at most 100/,
	);
	assert.equal(runner.calls.length, 0);
});

test("runDag exposes bounded loop summary to downstream dependents", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name === "publish" ? "published" : JSON.stringify({ continue: false }),
	});

	const result = await runDag(
		{
			tasks: [
				{
					name: "research-loop",
					loop: {
						maxIterations: 2,
						body: { editor: { agent: "mock", task: "edit" } },
						until: "${editor.output.continue} == false",
					},
				},
				{ name: "publish", agent: "mock", role: "verifier", dependsOn: ["research-loop"], task: "publish" },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.equal(runner.calls.find((call) => call.name === "publish")?.dependsOn?.[0], "research-loop");
	assert.match(runner.calls.find((call) => call.name === "publish")?.task ?? "", /### research-loop/);
	assert.match(runner.calls.find((call) => call.name === "publish")?.task ?? "", /"iterationsCompleted":1/);
});

test("runDag scopes verifier fan-in to nested workflow siblings", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name, task }) => `done:${name}:${task}`,
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "outside", agent: "mock", task: "outside" },
				{
					name: "review",
					workflow: {
						tasks: [
							{ name: "api", agent: "mock", task: "api" },
							{ name: "verify", agent: "mock", role: "verifier", task: "verify" },
						],
					},
				},
			],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.deepEqual(runner.calls.find((call) => call.name === "review.verify")?.dependsOn, ["review.api"]);
	assert.match(runner.calls.find((call) => call.name === "review.verify")?.task ?? "", /### review\.api/);
	assert.doesNotMatch(runner.calls.find((call) => call.name === "review.verify")?.task ?? "", /### outside/);
});

test("runDag skips a task when its when condition is false", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name === "triage" ? JSON.stringify({ score: 0.2 }) : "ran",
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "triage", agent: "mock", task: "triage" },
				{ name: "analyze", agent: "mock", dependsOn: ["triage"], when: "${triage.output.score} > 0.7", task: "analyze" },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.equal(result.results[1].status, "skipped");
	assert.equal(result.results[1].error, "condition false: ${triage.output.score} > 0.7");
	assert.equal(runner.calls.length, 1);
});

test("runDag runs a task when its when condition is true", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name === "triage" ? JSON.stringify({ score: 0.9 }) : "ran",
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "triage", agent: "mock", task: "triage" },
				{ name: "analyze", agent: "mock", dependsOn: ["triage"], when: "${triage.output.score} > 0.7", task: "analyze" },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.equal(result.results[1].status, "completed");
	assert.equal(runner.calls.length, 2);
});

test("runDag fails validation when a when expression references a missing task", async () => {
	const runner = new MockSubagentRunner({
		mock: async () => "ran",
	});

	await assert.rejects(
		runDag(
			{
				tasks: [
					{ name: "triage", agent: "mock", task: "triage" },
					{ name: "analyze", agent: "mock", dependsOn: ["triage"], when: "${missing.output.score} > 0.7", task: "analyze" },
				],
			},
			{ runner },
		),
		/task analyze when references missing task missing/,
	);
	assert.equal(runner.calls.length, 0);
});

test("runDag fails validation when a when expression references a non-dependency", async () => {
	const runner = new MockSubagentRunner({ mock: async () => "ran" });

	await assert.rejects(
		runDag(
			{
				tasks: [
					{ name: "triage", agent: "mock", task: "triage" },
					{ name: "analyze", agent: "mock", when: "${triage.output.score} > 0.7", task: "analyze" },
				],
			},
			{ runner },
		),
		/task analyze when references task triage but does not depend on it/,
	);
	assert.equal(runner.calls.length, 0);
});

test("runDag fails a conditional task when dependency output is not JSON", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name === "triage" ? "not json" : "ran",
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "triage", agent: "mock", task: "triage" },
				{ name: "analyze", agent: "mock", dependsOn: ["triage"], when: "${triage.output.score} > 0.7", task: "analyze" },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "failed");
	assert.equal(result.results[1].status, "failed");
	assert.match(result.results[1].error ?? "", /condition failed: task triage output is not valid JSON/);
	assert.equal(runner.calls.length, 1);
});

test("runDag fails a conditional task when dependency output path is missing", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name === "triage" ? JSON.stringify({ other: 1 }) : "ran",
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "triage", agent: "mock", task: "triage" },
				{ name: "analyze", agent: "mock", dependsOn: ["triage"], when: "${triage.output.score} > 0.7", task: "analyze" },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "failed");
	assert.equal(result.results[1].status, "failed");
	assert.match(result.results[1].error ?? "", /condition failed: task triage output is missing path score/);
	assert.equal(runner.calls.length, 1);
});

test("runDag supports boolean logic, strings, parentheses, and negation in when expressions", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name === "triage" ? JSON.stringify({ pass: true, label: "go" }) : "ran",
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "triage", agent: "mock", task: "triage" },
				{ name: "analyze", agent: "mock", dependsOn: ["triage"], when: "(${triage.output.pass} == true && ${triage.output.label} == 'go') || !false", task: "analyze" },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "completed");
	assert.equal(result.results[1].status, "completed");
	assert.equal(runner.calls.length, 2);
});

test("runDag fails a conditional task when comparing non-primitive output", async () => {
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => name === "triage" ? JSON.stringify({ score: { nested: true } }) : "ran",
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "triage", agent: "mock", task: "triage" },
				{ name: "analyze", agent: "mock", dependsOn: ["triage"], when: "${triage.output.score} == true", task: "analyze" },
			],
		},
		{ runner },
	);

	assert.equal(result.status, "failed");
	assert.equal(result.results[1].status, "failed");
	assert.match(result.results[1].error ?? "", /comparison operands must be strings, numbers, or booleans/);
	assert.equal(runner.calls.length, 1);
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

test("validateDagTasks reports dependency cycles with a structured issue", () => {
	const result = validateDagTasks([{ ...task("a"), dependsOn: ["b"] }, { ...task("b"), dependsOn: ["a"] }]);

	assert.deepEqual(result.issues, [
		{
			code: "cycle",
			message: "dependency cycle: a -> b -> a",
			path: ["a", "b", "a"],
		},
	]);
});

test("planDagStages rejects duplicate task names when called directly", () => {
	assert.throws(
		() => planDagStages([{ ...task("dup"), dependsOn: [] }, { ...task("dup"), dependsOn: [] }]),
		/duplicate DAG task name: dup/,
	);
});

test("planDagStages rejects missing dependencies when called directly", () => {
	assert.throws(
		() => planDagStages([{ ...task("verify"), dependsOn: ["missing"] }]),
		/task verify depends on missing task missing/,
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
