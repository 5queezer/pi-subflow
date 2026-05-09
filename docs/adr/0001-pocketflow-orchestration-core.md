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

The package also exposes a Pi extension entry point via `registerPiSubflowExtension` and the default extension export. The extension registers a `subflow` tool that dispatches to the orchestration APIs, accepts a `dagYaml` YAML shorthand for concise LLM-authored DAGs and normalizes it to the existing task array shape, displays a live progress widget in interactive sessions, owns its visible tool card rendering via `renderShell: "self"`, returns compact summary cards with task-level success/error lines, agent/model metadata, and labeled DAG graph structure derived from structured dependency metadata, and records JSONL history. At session start it also scans repo-local `.pi/subflow/workflows/*.yaml` and `.pi/subflow/workflows/*.yml` files with safe command names, lists them in a dedicated `[Workflows]` startup section, and registers slash commands such as `/code-review`; those commands inject text after the slash command into each task as workflow command arguments, execute the DAG immediately through the same policy, agent discovery, progress, and history path as the tool, show a completion notification, open the final subflow summary in an editor, use both user and project-local agents, and reject task `cwd` values that are absolute or contain `..`. An interactive run-history browser remains planned, but `/subflow-runs` is not registered until its TUI behavior is stable across Pi terminals.

Supporting modules expose Pi-extension-adjacent capabilities without coupling them to tool registration:

- `discoverAgents` loads markdown agent definitions from user and project directories; the extension applies agent-defined `tools`, `model`, and `thinking` to effective runner inputs unless a task explicitly overrides them. Explicit tools are checked against a runtime allowlist before SDK session creation. Extension-created tasks default to the active Pi cwd unless they set cwd explicitly.
- `validateExecutionPolicy` enforces project-local confirmation and external-side-effect risk rules before UI side-effect confirmation prompts are shown. Mutating and external-side-effect tasks are not retried, even when retry budgets are configured.
- `appendRunHistory` records JSONL run summaries.
- DAG execution supports verifier repair and re-verification rounds. DAG task names must be unique, and task results carry structured `dependsOn` metadata so renderers and history views do not infer graph edges from injected prompt text.

PocketFlow primitives may be used internally, but public APIs should remain stable and not leak PocketFlow-specific state unless there is a clear need.

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
