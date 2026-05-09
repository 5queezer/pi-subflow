# Usage in Pi

Once loaded, Pi gets a `subflow` tool. Example request:

```text
Use subflow to run three read-only code review agents in parallel:
1. API surface review
2. test coverage review
3. README/docs review
Then run a verifier that synthesizes the findings.
Use cheap models for the first three tasks and a stronger model for the verifier.
```

For explicit DAGs, `dagYaml` is the most compact authoring form:

```yaml
api-review:
  agent: reviewer
  task: Review src/index.ts and public exports

test-review:
  agent: reviewer
  task: Review tests for coverage gaps

final-verdict:
  agent: reviewer
  role: verifier
  needs: [api-review, test-review]
  task: Synthesize findings into a prioritized verdict
```

The extension records JSONL history to `.pi/subflow/runs.jsonl` in the active project. An interactive history browser is planned, but is not registered until its TUI behavior is stable.
