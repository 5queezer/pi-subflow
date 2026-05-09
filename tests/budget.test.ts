import assert from "node:assert/strict";
import { test } from "node:test";
import { MockSubagentRunner, runChain, runDag, runSingle } from "../src/index.js";

test("runSingle returns a failed result instead of throwing on budget failure", async () => {
	const runner = new MockSubagentRunner({ mock: async () => ({ output: "ok", usage: { cost: 2 } }) });

	const result = await runSingle({ agent: "mock", task: "work" }, { runner, maxCost: 1 });

	assert.equal(result.status, "failed");
	assert.match(result.results.at(-1)?.error ?? "", /exceeds maxCost/);
});

test("runChain returns a failed result instead of throwing on budget failure", async () => {
	const runner = new MockSubagentRunner({ mock: async () => ({ output: "ok", usage: { cost: 2 } }) });

	const result = await runChain({ chain: [{ agent: "mock", task: "work" }] }, { runner, maxCost: 1 });

	assert.equal(result.status, "failed");
	assert.match(result.results.at(-1)?.error ?? "", /exceeds maxCost/);
});

test("runDag rejects maxTurns smaller than the DAG task count before running agents", async () => {
	const runner = new MockSubagentRunner({ mock: async () => ({ output: "ok", usage: { turns: 1 } }) });

	await assert.rejects(
		runDag(
			{
				tasks: [
					{ name: "worker", agent: "mock", task: "work" },
					{ name: "verify", agent: "mock", role: "verifier", task: "verify", dependsOn: ["worker"] },
				],
			},
			{ runner, maxTurns: 1 },
		),
		/maxTurns 1 is too low for 2 DAG tasks/,
	);
	assert.equal(runner.calls.length, 0);
});

test("runDag does not run verifier repair after budget is exceeded", async () => {
	const calls: string[] = [];
	const runner = new MockSubagentRunner({
		mock: async ({ name }) => {
			calls.push(name);
			if (name === "verify") throw new Error("verification failed");
			return { output: "worker output", usage: { cost: 2 } };
		},
	});

	const result = await runDag(
		{
			tasks: [
				{ name: "worker", agent: "mock", task: "work" },
				{ name: "verify", agent: "mock", role: "verifier", task: "verify" },
			],
		},
		{ runner, maxCost: 1, maxVerificationRounds: 1 },
	);

	assert.equal(result.status, "failed");
	assert.equal(calls.includes("repair-verify-1"), false);
});
