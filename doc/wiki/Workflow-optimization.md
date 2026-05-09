# Workflow optimization

`subflow_optimize` is the dry-run optimizer for authored `pi-subflow` DAG workflows. It evaluates a baseline workflow and optional candidate DAG YAMLs against repeatable eval sets, compares the results with an explicit objective, and writes a scored report under `.pi/subflow/optimizer-reports/`. It never rewrites workflow files.

## MVP interface

```ts
subflow_optimize({
  workflowPath | dagYaml,
  evalSet: { path | inline },
  candidateDagYamls?,
  maxCandidateRuns?,
  maxCost?,
  maxConcurrency?,
  timeoutSeconds?,
})
```

Use `workflowPath` or `dagYaml`, but not both. Use `evalSet.path` or `evalSet.inline`, but not both. `candidateDagYamls` is optional and may hold manually proposed replacements for comparison.

## Eval sets

Canonical eval sets live under `.pi/subflow/evals/*.yaml`. Inline eval sets are useful for experiments, but if an eval becomes reusable, save it in that directory so it can be reviewed and reused.

- Schema: [`schemas/subflow-eval.schema.json`](https://github.com/5queezer/pi-subflow/blob/main/schemas/subflow-eval.schema.json)
- Example: [`examples/evals/docs-consistency.yaml`](https://github.com/5queezer/pi-subflow/blob/main/examples/evals/docs-consistency.yaml)

```yaml
name: docs-consistency
workflow: examples/workflows/recipes/docs-consistency.yaml
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
        - λ_latency * wall_time_ms
        - λ_instability * failure_rate
        - λ_complexity * graph_complexity
```

The optimizer keeps this objective explicit so changes can be compared across runs instead of judged only by an LLM preference. Single-run comparisons are noisy; treat one-run reports as profiling and require repeated runs before trusting small utility deltas.

## Safety model

- Baseline and candidate DAG YAML are normalized and validated through the same DAG path before any run starts.
- Candidate YAML that fails validation or violates policy/tool allowlists is reported as invalid and is not executed.
- The optimizer is read-only with respect to workflow files; it only writes JSON reports under `.pi/subflow/optimizer-reports/`.
- The first release is dry-run only; a future `subflow_optimize_apply` tool can be added later for explicit replacement of a workflow file.

## Follow-up

- Add trace capture for node outputs, token/cost estimates, latency, retries, and dependency metadata.
- Add holdout evals and regression checks so candidate search can resist overfitting.
- Introduce `subflow_optimize_apply` as a separate tool only after dry-run evaluation is stable.
