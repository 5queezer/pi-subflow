# ADR 0001: Use PocketFlow for the subagent orchestration core

## Status

Accepted

## Context

`pi-subflow` is a sibling prototype for recreating the Pi Subagent Extension's workflow layer with clearer boundaries. The existing extension combines Pi tool registration, agent discovery, SDK-based agent execution, policy checks, validation, tracing, and workflow orchestration in one implementation.

We want a design that keeps Pi-specific integration replaceable while making the orchestration behavior easier to test and evolve.

## Decision

Use `pocketflow` as the workflow/orchestration dependency for `pi-subflow`.

The project will keep execution behind a `SubagentRunner` interface:

- `MockSubagentRunner` supports deterministic tests and local development.
- `PiSdkRunner` is the real Pi adapter. It creates a fresh SDK `createAgentSession()` with `SessionManager.inMemory()` per subagent run, preserving subagent context isolation without spawning a full `pi` process. When supplied with discovered agent definitions, it includes the selected agent's description, tools, model/thinking hints, and markdown instructions in the subagent task prompt, with agent markdown quoted as untrusted context below system/caller instructions. Explicit task `tools` values are passed to the SDK session as the active tool subset; omitted tools let Pi create its default tool set for the subagent cwd. Explicit model selections are resolved through the Pi model registry and fail fast if unknown, and tests can inject `modelRegistry` / `createAgentSession` seams.

Flow modules expose simple TypeScript functions for consumers:

- `runSingle`
- `runChain`
- `runParallel`
- `runDag`

The package also exposes a Pi extension entry point via `registerPiSubflowExtension` and the default extension export. The extension registers a `subflow` tool that dispatches to the orchestration APIs, accepts a `dagYaml` YAML shorthand for concise LLM-authored DAGs and normalizes it to the existing task array shape, displays a live progress widget in interactive sessions, owns its visible tool card rendering via `renderShell: "self"`, returns compact summary cards with task-level success/error lines, agent/model metadata, and labeled DAG graph structure derived from structured dependency metadata, and records JSONL history.

Repo-local workflow files are a Pi extension feature, not a core orchestration API. The extension scans `.pi/subflow/workflows/*.yaml` and `.pi/subflow/workflows/*.yml` files whose basenames are safe command names, registers slash commands such as `/code-review`, and generates marked prompt-template stubs under `.pi/subflow/workflow-prompts/`. Those stubs are returned from `resources_discover.promptPaths`; in Pi, that prompt-path discovery is the mechanism that makes generated workflow entries visible in the native `[Prompts]` startup section and slash-command autocomplete. Slash-command registration is still performed during `session_start`, so prompt stubs advertise the commands while the registered command handler executes them. Prompt-stub cleanup is intentionally limited to files carrying the generated marker so manual prompt files are not removed.

Workflow command arguments are prompt content. Text after the slash command is trimmed, replaced with `(none provided)` when empty, and prepended to every workflow task body as:

```text
Workflow command arguments:
<arguments>

Workflow task:
<original task>
```

The arguments are not task metadata, are not interpolated into YAML, are not shell-expanded, and are not separately rendered as user-visible output except insofar as they appear in subagent prompts or downstream subagent output. Workflow commands execute the DAG immediately through the same policy, agent discovery, progress, and history path as the tool, show a completion notification, add a concise summary plus final output to chat history, use both user and project-local agents, and reject task `cwd` values that are absolute or contain `..`. An interactive run-history browser remains planned, but `/subflow-runs` is not registered until its TUI behavior is stable across Pi terminals.

Stable public API guarantees:

- The exported orchestration functions remain `runSingle`, `runChain`, `runParallel`, and `runDag`, with execution hidden behind `SubagentRunner`.
- The Pi extension entry points remain `registerPiSubflowExtension` and the default extension export.
- The `subflow` tool supports single, chain, parallel, and DAG modes, including `dagYaml` normalization and `needs` as an alias for `dependsOn`.
- DAG task names are validated as unique, dependency failures skip downstream tasks, verifier fan-in is part of DAG semantics, and task results carry structured `dependsOn` metadata so renderers and history views do not infer graph edges from injected prompt text.
- Workflow command arguments are prepended to task prompt content using the format above.
- PocketFlow primitives and future workflow-IR internals are non-goals for the public API; they may be used internally, but callers should not depend on PocketFlow-specific or graph-library-specific state.

Current runner and extension implementation details, intentionally not stronger API guarantees:

- `PiSdkRunner` currently creates a fresh SDK session with in-memory session state per subagent run and passes explicit task `tools` as the active SDK tool subset.
- Agent definitions currently contribute description, markdown instructions, and default `tools`, `model`, and `thinking` hints unless task fields override them.
- Explicit tool names are currently checked against a runtime allowlist before SDK session creation.
- Extension-created tasks currently default to the active Pi cwd unless they set `cwd` explicitly.
- Retry handling, including the current rule that mutating and external-side-effect tasks are not retried, is implementation policy rather than a stable core API shape.
- `dependsOn` currently drives deterministic static DAG stage planning; richer workflow forms should pass through the validation boundary rather than leaking planner internals.

Supporting modules expose Pi-extension-adjacent capabilities without coupling them to tool registration:

- `discoverAgents` loads markdown agent definitions from user and project directories.
- `validateExecutionPolicy` enforces project-local confirmation and external-side-effect risk rules before UI side-effect confirmation prompts are shown.
- `appendRunHistory` records JSONL run summaries.
- DAG execution supports verifier repair and re-verification rounds.

The DAG validation boundary is an internal workflow-IR seam: it should normalize tasks, diagnose invalid graphs, and plan stages before execution without exposing graph library concepts. Re-evaluate whether a graph library is warranted only when advanced features such as conditional branches, nested workflows, or dynamic dependency graphs make the custom validator insufficient.

## Consequences

Positive:

- Workflow logic remains separated from Pi extension registration and TUI concerns, while a thin extension adapter now makes the core usable from Pi with live progress and readable final summaries.
- Single, chain, parallel, DAG, verifier, retry, timeout, validation, budget, cancellation, tool allowlisting, and trace behavior can be tested without launching Pi subprocesses.
- SDK-based execution avoids subprocess overhead while keeping isolated per-subagent sessions and can still honor named agent instructions through the `agentDefinitions` runner option.
- The design leaves room for future adaptive routing and verifier-repair loops.

Tradeoffs:

- This is a prototype, not a drop-in replacement for the current Pi extension; the extension adapter has live progress and JSONL history recording, but interactive history browsing and the original extension's full streaming run-management experience remain planned work.
- PocketFlow TypeScript is still small and may not cover every desired workflow pattern directly.
- SDK execution couples the real runner to the `@earendil-works/pi-coding-agent` package API, so version compatibility and available tool names must be monitored.
- Some orchestration helpers remain custom because Pi-specific semantics are stricter than generic flow execution.

## Synchronization requirement

When this ADR changes in a way that affects project purpose, architecture, scope, install/test commands, or public APIs, update `README.md` in the same change. When `README.md` changes those same topics, review this ADR and update it if needed.
