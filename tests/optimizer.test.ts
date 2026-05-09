import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { evaluateOptimizerRun } from "../src/optimizer/evaluator.js";
import { formatOptimizerReport, writeOptimizerReport } from "../src/optimizer/report.js";
import { loadEvalSet } from "../src/optimizer/eval-set.js";
import { computeGraphMetrics } from "../src/optimizer/graph-metrics.js";
import { computeUtility, summarizeRuns } from "../src/optimizer/objective.js";
import { MockSubagentRunner } from "../src/index.js";

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

test("computeGraphMetrics counts conditionals, nested workflows, loops, edges, and summary nodes", () => {
	const metrics = computeGraphMetrics([
		{ name: "gate", agent: "mock", task: "gate" },
		{ name: "conditional", agent: "mock", task: "conditional", dependsOn: ["gate"], when: "${gate.output.ok} == true" },
		{
			name: "nested",
			dependsOn: ["conditional"],
			workflow: { tasks: [{ name: "child", agent: "mock", task: "child" }] },
		},
		{
			name: "loop",
			loop: { maxIterations: 3, body: { editor: { agent: "mock", task: "edit" } }, until: "${editor.output.done} == true" },
		},
	]);

	assert.equal(metrics.conditionals, 1);
	assert.equal(metrics.nestedWorkflowDepth, 1);
	assert.equal(metrics.loopExpansionBound, 3);
	assert.equal(metrics.syntheticSummaryNodes, 2);
	assert(metrics.runnableTasks >= 4);
	assert(metrics.complexity > metrics.runnableTasks);
});

test("computeUtility applies objective weights to aggregate metrics", () => {
	const metrics = summarizeRuns([
		{ caseName: "one", wallTimeMs: 1000, result: { status: "completed", output: "ok", results: [], trace: [], usage: { cost: 0.25 } } },
		{ caseName: "two", wallTimeMs: 3000, result: { status: "failed", output: "", results: [], trace: [], usage: { cost: 0.75 } } },
	]);
	const utility = computeUtility(metrics, { complexity: 4 } as never, { taskScore: 1, cost: 1, latency: 0.001, instability: 2, complexity: 0.5 });

	assert.equal(metrics.taskScore, 0.5);
	assert.equal(metrics.dollarCost, 1);
	assert.equal(metrics.wallTimeMs, 4000);
	assert.equal(metrics.failureRate, 0.5);
	assert.equal(utility, 0.5 - 1 - 0.004 - 1 - 2);
});

test("evaluateOptimizerRun normalizes nested dagYaml in baseline workflows", async () => {
	const cwd = await tmpProject();
	const runner = new MockSubagentRunner({ mock: async () => "## Summary\nOk" });
	const report = await evaluateOptimizerRun({
		cwd,
		dagYaml: `
parent:
  workflow:
    dagYaml: |
      review:
        agent: mock
        task: Review docs
`,
		evalSet: {
			inline: {
				name: "inline-docs",
				objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0 },
				scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 },
				cases: [{ name: "one", input: "Check docs", expectedSections: ["Summary"] }],
			},
		},
		runner,
	});

	assert.equal(report.baseline.status, "completed");
	assert.equal(runner.calls.length, 1);
});

test("evaluateOptimizerRun rejects workflowPath values outside the project", async () => {
	const cwd = await tmpProject();
	await assert.rejects(
		() => evaluateOptimizerRun({ cwd, workflowPath: resolve(cwd, "workflow.yaml"), evalSet: { inline: baseEvalSet() }, runner: new MockSubagentRunner({ mock: async () => "" }) }),
		/workflowPath must be relative to the project/,
	);
	await assert.rejects(
		() => evaluateOptimizerRun({ cwd, workflowPath: "../outside.yaml", evalSet: { inline: baseEvalSet() }, runner: new MockSubagentRunner({ mock: async () => "" }) }),
		/workflowPath must stay inside the project/,
	);
});

test("evaluateOptimizerRun rejects workflowPath symlink escapes outside the project", async () => {
	const cwd = await tmpProject();
	const outside = await tmpProject();
	const workflowOut = join(outside, "workflow.yaml");
	const linkPath = join(cwd, "workflow.yaml");
	await writeFile(workflowOut, "review:\n  agent: mock\n  task: Review docs\n");

	try {
		await symlink(workflowOut, linkPath);
	} catch (error) {
		if (error instanceof Error && ["EOPNOTSUPP", "ENOTSUP", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) {
			return;
		}
		throw error;
	}

	await assert.rejects(
		() => evaluateOptimizerRun({ cwd, workflowPath: "workflow.yaml", evalSet: { inline: baseEvalSet() }, runner: new MockSubagentRunner({ mock: async () => "" }) }),
		/workflowPath must stay inside the project/,
	);
});

test("evaluateOptimizerRun does not recommend candidates beyond maxFailureRateRegression", async () => {
	const cwd = await tmpProject();
	let candidateRuns = 0;
	const runner = new MockSubagentRunner({
		mock: async ({ task }) => {
			if (task?.includes("Cheap flaky review")) {
				candidateRuns += 1;
				if (candidateRuns === 2) return { status: "failed", output: "", usage: { cost: 0 } };
			}
			return { output: "## Summary\nOk", usage: { cost: 0 } };
		},
	});
	const report = await evaluateOptimizerRun({
		cwd,
		dagYaml: "draft:\n  agent: mock\n  task: Draft docs\nreview:\n  agent: mock\n  task: Expensive reliable review\n  dependsOn: [draft]\n",
		evalSet: {
			inline: {
				name: "inline-docs",
				objective: { taskScore: 1, cost: 0, latency: 0, instability: 0.1, complexity: 1 },
				scoring: { minRunsPerCase: 2, minUtilityDelta: 0.05, maxFailureRateRegression: 0.25 },
				cases: [{ name: "one", input: "Check docs" }],
			},
		},
		candidateDagYamls: ["review:\n  agent: mock\n  task: Cheap flaky review\n"],
		runner,
	});

	assert.equal(report.baseline.metrics?.failureRate, 0);
	assert.equal(report.candidates[0].metrics?.failureRate, 0.5);
	assert((report.candidates[0].utility ?? -Infinity) > (report.baseline.utility ?? Infinity));
	assert.match(report.recommendation, /No candidate cleared/);
});

test("evaluateOptimizerRun produces a baseline-only dry-run report", async () => {
	const cwd = await tmpProject();
	const runner = new MockSubagentRunner({ mock: async () => "## Summary\nOk" });
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
		runner,
	});

	assert.equal(report.baseline.status, "completed");
	assert.equal(report.baseline.metrics?.runs, 1);
	assert.equal(report.candidates.length, 0);
	assert.match(report.recommendation, /No candidates supplied/);
});

test("evaluateOptimizerRun reports invalid candidates without executing them", async () => {
	const cwd = await tmpProject();
	const runner = new MockSubagentRunner({ mock: async () => "## Summary\nOk" });
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
		candidateDagYamls: ["broken:\n  agent: mock\n"],
		runner,
	});

	assert.equal(report.candidates[0].status, "invalid");
	assert.match(report.candidates[0].error ?? "", /requires agent and task strings/);
	assert.equal(runner.calls.length, 1);
});

test("evaluateOptimizerRun reports missing-dependency candidates without executing them", async () => {
	const cwd = await tmpProject();
	const runner = new MockSubagentRunner({ mock: async () => "## Summary\nOk" });
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
		candidateDagYamls: ["review:\n  agent: mock\n  task: Review docs\n  dependsOn: [missing]\n"],
		runner,
	});

	assert.equal(report.candidates[0].status, "invalid");
	assert.match(report.candidates[0].error ?? "", /depends on missing task missing/);
	assert.equal(runner.calls.length, 1);
});

test("evaluateOptimizerRun applies eval case input to executed task prompts without mutating candidates", async () => {
	const cwd = await tmpProject();
	const runner = new MockSubagentRunner({ mock: async () => "## Summary\nOk" });
	const candidateDagYaml = "review:\n  agent: mock\n  task: Faster review\n";
	await evaluateOptimizerRun({
		cwd,
		dagYaml: "review:\n  agent: mock\n  task: Review docs\n",
		evalSet: {
			inline: {
				name: "inline-docs",
				objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0 },
				scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 },
				cases: [{ name: "one", input: "Check the onboarding guide.", expectedSections: ["Summary"] }],
			},
		},
		candidateDagYamls: [candidateDagYaml],
		runner,
	});

	assert.match(runner.calls[0].task, /Eval case input:\nCheck the onboarding guide\./);
	assert.match(runner.calls[1].task, /Eval case input:\nCheck the onboarding guide\./);
	assert.equal(candidateDagYaml, "review:\n  agent: mock\n  task: Faster review\n");
});

test("evaluateOptimizerRun evaluates valid manual candidates and reports recommendation", async () => {
	const cwd = await tmpProject();
	const runner = new MockSubagentRunner({ mock: async () => "## Summary\nOk" });
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
		candidateDagYamls: ["review:\n  agent: mock\n  task: Faster review\n"],
		runner,
	});

	assert.equal(report.candidates[0].status, "completed");
	assert.match(report.recommendation, /No candidate cleared/);
});

test("writeOptimizerReport rejects unsafe report IDs", async () => {
	const cwd = await tmpProject();
	await assert.rejects(
		() => writeOptimizerReport(cwd, {
			reportId: "../../escape",
			createdAt: new Date().toISOString(),
			evalSetName: "inline-docs",
			source: { kind: "inline" },
			baseline: { id: "baseline", label: "Baseline", status: "completed" },
			candidates: [],
			recommendation: "No candidates supplied; baseline profile only.",
			warnings: [],
		}),
		/reportId must be a safe filename/,
	);
});

test("writeOptimizerReport rejects symlinked report directories outside the project", async () => {
	const cwd = await tmpProject();
	const outside = await tmpProject();
	const subflowDir = join(cwd, ".pi", "subflow");
	const linkPath = join(subflowDir, "optimizer-reports");
	const outsideFile = join(outside, "safe.json");
	await mkdir(subflowDir, { recursive: true });

	try {
		await symlink(outside, linkPath, "dir");
	} catch (error) {
		if (error instanceof Error && ["EOPNOTSUPP", "ENOTSUP", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code || "")) {
			return;
		}
		throw error;
	}

	await assert.rejects(
		() => writeOptimizerReport(cwd, {
			reportId: "safe",
			createdAt: new Date().toISOString(),
			evalSetName: "inline-docs",
			source: { kind: "inline" },
			baseline: { id: "baseline", label: "Baseline", status: "completed" },
			candidates: [],
			recommendation: "No candidates supplied; baseline profile only.",
			warnings: [],
		}),
		/must stay inside the project/,
	);
	await assert.rejects(() => readFile(outsideFile, "utf8"), /ENOENT/);
});

test("writeOptimizerReport writes JSON and formatOptimizerReport renders summary", async () => {
	const cwd = await tmpProject();
	const runner = new MockSubagentRunner({ mock: async () => "## Summary\nOk" });
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
		runner,
	});
	const path = await writeOptimizerReport(cwd, report);
	const saved = await readFile(path, "utf8");

	assert.equal(isAbsolute(path), true);
	assert.match(path, /\.pi\/subflow\/optimizer-reports\/opt-[a-z0-9]+\.json$/);
	assert.match(saved, /"evalSetName": "inline-docs"/);
	assert.match(formatOptimizerReport(report), /subflow_optimize dry-run report/);
});
