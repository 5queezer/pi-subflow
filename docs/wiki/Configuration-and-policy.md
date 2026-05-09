# Configuration and policy

### Agent scope

Agents are markdown files discovered from user and/or project directories. Project-local agents require confirmation in interactive sessions unless explicitly disabled.

```json
{
  "agentScope": "both",
  "confirmProjectAgents": true
}
```

### Tools

Set the minimum tool subset each subagent needs:

```json
{
  "tools": ["read", "grep", "find"]
}
```

By default, explicit task tools are checked against this runtime allowlist:

```text
read, bash, grep, find, ls, edit, write
```

Embedders can override the allowlist through `registerPiSubflowExtension(..., { allowedTools })`.

### Models and thinking

Set `model` and `thinking` globally, per task, or in agent frontmatter. Explicit task values win over agent defaults. Supported `thinking` values are `off`, `minimal`, `low`, `medium`, `high`, and `xhigh`.

```json
{
  "model": "openai-codex/gpt-5.4-mini",
  "thinking": "low"
}
```

### Risk and retries

External side-effect tasks require high risk tolerance and confirmation or explicit bypass. Mutating and external-side-effect tasks are not retried, even when `maxRetries` is greater than 1.

```json
{
  "riskTolerance": "high",
  "maxRetries": 2,
  "timeoutSeconds": 120,
  "maxTurns": 40
}
```
