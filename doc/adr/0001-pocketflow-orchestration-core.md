# ADR 0001: Use PocketFlow for the subagent orchestration core

## Status

Accepted

## Context

`pi-subflow` is a sibling prototype for recreating the Pi Subagent Extension's workflow layer with clearer boundaries. The existing extension combines Pi tool registration, agent discovery, SDK-based agent execution, policy checks, validation, tracing, and workflow orchestration in one implementation.

We want a design that keeps Pi-specific integration replaceable while making orchestration behavior easier to test and evolve. The core needs to support single-task, chain, parallel, and DAG execution today, while leaving room for verifier repair loops, adaptive routing, and future workflow forms without exposing Pi UI or SDK details as orchestration API.

Options considered:

- Custom TypeScript orchestration only: lowest dependency count and maximum control, but it risks accumulating ad hoc abstractions as workflows become more capable.
- A general graph/workflow library: useful for richer graph algorithms, but heavier than the current static DAG needs and likely to leak library concepts into public APIs too early.
- PocketFlow: a small workflow-oriented dependency that gives the project a vocabulary for nodes/flows while still allowing Pi-specific validation, policy, and runner boundaries to stay explicit.

## Decision

Use `pocketflow` as the workflow/orchestration dependency for `pi-subflow`, but keep it as an internal implementation detail rather than a public API commitment.

Durable rationale:

- PocketFlow is lightweight enough for a Pi extension prototype and avoids committing to a large workflow engine before the feature set justifies one.
- It provides a workflow abstraction layer above hand-written control flow, reducing the chance that retries, verifier repair, budget checks, and future routing behavior become tangled with Pi extension registration.
- It lets the project separate orchestration concepts from execution details: subagent execution remains behind `SubagentRunner`, and validation remains behind the DAG validation boundary.
- It keeps migration options open. If conditional branches, nested workflows, dynamic dependencies, or graph visualization outgrow PocketFlow or the current custom validator, internals can change without breaking callers.

Stable architecture decisions:

- Execution is hidden behind a `SubagentRunner` interface. Test runners and real Pi-backed runners are interchangeable from the workflow functions' perspective.
- Flow modules expose simple TypeScript functions: `runSingle`, `runChain`, `runParallel`, and `runDag`.
- The Pi extension entry points are `registerPiSubflowExtension` and the default extension export.
- The `subflow` tool supports single, chain, parallel, and DAG modes. Direct task-array DAGs use `dependsOn`; `dagYaml` additionally accepts `needs` as an authoring alias. YAML parsing normalizes `needs` to `dependsOn` before the DAG validation boundary described in ADR 0002. A single `dagYaml` task must not set both fields; the current parser rejects that ambiguity instead of choosing a winner.
- DAG validation happens before execution. Task names are validated as unique, dependency failures skip downstream tasks, verifier fan-in is part of DAG semantics, and results carry structured `dependsOn` metadata so renderers and history views do not infer graph edges from prompt text.
- As of the DAG node integration slice, DAG execution is PocketFlow node-backed internally: validation, max-turns preflight, stage execution, verifier repair, and result aggregation run through explicit internal PocketFlow nodes. Chain and parallel modes still use custom orchestration and remain candidates for later node-backed slices.
- Workflow files are a Pi extension feature, not a core orchestration API. Safe repo-local `.pi/subflow/workflows/*.yaml` / `.yml` files and user `~/.pi/agent/subflow/workflows/*.yaml` / `.yml` files are registered by the extension during session startup and may generate prompt stubs under the matching `prompts/` directory for Pi prompt discovery. Project workflow commands take precedence over user workflow commands with the same name. Prompt-template names may still collide with normal Pi prompt directories such as `~/.pi/agent/prompts`; Pi's prompt loader reports those collisions and keeps the first prompt template, while registered workflow extension commands are handled before prompt-template expansion. These are extension-level integration guarantees for current workflow commands, not core orchestration API guarantees.
- Workflow command arguments and recent conversation context are treated as prompt content prepended to workflow task bodies. They are not task metadata, are not interpolated into YAML, and are not shell-expanded.
- PocketFlow primitives and future workflow-IR internals are non-goals for the public API; callers should not depend on PocketFlow-specific or graph-library-specific state.

Current runner and extension implementation notes, intentionally weaker than architecture guarantees:

- The real Pi runner currently creates isolated SDK sessions for each subagent run and passes explicit task tool/model/thinking/cwd settings through the Pi SDK where supported.
- Agent definitions currently contribute description, markdown instructions, and default `tools`, `model`, and `thinking` hints unless task fields override them.
- Explicit tool names are currently checked against a runtime allowlist before SDK session creation.
- Extension-created tasks currently default to the active Pi cwd unless they set `cwd` explicitly.
- Retry handling, including the current rule that mutating and external-side-effect tasks are not retried, is implementation policy rather than a stable core API shape.
- Workflow prompt stubs are implementation aids for Pi prompt discovery. Generated stubs are marked and may be refreshed or removed; manually authored prompt files are preserved.
- `dependsOn` currently drives deterministic static DAG stage planning; richer workflow forms should pass through the validation boundary rather than leaking planner internals.

Supporting modules expose Pi-extension-adjacent capabilities without coupling them to tool registration:

- `discoverAgents` loads markdown agent definitions from user and project directories.
- `validateExecutionPolicy` enforces project-local confirmation and external-side-effect risk rules before UI side-effect confirmation prompts are shown.
- `appendRunHistory` records JSONL run summaries.
- DAG execution supports verifier repair and re-verification rounds.

The DAG validation boundary in ADR 0002 is an internal workflow-IR seam: it should receive tasks after input-format alias normalization, diagnose invalid graphs, and plan stages before execution without exposing graph library concepts. Re-evaluate whether a graph library is warranted only when advanced features such as conditional branches, nested workflows, or dynamic dependency graphs make the custom validator insufficient.

## Consequences

Positive:

- Workflow logic remains separated from Pi extension registration and TUI concerns, while a thin extension adapter makes the core usable from Pi with live progress and readable final summaries.
- Single, chain, parallel, DAG, verifier, retry, timeout, validation, budget, cancellation, tool allowlisting, and trace behavior can be tested without launching Pi subprocesses.
- SDK-based execution avoids subprocess overhead while keeping isolated per-subagent sessions and can still honor named agent instructions through the runner boundary.
- The design leaves room for future adaptive routing and verifier-repair loops without turning Pi extension glue into the orchestration layer.

Tradeoffs:

- This is a prototype, not a drop-in replacement for the current Pi extension; the extension adapter has live progress and JSONL history recording, but interactive history browsing and the original extension's full streaming run-management experience remain planned work.
- PocketFlow TypeScript is still small and may not cover every desired workflow pattern directly.
- SDK execution couples the real runner to the `@earendil-works/pi-coding-agent` package API, so version compatibility and available tool names must be monitored.
- Some orchestration helpers remain custom because Pi-specific semantics are stricter than generic flow execution.

## Synchronization requirement

When this ADR changes in a way that affects project purpose, architecture, scope, install/test commands, or public APIs, update `README.md` in the same change. When `README.md` changes those same topics, review this ADR and update it if needed.
