# PocketFlow DAG Node Integration Design

## Goal

Deepen PocketFlow integration by making DAG execution visibly and testably node-based, starting with `runDag`, while preserving the existing public API and behavior.

## Scope

This is a tracer-bullet implementation for DAG execution, not a whole-project rewrite. It targets the highest-impact gap from the PocketFlow review: `src/flows/dag.ts` currently imports `Flow` but executes through hand-rolled imperative orchestration. The first slice will introduce explicit PocketFlow node classes for the main DAG execution phases and route `runDag` through them.

Out of scope for this slice:

- Rewriting `runChain` and `runParallel`.
- Changing the public SDK/API exports.
- Changing DAG validation semantics, history format, trace format, or rendered output.
- Replacing every helper function with a PocketFlow node.

## Architecture

Add a focused PocketFlow-backed DAG runtime module under `src/flows/pocketflow-dag.ts`. `runDag` remains the public entrypoint, but delegates execution to a `DagExecutionFlow` composed of explicit nodes.

The node layer should be intentionally small and observable:

- `ValidateDagNode` validates and normalizes tasks using `validateDagTasks`.
- `MaxTurnsGuardNode` enforces the existing non-loop `maxTurns` preflight.
- `ExecuteDagStagesNode` executes dependency stages. It may reuse existing helper logic, but stage execution itself is invoked through a PocketFlow node.
- `VerifierRepairNode` runs verifier repair rounds after initial graph execution.
- `AggregateDagResultNode` builds the final `FlowResult`.

Within `ExecuteDagStagesNode`, task-level execution should also use explicit semantic node names where practical:

- condition evaluation
- workflow summary synthesis
- loop task execution
- runnable task execution
- budget enforcement after each stage

The implementation may keep these as private helper functions in the first slice, but tests must prove the top-level DAG path is PocketFlow-backed and the node sequence is visible.

## Data flow

`runDag(input, options)` creates a shared state object containing:

- raw input tasks
- execution options
- trace events
- normalized tasks
- accumulated task results
- result lookup by task name
- final `FlowResult`
- diagnostic list of PocketFlow node names that executed

The PocketFlow nodes mutate this shared state, matching the current `runSingle` style. The final output remains identical to today: `FlowResult` with `status`, `output`, `results`, and `trace`.

## Testing strategy

Tests should be TDD and preserve behavior first.

Add focused tests in `tests/flows.test.ts` or a new `tests/pocketflow-dag.test.ts` that verify:

1. `runDag` still rejects invalid DAGs before executing any subagent.
2. Successful DAG execution still returns the same status, output, result ordering, and stage trace events.
3. Conditional skips, dependency failures, loop execution, verifier repair, and budget enforcement remain covered by existing tests.
4. A new internal debug/trace marker or exported test helper proves the PocketFlow DAG nodes ran, without exposing PocketFlow in the public package API.

The preferred observability mechanism is adding internal trace events with a distinct type such as `pocketflow_node` only if this does not break existing consumers. If trace type widening is too invasive, expose an internal-only helper from the new module and test it directly without exporting from `src/index.ts`.

## Error handling

Validation errors should keep the same message as current `runDag` behavior. Runtime errors should keep existing result semantics: failed tasks become `SubagentResult` failures, downstream tasks are skipped, budget failures append the existing budget result shape, and verifier repair behavior is unchanged.

## Documentation

Update ADR 0001 and/or README only if wording currently claims PocketFlow integration in a way this slice changes. The desired doc statement after this slice is: DAG execution is now PocketFlow-node-backed internally; chain and parallel remain custom orchestration for now.

## Success criteria

- `runDag` no longer contains a placeholder `void Flow` import.
- DAG execution is routed through explicit PocketFlow `Node`/`Flow` classes.
- Existing DAG behavior tests pass unchanged or with only intentional observability assertions added.
- New tests fail before implementation and pass after implementation, proving PocketFlow nodes are used.
- `npm run build && npm test && npm run check` passes.
