import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { evaluateOptimizerRun } from "../src/optimizer/evaluator.js";
import { MockSubagentRunner } from "../src/index.js";
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

test("proposeCandidates loads workflowPath relative to the supplied cwd", async () => {
	const cwd = await tmpProject();
	await writeFile(join(cwd, "relative.yaml"), `research:\n  agent: researcher\n  task: Research the topic.\n\nrepo:\n  agent: researcher\n  task: Inspect repository evidence.\n`);

	const result = await proposeCandidates({ workflowPath: "relative.yaml" }, { cwd });

	assert.equal(result.status, "completed");
	assert.equal(result.proposals.length, 1);
	assert.equal(result.proposals[0]?.valid, true);
	assert.match(result.proposals[0]?.dagYaml ?? "", /synthesis:/);
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
	assert.match(proposal.dagYaml, /agent: researcher/);
	assert.doesNotMatch(proposal.dagYaml, /agent: verifier/);
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
		/strategy must be safe, exploratory, or model-thinking/i,
	);
});

test("proposeCandidates model-thinking mutates only the deepest verifier", async () => {
	const result = await proposeCandidates({
		dagYaml: `worker:
  agent: reviewer
  model: openai-codex/gpt-5.4-mini
  thinking: low
  task: Inspect docs.

verdict:
  agent: reviewer
  model: openai-codex/gpt-5.5
  thinking: medium
  role: verifier
  needs: [worker]
  task: Synthesize findings.
`,
		strategy: "model-thinking",
		count: 3,
	});

	assert.equal(result.status, "completed");
	assert.equal(result.strategy, "model-thinking");
	assert.equal(result.proposals.length, 3);
	assert.equal(result.proposals.every((proposal) => proposal.valid), true);
	assert.match(result.proposals[0]?.id ?? "", /^model-thinking-/);
	assert.match(result.proposals[0]?.explanation ?? "", /verdict: openai-codex\/gpt-5\.5\/medium -> /);

	for (const proposal of result.proposals) {
		const parsed = YAML.parse(proposal.dagYaml) as Record<string, Record<string, unknown>>;
		assert.deepEqual(parsed.worker, {
			agent: "reviewer",
			task: "Inspect docs.",
			model: "openai-codex/gpt-5.4-mini",
			thinking: "low",
		});
	}

	const firstCandidate = YAML.parse(result.proposals[0]?.dagYaml ?? "") as Record<string, Record<string, unknown>>;
	assert.equal(firstCandidate.verdict?.model, "openai-codex/gpt-5.4-mini");
	assert.equal(firstCandidate.verdict?.thinking, "medium");
});

test("proposeCandidates model-thinking returns a clear empty result without a verifier", async () => {
	const result = await proposeCandidates({
		dagYaml: `worker:
  agent: reviewer
  model: openai-codex/gpt-5.4-mini
  thinking: low
  task: Inspect docs.
`,
		strategy: "model-thinking",
	});

	assert.equal(result.status, "completed");
	assert.equal(result.proposals.length, 0);
	assert.match(result.summary, /no verifier task found/i);
});

test("proposeCandidates model-thinking respects the count cap", async () => {
	const result = await proposeCandidates({
		dagYaml: `worker:
  agent: reviewer
  task: Inspect docs.

verdict:
  agent: reviewer
  model: openai-codex/gpt-5.5
  thinking: medium
  role: verifier
  needs: [worker]
  task: Synthesize findings.
`,
		strategy: "model-thinking",
		count: 1,
	});

	assert.equal(result.requestedCount, 1);
	assert.equal(result.proposals.length, 1);
});

test("proposeCandidates rejects malformed baseline DAG YAML", async () => {
	await assert.rejects(
		proposeCandidates({ dagYaml: "not: [valid" }),
		/yaml|parse|invalid/i,
	);
});

test("proposeCandidates still generates a candidate when a verifier root has no dependencies", async () => {
	const result = await proposeCandidates({
		dagYaml: `research:\n  agent: researcher\n  task: Research the topic.\n\nrepo:\n  agent: researcher\n  task: Inspect repository evidence.\n\nreview:\n  agent: verifier\n  role: verifier\n  task: Review the findings.\n`,
		count: 1,
	});

	assert.equal(result.proposals.length, 1);
	assert.equal(result.proposals[0]?.valid, true);
});

async function tmpProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-subflow-proposer-"));
}

test("proposeCandidates wraps workflowPath read failures with context", async () => {
	const cwd = await tmpProject();
	const workflowPath = join(cwd, "missing-workflow.yaml");

	await assert.rejects(
		proposeCandidates({ workflowPath }),
		new RegExp(`could not read workflowPath .*missing-workflow\\.yaml: .*ENOENT`),
	);
});

test("proposeCandidates defaults requestedCount to 3", async () => {
	const result = await proposeCandidates({
		dagYaml: `research:\n  agent: researcher\n  task: Research the topic.\n\nrepo:\n  agent: researcher\n  task: Inspect repository evidence.\n`,
	});

	assert.equal(result.requestedCount, 3);
	assert.equal(result.proposals.length, 1);
});

test("proposed candidate YAML is accepted by evaluateOptimizerRun", async () => {
	const cwd = await tmpProject();
	const runner = new MockSubagentRunner({ mock: async () => "## Summary\nOk", verifier: async () => "## Summary\nSynthesized" });
	const proposal = await proposeCandidates({
		dagYaml: `research:\n  agent: mock\n  task: Research the topic.\n\nrepo:\n  agent: mock\n  task: Inspect repository evidence.\n`,
		count: 1,
	});

	assert.equal(proposal.proposals[0]?.valid, true);
	const report = await evaluateOptimizerRun({
		cwd,
		dagYaml: "review:\n  agent: mock\n  task: Review docs\n",
		evalSet: {
			inline: {
				name: "inline-docs",
				objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0 },
				scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 },
				cases: [{ name: "one", input: "Check docs", expectedSections: ["Summary"] }],
			},
		},
		candidateDagYamls: [proposal.proposals[0]?.dagYaml ?? ""],
		runner,
	});

	assert.notEqual(report.candidates[0]?.status, "invalid");
	assert.equal(report.candidates[0]?.status, "completed");
});
