# Roadmap

Conditional DAG edges (`when`), inline nested workflows, and bounded loops are implemented in the DAG path. Remaining graph-roadmap work is about more dynamic dependency graphs, richer diagnostics, and graph visualization. If that scope grows, re-evaluate a graph library such as `graphlib` and treat validation as a workflow IR boundary.

## Workflow optimization

ADR 0003 proposes self-optimizing static DAGs as the next research direction. The first optimizer should profile a target DAG on an eval set, analyze traces, propose node prompt/model/tool/thinking changes and topology changes, generate candidate DAG YAML, evaluate candidates against the same objective, and select a replacement only when score/cost/latency/stability improve without unacceptable regression.

The objective should be explicit:

```text
utility = task_score
        - λ_cost * dollar_cost
        - λ_latency * wall_time
        - λ_instability * failure_rate
        - λ_complexity * graph_complexity
```

This keeps the near-term scope on static DAG optimization inspired by AFlow, MASS, and AWO rather than open-ended self-modification of `pi-subflow` itself.
