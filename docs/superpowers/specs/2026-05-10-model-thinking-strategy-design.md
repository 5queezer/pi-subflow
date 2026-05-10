# Model-Thinking Candidate Strategy Design

## Goal

Add an explicit `model-thinking` candidate proposal strategy to `subflow_propose_candidates` so users can ask the optimizer to evaluate verifier-node model and thinking-level tradeoffs without manually authoring every candidate YAML.

## Scope

The first version is deterministic and verifier-only. It proposes static DAG YAML candidates, validates each candidate through the existing DAG validation path, and does not execute, score, optimize adaptively, or mutate workflow files.

Out of scope for this change:

- Bayesian or adaptive search.
- User-supplied search spaces.
- All-task model/thinking mutation.
- Per-node cost/latency trace collection.
- Automatic workflow file replacement.
- Spark-tier model proposals.

## API

Extend the existing proposer strategy union:

```ts
type CandidateProposalStrategy = "safe" | "exploratory" | "model-thinking";
```

Example use:

```ts
subflow_propose_candidates({
  workflowPath: "examples/workflows/recipes/docs-consistency.yaml",
  strategy: "model-thinking",
  count: 3,
});
```

`count` keeps the existing semantics: it must be a positive integer and is capped at 5.

## Candidate generation

The strategy finds tasks with:

```yaml
role: verifier
```

For v1, it mutates the deepest verifier task only. Deepest means the verifier with the longest dependency path in the normalized DAG. This keeps candidate count small and targets the most likely quality/cost bottleneck: final synthesis or verdict nodes.

For the target verifier, generate baseline-relative perturbations from a built-in model/thinking space:

- switch model tier, keep thinking
- keep model, lower thinking by one step
- keep model, raise thinking by one step
- switch model tier and lower thinking by one step
- switch model tier and raise thinking by one step

Skip any candidate that is identical to the baseline. Stop after the requested `count` cap.

## Built-in search space

Use a small first-pass model tier table:

```ts
mini: "openai-codex/gpt-5.4-mini"
strong: "openai-codex/gpt-5.5"
```

Thinking levels are ordered:

```ts
["off", "minimal", "low", "medium", "high", "xhigh"]
```

If a verifier has no model or thinking, use conservative defaults for proposal purposes:

```ts
model: "openai-codex/gpt-5.5"
thinking: "medium"
```

Those defaults only define the baseline-relative perturbation source; generated candidates explicitly set model/thinking.

## Validation and output

Each generated candidate should be rendered with the existing YAML renderer and validated with the existing `validateRenderedDagYaml` path. Invalid candidates are returned with errors instead of thrown, matching the existing candidate proposal model.

Candidate metadata should make the diff readable:

```text
id: model-thinking-1
title: Model/thinking candidate for consistency-verdict
explanation: consistency-verdict: openai-codex/gpt-5.5/medium -> openai-codex/gpt-5.4-mini/medium
```

If no verifier exists, return no proposals and a clear summary:

```text
No verifier task found for model-thinking proposals.
```

## Documentation updates

Update:

- `README.md` optimizer section.
- `doc/wiki/Workflow-optimization.md` candidate proposal section.
- `doc/adr/0003-self-optimizing-static-dags.md` with this v1 strategy decision.
- `src/extension.ts` LLM-facing prompt guidance and tool schema.

The docs must state that `safe` and `exploratory` still use verifier fan-in, while `model-thinking` proposes verifier-only model/thinking variants.

## Testing

Add tests that verify:

- `model-thinking` is accepted.
- unknown strategies are still rejected with an updated error message.
- generated candidates mutate only the selected verifier task.
- worker tasks remain unchanged.
- no verifier returns no proposals with a clear summary.
- generated candidate YAML validates and can be passed to the optimizer evaluator.
- `count` cap is respected.

## Rationale

This matches ADR 0003's intended optimization surface for node model and thinking selection while preserving the dry-run, static-DAG safety model. Bayesian or all-task search is deferred because the current optimizer has aggregate candidate metrics, small eval sets, and budget-sensitive execution; deterministic verifier-only search provides immediate value with lower risk.
