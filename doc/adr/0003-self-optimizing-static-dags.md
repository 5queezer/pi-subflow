# ADR 0003: Treat self-optimizing static DAGs as the research direction for workflow optimization

## Status

Accepted

## Context

`pi-subflow` currently supports static single, chain, parallel, and DAG workflows with validation, verifier fan-in, retries, policy checks, and run history. The next research-grade step is not simply "self-improving DAGs" as a vague product claim, but workflow optimization for LLM agents: using execution traces, objective functions, and candidate evaluation to improve agentic computation graphs.

The closest literature frames this space as **workflow optimization for LLM agents**, **agentic computation graphs**, **optimizable agent graphs**, **multi-agent topology optimization**, and **self-evolving agents**. Relevant work includes:

- **AFlow: Automating Agentic Workflow Generation** — treats workflows as code-represented graphs with LLM nodes and edges, then uses MCTS, execution feedback, and iterative code modification to improve workflows.
- **GPTSwarm: Language Agents as Optimizable Graphs** — models language agents as computational graphs and optimizes node-level prompts plus edge connectivity.
- **Multi-Agent Design / MASS** — optimizes prompts and multi-agent topology in stages: local prompt optimization, workflow topology optimization, and global prompt optimization.
- **EvoAgentX** — provides workflow, evolving, and evaluation layers and integrates optimizers such as TextGrad, AFlow, and MIPRO for prompts, tool configurations, and workflow topology.
- **TextGrad** — backpropagates textual feedback through computation graphs to improve prompts, code snippets, and other variables.
- **MIPRO** — optimizes instructions and demonstrations for multi-stage LM programs using downstream metrics, mini-batch evaluation, and credit assignment across modules.
- **AWO: Optimizing Agentic Workflows using Meta-tools** — profiles workflow traces, identifies repeated tool-call sequences, and compiles them into deterministic composite tools for efficiency.
- **Helium** — treats agentic workflows as query plans and optimizes runtime efficiency through caching, scheduling, and cross-call redundancy reduction.
- **Automated Design of Agentic Systems / ADAS** — uses a meta-agent to generate improved agentic systems in code, including prompts, tool use, and workflows.
- **Darwin Gödel Machine** — explores open-ended self-improvement of a coding agent by modifying and validating its own code.
- **From Static Templates to Dynamic Runtime Graphs** — surveys workflow optimization for LLM agents and categorizes systems by structure, optimized component, and evaluation signal.

For `pi-subflow`, the most directly applicable combination is **AFlow + MASS + AWO**:

1. AFlow motivates search over candidate workflow graphs.
2. MASS motivates joint prompt and topology optimization.
3. AWO motivates trace-derived profiling and collapsing inefficient recurring subgraphs.

## Decision

Adopt **self-optimizing static DAGs with trace-derived critique and candidate evaluation** as the project's future workflow-optimization direction.

The first version should optimize authored static DAGs rather than introduce dynamic runtime graphs. It should take an existing target DAG, run it on an evaluation set, collect traces and quality/cost/latency metrics, propose candidate changes, evaluate those candidates against the same objective, and select a replacement only when it improves the objective without unacceptable regressions.

The practical meta-workflow should be modeled as a DAG similar to:

```yaml
baseline-run:
  task: Run the target DAG on an eval set and collect score, cost, latency, failures, retries, token use, and node outputs.

trace-analyzer:
  needs: [baseline-run]
  task: Identify bottleneck nodes, redundant nodes, weak fan-in/fan-out structure, expensive low-value nodes, and verifier failures.

node-critic:
  needs: [baseline-run, trace-analyzer]
  task: Propose prompt/model/tool/thinking changes per node.

edge-critic:
  needs: [baseline-run, trace-analyzer]
  task: Propose DAG topology changes: remove edges, add verifier fan-in, split overloaded nodes, merge redundant nodes.

candidate-generator:
  needs: [node-critic, edge-critic]
  task: Produce N candidate DAG YAMLs.

candidate-evaluator:
  needs: [candidate-generator]
  task: Run candidates on the same eval set and compare score/cost/latency.

optimizer-verdict:
  needs: [baseline-run, candidate-evaluator]
  role: verifier
  task: Select the best candidate only if it improves the objective without regression.
```

The optimizer should use an explicit objective function rather than a purely qualitative verdict:

```text
utility = task_score
        - λ_cost * dollar_cost
        - λ_latency * wall_time_seconds
        - λ_instability * failure_rate
        - λ_complexity * graph_complexity
```

The initial optimization surface is:

- node prompts
- node `model` selection
- node `thinking` level
- node tool sets
- node split/merge suggestions
- dependency edges and verifier fan-in shape
- repeated subgraphs that could become deterministic composite tools

The optimizer must preserve the DAG validation boundary from ADR 0002. Candidate DAGs are generated as authoring artifacts, then normalized and validated through the same validation/planning path as user-authored DAGs before any evaluation run spends model or tool budget.

## Non-goals

- Do not ship open-ended self-modification of `pi-subflow` itself as the first step. Darwin Gödel Machine-style self-improvement is a later and higher-risk research direction.
- Do not introduce dynamic runtime graph mutation before static DAG optimization has reliable traces, evaluation sets, and objective functions.
- Do not choose candidates based only on an LLM preference judgment. Candidate selection must be grounded in repeatable evaluation results.
- Do not bypass existing policy gates, tool allowlists, budget checks, or DAG validation when evaluating generated candidates.

## MVP interface

`subflow_propose_candidates` is the first candidate-generation surface for this ADR. It proposes validated authoring artifacts only; it does not run, score, or mutate workflows. `subflow_optimize` remains the evaluator: it accepts exactly one of `workflowPath` or `dagYaml`, exactly one of `evalSet.path` or `evalSet.inline`, and optional manual `candidateDagYamls`, `maxCandidateRuns`, `maxCost`, `maxRunCost`, `maxCandidateCost`, `maxTotalCost`, `maxConcurrency`, and `timeoutSeconds`. Exact-one invariants are enforced in the optimizer runtime (`evaluateOptimizerRun` → `loadWorkflowTasks` and `loadEvalSet`) before any candidate execution.

Canonical eval sets live under `.pi/subflow/evals/*.yaml`. Structural checks (`expectedSections` and `jsonSchema.required`) are gates, not quality scores. Candidate recommendations require scorer-backed eval cases; structural-only eval sets remain profile-only. Eval input is injected into explicit `entryTasks` or root runnable tasks instead of every downstream prompt. Optional train/holdout splits let the optimizer select on train cases and require holdout gates before promotion. File replacement remains out of scope until a separate apply tool is introduced.

The tool writes collision-resistant report artifacts under `.pi/subflow/optimizer-reports/` with exclusive creation and must not mutate workflow files. Invalid or policy-failing candidates are reported per candidate and do not abort the whole dry run. Any future file-replacement behavior belongs in a separate `subflow_optimize_apply` tool so the apply step is explicit and opt-in. That separation is intentional while this feature remains dry-run-only; replacement is not yet implemented to keep optimization experiments non-destructive until evaluator reliability, regression controls, and policy/allowlist safeguards are productionized in a separate command.

## Consequences

Positive:

- The roadmap gets a concrete research feature rather than a vague self-improvement claim.
- Trace data becomes actionable: traces can identify bottlenecks, redundant nodes, weak topology, verifier failures, and repeated subgraphs.
- The project can improve quality, cost, and latency while keeping static DAG authoring and validation semantics intact.
- The approach aligns with current agent-workflow research without committing to full open-ended self-modifying agents.

Tradeoffs:

- Reliable optimization requires evaluation datasets, scoring functions, cost/latency instrumentation, and comparable repeated runs.
- Candidate generation can overfit to small eval sets, so the optimizer needs holdout tasks or explicit regression checks before recommending changes.
- Topology mutation increases the importance of clear graph-complexity penalties and human-readable diffs.
- Running multiple candidates can be expensive, so the optimizer must expose budget controls and should support cheap profiling passes before broad search.

## Follow-up

- Add trace fields needed for optimization: node output summaries, token/cost estimates, latency, retry counts, failures, model/thinking/tool configuration, and dependency metadata.
- Improve scorer prompts and trace fields as more real eval sets are collected.
- Keep mutation as a separate `subflow_optimize_apply` operation that consumes a saved report, and keep it unreleased until dry-run metrics, holdout gates, and safety policies are sufficiently stable for explicit file replacement.
- Keep file replacement out of scope until a separate apply tool is introduced.
- Consider an AWO-inspired pass that detects repeated tool-call sequences and suggests deterministic composite tools.
- Keep README, wiki roadmap, and this ADR synchronized when this direction changes scope, public API, or implementation behavior.

## References

- AFlow: Automating Agentic Workflow Generation — <https://arxiv.org/abs/2410.10762>
- GPTSwarm: Language Agents as Optimizable Graphs — <https://proceedings.mlr.press/v235/zhuge24a.html>
- Multi-Agent Design: Optimizing Agents with Better Prompts and Topologies — <https://arxiv.org/abs/2502.02533>
- EvoAgentX: An Automated Framework for Evolving Agentic Workflows — <https://arxiv.org/abs/2507.03616>
- TextGrad: Automatic Differentiation via Text — <https://arxiv.org/abs/2406.07496>
- Optimizing Instructions and Demonstrations for Multi-Stage Language Model Programs / MIPRO — <https://arxiv.org/abs/2406.11695>
- Optimizing Agentic Workflows using Meta-tools / AWO — <https://arxiv.org/abs/2601.22037>
- Efficient LLM Serving for Agentic Workflows / Helium — <https://arxiv.org/abs/2603.16104>
- Automated Design of Agentic Systems / ADAS — <https://arxiv.org/abs/2408.08435>
- Darwin Gödel Machine — <https://arxiv.org/abs/2505.22954>
- From Static Templates to Dynamic Runtime Graphs: A Survey of Workflow Optimization for LLM Agents — <https://arxiv.org/abs/2603.22386>
