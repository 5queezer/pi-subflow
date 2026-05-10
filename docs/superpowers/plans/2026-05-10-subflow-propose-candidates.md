# Subflow Candidate Proposer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a separate `subflow_propose_candidates` Pi tool that proposes validated static DAG candidate YAMLs without executing or mutating workflows.

**Architecture:** Add a focused proposer module under `src/optimizer/` that reuses existing workflow loading, DAG parsing, YAML rendering, and validation boundaries. Register a new extension tool in `src/extension.ts`, then document the proposal→evaluation workflow in the wiki, ADR, and README.

**Tech Stack:** TypeScript, Node test runner, `yaml`, existing `pi-subflow` optimizer and DAG utilities, Biome, `npm run build && npm test`.

---

## File map

- Create `src/optimizer/proposer.ts`: public `proposeCandidates()` function, exact-one input validation, deterministic transform orchestration, candidate validation, and markdown formatting helper if needed.
- Modify `src/optimizer/types.ts`: add proposer input/output types.
- Modify `src/extension.ts`: register `subflow_propose_candidates` and add prompt guidance that distinguishes proposal from evaluation/apply.
- Modify `tests/optimizer.test.ts` or create `tests/proposer.test.ts`: red-green tests for input validation, candidate generation, rendered YAML validation, and extension registration.
- Modify `doc/wiki/Workflow-optimization.md`: document candidate proposal as separate from optimization.
- Modify `doc/adr/0003-self-optimizing-static-dags.md`: update MVP/follow-up language after implementation.
- Modify `README.md`: mention the new public tool where optimizer tools are listed.

---

### Task 1: Add proposer type contracts and failing validation test

**Files:**
- Modify: `src/optimizer/types.ts`
- Test: `tests/proposer.test.ts`

- [ ] **Step 1: Inspect existing optimizer type style**

Run:

```bash
sed -n '1,240p' src/optimizer/types.ts
sed -n '1,120p' tests/optimizer.test.ts
```

Expected: see existing `OptimizerInput`, eval-set, and report type conventions.

- [ ] **Step 2: Create failing proposer validation test**

Create `tests/proposer.test.ts` with imports adjusted to existing exported/internal paths:

```ts
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
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
node --import tsx --test tests/proposer.test.ts
```

Expected: FAIL because `src/optimizer/proposer.ts` does not exist or `proposeCandidates` is not exported.

- [ ] **Step 4: Add minimal types and stub implementation**

In `src/optimizer/types.ts`, add:

```ts
export type CandidateProposalStrategy = "safe" | "exploratory";

export type CandidateProposerInput = {
  workflowPath?: string;
  dagYaml?: string;
  evalSet?: {
    path?: string;
    inline?: unknown;
  };
  count?: number;
  strategy?: CandidateProposalStrategy;
};

export type CandidateProposal = {
  id: string;
  title: string;
  explanation: string;
  dagYaml: string;
  valid: boolean;
  errors: string[];
};

export type CandidateProposerResult = {
  status: "completed" | "failed";
  strategy: CandidateProposalStrategy;
  requestedCount: number;
  proposals: CandidateProposal[];
  summary: string;
};
```

Create `src/optimizer/proposer.ts`:

```ts
import type { CandidateProposerInput, CandidateProposerResult } from "./types.js";

export async function proposeCandidates(input: CandidateProposerInput): Promise<CandidateProposerResult> {
  if (Boolean(input.workflowPath) === Boolean(input.dagYaml)) {
    throw new Error("Provide exactly one of workflowPath or dagYaml");
  }

  return {
    status: "completed",
    strategy: input.strategy ?? "safe",
    requestedCount: input.count ?? 3,
    proposals: [],
    summary: "No candidate proposals generated.",
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --import tsx --test tests/proposer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/optimizer/types.ts src/optimizer/proposer.ts tests/proposer.test.ts
git commit -m "feat: add candidate proposer contract"
```

---

### Task 2: Generate and validate verifier fan-in candidate

**Files:**
- Modify: `src/optimizer/proposer.ts`
- Test: `tests/proposer.test.ts`

- [ ] **Step 1: Inspect DAG parser/export utilities**

Run:

```bash
grep -R "function parseDagYaml\|export function parseDagYaml\|parseDagYaml" -n src tests | head -20
grep -R "stringify\|YAML.stringify\|dagYaml" -n src/optimizer src | head -40
```

Expected: identify existing parser functions and YAML package usage.

- [ ] **Step 2: Add failing fan-in candidate test**

Append to `tests/proposer.test.ts`:

```ts
test("proposeCandidates returns a valid verifier fan-in candidate for a multi-root DAG", async () => {
  const result = await proposeCandidates({
    dagYaml: `research:\n  agent: researcher\n  task: Research the topic.\n\nrepo:\n  agent: researcher\n  task: Inspect repository evidence.\n`,
    count: 1,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.proposals.length, 1);
  const [proposal] = result.proposals;
  assert.equal(proposal.valid, true);
  assert.match(proposal.title, /verifier fan-in/i);
  assert.match(proposal.dagYaml, /synthesis:/);
  assert.match(proposal.dagYaml, /dependsOn:\n\s+- research\n\s+- repo/);
  assert.match(proposal.dagYaml, /role: verifier/);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
node --import tsx --test tests/proposer.test.ts
```

Expected: FAIL because no proposals are generated.

- [ ] **Step 4: Implement deterministic fan-in transform**

In `src/optimizer/proposer.ts`, use existing DAG YAML parsing if available. If the existing parser is not exported from its current module, export it from that module rather than duplicating parsing logic. Implement this behavior:

```ts
// Pseudocode shape, adapt names to existing DAG task type.
const tasks = loadAndNormalizeWorkflow(input);
const rootWorkers = tasks.filter((task) => !task.dependsOn?.length && task.role !== "verifier");
const hasVerifierFanIn = tasks.some((task) => task.role === "verifier" && (task.dependsOn?.length ?? 0) >= 2);

if (rootWorkers.length >= 2 && !hasVerifierFanIn) {
  const synthesisName = uniqueName(tasks, "synthesis");
  const candidateTasks = [
    ...tasks,
    {
      name: synthesisName,
      agent: "researcher",
      role: "verifier",
      dependsOn: rootWorkers.map((task) => task.name),
      task: "Synthesize the dependency outputs into a concise answer. Include evidence, caveats, and a recommendation.",
    },
  ];
  render candidateTasks as DAG YAML;
  reparse/revalidate rendered YAML;
}
```

Rendering should preserve simple scalar fields: `agent`, `role`, `model`, `thinking`, `tools`, `cwd`, `dependsOn`, `task`, `when`, nested `workflow`, and `loop` when present. For v1, if rendering nested workflow or loop is risky, leave those unchanged using `YAML.stringify` on normalized task maps and add tests for simple DAGs only.

- [ ] **Step 5: Run proposer test**

Run:

```bash
node --import tsx --test tests/proposer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run relevant optimizer tests**

Run:

```bash
node --import tsx --test tests/optimizer.test.ts tests/dag-yaml.test.ts tests/proposer.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/optimizer/proposer.ts tests/proposer.test.ts
git commit -m "feat: propose verifier fan-in candidates"
```

---

### Task 3: Add candidate count/strategy bounds and rejected-candidate diagnostics

**Files:**
- Modify: `src/optimizer/proposer.ts`
- Modify: `tests/proposer.test.ts`

- [ ] **Step 1: Add failing tests for count and strategy**

Append:

```ts
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
```

- [ ] **Step 2: Add failing test for non-aborting rejected proposal**

Append a test that uses an internal test hook only if needed:

```ts
test("proposeCandidates reports rejected candidates without failing the whole result", async () => {
  const result = await proposeCandidates({
    dagYaml: `research:\n  task: Research.\n\nrepo:\n  task: Inspect.\n`,
    count: 2,
    strategy: "exploratory",
  });

  assert.equal(result.status, "completed");
  assert.ok(result.proposals.length >= 1);
  assert.ok(result.proposals.some((proposal) => proposal.valid));
});
```

If deterministic transforms do not naturally create an invalid candidate, do not add artificial invalid output to production code. Instead test that invalid baseline YAML rejects before proposal generation:

```ts
test("proposeCandidates rejects malformed baseline DAG YAML", async () => {
  await assert.rejects(
    proposeCandidates({ dagYaml: "not: [valid" }),
    /yaml|parse|invalid/i,
  );
});
```

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
node --import tsx --test tests/proposer.test.ts
```

Expected: FAIL for validation not implemented.

- [ ] **Step 4: Implement bounds**

In `proposeCandidates()`:

```ts
const count = input.count ?? 3;
if (!Number.isInteger(count) || count < 1) {
  throw new Error("count must be a positive integer");
}
const cappedCount = Math.min(count, 5);
const strategy = input.strategy ?? "safe";
if (strategy !== "safe" && strategy !== "exploratory") {
  throw new Error("strategy must be safe or exploratory");
}
```

Return `requestedCount: cappedCount` or add a `returnedCount` field if the existing result shape makes that clearer. Keep the public result simple.

- [ ] **Step 5: Run tests**

Run:

```bash
node --import tsx --test tests/proposer.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/optimizer/proposer.ts tests/proposer.test.ts
git commit -m "feat: bound candidate proposal inputs"
```

---

### Task 4: Register `subflow_propose_candidates` extension tool

**Files:**
- Modify: `src/extension.ts`
- Test: `tests/extension.test.ts`

- [ ] **Step 1: Inspect existing tool registration tests**

Run:

```bash
grep -n "subflow_optimize\|promptGuidelines\|register" src/extension.ts tests/extension.test.ts | head -80
```

Expected: find patterns for registering Pi tools and asserting LLM-facing guidance.

- [ ] **Step 2: Add failing extension registration test**

In `tests/extension.test.ts`, add a test following existing extension setup helpers:

```ts
test("subflow extension registers subflow_propose_candidates with LLM-facing guidance", async () => {
  const extension = await createTestExtension();
  const tool = extension.tools.find((candidate) => candidate.name === "subflow_propose_candidates");

  assert.ok(tool, "expected subflow_propose_candidates tool to be registered");
  assert.match(tool.description ?? "", /candidate/i);
  assert.match(tool.promptGuidelines ?? "", /does not execute/i);
  assert.match(tool.promptGuidelines ?? "", /subflow_optimize/i);
});
```

Adapt `createTestExtension()` and property names to the existing test helpers.

- [ ] **Step 3: Run test to verify failure**

Run:

```bash
node --import tsx --test tests/extension.test.ts
```

Expected: FAIL because the tool is not registered.

- [ ] **Step 4: Register the tool**

In `src/extension.ts`, import `proposeCandidates` and add a Pi tool with schema matching `CandidateProposerInput`. Description/guidance must include:

```text
Generate validated static DAG candidate YAML proposals. This tool does not execute candidates, does not evaluate them, and does not mutate workflow files. Pass returned valid candidate dagYaml strings to subflow_optimize as candidateDagYamls for dry-run evaluation.
```

The handler should:

```ts
const result = await proposeCandidates(input);
return result.summary;
```

If existing tools return structured data in a standard format, follow that format and include candidate YAML blocks in the rendered markdown.

- [ ] **Step 5: Run extension test**

Run:

```bash
node --import tsx --test tests/extension.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts tests/extension.test.ts
git commit -m "feat: register candidate proposal tool"
```

---

### Task 5: Ensure proposed YAML is optimizer-compatible

**Files:**
- Modify: `tests/proposer.test.ts`
- Modify: `src/optimizer/proposer.ts` if needed

- [ ] **Step 1: Add failing integration test**

Append:

```ts
import { evaluateOptimizerRun } from "../src/optimizer/evaluator.ts";

test("valid proposed candidate YAML can be evaluated by subflow optimizer", async () => {
  const baseline = `research:\n  agent: mock\n  task: Research.\n\nrepo:\n  agent: mock\n  task: Inspect.\n`;
  const proposals = await proposeCandidates({ dagYaml: baseline, count: 1 });
  const valid = proposals.proposals.find((proposal) => proposal.valid);
  assert.ok(valid, "expected a valid proposal");

  const report = await evaluateOptimizerRun({
    dagYaml: baseline,
    evalSet: {
      inline: {
        name: "proposer-smoke",
        objective: { taskScore: 1, complexity: 0.01 },
        scoring: { minRunsPerCase: 1 },
        cases: [{ name: "case", input: "answer briefly" }],
      },
    },
    candidateDagYamls: [valid.dagYaml],
  });

  assert.equal(report.candidates.length, 1);
  assert.notEqual(report.candidates[0]?.status, "invalid");
});
```

Adapt report property names to the existing `evaluateOptimizerRun` return type.

- [ ] **Step 2: Run test to verify failure or pass**

Run:

```bash
node --import tsx --test tests/proposer.test.ts tests/optimizer.test.ts
```

Expected: PASS if rendering is already compatible; otherwise FAIL with parser/evaluator error.

- [ ] **Step 3: Fix rendering compatibility if needed**

If the test fails, adjust proposer rendering so candidate YAML uses the exact DAG shorthand accepted by existing parser:

```yaml
research:
  agent: mock
  task: Research.
repo:
  agent: mock
  task: Inspect.
synthesis:
  agent: mock
  role: verifier
  dependsOn:
    - research
    - repo
  task: Synthesize the dependency outputs into a concise answer. Include evidence, caveats, and a recommendation.
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --import tsx --test tests/proposer.test.ts tests/optimizer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/optimizer/proposer.ts tests/proposer.test.ts
git commit -m "test: verify proposer optimizer compatibility"
```

---

### Task 6: Update docs and guidance

**Files:**
- Modify: `doc/wiki/Workflow-optimization.md`
- Modify: `doc/adr/0003-self-optimizing-static-dags.md`
- Modify: `README.md`
- Modify: `src/extension.ts` if prompt guidance needs refinement
- Test: `tests/package.test.ts` or docs tests if existing docs assertions fail

- [ ] **Step 1: Update workflow optimization wiki**

Add a section near MVP interface:

```md
## Candidate proposal

`subflow_propose_candidates` generates validated static DAG candidate YAML proposals for an existing workflow. It does not run candidates, score candidates, write reports, or mutate workflow files.

Typical flow:

1. Run `subflow_propose_candidates` with `workflowPath` or `dagYaml`.
2. Review the returned valid candidate YAML blocks.
3. Pass selected YAML strings to `subflow_optimize` as `candidateDagYamls`.
4. Promote changes manually only after scorer-backed optimizer reports justify the change.
```

- [ ] **Step 2: Update ADR 0003**

Change language that says generated candidates are only future follow-up. Keep the safety posture:

```md
`subflow_propose_candidates` is the first candidate-generation surface. It proposes validated authoring artifacts only; `subflow_optimize` remains the evaluator, and file replacement remains out of scope until a separate apply tool exists.
```

- [ ] **Step 3: Update README**

Find the tool list or optimizer section:

```bash
grep -n "subflow_optimize\|Workflow optimization\|Tools" README.md | head -40
```

Add a concise mention:

```md
- `subflow_propose_candidates`: propose validated static DAG candidate YAMLs without executing or mutating workflows.
- `subflow_optimize`: evaluate a baseline and optional candidate DAG YAMLs against eval sets and write dry-run reports.
```

- [ ] **Step 4: Run docs-related tests**

Run:

```bash
node --import tsx --test tests/package.test.ts tests/extension.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md doc/wiki/Workflow-optimization.md doc/adr/0003-self-optimizing-static-dags.md src/extension.ts tests/package.test.ts tests/extension.test.ts
git commit -m "docs: document candidate proposal workflow"
```

---

### Task 7: Full verification and final cleanup

**Files:**
- All changed files

- [ ] **Step 1: Run full build and tests**

Run:

```bash
npm run build && npm test
```

Expected: TypeScript build succeeds and all tests pass.

- [ ] **Step 2: Run status and inspect diff**

Run:

```bash
git status --short
git diff --stat HEAD~6..HEAD
```

Expected: only intended files changed; no generated artifacts or local reports committed unless intentionally tracked.

- [ ] **Step 3: If verification fails, fix with a red-green loop**

For each failure:

```bash
node --import tsx --test path/to/failing.test.ts
# edit the smallest relevant source/test/doc file
node --import tsx --test path/to/failing.test.ts
npm run build && npm test
```

Expected: targeted test passes, then full verification passes.

- [ ] **Step 4: Final commit if cleanup changed files**

```bash
git add -A
git commit -m "chore: verify candidate proposer"
```

Only run this commit if Step 3 created additional changes.
