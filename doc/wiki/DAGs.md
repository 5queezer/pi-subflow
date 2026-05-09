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

The shorthand is only an authoring format at the Pi tool boundary. Internally it becomes the same `tasks` array. It supports an intentionally small subset: task mappings, scalar strings, inline string arrays such as `[read, bash]`, one nested `jsonSchema.required` mapping, and `|`/`>` block strings. YAML anchors, aliases, and advanced tags are not supported.

### Supported task fields

| Field | Type / values | Notes |
| --- | --- | --- |
| `name` | string | Required for DAG task arrays; implicit from each `dagYaml` top-level key. |
| `agent` | string | Required agent name. |
| `task` | string | Required prompt text for the subagent. |
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

Verifier fan-in shortcut: if a task has `role: "verifier"` and no explicit `dependsOn`, it depends on all non-verifier tasks.
