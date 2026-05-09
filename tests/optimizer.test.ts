import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEvalSet } from "../src/optimizer/eval-set.js";

async function tmpProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-subflow-optimizer-"));
}

const baseEvalSetYaml = `
name: docs
objective:
  taskScore: 1
  cost: 0
  latency: 0
  instability: 1
  complexity: 0.25
scoring:
  minRunsPerCase: 1
  minUtilityDelta: 0.05
  maxFailureRateRegression: 0
cases:
  - name: one
    input: Check docs.
    expectedSections: [Summary]
`;

function baseEvalSet() {
	return {
		name: "inline-docs",
		objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0.25 },
		scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 },
		cases: [{ name: "one", input: "Check docs.", expectedSections: ["Summary"] }],
	};
}

test("loadEvalSet accepts a canonical project eval file", async () => {
	const cwd = await tmpProject();
	const evalDir = join(cwd, ".pi", "subflow", "evals");
	await mkdir(evalDir, { recursive: true });
	await writeFile(join(evalDir, "docs.yaml"), baseEvalSetYaml);

	const loaded = await loadEvalSet({ evalSet: { path: ".pi/subflow/evals/docs.yaml" }, cwd });

	assert.equal(loaded.evalSet.name, "docs");
	assert.equal(loaded.source.kind, "path");
	assert.equal(loaded.source.canonical, true);
	assert.equal(loaded.persistenceRecommendation, undefined);
});

test("loadEvalSet marks non-canonical project eval files", async () => {
	const cwd = await tmpProject();
	await writeFile(join(cwd, "docs.yaml"), baseEvalSetYaml);

	const loaded = await loadEvalSet({ evalSet: { path: "docs.yaml" }, cwd });

	assert.equal(loaded.source.kind, "path");
	assert.equal(loaded.source.canonical, false);
});

test("loadEvalSet accepts inline eval sets and recommends persistence", async () => {
	const loaded = await loadEvalSet({
		cwd: await tmpProject(),
		evalSet: {
			inline: baseEvalSet(),
		},
	});

	assert.equal(loaded.source.kind, "inline");
	assert.equal(
		loaded.persistenceRecommendation,
		"Save this inline eval set to .pi/subflow/evals/inline-docs.yaml for reuse and review.",
	);
});

test("loadEvalSet rejects path security and schema violations", async () => {
	const cwd = await tmpProject();
	await assert.rejects(() => loadEvalSet({ cwd, evalSet: {} as never }), /requires exactly one of evalSet.path or evalSet.inline/);
	await assert.rejects(
		() => loadEvalSet({ cwd, evalSet: { path: "a.yaml", inline: { name: "x", cases: [] } } as never }),
		/requires exactly one of evalSet.path or evalSet.inline/,
	);
	await assert.rejects(() => loadEvalSet({ cwd, evalSet: { path: "" } as never }), /non-empty string/);
	await assert.rejects(() => loadEvalSet({ cwd, evalSet: { path: "../outside.yaml" } }), /must stay inside the project/);
	await assert.rejects(
		() =>
			loadEvalSet({
				cwd,
				evalSet: {
					inline: {
						...baseEvalSet(),
						unexpected: "field",
					} as never,
				},
			}),
		/has unknown field\(s\): unexpected/,
	);
	await assert.rejects(
		() =>
			loadEvalSet({
				cwd,
				evalSet: {
					inline: {
						...baseEvalSet(),
						objective: { ...baseEvalSet().objective, unknownObjective: 1 },
					} as never,
				},
			}),
		/has unknown field\(s\): unknownObjective/,
	);
	await assert.rejects(
		() =>
			loadEvalSet({
				cwd,
				evalSet: {
					inline: {
						...baseEvalSet(),
						scoring: { ...baseEvalSet().scoring, unknownScoring: 1 },
					} as never,
				},
			}),
		/has unknown field\(s\): unknownScoring/,
	);
	await assert.rejects(
		() =>
			loadEvalSet({
				cwd,
				evalSet: {
					inline: {
						...baseEvalSet(),
						cases: [{ ...baseEvalSet().cases[0], unknownCase: "field" }],
					} as never,
				},
			}),
		/has unknown field\(s\): unknownCase/,
	);
	await assert.rejects(
		() =>
			loadEvalSet({
				cwd,
				evalSet: {
					inline: {
						...baseEvalSet(),
						cases: [{ ...baseEvalSet().cases[0], jsonSchema: { required: ["output"], extra: true } }],
					} as never,
				},
			}),
		/has unknown field\(s\): extra/,
	);
	await assert.rejects(
		() =>
			loadEvalSet({
				cwd,
				evalSet: {
					inline: {
						...baseEvalSet(),
						scoring: { ...baseEvalSet().scoring, minUtilityDelta: -0.01 },
					},
				},
			}),
		/scoring\.minUtilityDelta must be non-negative/,
	);
	await assert.rejects(
		() =>
			loadEvalSet({
				cwd,
				evalSet: {
					inline: {
						...baseEvalSet(),
						scoring: { ...baseEvalSet().scoring, maxFailureRateRegression: -0.01 },
					},
				},
			}),
		/scoring\.maxFailureRateRegression must be non-negative/,
	);
});

test("loadEvalSet rejects symlink escapes outside the project", async () => {
	const cwd = await tmpProject();
	const outside = await tmpProject();
	const evalOut = join(outside, "outside.yaml");
	const evalDir = join(cwd, ".pi", "subflow", "evals");
	const linkPath = join(evalDir, "outside.yaml");
	await mkdir(evalDir, { recursive: true });
	await writeFile(evalOut, baseEvalSetYaml);

	try {
		await symlink(evalOut, linkPath);
	} catch (error) {
		if (error instanceof Error && ["EOPNOTSUPP", "ENOTSUP", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) {
			return;
		}
		throw error;
	}

	await assert.rejects(() => loadEvalSet({ cwd, evalSet: { path: ".pi/subflow/evals/outside.yaml" } }), /must stay inside the project/);
});
