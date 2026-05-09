# Architecture

Important boundaries:

- Workflow functions are independent from Pi UI concerns.
- `SubagentRunner` isolates orchestration from real Pi execution.
- `PiSdkRunner` creates a fresh in-memory Pi SDK session per subagent run.
- Agent markdown is included as quoted untrusted context, below system and caller instructions.
- DAG normalization, validation, and planning live behind the DAG validation boundary.

High-level flow:

```text
Pi extension subflow tool
  -> policy and tool allowlist
  -> flow selector: single, chain, parallel, DAG
  -> DAG validation and stage planning when needed
  -> SubagentRunner
  -> PiSdkRunner or MockSubagentRunner
  -> JSONL history and renderer
```
