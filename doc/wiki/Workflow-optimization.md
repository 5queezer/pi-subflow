# Workflow optimization

`subflow_optimize` is the dry-run optimizer for authored `pi-subflow` DAG workflows. It evaluates a baseline workflow and optional **manual** candidate DAG YAMLs against repeatable eval sets, compares the results with an explicit objective, and writes a scored report under `.pi/subflow/optimizer-reports/`. It never rewrites workflow files and does not generate candidates in the MVP.

## MVP interface

```ts
subflow_optimize({
  workflowPath | dagYaml,
  evalSet: { path | inline },
  candidateDagYamls?,
  agentScope?,       // "user" (default), "project", or "both"
  maxCandidateRuns?,
  maxCost?,          // compatibility alias for per-candidate budget behavior
  maxRunCost?,
  maxCandidateCost?,
  maxTotalCost?,
  maxConcurrency?,
  timeoutSeconds?,
})
```

Use `workflowPath` or `dagYaml`, but not both. Use `evalSet.path` or `evalSet.inline`, but not both. `candidateDagYamls` is optional and holds manually proposed replacements for comparison. `agentScope` defaults to `"user"`; set it to `"both"` (or `"project"`) when the workflow under evaluation depends on project-local agents under `.pi/agents/`, otherwise those agents are not loaded.

## Eval sets

Canonical eval sets live under `.pi/subflow/evals/*.yaml`. Inline eval sets are useful for experiments, but if an eval becomes reusable, save it in that directory so it can be reviewed and reused.

- Schema: [`schemas/subflow-eval.schema.json`](https://github.com/5queezer/pi-subflow/blob/main/schemas/subflow-eval.schema.json)
- Example: [`examples/evals/docs-consistency.yaml`](https://github.com/5queezer/pi-subflow/blob/main/examples/evals/docs-consistency.yaml)

```yaml
name: docs-consistency
workflow: examples/workflows/recipes/docs-consistency.yaml
objective:
  taskScore: 1
  cost: 0.05
  latency: 0.001
  instability: 1
  complexity: 0.25
scoring:
  minRunsPerCase: 2
  minUtilityDelta: 0.05
  maxFailureRateRegression: 0
cases:
  - name: readme-wiki-adr-schema-sync-train
    split: train
    input: Check README.md, doc/wiki, doc/adr, schemas, and src/extension.ts guidance for consistency.
    expectedSections: [Summary, Findings, Recommendation]
    entryTasks: [requirements-scout]
    scorer:
      type: judge
      agent: reviewer
      rubric:
        - name: correctness
          description: Findings are grounded in repository files.
          weight: 1
```

`expectedSections` and `jsonSchema.required` are structural gates: if they fail, the run scores zero and the judge scorer is not called. They are not quality rubrics. Recommendations require every eval case to define a quality `scorer`; structural-only eval sets still run, but are profile-only.

`entryTasks` optionally restricts where the eval input is prepended. When omitted, the optimizer injects input only into root runnable tasks for backwards compatibility. Downstream tasks receive normal dependency context but are not directly polluted by the eval input.

`split` defaults to `train`. When holdout cases are present, candidates are selected on train metrics and promoted only when holdout utility/failure gates also pass.

## Objective

```text
utility = task_score
        - λ_cost * dollar_cost
        - λ_latency * wall_time_seconds
        - λ_instability * failure_rate
        - λ_complexity * graph_complexity
```

Treat objective weights as λ calibration coefficients for the eval set. Examples use non-zero cost and latency weights so candidate comparison exercises real tradeoffs. Single-run comparisons are noisy; the optimizer treats one-run reports as profiling and disables confident recommendations until repeated runs are configured.

## Safety model

- Baseline and candidate DAG YAML are normalized and validated through the same DAG path before execution.
- Candidate YAML that fails DAG validation, policy checks, or tool allowlists is reported as an invalid candidate and is not executed; other valid candidates can still run.
- Budget controls are separated into per-run, per-candidate, and total optimizer caps. `maxCost` remains as a compatibility alias for existing callers.
- Report IDs are collision-resistant and report writes use exclusive creation so artifacts are not overwritten.
- The optimizer is read-only with respect to workflow files; it only writes JSON reports under `.pi/subflow/optimizer-reports/`.
- The first release is dry-run only; a future `subflow_optimize_apply` tool can be added later for explicit replacement of a workflow file.

## Follow-up

- Add trace capture for node outputs, token/cost estimates, latency, retries, and dependency metadata.
- Add generated candidate proposals only after scorer-backed evals and holdout checks are reliable.
- Introduce `subflow_optimize_apply` as a separate tool only after dry-run evaluation is stable.
