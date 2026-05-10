# Model-Thinking Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic verifier-only `model-thinking` candidate proposal strategy for `subflow_propose_candidates`.

**Architecture:** Keep `subflow_optimize` unchanged as the evaluator. Extend the proposer with a separate model/thinking generator that targets one verifier task, renders complete candidate DAG YAML, and validates candidates through the existing DAG validation path. Centralize the small built-in model tier and thinking-level helpers in a focused optimizer module.

**Tech Stack:** TypeScript, Node test runner, YAML rendering via existing `yaml` dependency, existing Pi extension TypeBox schema, markdown docs.

---

## File structure

- Create: `src/optimizer/model-thinking.ts`
  - Owns model tier constants, thinking level order, and pure helper functions for choosing verifier model/thinking variants.
- Modify: `src/optimizer/types.ts`
  - Adds `"model-thinking"` to `CandidateProposalStrategy`.
- Modify: `src/optimizer/proposer.ts`
  - Routes `strategy: "model-thinking"` to the new generator and builds validated proposal objects.
- Modify: `src/extension.ts`
  - Updates `subflow_propose_candidates` schema and LLM-facing guidance.
- Modify: `tests/proposer.test.ts`
  - Adds TDD coverage for the new strategy.
- Modify: `tests/extension.test.ts`
  - Updates schema/guidance expectations.
- Modify: `README.md`
  - Documents the new strategy.
- Modify: `doc/wiki/Workflow-optimization.md`
  - Documents candidate proposal behavior.
- Modify: `doc/adr/0003-self-optimizing-static-dags.md`
  - Records the staged v1 decision.

## Task 1: Add failing proposer tests

**Files:**
- Modify: `tests/proposer.test.ts`

- [ ] **Step 1: Add tests for `model-thinking` behavior**

Append these tests before `tmpProject()` so they can reuse imports already in the file:

```ts
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
		assert.match(proposal.dagYaml, /worker:\n\s+agent: reviewer\n\s+task: Inspect docs\.\n\s+dependsOn: \[\]\n\s+role:/m);
		assert.match(proposal.dagYaml, /worker:[\s\S]*model: openai-codex\/gpt-5\.4-mini/);
		assert.match(proposal.dagYaml, /worker:[\s\S]*thinking: low/);
	}

	assert.match(result.proposals[0]?.dagYaml ?? "", /verdict:[\s\S]*model: openai-codex\/gpt-5\.4-mini/);
	assert.match(result.proposals[0]?.dagYaml ?? "", /verdict:[\s\S]*thinking: medium/);
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
```

- [ ] **Step 2: Update existing unknown-strategy test expectation**

Change:

```ts
/strategy must be safe or exploratory/i,
```

to:

```ts
/strategy must be safe, exploratory, or model-thinking/i,
```

- [ ] **Step 3: Run proposer tests and confirm they fail**

Run:

```bash
npm test -- tests/proposer.test.ts
```

Expected: FAIL because `model-thinking` is not accepted yet.

## Task 2: Implement model/thinking helper module

**Files:**
- Create: `src/optimizer/model-thinking.ts`

- [ ] **Step 1: Create helper module**

Create `src/optimizer/model-thinking.ts` with:

```ts
import type { SubagentTask } from "../types.js";

export const modelTiers = {
	mini: "openai-codex/gpt-5.4-mini",
	strong: "openai-codex/gpt-5.5",
} as const;

export const defaultVerifierModel = modelTiers.strong;
export const defaultVerifierThinking = "medium" satisfies NonNullable<SubagentTask["thinking"]>;

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type ThinkingLevel = typeof thinkingLevels[number];

type ModelThinkingConfig = {
	model: string;
	thinking: ThinkingLevel;
};

export type ModelThinkingVariant = ModelThinkingConfig & {
	description: string;
};

export function baselineModelThinking(task: SubagentTask): ModelThinkingConfig {
	return {
		model: task.model ?? defaultVerifierModel,
		thinking: task.thinking ?? defaultVerifierThinking,
	};
}

export function modelThinkingVariants(task: SubagentTask, count: number): ModelThinkingVariant[] {
	const baseline = baselineModelThinking(task);
	const switchedModel = switchModelTier(baseline.model);
	const lowerThinking = adjacentThinking(baseline.thinking, -1);
	const higherThinking = adjacentThinking(baseline.thinking, 1);
	const candidates: ModelThinkingVariant[] = [
		{ model: switchedModel, thinking: baseline.thinking, description: "switch model tier" },
		{ model: baseline.model, thinking: lowerThinking, description: "lower thinking one step" },
		{ model: baseline.model, thinking: higherThinking, description: "raise thinking one step" },
		{ model: switchedModel, thinking: lowerThinking, description: "switch model tier and lower thinking one step" },
		{ model: switchedModel, thinking: higherThinking, description: "switch model tier and raise thinking one step" },
	];

	const seen = new Set<string>([keyOf(baseline)]);
	const variants: ModelThinkingVariant[] = [];
	for (const candidate of candidates) {
		const key = keyOf(candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		variants.push(candidate);
		if (variants.length >= count) break;
	}
	return variants;
}

function switchModelTier(model: string): string {
	if (model === modelTiers.mini) return modelTiers.strong;
	return modelTiers.mini;
}

function adjacentThinking(thinking: ThinkingLevel, offset: -1 | 1): ThinkingLevel {
	const index = thinkingLevels.indexOf(thinking);
	const nextIndex = Math.min(thinkingLevels.length - 1, Math.max(0, index + offset));
	return thinkingLevels[nextIndex] ?? thinking;
}

function keyOf(config: ModelThinkingConfig): string {
	return `${config.model}\u0000${config.thinking}`;
}
```

- [ ] **Step 2: Run typecheck/build and confirm current strategy still fails tests**

Run:

```bash
npm run build
npm test -- tests/proposer.test.ts
```

Expected: build may pass, proposer tests still FAIL until routing is implemented.

## Task 3: Route proposer strategy and generate validated candidates

**Files:**
- Modify: `src/optimizer/types.ts`
- Modify: `src/optimizer/proposer.ts`

- [ ] **Step 1: Extend strategy type**

In `src/optimizer/types.ts`, change:

```ts
export type CandidateProposalStrategy = "safe" | "exploratory";
```

to:

```ts
export type CandidateProposalStrategy = "safe" | "exploratory" | "model-thinking";
```

- [ ] **Step 2: Import helpers in proposer**

In `src/optimizer/proposer.ts`, add:

```ts
import { baselineModelThinking, modelThinkingVariants } from "./model-thinking.js";
```

- [ ] **Step 3: Update strategy validation and routing**

Replace:

```ts
if (strategy !== "safe" && strategy !== "exploratory") {
	throw new Error("strategy must be safe or exploratory");
}

const sourceDagYaml = input.dagYaml ?? await readWorkflowSource(input.workflowPath ?? "", options.cwd);
const tasks = loadDagTasks(sourceDagYaml);
const proposal = buildVerifierFanInCandidate(tasks);
const proposals = proposal ? [proposal] : [];
const validCount = proposals.filter((candidate) => candidate.valid).length;

return {
	status: "completed",
	strategy,
	requestedCount,
	proposals,
	summary: validCount > 0 ? "Generated 1 valid verifier fan-in candidate." : "No verifier fan-in candidate generated.",
};
```

with:

```ts
if (strategy !== "safe" && strategy !== "exploratory" && strategy !== "model-thinking") {
	throw new Error("strategy must be safe, exploratory, or model-thinking");
}

const sourceDagYaml = input.dagYaml ?? await readWorkflowSource(input.workflowPath ?? "", options.cwd);
const tasks = loadDagTasks(sourceDagYaml);
const proposals = strategy === "model-thinking"
	? buildModelThinkingCandidates(tasks, requestedCount)
	: compactProposal(buildVerifierFanInCandidate(tasks));
const validCount = proposals.filter((candidate) => candidate.valid).length;

return {
	status: "completed",
	strategy,
	requestedCount,
	proposals,
	summary: summarizeProposals(strategy, proposals, validCount),
};
```

- [ ] **Step 4: Add proposer helper functions**

Add below `buildVerifierFanInCandidate`:

```ts
function buildModelThinkingCandidates(tasks: SubagentTask[], count: number): CandidateProposal[] {
	const target = deepestVerifierTask(tasks);
	if (!target?.name) return [];
	const baseline = baselineModelThinking(target);
	return modelThinkingVariants(target, count).map((variant, index) => {
		const candidateTasks = tasks.map((task) => task.name === target.name ? { ...task, model: variant.model, thinking: variant.thinking } : task);
		const dagYaml = renderDagYaml(candidateTasks);
		const validation = validateRenderedDagYaml(dagYaml);
		return {
			id: `model-thinking-${index + 1}`,
			title: `Model/thinking candidate for ${target.name}`,
			explanation: `${target.name}: ${baseline.model}/${baseline.thinking} -> ${variant.model}/${variant.thinking} (${variant.description}).`,
			dagYaml,
			valid: validation.valid,
			errors: validation.errors,
		};
	});
}

function deepestVerifierTask(tasks: SubagentTask[]): SubagentTask | undefined {
	const byName = new Map(tasks.map((task) => [task.name, task]).filter((entry): entry is [string, SubagentTask] => typeof entry[0] === "string"));
	let best: { task: SubagentTask; depth: number } | undefined;
	for (const task of tasks) {
		if (task.role !== "verifier" || !task.name) continue;
		const depth = dependencyDepth(task, byName, new Set());
		if (!best || depth > best.depth) best = { task, depth };
	}
	return best?.task;
}

function dependencyDepth(task: SubagentTask, byName: Map<string, SubagentTask>, visiting: Set<string>): number {
	const name = task.name;
	if (!name || visiting.has(name)) return 0;
	const dependencies = task.dependsOn ?? [];
	if (dependencies.length === 0) return 0;
	visiting.add(name);
	const depth = 1 + Math.max(...dependencies.map((dependency) => {
		const dependencyTask = byName.get(dependency);
		return dependencyTask ? dependencyDepth(dependencyTask, byName, visiting) : 0;
	}));
	visiting.delete(name);
	return depth;
}

function compactProposal(proposal: CandidateProposal | undefined): CandidateProposal[] {
	return proposal ? [proposal] : [];
}

function summarizeProposals(strategy: CandidateProposalStrategy, proposals: CandidateProposal[], validCount: number): string {
	if (strategy === "model-thinking") {
		if (proposals.length === 0) return "No verifier task found for model-thinking proposals.";
		return `Generated ${validCount} valid model-thinking candidate${validCount === 1 ? "" : "s"}.`;
	}
	return validCount > 0 ? "Generated 1 valid verifier fan-in candidate." : "No verifier fan-in candidate generated.";
}
```

- [ ] **Step 5: Run proposer tests**

Run:

```bash
npm test -- tests/proposer.test.ts
```

Expected: PASS or reveal formatting mismatch to fix.

## Task 4: Update extension schema and tests

**Files:**
- Modify: `src/extension.ts`
- Modify: `tests/extension.test.ts`

- [ ] **Step 1: Update schema enum**

In `src/extension.ts`, change the `subflow_propose_candidates` strategy schema from:

```ts
strategy: Type.Optional(Type.Union([Type.Literal("safe"), Type.Literal("exploratory")])),
```

to:

```ts
strategy: Type.Optional(Type.Union([Type.Literal("safe"), Type.Literal("exploratory"), Type.Literal("model-thinking")])),
```

- [ ] **Step 2: Update prompt guidance**

Replace guidance text that says:

```ts
"safe and exploratory currently share the same fan-in-only proposal transform; strategy is reserved for future proposal transforms.",
```

with:

```ts
"safe and exploratory currently share the verifier fan-in proposal transform; model-thinking proposes deterministic verifier-only model/thinking variants for later optimizer evaluation.",
```

- [ ] **Step 3: Update extension tests**

In `tests/extension.test.ts`, replace expectations matching `/strategy is reserved/i` with an expectation matching `/model-thinking/i`.

- [ ] **Step 4: Run extension tests**

Run:

```bash
npm test -- tests/extension.test.ts
```

Expected: PASS.

## Task 5: Update docs and ADR

**Files:**
- Modify: `README.md`
- Modify: `doc/wiki/Workflow-optimization.md`
- Modify: `doc/adr/0003-self-optimizing-static-dags.md`

- [ ] **Step 1: Update README optimizer paragraph**

In `README.md`, replace:

```md
`subflow_propose_candidates` generates validated static DAG candidate YAMLs without executing or mutating workflows. In v1, `safe` and `exploratory` share the same fan-in-only transform; `strategy` is reserved for future proposal transforms. `subflow_optimize` is dry-run-only and writes JSON reports without mutating workflow files:
```

with:

```md
`subflow_propose_candidates` generates validated static DAG candidate YAMLs without executing or mutating workflows. `safe` and `exploratory` currently share the verifier fan-in transform; `model-thinking` proposes deterministic verifier-only model/thinking variants for later optimizer evaluation. `subflow_optimize` is dry-run-only and writes JSON reports without mutating workflow files:
```

- [ ] **Step 2: Add README bullet**

After:

```md
- Use `subflow_propose_candidates` to generate candidate YAMLs, then pass selected valid outputs to `subflow_optimize` as `candidateDagYamls`.
```

add:

```md
- Use `strategy: "model-thinking"` to generate verifier-only model/thinking variants from the built-in Mini/Strong search space; Bayesian search, all-task mutation, and custom search spaces are future work.
```

- [ ] **Step 3: Update wiki candidate proposal section**

In `doc/wiki/Workflow-optimization.md`, replace the current candidate proposal paragraph with:

```md
`subflow_propose_candidates` generates validated static DAG candidate YAML proposals. `safe` and `exploratory` currently share the verifier fan-in transform. `model-thinking` proposes deterministic verifier-only model/thinking variants using a small built-in Mini/Strong search space. It does not run candidates, score them, write reports, or mutate workflow files.

Review the valid outputs, then pass selected YAML strings to `subflow_optimize` as `candidateDagYamls`. Promote changes manually only after scorer-backed optimizer reports justify the change. Bayesian search, all-task mutation, and user-supplied search spaces are future work.
```

- [ ] **Step 4: Update ADR follow-up/status text**

In `doc/adr/0003-self-optimizing-static-dags.md`, append this paragraph near the end of the MVP interface section:

```md
A deterministic `model-thinking` proposal strategy is the first node-configuration optimization step. It targets verifier tasks only, uses a small built-in Mini/Strong model tier and adjacent-thinking search space, and emits validated static DAG YAML candidates for `subflow_optimize`. Adaptive/Bayesian search, all-task mutation, user-supplied search spaces, and per-node cost/latency credit assignment remain future work until optimizer reports expose richer trace data and budget controls.
```

- [ ] **Step 5: Run wiki sync if available**

Run:

```bash
npm run wiki:sync
```

Expected: either succeeds or reports no wiki remote/config. If it fails due to environment, capture the error and continue to final verification.

## Task 6: Full verification and manual smoke test

**Files:**
- No new source edits expected unless tests reveal issues.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run build && npm test
```

Expected: PASS.

- [ ] **Step 2: Run manual proposer smoke test through Pi tool or direct node test path**

Preferred manual tool call:

```ts
subflow_propose_candidates({
  workflowPath: "examples/workflows/recipes/docs-consistency.yaml",
  strategy: "model-thinking",
  count: 3,
});
```

Expected: completed result with up to three valid `model-thinking-*` proposals targeting `consistency-verdict`.

- [ ] **Step 3: Optional optimizer smoke test**

Pass one returned candidate YAML into:

```ts
subflow_optimize({
  workflowPath: "examples/workflows/recipes/docs-consistency.yaml",
  evalSet: { path: "examples/evals/docs-consistency.yaml" },
  candidateDagYamls: ["<returned candidate YAML>"],
  maxRunCost: 0.5,
  maxCandidateCost: 2,
  maxTotalCost: 5,
  maxConcurrency: 2,
  timeoutSeconds: 600,
});
```

Expected: candidate is not invalid. It may fail structural gates if the baseline workflow headings still disagree with the eval set; that is acceptable for this feature.

## Self-review notes

- Spec coverage: API, strategy routing, verifier-only scope, deterministic search, docs, tests, and verification are covered.
- Placeholder scan: no placeholder implementation steps are left.
- Type consistency: `CandidateProposalStrategy`, `CandidateProposal`, `SubagentTask`, `model-thinking`, and helper names are consistent across tasks.
