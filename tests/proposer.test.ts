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
