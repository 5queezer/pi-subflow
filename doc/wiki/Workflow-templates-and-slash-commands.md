# Workflow templates and slash commands

Copy/paste templates from [`examples/workflows/`](https://github.com/5queezer/pi-subflow/tree/main/examples/workflows), then adjust agent names, target paths, and task text.

A JSON Schema for editor documentation and YAML language-server validation is available at [`schemas/subflow-dag.schema.json`](https://github.com/5queezer/pi-subflow/blob/main/schemas/subflow-dag.schema.json). Templates include this header so compatible editors can validate the YAML shape and offer completions:

```yaml
# yaml-language-server: $schema=../../schemas/subflow-dag.schema.json
```

The schema validates task fields, required `agent`/`task` strings, allowed enum values, and the `needs`/`dependsOn` mutual exclusion. Runtime DAG validation still handles graph semantics such as missing dependencies, self-dependencies, duplicate names, and cycles.

To make a template available as an immediate slash command, copy it into `.pi/subflow/workflows/` or `~/.pi/agent/subflow/workflows/`. At Pi session start the extension registers every `.yaml` or `.yml` file with a safe filename as a command named after the file stem:

```text
.pi/subflow/workflows/code-review.yaml -> /code-review
.pi/subflow/workflows/docs-consistency.yaml -> /docs-consistency
```

Running one of these commands executes the DAG immediately, without asking the LLM to call the `subflow` tool.

Prompt stubs are generated under `.pi/subflow/prompts/` for project workflow files and `~/.pi/agent/subflow/prompts/` for user workflow files when no manually authored prompt file with the same name exists. Those directories are returned from `resources_discover.promptPaths`.

Stable workflow-command behavior:

- repo-local `.pi/subflow/workflows/*.yaml` / `.yml` and user `~/.pi/agent/subflow/workflows/*.yaml` / `.yml` files with safe basenames are registered during session startup
- project workflows win when a user workflow has the same command name
- prompt-template names can collide with normal Pi prompts such as `~/.pi/agent/prompts/*.md`; Pi reports prompt collisions and keeps the first loaded prompt template
- registered workflow extension commands are handled before prompt-template expansion
- only generated stubs carrying the pi-subflow marker are overwritten or removed during refresh; manually authored prompt files are left intact
- recent chat history is prepended to every workflow task as `Recent conversation context`
- text after the slash command is prepended as `Workflow command arguments`; empty command arguments become `(none provided)`
- commands such as `/bug-investigation failing npm test output...` pass the user's request to every subagent
- completion adds a notification, a concise chat-history result, and an entry in `.pi/subflow/runs.jsonl`
- workflow commands resolve both user and project-local agents and still ask for project-agent and external-side-effect confirmations
- workflow task `cwd` values must be relative and cannot contain `..`
- run `/reload` after adding, removing, or renaming workflow files

Recipes (concrete jobs):

| Recipe | Use when | Path |
| --- | --- | --- |
| Code review fan-in | independent API, tests, and docs reviewers should feed one verdict | `examples/workflows/recipes/code-review.yaml` |
| Implementation planning | requirements, architecture, and risk scouts should feed one implementation plan | `examples/workflows/recipes/implementation-planning.yaml` |
| Research synthesis | web, repository, and docs research should be reconciled into one answer | `examples/workflows/recipes/research-synthesis.yaml` |
| Docs consistency | README, ADR, and LLM-facing guidance should be checked together | `examples/workflows/recipes/docs-consistency.yaml` |
| Bug investigation | repro, code-path, and test-gap scouts should feed one root-cause analysis | `examples/workflows/recipes/bug-investigation.yaml` |

Patterns (reusable shapes — see [[Workflow patterns|Workflow-patterns]] for model fit and rationale):

| Pattern | Use when | Path |
| --- | --- | --- |
| Adversarial triangle | a proposal needs steelman + attack rather than parallel polling | `examples/workflows/patterns/adversarial-triangle.yaml` |
| Two-tier audit | expensive parallel audits should be gated by a cheap triage | `examples/workflows/patterns/two-tier-audit.yaml` |
| Tournament | n-best with a deterministic discriminator (tests/benchmarks) | `examples/workflows/patterns/tournament.yaml` |
| Cross-validation | irreversible decisions need two independent runs and a tiebreaker | `examples/workflows/patterns/cross-validation.yaml` |
| Map-group-reduce | partition a large input, regroup findings by theme, rank by impact | `examples/workflows/patterns/map-group-reduce.yaml` |

These examples intentionally use generic agent names such as `reviewer`, `planner`, `researcher`, and `debugger`. Rename them to match agents installed in your Pi user or project agent directories.
