# ADR 0003 Pi-native Optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first dry-run-only `subflow_optimize` Pi tool for evaluating a baseline workflow and optional manually supplied candidate DAG YAMLs against durable eval sets.

**Architecture:** Extract DAG YAML parsing from `src/extension.ts` into a shared module, add focused optimizer modules for eval-set loading, graph metrics, objective scoring, evaluation, and reporting, then register a second Pi tool from `src/extension.ts`. The optimizer reuses `runDag`, DAG validation, policy checks, tool allowlists, and the existing runner factory; it writes JSON reports under `.pi/subflow/optimizer-reports/` and never mutates workflow files.

**Tech Stack:** TypeScript ESM, Node `fs/promises`, `yaml`, `typebox`, Node test runner, existing pi-subflow orchestration modules.

---

## File map

- Create `src/dag-yaml.ts`: shared `parseDagYaml`, `normalizeDagYaml`, `normalizeNestedWorkflows`, and task parsing helpers moved from `src/extension.ts`.
- Modify `src/extension.ts`: import shared DAG YAML helpers; register `subflow_optimize`; adapt fake tests to multiple tools.
- Create `src/optimizer/types.ts`: optimizer-specific types shared by modules.
- Create `src/optimizer/eval-set.ts`: path/inline eval loading, XOR validation, defaults, canonical-path guidance.
- Create `src/optimizer/graph-metrics.ts`: deterministic complexity metrics for conditions, nested workflows, loops, edges, and summary nodes.
- Create `src/optimizer/objective.ts`: utility scoring and aggregate metrics.
- Create `src/optimizer/report.ts`: human-readable report formatting and JSON report writing.
- Create `src/optimizer/tool.ts`: `executeSubflowOptimize` and Pi tool registration data.
- Create `schemas/subflow-eval.schema.json`: YAML schema for eval sets.
- Create `examples/evals/docs-consistency.yaml`: first eval-set example.
- Create `tests/dag-yaml.test.ts`: parser extraction regression tests.
- Create `tests/optimizer.test.ts`: eval loading, metrics, objective, evaluator/report tests.
- Modify `tests/extension.test.ts`: second-tool registration and `subflow_optimize` integration tests.
- Modify `README.md`, `doc/wiki/Roadmap.md`, create `doc/wiki/Workflow-optimization.md`: documentation sync.
- Modify `doc/adr/0003-self-optimizing-static-dags.md`: note concrete MVP interface if needed.

---

### Task 1: Extract shared DAG YAML parsing without behavior changes

**Files:**
- Create: `src/dag-yaml.ts`
- Modify: `src/extension.ts`
- Create: `tests/dag-yaml.test.ts`
- Test: `tests/extension.test.ts`

- [x] **Step 1: Write failing parser extraction tests**

Create `tests/dag-yaml.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDagYaml, normalizeNestedWorkflows, parseDagYaml } from "../src/dag-yaml.js";

test("parseDagYaml normalizes needs to dependsOn and preserves block scalars", () => {
	const tasks = parseDagYaml(`
api:
  agent: reviewer
  task: |
    Review API
    Keep indentation
verdict:
  agent: reviewer
  role: verifier
  needs: [api]
  task: Decide
`);

	assert.deepEqual(tasks.map((task) => task.name), ["api", "verdict"]);
	assert.equal(tasks[0].task, "Review API\nKeep indentation");
	assert.deepEqual(tasks[1].dependsOn, ["api"]);
});

test("parseDagYaml rejects tasks that set both needs and dependsOn", () => {
	assert.throws(
		() => parseDagYaml(`
review:
  agent: reviewer
  task: Review
  needs: [a]
  dependsOn: [b]
`),
		/cannot set both needs and dependsOn/,
	);
});

test("normalizeNestedWorkflows parses nested workflow dagYaml and loop body mappings", () => {
	const params = normalizeNestedWorkflows({
		tasks: [
			{
				name: "outer",
				workflow: { dagYaml: "inner:\n  agent: reviewer\n  task: Review inner\n" },
			},
			{
				name: "repeat",
				loop: {
					maxIterations: 2,
					body: { editor: { agent: "reviewer", task: "Edit" } },
					until: "${editor.output.continue} == false",
				},
			},
		],
	});

	assert.equal(params.tasks?.[0].workflow?.tasks?.[0].name, "inner");
	assert.equal((params.tasks?.[1].loop?.body as Record<string, unknown>).editor !== undefined, true);
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/dag-yaml.test.ts
```

Expected: fails because `src/dag-yaml.ts` does not exist.

- [x] **Step 3: Create `src/dag-yaml.ts` by moving parser helpers**

Move the existing private parsing helpers from `src/extension.ts` into `src/dag-yaml.ts`. Export these types and functions:

```ts
import { parseDocument } from "yaml";
import { namedTask } from "./execution.js";
import type { SubagentTask } from "./types.js";

export interface DagYamlParams {
	tasks?: SubagentTask[];
	dagYaml?: string;
}

type WorkflowTasksValue = NonNullable<NonNullable<SubagentTask["workflow"]>["tasks"]>;

export function normalizeDagYaml<T extends DagYamlParams>(params: T): T {
	if (!params.dagYaml) return params;
	if (params.tasks) throw new Error("subflow accepts either dagYaml or tasks, not both");
	return { ...params, tasks: parseDagYaml(params.dagYaml) };
}

export function normalizeNestedWorkflows<T extends DagYamlParams>(params: T): T {
	return { ...params, tasks: params.tasks?.map((task) => normalizeTask(task)) };
}

export function parseDagYaml(source: string): SubagentTask[] {
	const document = parseDocument(source, { uniqueKeys: true });
	if (document.errors.length) {
		throw new Error(`invalid dagYaml: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	const root = document.toJSON();
	if (!isRecord(root) || Array.isArray(root) || !Object.keys(root).length) {
		throw new Error("dagYaml root must be a mapping of task names to task definitions");
	}
	return Object.entries(root).map(([name, value]) => parseDagYamlTask(name, value));
}
```

Also move these helpers unchanged from `src/extension.ts` into `src/dag-yaml.ts` and keep their exact runtime error messages:

```ts
function normalizeTask(task: SubagentTask): SubagentTask;
function normalizeLoopDefinition(loop: SubagentTask["loop"] | undefined, context: string): SubagentTask["loop"] | undefined;
function normalizeWorkflowDefinition(workflow: SubagentTask["workflow"] | undefined, context: string): SubagentTask["workflow"] | undefined;
function normalizeWorkflowTasksValue(tasks: WorkflowTasksValue | undefined, context: string): SubagentTask[] | undefined;
function parseDagYamlTask(name: string, value: unknown): SubagentTask;
function parseDagYamlWorkflow(value: unknown, name: string): SubagentTask["workflow"] | undefined;
function parseDagYamlLoop(value: unknown, name: string): SubagentTask["loop"] | undefined;
function parseLoopBodyValue(value: unknown, context: string): NonNullable<SubagentTask["loop"]>["body"];
function parseWorkflowTasksValue(tasks: unknown, context: string): SubagentTask[] | undefined;
function parseWorkflowTask(value: unknown, context: string, name: string | number): SubagentTask;
function parseStringArray(value: unknown, context: string): string[] | undefined;
function optionalString(value: unknown, context: string): string | undefined;
function optionalRole(value: unknown, name: string): SubagentTask["role"] | undefined;
function optionalAuthority(value: unknown, name: string): SubagentTask["authority"] | undefined;
function optionalThinking(value: unknown, name: string): SubagentTask["thinking"] | undefined;
function isRecord(value: unknown): value is Record<string, unknown>;
```

- [x] **Step 4: Update `src/extension.ts` to import shared helpers**

At the top of `src/extension.ts`, remove `parseDocument` and `namedTask` imports if no longer used there, then add:

```ts
import { normalizeDagYaml, normalizeNestedWorkflows } from "./dag-yaml.js";
```

Delete the moved helper implementations from `src/extension.ts`. Keep `type WorkflowTasksValue` only if still used; otherwise remove it.

- [x] **Step 5: Run extraction tests**

Run:

```bash
npm test -- tests/dag-yaml.test.ts tests/extension.test.ts
```

Expected: all selected tests pass.

- [x] **Step 6: Commit**

```bash
git add src/dag-yaml.ts src/extension.ts tests/dag-yaml.test.ts
git commit -m "refactor: share DAG YAML parsing"
```

---

### Task 2: Add eval-set schema and loader

**Files:**
- Create: `schemas/subflow-eval.schema.json`
- Create: `src/optimizer/types.ts`
- Create: `src/optimizer/eval-set.ts`
- Create/modify: `tests/optimizer.test.ts`
- Create: `examples/evals/docs-consistency.yaml`

- [x] **Step 1: Write failing eval-loader tests**

Create `tests/optimizer.test.ts` with the initial tests:

```ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadEvalSet } from "../src/optimizer/eval-set.js";

async function tmpProject(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-subflow-optimizer-"));
}

test("loadEvalSet accepts a canonical project eval file", async () => {
	const cwd = await tmpProject();
	const evalDir = join(cwd, ".pi", "subflow", "evals");
	await mkdir(evalDir, { recursive: true });
	await writeFile(join(evalDir, "docs.yaml"), `
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
`);

	const loaded = await loadEvalSet({ evalSet: { path: ".pi/subflow/evals/docs.yaml" }, cwd });

	assert.equal(loaded.evalSet.name, "docs");
	assert.equal(loaded.source.kind, "path");
	assert.equal(loaded.source.canonical, true);
	assert.equal(loaded.persistenceRecommendation, undefined);
});

test("loadEvalSet accepts inline eval sets and recommends persistence", async () => {
	const loaded = await loadEvalSet({
		cwd: await tmpProject(),
		evalSet: {
			inline: {
				name: "inline-docs",
				objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0.25 },
				scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 },
				cases: [{ name: "one", input: "Check docs.", expectedSections: ["Summary"] }],
			},
		},
	});

	assert.equal(loaded.source.kind, "inline");
	assert.match(loaded.persistenceRecommendation ?? "", /.pi\/subflow\/evals\/inline-docs.yaml/);
});

test("loadEvalSet rejects missing, ambiguous, and escaping eval set inputs", async () => {
	const cwd = await tmpProject();
	await assert.rejects(() => loadEvalSet({ cwd, evalSet: {} as never }), /requires exactly one of evalSet.path or evalSet.inline/);
	await assert.rejects(
		() => loadEvalSet({ cwd, evalSet: { path: "a.yaml", inline: { name: "x", cases: [] } } as never }),
		/requires exactly one of evalSet.path or evalSet.inline/,
	);
	await assert.rejects(() => loadEvalSet({ cwd, evalSet: { path: "../outside.yaml" } }), /must stay inside the project/);
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/optimizer.test.ts
```

Expected: fails because optimizer modules do not exist.

- [x] **Step 3: Add eval-set types**

Create `src/optimizer/types.ts`:

```ts
import type { FlowResult, SubagentTask } from "../types.js";

export interface OptimizerObjectiveWeights {
	taskScore: number;
	cost: number;
	latency: number;
	instability: number;
	complexity: number;
}

export interface OptimizerScoringPolicy {
	minRunsPerCase: number;
	minUtilityDelta: number;
	maxFailureRateRegression: number;
}

export interface EvalCase {
	name: string;
	input: string;
	expectedSections?: string[];
	jsonSchema?: { required?: string[] };
}

export interface EvalSet {
	name: string;
	workflow?: string;
	objective: OptimizerObjectiveWeights;
	scoring: OptimizerScoringPolicy;
	cases: EvalCase[];
}

export type EvalSetInput = { path: string; inline?: never } | { inline: EvalSet; path?: never };

export interface LoadedEvalSet {
	evalSet: EvalSet;
	source: { kind: "path"; path: string; canonical: boolean } | { kind: "inline" };
	persistenceRecommendation?: string;
}

export interface GraphMetrics {
	runnableTasks: number;
	edges: number;
	conditionals: number;
	nestedWorkflowDepth: number;
	loopExpansionBound: number;
	syntheticSummaryNodes: number;
	complexity: number;
}

export interface CandidateEvaluation {
	id: string;
	label: string;
	status: "completed" | "failed" | "invalid";
	dagYaml?: string;
	error?: string;
	metrics?: EvaluationMetrics;
	utility?: number;
	graph?: GraphMetrics;
}

export interface EvaluationMetrics {
	taskScore: number;
	dollarCost: number;
	wallTimeMs: number;
	failureRate: number;
	runs: number;
	failures: number;
}

export interface OptimizerReport {
	reportId: string;
	createdAt: string;
	evalSetName: string;
	source: LoadedEvalSet["source"];
	persistenceRecommendation?: string;
	baseline: CandidateEvaluation;
	candidates: CandidateEvaluation[];
	recommendation: string;
	warnings: string[];
}

export interface WorkflowCandidate {
	id: string;
	label: string;
	tasks: SubagentTask[];
	dagYaml?: string;
}

export interface CaseRunResult {
	caseName: string;
	result: FlowResult;
	wallTimeMs: number;
}
```

- [x] **Step 4: Create eval schema file**

Create `schemas/subflow-eval.schema.json`:

```json
{
  "title": "pi-subflow eval set",
  "description": "YAML language-server schema for pi-subflow optimizer eval sets.",
  "type": "object",
  "additionalProperties": false,
  "required": ["name", "objective", "scoring", "cases"],
  "properties": {
    "name": { "type": "string", "minLength": 1 },
    "workflow": { "type": "string", "minLength": 1 },
    "objective": {
      "type": "object",
      "additionalProperties": false,
      "required": ["taskScore", "cost", "latency", "instability", "complexity"],
      "properties": {
        "taskScore": { "type": "number" },
        "cost": { "type": "number" },
        "latency": { "type": "number" },
        "instability": { "type": "number" },
        "complexity": { "type": "number" }
      }
    },
    "scoring": {
      "type": "object",
      "additionalProperties": false,
      "required": ["minRunsPerCase", "minUtilityDelta", "maxFailureRateRegression"],
      "properties": {
        "minRunsPerCase": { "type": "integer", "minimum": 1 },
        "minUtilityDelta": { "type": "number", "minimum": 0 },
        "maxFailureRateRegression": { "type": "number", "minimum": 0 }
      }
    },
    "cases": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "input"],
        "properties": {
          "name": { "type": "string", "minLength": 1 },
          "input": { "type": "string", "minLength": 1 },
          "expectedSections": { "type": "array", "items": { "type": "string", "minLength": 1 } },
          "jsonSchema": {
            "type": "object",
            "additionalProperties": false,
            "properties": { "required": { "type": "array", "items": { "type": "string", "minLength": 1 } } }
          }
        }
      }
    }
  }
}
```

- [x] **Step 5: Implement `loadEvalSet`**

Create `src/optimizer/eval-set.ts`:

```ts
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { EvalCase, EvalSet, EvalSetInput, LoadedEvalSet, OptimizerObjectiveWeights, OptimizerScoringPolicy } from "./types.js";

export async function loadEvalSet(input: { evalSet: EvalSetInput; cwd: string }): Promise<LoadedEvalSet> {
	const hasPath = typeof input.evalSet.path === "string";
	const hasInline = input.evalSet.inline !== undefined;
	if (hasPath === hasInline) throw new Error("subflow_optimize requires exactly one of evalSet.path or evalSet.inline");
	if (hasInline) {
		const evalSet = normalizeEvalSet(input.evalSet.inline, "inline eval set");
		return {
			evalSet,
			source: { kind: "inline" },
			persistenceRecommendation: `Save this inline eval set to .pi/subflow/evals/${slug(evalSet.name)}.yaml for reuse and review.`,
		};
	}
	const absolutePath = resolveProjectPath(input.cwd, input.evalSet.path);
	const source = await readFile(absolutePath, "utf8");
	const document = parseDocument(source, { uniqueKeys: true });
	if (document.errors.length) throw new Error(`invalid eval set YAML: ${document.errors.map((error) => error.message).join("; ")}`);
	const evalSet = normalizeEvalSet(document.toJSON(), `eval set ${input.evalSet.path}`);
	const canonical = relative(join(input.cwd, ".pi", "subflow", "evals"), absolutePath).split(/[\\/]/u)[0] !== "..";
	return { evalSet, source: { kind: "path", path: relative(input.cwd, absolutePath), canonical } };
}

function resolveProjectPath(cwd: string, path: string): string {
	if (isAbsolute(path)) throw new Error("evalSet.path must be relative to the project");
	const resolved = resolve(cwd, path);
	const rel = relative(cwd, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("evalSet.path must stay inside the project");
	return resolved;
}

function normalizeEvalSet(value: unknown, context: string): EvalSet {
	if (!isRecord(value)) throw new Error(`${context} must be a mapping`);
	const name = requiredString(value.name, `${context} name`);
	const objective = normalizeObjective(value.objective, context);
	const scoring = normalizeScoring(value.scoring, context);
	if (!Array.isArray(value.cases) || value.cases.length === 0) throw new Error(`${context} cases must be a non-empty array`);
	return { name, workflow: optionalString(value.workflow, `${context} workflow`), objective, scoring, cases: value.cases.map((item, index) => normalizeCase(item, `${context} cases[${index}]`)) };
}

function normalizeObjective(value: unknown, context: string): OptimizerObjectiveWeights {
	if (!isRecord(value)) throw new Error(`${context} objective must be a mapping`);
	return { taskScore: requiredNumber(value.taskScore, `${context} objective.taskScore`), cost: requiredNumber(value.cost, `${context} objective.cost`), latency: requiredNumber(value.latency, `${context} objective.latency`), instability: requiredNumber(value.instability, `${context} objective.instability`), complexity: requiredNumber(value.complexity, `${context} objective.complexity`) };
}

function normalizeScoring(value: unknown, context: string): OptimizerScoringPolicy {
	if (!isRecord(value)) throw new Error(`${context} scoring must be a mapping`);
	const minRunsPerCase = requiredInteger(value.minRunsPerCase, `${context} scoring.minRunsPerCase`);
	if (minRunsPerCase < 1) throw new Error(`${context} scoring.minRunsPerCase must be at least 1`);
	return { minRunsPerCase, minUtilityDelta: requiredNumber(value.minUtilityDelta, `${context} scoring.minUtilityDelta`), maxFailureRateRegression: requiredNumber(value.maxFailureRateRegression, `${context} scoring.maxFailureRateRegression`) };
}

function normalizeCase(value: unknown, context: string): EvalCase {
	if (!isRecord(value)) throw new Error(`${context} must be a mapping`);
	return { name: requiredString(value.name, `${context} name`), input: requiredString(value.input, `${context} input`), expectedSections: optionalStringArray(value.expectedSections, `${context} expectedSections`), jsonSchema: isRecord(value.jsonSchema) ? { required: optionalStringArray(value.jsonSchema.required, `${context} jsonSchema.required`) } : undefined };
}

function requiredString(value: unknown, context: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be a non-empty string`);
	return value;
}

function optionalString(value: unknown, context: string): string | undefined {
	if (value === undefined) return undefined;
	return requiredString(value, context);
}

function requiredNumber(value: unknown, context: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${context} must be a finite number`);
	return value;
}

function requiredInteger(value: unknown, context: string): number {
	if (!Number.isInteger(value)) throw new Error(`${context} must be an integer`);
	return value;
}

function optionalStringArray(value: unknown, context: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) throw new Error(`${context} must be an array of non-empty strings`);
	return value;
}

function slug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "eval-set";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

- [x] **Step 6: Add example eval set**

Create `examples/evals/docs-consistency.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/5queezer/pi-subflow/refs/heads/master/schemas/subflow-eval.schema.json
name: docs-consistency
workflow: examples/workflows/docs-consistency.yaml
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
  - name: readme-wiki-adr-schema-sync
    input: Check README.md, doc/wiki, doc/adr, schemas, and src/extension.ts LLM-facing guidance for consistency.
    expectedSections: [Summary, Findings, Recommendation]
```

- [x] **Step 7: Run eval loader tests**

Run:

```bash
npm test -- tests/optimizer.test.ts
```

Expected: eval loader tests pass.

- [x] **Step 8: Commit**

```bash
git add schemas/subflow-eval.schema.json src/optimizer/types.ts src/optimizer/eval-set.ts tests/optimizer.test.ts examples/evals/docs-consistency.yaml
git commit -m "feat: add optimizer eval set loader"
```

---

### Task 3: Add graph metrics and objective scoring

**Files:**
- Create: `src/optimizer/graph-metrics.ts`
- Create: `src/optimizer/objective.ts`
- Modify: `tests/optimizer.test.ts`

- [x] **Step 1: Add failing graph/objective tests**

Append to `tests/optimizer.test.ts`:

```ts
import { computeGraphMetrics } from "../src/optimizer/graph-metrics.js";
import { computeUtility, summarizeRuns } from "../src/optimizer/objective.js";

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
	assert.equal(utility, 0.5 - 1 - 4 - 1 - 2);
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/optimizer.test.ts
```

Expected: fails because metric modules do not exist.

- [x] **Step 3: Implement graph metrics**

Create `src/optimizer/graph-metrics.ts`:

```ts
import type { SubagentTask } from "../types.js";
import type { GraphMetrics } from "./types.js";

export function computeGraphMetrics(tasks: SubagentTask[]): GraphMetrics {
	const counts = countTasks(tasks, 0);
	const complexity = counts.runnableTasks
		+ counts.edges * 0.25
		+ counts.conditionals * 0.75
		+ counts.nestedWorkflowDepth * 1.5
		+ counts.loopExpansionBound * 0.5
		+ counts.syntheticSummaryNodes * 0.5;
	return { ...counts, complexity };
}

function countTasks(tasks: SubagentTask[], depth: number): Omit<GraphMetrics, "complexity"> {
	let runnableTasks = 0;
	let edges = 0;
	let conditionals = 0;
	let nestedWorkflowDepth = depth;
	let loopExpansionBound = 0;
	let syntheticSummaryNodes = 0;
	for (const task of tasks) {
		edges += task.dependsOn?.length ?? 0;
		if (task.when) conditionals += 1;
		if (task.workflow?.tasks) {
			syntheticSummaryNodes += 1;
			const childTasks = normalizeTaskCollection(task.workflow.tasks);
			const child = countTasks(childTasks, depth + 1);
			runnableTasks += child.runnableTasks;
			edges += child.edges;
			conditionals += child.conditionals;
			nestedWorkflowDepth = Math.max(nestedWorkflowDepth, child.nestedWorkflowDepth);
			loopExpansionBound += child.loopExpansionBound;
			syntheticSummaryNodes += child.syntheticSummaryNodes;
			continue;
		}
		if (task.loop) {
			syntheticSummaryNodes += 1;
			loopExpansionBound += task.loop.maxIterations;
			const bodyTasks = normalizeTaskCollection(task.loop.body);
			const body = countTasks(bodyTasks, depth);
			runnableTasks += body.runnableTasks * task.loop.maxIterations;
			edges += body.edges * task.loop.maxIterations;
			conditionals += body.conditionals * task.loop.maxIterations;
			nestedWorkflowDepth = Math.max(nestedWorkflowDepth, body.nestedWorkflowDepth);
			loopExpansionBound += body.loopExpansionBound * task.loop.maxIterations;
			syntheticSummaryNodes += body.syntheticSummaryNodes * task.loop.maxIterations;
			continue;
		}
		runnableTasks += 1;
	}
	return { runnableTasks, edges, conditionals, nestedWorkflowDepth, loopExpansionBound, syntheticSummaryNodes };
}

function normalizeTaskCollection(tasks: SubagentTask[] | Record<string, SubagentTask>): SubagentTask[] {
	return Array.isArray(tasks) ? tasks : Object.entries(tasks).map(([name, task]) => ({ ...task, name: task.name ?? name }));
}
```

- [x] **Step 4: Implement objective scoring**

Create `src/optimizer/objective.ts`:

```ts
import type { FlowResult, UsageStats } from "../types.js";
import type { CaseRunResult, EvaluationMetrics, GraphMetrics, OptimizerObjectiveWeights } from "./types.js";

export function summarizeRuns(runs: CaseRunResult[]): EvaluationMetrics {
	const failures = runs.filter((run) => run.result.status !== "completed").length;
	const dollarCost = runs.reduce((sum, run) => sum + usageCost(run.result.usage), 0);
	const wallTimeMs = runs.reduce((sum, run) => sum + run.wallTimeMs, 0);
	return {
		taskScore: runs.length === 0 ? 0 : (runs.length - failures) / runs.length,
		dollarCost,
		wallTimeMs,
		failureRate: runs.length === 0 ? 1 : failures / runs.length,
		runs: runs.length,
		failures,
	};
}

export function computeUtility(metrics: EvaluationMetrics, graph: Pick<GraphMetrics, "complexity">, weights: OptimizerObjectiveWeights): number {
	return metrics.taskScore * weights.taskScore
		- metrics.dollarCost * weights.cost
		- (metrics.wallTimeMs / 1000) * weights.latency
		- metrics.failureRate * weights.instability
		- graph.complexity * weights.complexity;
}

function usageCost(usage: FlowResult["usage"] | UsageStats | undefined): number {
	return typeof usage?.cost === "number" ? usage.cost : 0;
}
```

- [x] **Step 5: Run metric tests**

Run:

```bash
npm test -- tests/optimizer.test.ts
```

Expected: optimizer tests pass.

- [x] **Step 6: Commit**

```bash
git add src/optimizer/graph-metrics.ts src/optimizer/objective.ts tests/optimizer.test.ts
git commit -m "feat: score optimizer candidates"
```

---

### Task 4: Implement evaluator and dry-run report generation

**Files:**
- Create: `src/optimizer/evaluator.ts`
- Create: `src/optimizer/report.ts`
- Modify: `tests/optimizer.test.ts`

- [x] **Step 1: Add failing evaluator/report tests**

Append to `tests/optimizer.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises";
import { evaluateOptimizerRun } from "../src/optimizer/evaluator.js";
import { formatOptimizerReport, writeOptimizerReport } from "../src/optimizer/report.js";
import { MockSubagentRunner } from "../src/index.js";

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

	assert.match(saved, /"evalSetName": "inline-docs"/);
	assert.match(formatOptimizerReport(report), /subflow_optimize dry-run report/);
});
```

- [x] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/optimizer.test.ts
```

Expected: fails because evaluator/report modules do not exist.

- [x] **Step 3: Implement evaluator**

Create `src/optimizer/evaluator.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeDagYaml, normalizeNestedWorkflows, parseDagYaml } from "../dag-yaml.js";
import { runDag } from "../flows/dag.js";
import { validateDagTasks } from "../flows/dag-validation.js";
import type { ExecutionOptions, SubagentRunner, SubagentTask } from "../types.js";
import { loadEvalSet } from "./eval-set.js";
import { computeGraphMetrics } from "./graph-metrics.js";
import { computeUtility, summarizeRuns } from "./objective.js";
import type { CandidateEvaluation, EvalSetInput, OptimizerReport, WorkflowCandidate } from "./types.js";

export interface EvaluateOptimizerRunInput {
	cwd: string;
	workflowPath?: string;
	dagYaml?: string;
	evalSet: EvalSetInput;
	candidateDagYamls?: string[];
	runner: SubagentRunner;
	maxCandidateRuns?: number;
	maxCost?: number;
	maxConcurrency?: number;
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

export async function evaluateOptimizerRun(input: EvaluateOptimizerRunInput): Promise<OptimizerReport> {
	const loadedEval = await loadEvalSet({ cwd: input.cwd, evalSet: input.evalSet });
	const baselineTasks = await loadWorkflowTasks(input);
	validateDagTasks(baselineTasks);
	const baseline = await evaluateCandidate({ id: "baseline", label: "Baseline", tasks: baselineTasks }, input, loadedEval.evalSet.objective, loadedEval.evalSet.scoring.minRunsPerCase);
	const candidates: CandidateEvaluation[] = [];
	for (const [index, dagYaml] of (input.candidateDagYamls ?? []).entries()) {
		try {
			const tasks = normalizeNestedWorkflows({ tasks: parseDagYaml(dagYaml) }).tasks ?? [];
			validateDagTasks(tasks);
			candidates.push(await evaluateCandidate({ id: `candidate-${index + 1}`, label: `Candidate ${index + 1}`, tasks, dagYaml }, input, loadedEval.evalSet.objective, Math.min(loadedEval.evalSet.scoring.minRunsPerCase, input.maxCandidateRuns ?? loadedEval.evalSet.scoring.minRunsPerCase)));
		} catch (error) {
			candidates.push({ id: `candidate-${index + 1}`, label: `Candidate ${index + 1}`, status: "invalid", dagYaml, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return {
		reportId: `opt-${Date.now().toString(36)}`,
		createdAt: new Date().toISOString(),
		evalSetName: loadedEval.evalSet.name,
		source: loadedEval.source,
		persistenceRecommendation: loadedEval.persistenceRecommendation,
		baseline,
		candidates,
		recommendation: recommend(baseline, candidates, loadedEval.evalSet.scoring.minUtilityDelta),
		warnings: warnings(loadedEval.evalSet.scoring.minRunsPerCase, loadedEval.persistenceRecommendation),
	};
}

async function loadWorkflowTasks(input: EvaluateOptimizerRunInput): Promise<SubagentTask[]> {
	if (Boolean(input.workflowPath) === Boolean(input.dagYaml)) throw new Error("subflow_optimize requires exactly one of workflowPath or dagYaml");
	if (input.dagYaml) return normalizeDagYaml({ dagYaml: input.dagYaml }).tasks ?? [];
	const source = await readFile(resolve(input.cwd, input.workflowPath ?? ""), "utf8");
	return normalizeDagYaml({ dagYaml: source }).tasks ?? [];
}

async function evaluateCandidate(candidate: WorkflowCandidate, input: EvaluateOptimizerRunInput, objective: Parameters<typeof computeUtility>[2], runsPerCase: number): Promise<CandidateEvaluation> {
	const graph = computeGraphMetrics(candidate.tasks);
	const runs = [];
	for (let index = 0; index < runsPerCase; index += 1) {
		const started = Date.now();
		const result = await runDag({ tasks: candidate.tasks }, executionOptions(input));
		runs.push({ caseName: `run-${index + 1}`, result, wallTimeMs: Date.now() - started });
		if (input.maxCost !== undefined && summarizeRuns(runs).dollarCost > input.maxCost) break;
	}
	const metrics = summarizeRuns(runs);
	return { ...candidate, status: metrics.failures > 0 ? "failed" : "completed", metrics, utility: computeUtility(metrics, graph, objective), graph };
}

function executionOptions(input: EvaluateOptimizerRunInput): ExecutionOptions {
	return { runner: input.runner, maxConcurrency: input.maxConcurrency, timeoutSeconds: input.timeoutSeconds, maxCost: input.maxCost, signal: input.signal };
}

function recommend(baseline: CandidateEvaluation, candidates: CandidateEvaluation[], minDelta: number): string {
	const valid = candidates.filter((candidate) => candidate.status === "completed" && candidate.utility !== undefined && baseline.utility !== undefined);
	if (valid.length === 0) return candidates.length === 0 ? "No candidates supplied; baseline profile only." : "No valid completed candidates to recommend.";
	const best = valid.toSorted((a, b) => (b.utility ?? -Infinity) - (a.utility ?? -Infinity))[0];
	const delta = (best.utility ?? 0) - (baseline.utility ?? 0);
	return delta >= minDelta ? `${best.label} improves utility by ${delta.toFixed(4)}; dry-run recommendation only.` : "No candidate cleared the minimum utility delta; keep the baseline.";
}

function warnings(minRunsPerCase: number, persistenceRecommendation?: string): string[] {
	const warnings = [];
	if (minRunsPerCase === 1) warnings.push("Single-run comparisons are noisy; treat utility deltas as directional until repeated runs are configured.");
	if (persistenceRecommendation) warnings.push(persistenceRecommendation);
	return warnings;
}
```

- [x] **Step 4: Implement report formatting/writing**

Create `src/optimizer/report.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CandidateEvaluation, OptimizerReport } from "./types.js";

export function formatOptimizerReport(report: OptimizerReport): string {
	const lines = [
		`subflow_optimize dry-run report: ${report.evalSetName}`,
		`Report ID: ${report.reportId}`,
		`Baseline: ${formatCandidate(report.baseline)}`,
	];
	if (report.candidates.length) {
		lines.push("Candidates:");
		for (const candidate of report.candidates) lines.push(`- ${formatCandidate(candidate)}`);
	} else {
		lines.push("Candidates: none supplied");
	}
	lines.push(`Recommendation: ${report.recommendation}`);
	if (report.warnings.length) {
		lines.push("Warnings:");
		for (const warning of report.warnings) lines.push(`- ${warning}`);
	}
	return lines.join("\n");
}

export async function writeOptimizerReport(cwd: string, report: OptimizerReport): Promise<string> {
	const dir = join(cwd, ".pi", "subflow", "optimizer-reports");
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${report.reportId}.json`);
	await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
	return path;
}

function formatCandidate(candidate: CandidateEvaluation): string {
	if (candidate.status === "invalid") return `${candidate.label} invalid (${candidate.error ?? "unknown error"})`;
	const utility = candidate.utility === undefined ? "n/a" : candidate.utility.toFixed(4);
	const runs = candidate.metrics?.runs ?? 0;
	const failures = candidate.metrics?.failures ?? 0;
	return `${candidate.label} ${candidate.status}, utility=${utility}, runs=${runs}, failures=${failures}`;
}
```

- [x] **Step 5: Run evaluator/report tests**

Run:

```bash
npm test -- tests/optimizer.test.ts
```

Expected: optimizer tests pass.

- [x] **Step 6: Commit**

```bash
git add src/optimizer/evaluator.ts src/optimizer/report.ts tests/optimizer.test.ts
git commit -m "feat: evaluate optimizer dry runs"
```

---

### Task 5: Register `subflow_optimize` as a Pi tool

**Files:**
- Create: `src/optimizer/tool.ts`
- Modify: `src/extension.ts`
- Modify: `tests/extension.test.ts`

- [x] **Step 1: Update fake Pi in tests to support multiple tools**

Modify `fakePi()` in `tests/extension.test.ts` so existing tests still use `pi.tool` and new tests can use `pi.tools.get("subflow_optimize")`:

```ts
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
```

- [x] **Step 2: Add failing extension tests for optimizer registration**

Append to `tests/extension.test.ts`:

```ts
test("subflow extension registers subflow_optimize with LLM-facing guidance", () => {
	const pi = fakePi();
	registerPiSubflowExtension(pi);
	const tool = pi.tools.get("subflow_optimize");

	assert.equal(tool.name, "subflow_optimize");
	assert.match(tool.promptSnippet, /dry-run optimizer/);
	assert(tool.promptGuidelines.some((line: string) => /canonical.*\.pi\/subflow\/evals/.test(line)));
	assert(tool.promptGuidelines.some((line: string) => /does not mutate/.test(line)));
});

test("subflow_optimize runs a baseline dry-run and writes a report", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-opt-tool-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner });
	const tool = pi.tools.get("subflow_optimize");

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
	assert.match(result.content[0].text, /Save this inline eval set/);
});
```

- [x] **Step 3: Run extension tests to verify failure**

Run:

```bash
npm test -- tests/extension.test.ts
```

Expected: fails because `subflow_optimize` is not registered.

- [x] **Step 4: Implement optimizer tool module**

Create `src/optimizer/tool.ts`:

```ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentDefinition } from "../agents.js";
import { PiSdkRunner } from "../runner.js";
import type { SubagentRunner } from "../types.js";
import { evaluateOptimizerRun, type EvaluateOptimizerRunInput } from "./evaluator.js";
import { formatOptimizerReport, writeOptimizerReport } from "./report.js";

export interface SubflowOptimizeToolParams {
	workflowPath?: string;
	dagYaml?: string;
	evalSet: { path?: string; inline?: unknown };
	candidateDagYamls?: string[];
	maxCandidateRuns?: number;
	maxCost?: number;
	maxConcurrency?: number;
	timeoutSeconds?: number;
}

export const subflowOptimizeParameterSchema = Type.Object({
	workflowPath: Type.Optional(Type.String({ minLength: 1 })),
	dagYaml: Type.Optional(Type.String({ minLength: 1 })),
	evalSet: Type.Object({ path: Type.Optional(Type.String({ minLength: 1 })), inline: Type.Optional(Type.Any()) }),
	candidateDagYamls: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	maxCandidateRuns: Type.Optional(Type.Number()),
	maxCost: Type.Optional(Type.Number()),
	maxConcurrency: Type.Optional(Type.Number()),
	timeoutSeconds: Type.Optional(Type.Number()),
});

export function createSubflowOptimizeTool(options: {
	discoverRunner: (ctx: ExtensionContext, params: SubflowOptimizeToolParams) => Promise<SubagentRunner> | SubagentRunner;
}) {
	return {
		name: "subflow_optimize",
		label: "Pi Subflow Optimizer",
		description: "Dry-run optimizer for pi-subflow DAG workflows using eval sets and candidate comparison.",
		promptSnippet: "subflow_optimize: dry-run optimizer for authored DAG workflows; evaluates a baseline and optional manual candidates against canonical eval sets without mutating workflow files.",
		promptGuidelines: [
			"Use subflow_optimize for ADR 0003 workflow optimization experiments, not for normal subagent delegation.",
			"Eval sets should live canonically under .pi/subflow/evals/*.yaml; inline evalSet is convenience only and should be saved if useful.",
			"The tool does not mutate workflow files; future apply behavior must be separate from this dry-run report.",
			"Pass exactly one of workflowPath or dagYaml, and exactly one of evalSet.path or evalSet.inline.",
			"Manual candidateDagYamls are validated before execution; invalid candidates are reported and not run.",
		],
		renderShell: "self" as const,
		parameters: subflowOptimizeParameterSchema,
		renderCall(args: unknown) {
			const params = args as SubflowOptimizeToolParams;
			return new Text(`subflow_optimize ${params.workflowPath ?? "inline dagYaml"}`, 0, 0);
		},
		renderResult(result: { content: Array<{ type: string; text?: string }> }) {
			return new Text(result.content.map((item) => item.text ?? "").join("\n"), 0, 0);
		},
		async execute(_toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const params = rawParams as SubflowOptimizeToolParams;
			const runner = await options.discoverRunner(ctx, params);
			const report = await evaluateOptimizerRun({ ...(params as EvaluateOptimizerRunInput), cwd: ctx.cwd, runner, signal: signal ?? ctx.signal });
			const reportPath = await writeOptimizerReport(ctx.cwd, report);
			const text = `${formatOptimizerReport(report)}\nReport artifact: ${reportPath}`;
			return { content: [{ type: "text" as const, text }], details: { ...report, reportPath }, isError: false };
		},
	};
}

export function defaultOptimizerRunner(_agents: Map<string, AgentDefinition>): SubagentRunner {
	return new PiSdkRunner({ agentDefinitions: _agents });
}
```

- [x] **Step 5: Register optimizer tool from extension**

In `src/extension.ts`, import:

```ts
import { createSubflowOptimizeTool, type SubflowOptimizeToolParams } from "./optimizer/tool.js";
```

After the existing `pi.registerTool({ name: "subflow", ... })` block, register the optimizer:

```ts
pi.registerTool(createSubflowOptimizeTool({
	discoverRunner: async (ctx, params: SubflowOptimizeToolParams) => {
		const agents = await discoverAgents({
			scope: "user",
			userDir: options.userDir ?? join(homedir(), ".pi", "agent", "agents"),
			projectDir: options.projectDir ?? join(ctx.cwd, ".pi", "agents"),
		});
		return options.runnerFactory?.({ agents, ctx, params: params as never }) ?? new PiSdkRunner({ agentDefinitions: agents });
	},
}));
```

If `runnerFactory` typing rejects `SubflowOptimizeToolParams`, widen `PiSubflowExtensionOptions.runnerFactory` to accept `params: SubflowToolParams | SubflowOptimizeToolParams`.

- [x] **Step 6: Run extension tests**

Run:

```bash
npm test -- tests/extension.test.ts
```

Expected: extension tests pass.

- [x] **Step 7: Commit**

```bash
git add src/optimizer/tool.ts src/extension.ts tests/extension.test.ts
git commit -m "feat: register subflow optimizer tool"
```

---

### Task 6: Enforce policy, allowlist, and project path safety for optimizer runs

**Files:**
- Modify: `src/optimizer/evaluator.ts`
- Modify: `src/extension.ts`
- Modify: `tests/optimizer.test.ts`
- Modify: `tests/extension.test.ts`

- [x] **Step 1: Add failing safety tests**

Append to `tests/optimizer.test.ts`:

```ts
test("evaluateOptimizerRun rejects workflow paths outside the project", async () => {
	await assert.rejects(
		() => evaluateOptimizerRun({
			cwd: await tmpProject(),
			workflowPath: "../workflow.yaml",
			evalSet: { inline: { name: "x", objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0 }, scoring: { minRunsPerCase: 1, minUtilityDelta: 0, maxFailureRateRegression: 0 }, cases: [{ name: "one", input: "x" }] } },
			runner: new MockSubagentRunner({ mock: async () => "ok" }),
		}),
		/workflowPath must stay inside the project/,
	);
});
```

Append to `tests/extension.test.ts`:

```ts
test("subflow_optimize rejects disallowed candidate tools before running", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-subflow-opt-tool-"));
	const runner = new RecordingRunner();
	const pi = fakePi();
	registerPiSubflowExtension(pi, { runnerFactory: () => runner, allowedTools: ["read"] });
	const tool = pi.tools.get("subflow_optimize");

	await assert.rejects(
		() => tool.execute("call-1", {
			dagYaml: "review:\n  agent: worker\n  tools: [write]\n  task: Review docs\n",
			evalSet: { inline: { name: "inline-docs", objective: { taskScore: 1, cost: 0, latency: 0, instability: 1, complexity: 0 }, scoring: { minRunsPerCase: 1, minUtilityDelta: 0.05, maxFailureRateRegression: 0 }, cases: [{ name: "one", input: "Check docs" }] } },
		}, undefined, undefined, fakeCtx(cwd)),
		/tool write is not allowed/,
	);
	assert.equal(runner.calls.length, 0);
});
```

- [x] **Step 2: Run safety tests to verify failure**

Run:

```bash
npm test -- tests/optimizer.test.ts tests/extension.test.ts
```

Expected: the new safety tests fail.

- [x] **Step 3: Harden workflow path resolution**

In `src/optimizer/evaluator.ts`, replace direct `resolve(input.cwd, input.workflowPath ?? "")` use with:

```ts
import { isAbsolute, relative, resolve } from "node:path";

function resolveWorkflowPath(cwd: string, path: string): string {
	if (isAbsolute(path)) throw new Error("workflowPath must be relative to the project");
	const resolved = resolve(cwd, path);
	const rel = relative(cwd, resolved);
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("workflowPath must stay inside the project");
	return resolved;
}
```

Then use:

```ts
const source = await readFile(resolveWorkflowPath(input.cwd, input.workflowPath ?? ""), "utf8");
```

- [x] **Step 4: Reuse policy and tool allowlist in optimizer registration**

In `src/extension.ts`, before creating the runner for optimizer execution, normalize all baseline/candidate DAGs enough to inspect tasks and call existing validators. Add a small helper if needed:

```ts
function optimizerTasksForPolicy(params: SubflowOptimizeToolParams): SubagentTask[] {
	const tasks: SubagentTask[] = [];
	if (params.dagYaml) tasks.push(...normalizeNestedWorkflows(normalizeDagYaml({ dagYaml: params.dagYaml })).tasks ?? []);
	for (const dagYaml of params.candidateDagYamls ?? []) {
		try {
			tasks.push(...normalizeNestedWorkflows(normalizeDagYaml({ dagYaml })).tasks ?? []);
		} catch {
			// Invalid candidates are reported by the optimizer evaluator and are not executed.
		}
	}
	return tasks;
}
```

Use it inside `discoverRunner`:

```ts
const flowTasks = optimizerTasksForPolicy(params);
validateNonEmptyStrings(flowTasks);
validateExecutionPolicy({
	agentScope: "user",
	confirmProjectAgents: true,
	hasUI: ctx.hasUI,
	riskTolerance: "low",
	allowExternalSideEffectWithoutConfirmation: false,
	tasks: flowTasks,
});
validateToolAllowlist(flowTasks, options.allowedTools);
```

- [x] **Step 5: Run safety tests**

Run:

```bash
npm test -- tests/optimizer.test.ts tests/extension.test.ts
```

Expected: safety tests pass.

- [x] **Step 6: Commit**

```bash
git add src/optimizer/evaluator.ts src/extension.ts tests/optimizer.test.ts tests/extension.test.ts
git commit -m "fix: enforce optimizer safety gates"
```

---

### Task 7: Document optimizer MVP and schema/example discovery

**Files:**
- Modify: `README.md`
- Create: `doc/wiki/Workflow-optimization.md`
- Modify: `doc/wiki/Roadmap.md`
- Modify: `doc/adr/0003-self-optimizing-static-dags.md`
- Modify: `tests/package.test.ts`

- [x] **Step 1: Add failing docs tests**

Append to `tests/package.test.ts`:

```ts
test("docs describe Pi-native optimizer eval sets and dry-run safety", async () => {
	const readme = await readFile("README.md", "utf8");
	const roadmap = await readFile("doc/wiki/Roadmap.md", "utf8");
	const workflowOptimization = await readFile("doc/wiki/Workflow-optimization.md", "utf8");
	const adr = await readFile("doc/adr/0003-self-optimizing-static-dags.md", "utf8");

	assert.match(readme, /subflow_optimize/);
	assert.match(readme, /schemas\/subflow-eval.schema.json/);
	assert.match(roadmap, /dry-run-only Pi tool/);
	assert.match(workflowOptimization, /.pi\/subflow\/evals/);
	assert.match(workflowOptimization, /subflow_optimize_apply/);
	assert.match(adr, /subflow_optimize/);
});
```

- [x] **Step 2: Run docs tests to verify failure**

Run:

```bash
npm test -- tests/package.test.ts
```

Expected: fails because docs are not updated.

- [x] **Step 3: Update README**

Add to README feature list:

```md
- Dry-run workflow optimization with `subflow_optimize`, eval sets, objective scoring, and candidate comparison
```

Add to Documentation list:

```md
- [`schemas/subflow-eval.schema.json`](schemas/subflow-eval.schema.json) — YAML schema for optimizer eval sets
- [`doc/wiki/Workflow-optimization.md`](doc/wiki/Workflow-optimization.md) — dry-run optimizer, eval sets, reports, and safety model
```

- [x] **Step 4: Create workflow optimization wiki page**

Create `doc/wiki/Workflow-optimization.md`:

```md
# Workflow optimization

`subflow_optimize` is the ADR 0003 dry-run optimizer for authored pi-subflow DAG workflows. It evaluates a baseline workflow and optional manually supplied candidate DAG YAMLs against the same eval set and objective function.

The first version never mutates workflow files. A future apply operation, if added, should be a separate `subflow_optimize_apply({ reportId })` flow that consumes a saved report artifact.

## Eval sets

Canonical eval sets live under `.pi/subflow/evals/*.yaml`. Inline eval sets are accepted for ad-hoc exploration, but useful inline evals should be saved to `.pi/subflow/evals/<name>.yaml` so they can be reviewed, committed, and reused.

```yaml
name: docs-consistency
workflow: examples/workflows/docs-consistency.yaml
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
  - name: readme-wiki-adr-schema-sync
    input: Check README.md, doc/wiki, doc/adr, schemas, and src/extension.ts guidance for consistency.
    expectedSections: [Summary, Findings, Recommendation]
```

## Objective

```text
utility = task_score
        - λ_cost * dollar_cost
        - λ_latency * wall_time
        - λ_instability * failure_rate
        - λ_complexity * graph_complexity
```

Single-run comparisons are noisy. Treat one-run reports as profiling and require repeated runs before trusting small utility deltas.

## Safety model

- Baseline and candidate DAGs are parsed, normalized, and validated before execution.
- Invalid candidates are reported and not run.
- The tool reuses policy gates, tool allowlists, budget controls, and timeout controls.
- Reports are written under `.pi/subflow/optimizer-reports/`.
```

- [x] **Step 5: Update roadmap and ADR**

In `doc/wiki/Roadmap.md`, add this sentence under Workflow optimization:

```md
The MVP is a dry-run-only Pi tool, `subflow_optimize`, with canonical eval files under `.pi/subflow/evals/*.yaml`, inline evals as a convenience, manually supplied candidate DAG YAMLs, and JSON reports under `.pi/subflow/optimizer-reports/`.
```

In ADR 0003 Follow-up, add:

```md
- Expose the MVP as a dry-run-only Pi tool named `subflow_optimize`; keep mutation as a future separate apply operation that consumes a saved report.
```

- [x] **Step 6: Run docs tests**

Run:

```bash
npm test -- tests/package.test.ts
```

Expected: docs tests pass.

- [x] **Step 7: Commit**

```bash
git add README.md doc/wiki/Workflow-optimization.md doc/wiki/Roadmap.md doc/adr/0003-self-optimizing-static-dags.md tests/package.test.ts
git commit -m "docs: document subflow optimizer MVP"
```

---

### Task 8: Final integration, exports, and verification

**Files:**
- Modify: `src/index.ts` if public exports are needed
- Modify: tests as needed for type/import stability

- [x] **Step 1: Decide public exports**

Keep optimizer internals private unless tests or downstream users need them. If exporting is useful for tests and API consistency, add only stable helper exports to `src/index.ts`:

```ts
export { loadEvalSet } from "./optimizer/eval-set.js";
export { computeGraphMetrics } from "./optimizer/graph-metrics.js";
export { computeUtility, summarizeRuns } from "./optimizer/objective.js";
export type { EvalSet, OptimizerReport } from "./optimizer/types.js";
```

- [x] **Step 2: Run full build and test**

Run:

```bash
npm run build && npm test
```

Expected: TypeScript build succeeds and all tests pass.

- [x] **Step 3: Run Biome check and note pre-existing warnings if any**

Run:

```bash
npm run check
```

Expected: no errors. If warnings exist in unrelated pre-existing files, do not expand scope unless the warning blocks commit hooks.

- [x] **Step 4: Fix any TypeScript or test failures from integration**

Common fixes:

```ts
// If TypeScript complains about unknown inline eval shape in tool params,
// cast only at the boundary after schema validation.
const report = await evaluateOptimizerRun({
	cwd: ctx.cwd,
	workflowPath: params.workflowPath,
	dagYaml: params.dagYaml,
	evalSet: params.evalSet as EvaluateOptimizerRunInput["evalSet"],
	candidateDagYamls: params.candidateDagYamls,
	runner,
	maxCandidateRuns: params.maxCandidateRuns,
	maxCost: params.maxCost,
	maxConcurrency: params.maxConcurrency,
	timeoutSeconds: params.timeoutSeconds,
	signal: signal ?? ctx.signal,
});
```

- [x] **Step 5: Commit final integration fixes**

If changes were needed:

```bash
git add src tests README.md doc schemas examples
git commit -m "test: verify optimizer integration"
```

If no changes were needed, skip this commit.

- [x] **Step 6: Report final verification**

Final response must include:

```text
Implemented ADR 0003 optimizer MVP.
Verification: npm run build && npm test passed.
Notes: subflow_optimize is dry-run-only; mutation remains a future separate apply operation.
```

---

## Self-review

- Spec coverage: The plan covers parser extraction, eval schema/loader, graph metrics, utility scoring, evaluator, report writing, Pi tool registration, safety gates, docs, examples, and final verification.
- Placeholder scan: No task relies on unspecified implementation; each module has concrete function names, type shapes, commands, and expected outcomes.
- Type consistency: Tool params use `workflowPath`, `dagYaml`, `evalSet`, `candidateDagYamls`, `maxCandidateRuns`, `maxCost`, `maxConcurrency`, and `timeoutSeconds` consistently across tests, evaluator, and tool registration.
- Scope control: LLM candidate generation, automatic mutation, dynamic runtime graph mutation, and rich trace instrumentation remain explicit follow-up work outside this MVP.
