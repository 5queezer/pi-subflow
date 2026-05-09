# ADR 0003 Pi-native optimizer design

## Status

Approved for implementation planning.

## Goal

Implement the first ADR 0003 optimizer as a Pi-native, dry-run-only tool that evaluates an authored workflow against a canonical eval set, optionally compares manually supplied candidate DAG YAMLs, and produces a scored report. The tool must make evals durable, avoid fake optimization from noisy single runs, and preserve the existing DAG validation, policy, tool allowlist, and budget boundaries.

## Non-goals

- No automatic workflow mutation in the first implementation.
- No LLM-generated candidates in the first implementation.
- No dynamic runtime graph mutation.
- No candidate recommendation based only on LLM preference judgment.
- No bypass around existing DAG validation or policy checks.

## User-facing interface

Add a new Pi tool named `subflow_optimize`.

The first version is always dry-run; it does not expose a `dryRun: false` path. A later mutation feature, if added, must be a separate operation such as `subflow_optimize_apply({ reportId })` that applies a previously written report.

Initial parameters:

```ts
{
  workflowPath?: string;
  dagYaml?: string;
  evalSet: { path: string } | { inline: EvalSet };
  candidateDagYamls?: string[];
  maxCandidateRuns?: number;
  maxCost?: number;
  maxConcurrency?: number;
  timeoutSeconds?: number;
}
```

Rules:

- Exactly one of `workflowPath` or `dagYaml` must be set.
- Exactly one of `evalSet.path` or `evalSet.inline` must be set.
- File-based eval sets under `.pi/subflow/evals/*.yaml` are canonical.
- Inline eval sets are accepted as convenience only and should be reported as ephemeral, with a recommendation to save them under `.pi/subflow/evals/<name>.yaml`.
- The tool returns a report and writes a JSON artifact under `.pi/subflow/optimizer-reports/` for later inspection.

## Eval-set format

Add `schemas/subflow-eval.schema.json` and a TypeScript loader/validator.

Minimum eval-set shape:

```yaml
name: docs-consistency
workflow: docs-consistency.yaml
objective:
  taskScore: 1
  cost: 1
  latency: 1
  instability: 1
  complexity: 0.25
scoring:
  minRunsPerCase: 1
  minUtilityDelta: 0.05
  maxFailureRateRegression: 0
cases:
  - name: readme-wiki-adr-sync
    input: Check README, wiki, ADR, and schema consistency.
    expectedSections: [Summary, Findings, Recommendation]
```

MVP scorer:

- A completed run receives task score `1` unless required output checks fail.
- A failed run receives task score `0`.
- Markdown `expectedSections` and minimal JSON `jsonSchema.required` reuse existing validation concepts.
- Multi-run policy exists in the schema and report, even if default `minRunsPerCase` is `1` for cost control.

## Objective and graph metrics

Compute utility as:

```text
utility = task_score
        - λ_cost * dollar_cost
        - λ_latency * wall_time
        - λ_instability * failure_rate
        - λ_complexity * graph_complexity
```

Graph complexity should count the current expressiveness surface:

- runnable task count
- dependency edge count
- conditional `when` count
- nested workflow depth
- bounded loop max-expansion bound
- synthetic workflow/loop summary nodes when known after validation expansion

The complexity score should be deterministic and computed before candidate execution.

## Internal optimizer meta-DAG

The implementation should model the optimizer conceptually as this workflow, even if the first code path executes some steps deterministically rather than by spawning subagents:

```yaml
eval-loader:
  agent: optimizer
  task: Load and validate the eval set. Prefer .pi/subflow/evals/*.yaml as canonical; accept inline only as ephemeral input. Produce normalized eval metadata and persistence recommendation.

baseline-profiler:
  agent: optimizer
  needs: [eval-loader]
  task: Run or summarize the baseline workflow against the eval set. Collect score, cost, latency, failures, retries, graph metrics, and trace summaries.

noise-analyzer:
  agent: optimizer
  needs: [baseline-profiler]
  task: Estimate score variance, insufficient sample risk, and whether candidate comparison is statistically meaningful.

trace-critic:
  agent: optimizer
  needs: [baseline-profiler, noise-analyzer]
  task: Identify bottleneck nodes, high-cost low-value nodes, flaky nodes, redundant edges, over-complex loops, and weak verifier fan-in.

candidate-validator:
  agent: optimizer
  needs: [eval-loader]
  task: Parse, normalize, and validate any manually supplied candidate DAG YAMLs through the existing DAG validation boundary before spending evaluation budget.

candidate-evaluator:
  agent: optimizer
  needs: [baseline-profiler, candidate-validator]
  task: Evaluate valid candidates against the same eval set and objective. Reject invalid, over-budget, or policy-unsafe candidates.

comparison-reporter:
  agent: optimizer
  needs: [baseline-profiler, noise-analyzer, trace-critic, candidate-evaluator]
  task: Produce a dry-run report with baseline, candidates, utility scores, regressions, confidence, and recommended next action.

optimizer-verdict:
  agent: optimizer
  role: verifier
  needs: [comparison-reporter]
  task: Decide whether any candidate should be recommended. Never mutate files. If inline eval was used, recommend saving it under .pi/subflow/evals/.
```

The first implementation should keep candidate generation outside the tool. Users may pass `candidateDagYamls`; otherwise the report profiles only the baseline and recommends likely improvement areas.

## Architecture

Add optimizer modules:

```text
src/dag-yaml.ts
src/optimizer/eval-set.ts
src/optimizer/objective.ts
src/optimizer/graph-metrics.ts
src/optimizer/evaluator.ts
src/optimizer/report.ts
src/optimizer/tool.ts
```

Responsibilities:

- `src/dag-yaml.ts`: extract shared DAG YAML parsing and nested workflow normalization from `src/extension.ts` so the existing `subflow` tool and new optimizer share one authoring path.
- `eval-set.ts`: load path or inline eval sets, validate XOR rules, enforce canonical path guidance, and parse objective/scoring/cases.
- `objective.ts`: compute task score, cost, latency, instability, complexity, and final utility.
- `graph-metrics.ts`: inspect normalized/expanded DAGs and compute deterministic complexity.
- `evaluator.ts`: validate baseline/candidates, run cases through existing `runDag`, aggregate results, and stop on budget/timeout.
- `report.ts`: render human-readable and JSON reports, including invalid candidates and inline persistence recommendations.
- `tool.ts`: expose the Pi tool execution function used by `src/extension.ts`.

## Data flow

1. Normalize the target workflow from `workflowPath` or `dagYaml`.
2. Load and validate eval set from canonical file path or inline object.
3. Validate the baseline DAG through the existing DAG validation boundary before any execution.
4. Compute baseline graph metrics.
5. Run the baseline for each eval case and configured repeat count.
6. Validate every supplied candidate before executing any candidate runs.
7. Run valid candidates against the same eval cases and scoring policy.
8. Compute objective scores and compare candidates to baseline.
9. Produce a dry-run report with recommendation, confidence, risks, and next actions.
10. Append normal subflow run history for underlying workflow runs where applicable and write an optimizer report artifact.

## Error handling and safety

- Invalid eval sets fail before any workflow execution.
- Invalid baseline DAG fails before any eval run.
- Invalid candidate DAGs are listed in the report and are not executed.
- Budget and timeout failures produce partial reports when possible.
- Inline eval sets cannot loosen policy checks, tool allowlists, or cwd safety.
- Repo-local eval file paths must stay inside the project, preferably under `.pi/subflow/evals/`.
- External-side-effect workflow tasks continue to require the existing confirmation/risk policy.

## Documentation and examples

Add or update:

- `README.md` feature/docs summary for `subflow_optimize`.
- `doc/wiki/Workflow-optimization.md` for eval sets, scoring, dry-run reports, and safety model.
- `doc/wiki/Roadmap.md` to mark the optimizer MVP shape.
- `doc/adr/0003-self-optimizing-static-dags.md` if behavior or scope changes from the current ADR.
- `schemas/subflow-eval.schema.json`.
- Example eval file under `.pi/subflow/evals/` or `examples/evals/`.

Preferred first example target: docs/code consistency review for this repo, because README/wiki/ADR/schema/tool guidance synchronization is project-critical and easier to score than open-ended creative tasks.

## Tests

Add tests for:

- eval-set schema/loader accepts canonical file and inline forms.
- loader rejects path+inline and missing eval sets.
- DAG YAML parser extraction preserves current `subflow` behavior.
- baseline-only optimizer report works.
- invalid candidate is reported but not executed.
- valid manual candidate is evaluated after validation.
- utility calculation handles cost, latency, instability, and complexity weights.
- graph metrics count conditionals, nested workflows, bounded loops, and summary nodes.
- `subflow_optimize` is registered with LLM-facing guidance.

Before completion, run:

```bash
npm run build && npm test
```

## Open follow-up after MVP

- Add LLM candidate generation as a separate milestone after scoring policy is calibrated.
- Add `subflow_optimize_apply({ reportId })` only after dry-run reports are trustworthy.
- Add trace instrumentation fields for richer latency/retry/model/tool analysis.
- Consider a `subflow_test` command that uses the same eval sets without optimization.
