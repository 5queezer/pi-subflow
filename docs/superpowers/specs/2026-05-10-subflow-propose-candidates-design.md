# Design: `subflow_propose_candidates`

## Goal

Add a separate, dry-run-only candidate proposal tool for static DAG workflow optimization. The tool generates validated candidate DAG YAML strings that users can manually pass to `subflow_optimize` as `candidateDagYamls`.

This closes the biggest current gap in workflow optimization: humans no longer need to hand-author every candidate, while the optimizer remains evaluator-driven and non-mutating.

## Non-goals

- Do not mutate workflow files.
- Do not execute candidates.
- Do not call `subflow_optimize` automatically.
- Do not add dynamic runtime graph mutation.
- Do not add open-ended self-modification.
- Do not bypass existing DAG validation, policy, or tool allowlist boundaries.

## Public tool shape

```ts
subflow_propose_candidates({
  workflowPath | dagYaml,
  evalSet?: { path | inline },
  count?: number,
  strategy?: "safe" | "exploratory",
})
```

Rules:

- Exactly one of `workflowPath` or `dagYaml` is required.
- `evalSet` is optional and, when present, follows the existing optimizer exact-one path/inline rules.
- `count` defaults to 3 and is capped to a small fixed maximum.
- `strategy` defaults to `safe`.

## Output shape

The tool returns a markdown summary plus structured candidate metadata. Each candidate includes:

- candidate id or label
- candidate DAG YAML
- explanation of the transform used
- validation status
- validation errors when rejected

Only valid candidates are presented as ready to pass into `subflow_optimize`; rejected candidates are useful diagnostics but should not be executed.

## Candidate generation v1

Generation is deterministic and conservative. It operates on normalized DAG task objects and renders candidate DAG YAML.

Initial transforms:

1. **Verifier fan-in**: when a workflow has multiple independent worker roots and no final verifier, add a synthesis/verifier task depending on the roots.
2. **Synthesis role normalization**: mark tasks whose names or prompts indicate synthesis/review/checking as `role: verifier` when they already depend on other tasks.
3. **Worker cost trim**: lower obviously over-provisioned worker tasks from high-cost model/thinking settings to cheaper worker defaults when they are not verifiers.
4. **Overloaded task split**: for long or multi-instruction tasks, propose a worker plus verifier/check task.

The first implementation may ship a subset of these transforms if tests and docs make the limits explicit.

## Architecture

Add a proposer module under `src/optimizer/`, reusing existing optimizer loaders and DAG validation helpers where possible.

Suggested files:

- `src/optimizer/proposer.ts` — candidate generation orchestration and transforms
- `src/optimizer/proposer-types.ts` or additions to `src/optimizer/types.ts`
- `src/extension.ts` — Pi tool registration and LLM-facing guidance
- tests in `tests/optimizer.test.ts` or `tests/proposer.test.ts`

Data flow:

1. Load workflow from `workflowPath` or `dagYaml`.
2. Normalize through existing DAG YAML/workflow task parsing.
3. Optionally load eval-set metadata for objective/entry-task hints.
4. Generate up to `count` candidate task arrays.
5. Render candidates to DAG YAML.
6. Re-parse/re-validate rendered YAML using existing validation boundary.
7. Return valid and rejected proposals.

## Safety and validation

- Candidate YAML must pass existing DAG validation before being marked valid.
- Tool allowlist and policy-sensitive fields should remain compatible with current optimizer behavior.
- The proposer must be deterministic in tests.
- The proposer never writes reports or workflow files.
- Any future automatic application remains separate from this tool.

## Documentation updates

Update:

- `doc/wiki/Workflow-optimization.md` to explain candidate proposal followed by optimizer evaluation.
- `doc/adr/0003-self-optimizing-static-dags.md` to move generated candidate proposals from follow-up into MVP-adjacent implemented behavior once complete.
- `README.md` if the public tool list or examples mention optimizer usage.
- `src/extension.ts` prompt guidance so Pi knows the proposal tool is separate from evaluation and apply.

## Testing plan

Use red-green TDD:

1. Failing test: extension registers `subflow_propose_candidates` with LLM-facing guidance.
2. Failing test: proposer rejects ambiguous `workflowPath` + `dagYaml` input.
3. Failing test: proposer returns a valid verifier fan-in candidate for a multi-root DAG.
4. Failing test: rejected candidates include validation errors and do not abort other proposals.
5. Failing test: proposed candidate YAML can be passed to existing optimizer parser/evaluator path.

Verification command before completion:

```sh
npm run build && npm test
```
