# DAGs

DAG mode runs dependency stages in order. Tasks with no dependencies run first; dependent tasks run only after prerequisites complete. Verifier tasks receive dependency outputs automatically.

Example task array:

```json
{
  "tasks": [
    {
      "name": "api-review",
      "agent": "reviewer",
      "task": "Review src/index.ts and public exports",
      "tools": ["read"],
      "model": "openai-codex/gpt-5.4-mini"
    },
    {
      "name": "tests-review",
      "agent": "reviewer",
      "task": "Review tests for missing failure-path coverage",
      "tools": ["read"],
      "model": "openai-codex/gpt-5.4-mini"
    },
    {
      "name": "final-verdict",
      "agent": "reviewer",
      "role": "verifier",
      "dependsOn": ["api-review", "tests-review"],
      "task": "Synthesize dependency outputs into a prioritized verdict",
      "tools": ["read"],
      "model": "openai-codex/gpt-5.4-mini"
    }
  ]
}
```

### `dagYaml` shorthand

For LLM-authored DAGs, the Pi tool accepts `dagYaml`. The YAML root is a mapping from task names to task fields. `needs` is an authoring alias normalized to `dependsOn` before DAG validation; use one or the other, not both. If both appear on one `dagYaml` task, parsing fails instead of choosing a winner.

```yaml
api-review:
  agent: reviewer
  task: Review src/index.ts and public exports
  tools: [read]
  model: openai-codex/gpt-5.4-mini

tests-review:
  agent: reviewer
  task: Review tests for missing failure-path coverage
  tools: [read]
  model: openai-codex/gpt-5.4-mini

final-verdict:
  agent: reviewer
  role: verifier
  needs: [api-review, tests-review]
  task: Synthesize dependency outputs into a prioritized verdict
```

The shorthand is only an authoring format at the Pi tool boundary. Internally it becomes the same `tasks` array. It is parsed as YAML, so equivalent YAML forms are accepted, including inline arrays (`needs: [api-review, tests-review]`) and block sequences:

```yaml
needs:
  - api-review
  - tests-review
```

### Supported task fields

| Field | Type / values | Notes |
| --- | --- | --- |
| `name` | string | Required for DAG task arrays; implicit from each `dagYaml` top-level key. |
| `agent` | string | Required agent name. |
| `task` | string | Required prompt text for the subagent. |
| `workflow` | nested workflow | Optional inline child workflow; child task names are namespaced under the parent. |
| `loop` | bounded repeated sub-DAG | Optional repeated body with `maxIterations`, `body`, and optional `until`. |
| `cwd` | string | Optional working directory; workflow slash commands reject absolute paths and `..`. |
| `dependsOn` / `needs` | string[] | DAG dependencies; `needs` is a `dagYaml` alias and cannot be combined with `dependsOn`. |
| `role` | `worker` \| `verifier` | Omit for normal workers; verifier tasks receive dependency outputs. |
| `authority` | `read_only` \| `internal_mutation` \| `external_side_effect` | Drives retry and policy behavior. `external_side_effect` is high risk because it can affect external systems and requires confirmation unless explicitly allowed by policy/risk settings. |
| `tools` | string[] | Minimum tool subset for the subagent. |
| `model` | string | Model identifier passed through the Pi model registry by the SDK runner. |
| `thinking` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` | Can be set globally, per task, or in agent frontmatter. |
| `expectedSections` | string[] | Markdown headings that must appear in successful task output; prefer this for markdown output contracts. |
| `jsonSchema.required` | string[] | Minimal JSON-output validation only: task output must parse as JSON and named top-level required fields must be present. This is not full JSON Schema validation. |

### DAG validation

Validation happens before execution. Invalid graphs fail before any subagent runs.

| Invalid DAG | Error |
| --- | --- |
| duplicate task name | `duplicate DAG task name: dup` |
| missing dependency | `task verify depends on missing task missing` |
| self-dependency | `task loop cannot depend on itself` |
| dependency cycle | `dependency cycle: a -> b -> a` |
| invalid loop maxIterations | `task research-loop loop maxIterations must be a positive integer` |

Verifier fan-in shortcut: if a task has `role: "verifier"` and no explicit `dependsOn`, it depends on all non-verifier tasks.

### Nested workflows

A DAG task can also contain an inline nested workflow with `workflow.tasks` or `workflow.dagYaml`. Child task names are namespaced under the parent task (for example, `review.api`), parent `dependsOn` values flow into workflow roots, and the parent task exposes a synthetic summary result for downstream dependents.

### Bounded loops

A DAG task can repeat a body with `loop: { maxIterations, body, until? }`. The loop parent may omit `agent` and `task`, just like workflow parents. Body tasks are namespaced per iteration (`research-loop.1.editor`), root body tasks inherit the loop parent's dependencies on the first pass, later passes inherit the previous iteration's terminal nodes, and `until` evaluates against current-iteration aliases such as `${editor.output.continue} == false`. The loop parent emits a synthetic summary with the iteration count and final status.
