import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	appendRunHistory,
	discoverAgents,
	MockSubagentRunner,
	runDag,
	validateExecutionPolicy,
} from "../src/index.js";

test("discoverAgents loads user and project agent markdown, with project overriding user", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-subflow-agents-"));
	const userDir = join(root, "user");
	const projectDir = join(root, "project");
	await writeFile(join(root, "placeholder"), "");
	await import("node:fs/promises").then((fs) => Promise.all([fs.mkdir(userDir), fs.mkdir(projectDir)]));
	await writeFile(join(userDir, "reviewer.md"), "---\nname: reviewer\ndescription: User reviewer\ntools: [read]\n---\nUser body\n");
	await writeFile(join(projectDir, "reviewer.md"), "---\nname: reviewer\ndescription: Project reviewer\nmodel: smart\n---\nProject body\n");
	await writeFile(join(projectDir, "worker.md"), "---\nname: worker\ndescription: Project worker\ntools:\n  - read\n  - bash\n---\nWorker body\n");

	const agents = await discoverAgents({ userDir, projectDir, scope: "both" });

	assert.equal(agents.size, 2);
	assert.equal(agents.get("reviewer")?.description, "Project reviewer");
	assert.equal(agents.get("reviewer")?.source, "project");
	assert.equal(agents.get("worker")?.body.trim(), "Worker body");
	assert.deepEqual(agents.get("worker")?.tools, ["read", "bash"]);
});

test("validateExecutionPolicy blocks project agents without confirmation and external side effects without high risk", () => {
	assert.throws(
		() => validateExecutionPolicy({ agentScope: "project", confirmProjectAgents: true, hasUI: false }),
		/project-local agents require confirmation/,
	);
	assert.throws(
		() => validateExecutionPolicy({ tasks: [{ name: "deploy", agent: "ops", task: "deploy", authority: "external_side_effect" }] }),
		/riskTolerance must be high/,
	);
	assert.doesNotThrow(() =>
		validateExecutionPolicy({
			riskTolerance: "high",
			allowExternalSideEffectWithoutConfirmation: true,
			tasks: [{ name: "deploy", agent: "ops", task: "deploy", authority: "external_side_effect" }],
		}),
	);
});

test("appendRunHistory writes jsonl entries for completed flow results", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-subflow-history-"));
	const historyPath = join(root, "runs.jsonl");
	await appendRunHistory(historyPath, {
		mode: "single",
		status: "completed",
		output: "ok",
		results: [{ name: "a", agent: "mock", task: "work", status: "completed", output: "ok", usage: {} }],
		trace: [],
	});

	const line = (await readFile(historyPath, "utf8")).trim();
	const parsed = JSON.parse(line);
	assert.equal(parsed.mode, "single");
	assert.equal(parsed.status, "completed");
	assert.equal(parsed.results[0].name, "a");
});

test("runDag can repair a failed verifier and rerun verification with repair output context", async () => {
	let verifierAttempts = 0;
	const runner = new MockSubagentRunner({
		mock: async ({ name, task }) => {
			if (name === "verify") {
				verifierAttempts += 1;
				if (verifierAttempts === 1) throw new Error("missing evidence");
				assert.match(task, /repair completed/);
				return `verified after repair: ${task}`;
			}
			if (name?.startsWith("repair-")) return "repair completed";
			return "worker output";
		},
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "worker", agent: "mock", task: "produce" },
				{ name: "verify", agent: "mock", role: "verifier", task: "verify" },
			],
		},
		{ runner, maxVerificationRounds: 1 },
	);

	assert.equal(result.status, "completed");
	assert.equal(verifierAttempts, 2);
	assert.ok(result.results.some((entry) => entry.name === "repair-verify-1"));
});

test("runDag ignores superseded failed repair attempts when a later verifier succeeds", async () => {
	let repairAttempts = 0;
	let verifierAttempts = 0;
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => {
			if (name === "verify") {
				verifierAttempts += 1;
				if (verifierAttempts < 2) throw new Error("verify failed");
				return "verified";
			}
			if (name === "repair-verify-1") {
				repairAttempts += 1;
				throw new Error("repair failed");
			}
			if (name === "repair-verify-2") {
				repairAttempts += 1;
				return "repair completed";
			}
			return "worker output";
		},
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "worker", agent: "mock", task: "produce" },
				{ name: "verify", agent: "mock", role: "verifier", task: "verify" },
			],
		},
		{ runner, maxVerificationRounds: 2 },
	);

	assert.equal(result.status, "completed");
	assert.equal(repairAttempts, 2);
	assert.ok(result.results.some((entry) => entry.name === "repair-verify-1" && entry.status === "failed"));
});
