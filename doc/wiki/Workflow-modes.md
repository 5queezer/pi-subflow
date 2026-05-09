# Workflow modes

| Mode | Use when | Input shape |
| --- | --- | --- |
| Single | exactly one focused subagent task is useful | `agent` + `task` |
| Chain | a linear pipeline where each step may consume the immediately previous result | `chain: [{ agent, task }]` with optional `{previous}` |
| Parallel | 2+ independent tasks can run concurrently | `tasks: [...]` with no `dependsOn` |
| DAG | named dependencies, parallel stages, verifier fan-in, bounded loops, and inline nested workflows | `tasks: [...]` with `dependsOn`, `loop`, `dagYaml`, or `workflow: { tasks / dagYaml }` |

### Chain vs DAG

A DAG can model chain ordering by making each task depend on the previous task, but the modes are intentionally different:

- `chain` is an ergonomic linear pipeline. Each step runs after the previous step and can splice the previous step's output into its prompt with `{previous}`.
- `dag` is a named dependency graph. Dependencies control scheduling and failure propagation. Dependency outputs are automatically injected only for `role: "verifier"` tasks.

Use `chain` for simple scout → implementer → reviewer handoffs. Use `dag` for named tasks, fan-out/fan-in, parallel dependency stages, verifier synthesis, bounded loops, or graph validation.
