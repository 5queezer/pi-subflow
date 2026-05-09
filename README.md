# pi-subflow

PocketFlow-powered prototype for Pi subagent orchestration.

`pi-subflow` explores a cleaner architecture for the Pi Subagent Extension: PocketFlow models the workflow layer, while Pi-specific execution is isolated behind a `SubagentRunner` interface. The preferred real Pi adapter is SDK-based (`PiSdkRunner`); subprocess execution remains available as an isolation/compatibility fallback.

## Why

The existing Pi subagent extension mixes tool registration, subprocess management, policy checks, DAG execution, validation, and rendering in one extension. This project prototypes a reusable orchestration core that can later be embedded back into a Pi extension.

## Features in this MVP

- Single subagent task execution
- Sequential chains with `{previous}` handoff
- Parallel fanout with bounded concurrency
- DAG execution with dependency stages
- Verifier fan-in: verifier tasks without `dependsOn` depend on all non-verifier tasks
- Dependency output injection for verifiers
- Markdown section / minimal JSON required-field validation
- Retry, timeout, and aggregate budget helpers
- Mock runner for deterministic tests
- Pi SDK runner that creates an isolated in-memory Pi session per subagent run, can inject discovered agent instructions into the task prompt, fails fast on unknown explicit models, and forwards cwd/tools/model/thinking into SDK session creation
- Pi subprocess runner scaffold for strict process isolation / CLI compatibility, including cwd/model/thinking/tools forwarding where possible
- Agent markdown discovery for user/project scopes
- Project-agent and external-side-effect policy checks with risk validation before UI side-effect confirmation
- JSONL run-history append helper
- Verifier repair and re-verification rounds
- Pi extension entry point that registers a `subflow` tool and interactive `/subflow-runs` browser
- Rich progress widget during interactive `subflow` execution with mode/status, task counts, per-task symbols, elapsed time, and timeout visibility
- Agent-defined `tools`, `model`, and `thinking` are applied as runner inputs, not only prompt hints

## Install

```bash
npm install
```

## Test

```bash
npm test
```

## Project APIs

Primary exports:

- `discoverAgents` for loading markdown agent definitions from user and project directories.
- `validateExecutionPolicy` for project-local agent confirmation and external-side-effect checks.
- `appendRunHistory` for JSONL run history persistence.
- `MockSubagentRunner`, `PiSdkRunner`, and `PiSubprocessRunner` for pluggable subagent execution.
- `runSingle`, `runChain`, `runParallel`, and `runDag` for workflow execution.
- `registerPiSubflowExtension` / default `piSubflowExtension` for registering the orchestration core as a Pi extension tool.

## Pi extension usage

The package now includes an extension entry point. In development, load it with Pi's extension flag or add the built file/path to Pi extension settings after building:

```bash
npm run build
pi -e ./dist/extension.js
```

The extension registers:

- `subflow` tool: accepts `agent` + `task`, `chain`, or `tasks` and dispatches to single, chain, parallel, or DAG execution. In interactive Pi sessions it shows a progress widget with mode/status, completion/failure/skipped counts, elapsed time, timeout, and per-task `✓`/`✗`/`⏳` rows, then clears the widget at completion. The tool owns its visible Pi card renderer (`renderShell: "self"`) so the call/result card shows a compact summary with task-level output/error lines, each task's agent/model (or `default`), collapsed long outputs, a `final:` line when available, and a labeled ASCII `DAG graph` with role and model metadata for dependency runs.
- `/subflow-runs` command: opens an interactive run-history browser for `.pi/subflow-runs.jsonl`. Use arrow keys or `j`/`k` to navigate, enter for details, and escape/`q` to go back or close. Tool executions append history to `.pi/subflow-runs.jsonl` under the active working directory by default.

Project-local agent scopes prompt for confirmation when UI is available; non-UI executions must explicitly set `confirmProjectAgents: false`. External side-effect tasks require `riskTolerance: "high"` and confirmation or explicit bypass; the risk check runs before prompting so low-risk calls fail without a misleading confirmation.

When an agent definition declares `tools`, `model`, or `thinking`, the extension applies those values to the actual runner input for tasks using that agent. Explicit task-level values still override agent defaults. Tasks and chain steps default to the active Pi `cwd` unless they set `cwd` explicitly.

## Runner choices

- Use `PiSdkRunner` for normal in-process Pi execution. It creates a fresh `createAgentSession()` session with `SessionManager.inMemory()` for each subagent run, preserving context isolation without spawning a full `pi` process. Pass discovered agent definitions via `agentDefinitions` when you want the runner to include the selected agent's description, tools, model/thinking hints, and markdown instructions in the task prompt. When invoked through the extension, effective task inputs include agent-defined tools/model/thinking before reaching the runner. Explicit `model` values are resolved through the Pi model registry and fail fast if unknown instead of silently falling back to the default model. Tests can inject `modelRegistry` and `createAgentSession` through `PiSdkRunnerOptions`.
- Use `PiSubprocessRunner` when strict process isolation, CLI behavior parity, or environment separation is more important than spawn overhead. It forwards task `cwd`, `model`, `thinking`, and `tools` to the Pi CLI where possible.
- Use `MockSubagentRunner` for deterministic tests and local orchestration development.

## Example

```ts
import { MockSubagentRunner, runDag } from "pi-subflow";

const runner = new MockSubagentRunner({
  scout: async ({ task }) => `found: ${task}`,
  reviewer: async ({ task }) => `verified:\n${task}`,
});

const result = await runDag({
  tasks: [
    { name: "frontend", agent: "scout", task: "Inspect frontend auth" },
    { name: "backend", agent: "scout", task: "Inspect backend auth" },
    { name: "verify", agent: "reviewer", role: "verifier", task: "Synthesize findings" },
  ],
}, { runner });
```

## Architecture decision records

ADRs live in [`docs/adr/`](docs/adr/). Start with [`ADR 0001: Use PocketFlow for the subagent orchestration core`](docs/adr/0001-pocketflow-orchestration-core.md).

Keep this README and ADRs synchronized when architecture, scope, public APIs, install/test commands, or design rationale change.

## Name collision check

Before creation, these were checked as free:

- local sibling directory: `../pi-subflow`
- npm package: `pi-subflow` returned 404
- `https://pi.dev/pi-subflow` returned 404
- `https://www.pi.dev/pi-subflow` returned 404
