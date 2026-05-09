# Roadmap

Conditional DAG edges (`when`), inline nested workflows, and bounded loops are implemented in the DAG path. Remaining graph-roadmap work is about more dynamic dependency graphs, richer diagnostics, and graph visualization. If that scope grows, re-evaluate a graph library such as `graphlib` and treat validation as a workflow IR boundary.

## Workflow optimization

ADR 0003 now has a concrete MVP: the dry-run-only Pi tool, `subflow_optimize`. It accepts exactly one of `workflowPath` or `dagYaml`, exactly one of `evalSet.path` or `evalSet.inline`, and optional `candidateDagYamls`. It loads canonical eval sets from `.pi/subflow/evals/*.yaml`, scores the baseline and candidates with the explicit utility formula below, and writes JSON reports under `.pi/subflow/optimizer-reports/`; it does not mutate workflow files.

```text
utility = task_score
        - λ_cost * dollar_cost
        - λ_latency * wall_time_ms
        - λ_instability * failure_rate
        - λ_complexity * graph_complexity
```

The follow-up should stay separate and explicit: add `subflow_optimize_apply` only after dry-run evaluation is stable, holdout/regression evals exist, and the safety model for file replacement is clear.

This keeps the near-term scope on static DAG optimization inspired by AFlow, MASS, and AWO rather than open-ended self-modification of `pi-subflow` itself.
