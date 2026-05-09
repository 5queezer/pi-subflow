# ADR 0002: Introduce a DAG validation boundary before advanced workflow features

## Status

Accepted

## Context

`pi-subflow` currently supports single, chain, parallel, and DAG execution. The DAG path already has several semantic rules: task names must be unique, verifier tasks without explicit dependencies fan in from all non-verifier tasks, dependencies determine execution stages, failed dependencies skip downstream tasks, and results carry structured `dependsOn` metadata for rendering and history.

The current DAG implementation is still intentionally small, but future project goals include conditional branches, nested workflows, and dynamic dependency graphs. Those features will make validation more important than the current topological-stage helper: callers will need clear preflight diagnostics before models spend tokens or tools run, and the orchestration layer will need a stable internal representation that can evolve beyond simple static DAGs.

ADR 0001 establishes the public `runDag` contract and extension behavior: DAG execution should validate task names and dependencies, execute deterministic dependency stages, skip downstream tasks after dependency failures, preserve structured `dependsOn` metadata for rendering/history, and keep PocketFlow or workflow-IR internals out of public APIs. The validation/planning boundary described here sits inside that contract. It prepares normalized tasks and planned stages for `runDag`; it does not replace `runDag`, change history or rendering formats, or expose planner internals to extension callers.

Recent research found reusable npm options for schema validation (`typebox`, `ajv`, `zod`, `valibot`) and graph operations (`graphlib`, `dependency-graph`, `topo-sort`). The project already uses TypeBox-style schemas at the Pi extension boundary, while the current graph logic is small enough that adding a graph library immediately would add more maintenance surface than benefit.

## Decision

Introduce a dedicated DAG validation boundary before adding advanced workflow features.

In the near term, create a focused validation/planning module for the existing DAG behavior. This module should own:

- task naming normalization
- verifier fan-in normalization
- duplicate-name detection
- missing-dependency diagnostics
- self-dependency diagnostics
- cycle diagnostics with a human-readable path
- deterministic execution-stage planning

The module should expose internal types shaped like a future workflow IR: normalized nodes, dependency edges, diagnostics, and planned stages. `runDag` should call this boundary before execution and should not run any subagent when validation fails. After validation succeeds, `runDag` remains responsible for execution, dependency-output injection for verifier prompts, verifier repair rounds, budget checks, result aggregation, trace/history data, and renderer-visible `dependsOn` metadata.

Keep schema validation separate from DAG validation. TypeBox-style schemas are appropriate at the Pi tool boundary for structural checks such as required strings, enum values, array shapes, and mutually exclusive `needs`/`dependsOn` fields. They are insufficient for this layer because DAG validity depends on cross-node semantics: uniqueness across the whole task set, whether a dependency names another normalized task, verifier fan-in defaults, self-dependencies, cycle paths, deterministic stage planning, and user-actionable graph diagnostics. Encoding those rules in boundary schemas would either be impossible, produce poor errors, or couple schema declarations to execution planning.

Do not add a graph library in the first extraction. Re-evaluate `graphlib` or another graph package before implementing conditional branches, nested workflows, dynamic dependencies, graph visualization, or other features that materially increase graph complexity.

## Consequences

Positive:

- Invalid DAGs fail before execution with precise, user-actionable errors.
- Validation rules live in one place instead of drifting across schema validation, DAG execution, rendering, and docs.
- The codebase gets a stable seam for future conditional, nested, or dynamic workflow behavior.
- The current implementation remains lightweight while DAG semantics are simple.

Tradeoffs:

- The first implementation still uses custom graph logic, so cycle detection and stage planning must remain well-tested.
- The validation boundary is an internal architecture commitment that needs documentation and maintenance.
- Future workflow features may require replacing the custom graph internals with a graph library, so the validation API should avoid leaking implementation details.

## Follow-up

Execute the DAG Validation IR implementation plan at `docs/superpowers/plans/2026-05-09-dag-validation-ir.md` using TDD. Keep `README.md` and this ADR synchronized if the validation boundary becomes public API or if a graph library is added.
