# PocketFlow DAG Node Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `runDag` execute through explicit PocketFlow nodes instead of a placeholder `Flow` import, while preserving public API and behavior.

**Architecture:** Add an internal PocketFlow DAG runtime module that wraps existing DAG behavior in semantic PocketFlow `Node` classes. `src/flows/dag.ts` remains the public implementation entrypoint but delegates to the node-backed runtime. Tests verify both behavior preservation and that PocketFlow node phases actually execute.

**Tech Stack:** TypeScript, Node.js test runner, `pocketflow`, existing `SubagentRunner` test mocks, Biome.

---

## File structure

- Create: `src/flows/pocketflow-dag.ts`
  - Owns the internal PocketFlow-backed DAG runtime.
  - Exports `runPocketFlowDag(input, options)` for `runDag` to call.
  - Exports `POCKETFLOW_DAG_NODE_TRACE_PREFIX` for focused internal tests if needed.
- Modify: `src/flows/dag.ts`
  - Remove placeholder `Flow` import and delegate `runDag` to `runPocketFlowDag`.
  - Keep existing helper functions either in this file or move them only if needed. Do not change public exports from `src/index.ts`.
- Modify/Test: `tests/flows.test.ts`
  - Add failing tests proving DAG execution records explicit PocketFlow node phases and preserves behavior.
- Modify docs if implementation changes wording:
  - `doc/adr/0001-pocketflow-orchestration-core.md`
  - Possibly `README.md`

---

### Task 1: Add failing tests for PocketFlow-backed DAG phases

**Files:**
- Modify: `tests/flows.test.ts`

- [ ] **Step 1: Add a test that expects DAG PocketFlow node phase markers**

Append this test near the existing `runDag executes dependencies before verifier and injects dependency outputs` test:

```ts
test("runDag executes through PocketFlow DAG node phases", async () => {
	const runner = new MockSubagentRunner({
		planner: "plan",
		reviewer: "review",
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
```

If TypeScript complains that `TraceEvent.type` does not allow `"pocketflow_node"`, update `src/types.ts` in Task 2.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- tests/flows.test.ts
```

Expected: FAIL because current `runDag` does not emit `pocketflow_node` trace events.

---

### Task 2: Add a typed trace marker for internal PocketFlow nodes

**Files:**
- Modify: `src/types.ts`
- Test: `tests/flows.test.ts`

- [ ] **Step 1: Extend `TraceEvent` with a `pocketflow_node` event**

Find the `TraceEvent` type in `src/types.ts` and add a union member shaped like:

```ts
| { type: "pocketflow_node"; name: string; timestamp: number }
```

Keep all existing trace event variants unchanged.

- [ ] **Step 2: Run the focused test and verify the behavior failure remains**

Run:

```bash
npm test -- tests/flows.test.ts
```

Expected: still FAIL, but not with a TypeScript/type error. The failure should be the missing trace events.

---

### Task 3: Introduce the PocketFlow DAG runtime skeleton

**Files:**
- Create: `src/flows/pocketflow-dag.ts`
- Modify: `src/flows/dag.ts`
- Test: `tests/flows.test.ts`

- [ ] **Step 1: Create `src/flows/pocketflow-dag.ts` with node classes and a temporary delegation path**

Create the file with this structure:

```ts
import { Flow, Node } from "pocketflow";
import type { ExecutionOptions, FlowResult, SubagentTask, TraceEvent } from "../types.js";
import { runDagImperative } from "./dag.js";

export const POCKETFLOW_DAG_NODE_TRACE_TYPE = "pocketflow_node" as const;

type DagShared = {
	input: { tasks: SubagentTask[] };
	options: ExecutionOptions;
	trace: TraceEvent[];
	result?: FlowResult;
};

abstract class DagNode extends Node<DagShared> {
	constructor(private readonly nodeName: string) {
		super();
	}

	protected mark(shared: DagShared): void {
		shared.trace.push({ type: POCKETFLOW_DAG_NODE_TRACE_TYPE, name: this.nodeName, timestamp: Date.now() });
	}
}

class ValidateDagNode extends DagNode {
	constructor() {
		super("validate-dag");
	}
	async post(shared: DagShared): Promise<string | undefined> {
		this.mark(shared);
		return "max-turns-guard";
	}
}

class MaxTurnsGuardNode extends DagNode {
	constructor() {
		super("max-turns-guard");
	}
	async post(shared: DagShared): Promise<string | undefined> {
		this.mark(shared);
		return "execute-dag-stages";
	}
}

class ExecuteDagStagesNode extends DagNode {
	constructor() {
		super("execute-dag-stages");
	}
	async post(shared: DagShared): Promise<string | undefined> {
		this.mark(shared);
		const result = await runDagImperative(shared.input, { ...shared.options, trace: shared.trace });
		shared.result = result;
		return "verifier-repair";
	}
}

class VerifierRepairNode extends DagNode {
	constructor() {
		super("verifier-repair");
	}
	async post(shared: DagShared): Promise<string | undefined> {
		this.mark(shared);
		return "aggregate-dag-result";
	}
}

class AggregateDagResultNode extends DagNode {
	constructor() {
		super("aggregate-dag-result");
	}
	async post(shared: DagShared): Promise<string | undefined> {
		this.mark(shared);
		return undefined;
	}
}

export async function runPocketFlowDag(input: { tasks: SubagentTask[] }, options: ExecutionOptions): Promise<FlowResult> {
	const shared: DagShared = { input, options, trace: [] };
	const validate = new ValidateDagNode();
	validate.on("max-turns-guard", new MaxTurnsGuardNode()).on("execute-dag-stages", new ExecuteDagStagesNode()).on("verifier-repair", new VerifierRepairNode()).on("aggregate-dag-result", new AggregateDagResultNode());
	await new Flow(validate).run(shared);
	if (!shared.result) throw new Error("PocketFlow DAG produced no result");
	return { ...shared.result, trace: shared.trace };
}
```

This skeleton is intentionally temporary: it proves PocketFlow nodes run first, then delegates existing behavior. Later tasks remove the delegation cycle or factor imperative execution cleanly.

- [ ] **Step 2: Factor current `runDag` implementation in `src/flows/dag.ts`**

Rename the existing exported function body to an internal exported helper:

```ts
export async function runDagImperative(input: { tasks: SubagentTask[] }, options: ExecutionOptions & { trace?: TraceEvent[] }): Promise<FlowResult> {
	const trace = options.trace ?? [];
	// existing runDag body, but do not redeclare trace as a new array unconditionally
}
```

Then add the new public `runDag`:

```ts
import { runPocketFlowDag } from "./pocketflow-dag.js";

export async function runDag(input: { tasks: SubagentTask[] }, options: ExecutionOptions): Promise<FlowResult> {
	return runPocketFlowDag(input, options);
}
```

Remove the old `import { Flow } from "pocketflow";` and `void Flow;` from `src/flows/dag.ts`.

- [ ] **Step 3: Run the focused test**

Run:

```bash
npm test -- tests/flows.test.ts
```

Expected: likely FAIL because PocketFlow transitions may require each node to register successors directly, or trace ordering may include stage events between markers. Fix only the skeleton wiring needed to get the node marker test passing.

---

### Task 4: Move validation and max-turns preflight into real PocketFlow nodes

**Files:**
- Modify: `src/flows/pocketflow-dag.ts`
- Modify: `src/flows/dag.ts`
- Test: `tests/flows.test.ts`

- [ ] **Step 1: Move validation logic from `runDagImperative` into `ValidateDagNode`**

Update `DagShared`:

```ts
import type { NormalizedDagTask } from "./dag-validation.js";

type DagShared = {
	input: { tasks: SubagentTask[] };
	options: ExecutionOptions;
	trace: TraceEvent[];
	tasks?: NormalizedDagTask[];
	result?: FlowResult;
};
```

In `ValidateDagNode.post`, call:

```ts
const validation = validateDagTasks(shared.input.tasks);
if (validation.issues.length > 0) throw new Error(validation.issues[0].message);
shared.tasks = validation.tasks;
```

- [ ] **Step 2: Move max-turns preflight into `MaxTurnsGuardNode`**

In `MaxTurnsGuardNode.post`, implement the existing guard exactly:

```ts
const tasks = shared.tasks ?? [];
const hasLoop = tasks.some((task) => Boolean(task.loop));
if (!hasLoop && shared.options.maxTurns !== undefined) {
	const runnableTaskCount = tasks.filter((task) => task.synthetic !== "workflow_summary").length;
	if (shared.options.maxTurns < runnableTaskCount) {
		throw new Error(`maxTurns ${shared.options.maxTurns} is too low for ${runnableTaskCount} DAG tasks; increase maxTurns or remove the limit`);
	}
}
```

- [ ] **Step 3: Remove duplicated validation/preflight from `runDagImperative`**

Change `runDagImperative` to accept normalized tasks:

```ts
export async function runDagImperative(input: { tasks: NormalizedDagTask[] }, options: ExecutionOptions & { trace?: TraceEvent[] }): Promise<FlowResult> {
	const trace = options.trace ?? [];
	const tasks = input.tasks;
	// continue from byName/results setup and executeDagGraph
}
```

Update `ExecuteDagStagesNode` to call:

```ts
if (!shared.tasks) throw new Error("DAG validation did not produce tasks");
const result = await runDagImperative({ tasks: shared.tasks }, { ...shared.options, trace: shared.trace });
```

- [ ] **Step 4: Run regression tests**

Run:

```bash
npm test -- tests/flows.test.ts
```

Expected: PASS.

---

### Task 5: Make verifier repair and aggregation real node responsibilities

**Files:**
- Modify: `src/flows/dag.ts`
- Modify: `src/flows/pocketflow-dag.ts`
- Test: `tests/flows.test.ts`

- [ ] **Step 1: Split `executeDagGraph` from verifier repair in `src/flows/dag.ts`**

Create and export an internal helper that executes only the initial graph stages:

```ts
export async function executeDagStages(
	tasks: NormalizedDagTask[],
	options: ExecutionOptions,
	trace: TraceEvent[],
	results: SubagentResult[],
	byName: Map<string, SubagentResult>,
): Promise<void> {
	await executeDagGraph(tasks, options, trace, results, byName, new Set(), { runVerifierRepairs: false });
}
```

Modify `executeDagGraph` to accept an optional config:

```ts
config: { runVerifierRepairs?: boolean } = { runVerifierRepairs: true }
```

At the end, replace the unconditional repair call with:

```ts
if (config.runVerifierRepairs !== false) await runVerifierRepairs(tasks, byName, results, trace, options);
```

Export `runVerifierRepairs` if it is currently private.

- [ ] **Step 2: Update `pocketflow-dag.ts` shared state**

Add:

```ts
results: SubagentResult[];
byName: Map<string, SubagentResult>;
```

Initialize them in `runPocketFlowDag`.

- [ ] **Step 3: Make `ExecuteDagStagesNode` call `executeDagStages` only**

Replace the `runDagImperative` call with:

```ts
if (!shared.tasks) throw new Error("DAG validation did not produce tasks");
await executeDagStages(shared.tasks, shared.options, shared.trace, shared.results, shared.byName);
return "verifier-repair";
```

- [ ] **Step 4: Make `VerifierRepairNode` call `runVerifierRepairs`**

Implement:

```ts
if (!shared.tasks) throw new Error("DAG validation did not produce tasks");
await runVerifierRepairs(shared.tasks, shared.byName, shared.results, shared.trace, shared.options);
return "aggregate-dag-result";
```

- [ ] **Step 5: Make `AggregateDagResultNode` build `FlowResult`**

Import or export the existing DAG status helper. Prefer exporting `dagStatus` from `src/flows/dag.ts` if it is not exported.

Set:

```ts
shared.result = {
	status: dagStatus(shared.results),
	output: shared.results.at(-1)?.output ?? "",
	results: shared.results,
	trace: shared.trace,
};
```

- [ ] **Step 6: Run full flow tests**

Run:

```bash
npm test -- tests/flows.test.ts
```

Expected: PASS. Existing verifier repair tests must still pass.

---

### Task 6: Add documentation and package guardrails

**Files:**
- Modify: `doc/adr/0001-pocketflow-orchestration-core.md`
- Modify: `tests/package.test.ts`

- [ ] **Step 1: Add docs test for DAG PocketFlow-backed wording**

In `tests/package.test.ts`, extend the docs-related test or add a new test:

```ts
test("PocketFlow docs describe DAG node-backed execution boundary", async () => {
	const adr = await readFile(new URL("../doc/adr/0001-pocketflow-orchestration-core.md", import.meta.url), "utf8");
	assert.match(adr, /DAG execution/i);
	assert.match(adr, /PocketFlow node-backed/i);
	assert.match(adr, /chain and parallel/i);
});
```

Run:

```bash
npm test -- tests/package.test.ts
```

Expected: FAIL until ADR wording is updated.

- [ ] **Step 2: Update ADR 0001 wording**

Add a short paragraph to `doc/adr/0001-pocketflow-orchestration-core.md`:

```md
As of the DAG node integration slice, DAG execution is PocketFlow node-backed internally: validation, max-turns preflight, stage execution, verifier repair, and result aggregation run through explicit internal PocketFlow nodes. Chain and parallel modes still use custom orchestration and remain candidates for later node-backed slices.
```

- [ ] **Step 3: Run package tests**

Run:

```bash
npm test -- tests/package.test.ts
```

Expected: PASS.

---

### Task 7: Final verification and commit

**Files:**
- All changed files

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run build && npm test && npm run check
```

Expected: PASS. Biome may report existing warnings, but exit code must be 0.

- [ ] **Step 2: Inspect git diff**

Run:

```bash
git diff --stat
git diff --check
```

Expected: focused changes only; no whitespace errors.

- [ ] **Step 3: Commit**

Run:

```bash
git add src/flows/dag.ts src/flows/pocketflow-dag.ts src/types.ts tests/flows.test.ts tests/package.test.ts doc/adr/0001-pocketflow-orchestration-core.md
git commit -m "feat: route DAG execution through PocketFlow nodes"
```

Expected: commit succeeds after pre-commit verification.

---

## Self-review

- Spec coverage: The plan implements DAG node-backed execution, preserves public API, adds observability tests, and updates ADR wording. Chain/parallel rewrites are explicitly out of scope.
- Placeholder scan: No implementation step uses TBD/TODO/fill-in language; each code-changing step includes concrete target code or exact behavior.
- Type consistency: `TraceEvent` widening, `DagShared`, `runPocketFlowDag`, `runDagImperative`, `executeDagStages`, `runVerifierRepairs`, and `dagStatus` names are consistent across tasks.
