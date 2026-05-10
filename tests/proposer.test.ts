import assert from "node:assert/strict";
import test from "node:test";
import { proposeCandidates } from "../src/optimizer/proposer.ts";

test("proposeCandidates rejects ambiguous workflowPath and dagYaml inputs", async () => {
	await assert.rejects(
		proposeCandidates({
			workflowPath: "examples/workflows/recipes/research-synthesis.yaml",
			dagYaml: "a:\n  task: a\n",
		}),
		/exactly one of workflowPath or dagYaml/i,
	);
});

test("proposeCandidates returns a valid verifier fan-in candidate for a multi-root DAG", async () => {
	const result = await proposeCandidates({
		dagYaml: `research:\n  agent: researcher\n  task: Research the topic.\n\nrepo:\n  agent: researcher\n  task: Inspect repository evidence.\n`,
		count: 1,
	});

	assert.equal(result.status, "completed");
	assert.equal(result.requestedCount, 1);
	assert.equal(result.proposals.length, 1);
	const [proposal] = result.proposals;
	assert.equal(proposal.valid, true);
	assert.match(proposal.title, /verifier fan-in/i);
	assert.match(proposal.dagYaml, /synthesis:/);
	assert.match(proposal.dagYaml, /dependsOn:\n\s+- research\n\s+- repo/);
	assert.match(proposal.dagYaml, /role: verifier/);
});

test("proposeCandidates validates count and strategy", async () => {
	await assert.rejects(
		proposeCandidates({ dagYaml: "a:\n  task: a\n", count: 0 }),
		/count must be a positive integer/i,
	);

	await assert.rejects(
		proposeCandidates({ dagYaml: "a:\n  task: a\n", strategy: "wild" as never }),
		/strategy must be safe or exploratory/i,
	);
});

test("proposeCandidates rejects malformed baseline DAG YAML", async () => {
	await assert.rejects(
		proposeCandidates({ dagYaml: "not: [valid" }),
		/yaml|parse|invalid/i,
	);
});

test("proposeCandidates defaults requestedCount to 3", async () => {
	const result = await proposeCandidates({
		dagYaml: `research:\n  agent: researcher\n  task: Research the topic.\n\nrepo:\n  agent: researcher\n  task: Inspect repository evidence.\n`,
	});

	assert.equal(result.requestedCount, 3);
	assert.equal(result.proposals.length, 1);
});
