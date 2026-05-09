# Contributing to pi-subflow

Thanks for helping improve `pi-subflow`. This project is a Pi extension and TypeScript orchestration core for bounded subagent workflows, so contributions should keep the public tool behavior, docs, tests, and Pi-facing guidance aligned.

## Development setup

Prerequisites:

- Node.js compatible with the versions used by this repository
- npm
- Pi, if you want to manually load and test the extension in an agent session

Install dependencies:

```bash
npm install
```

Build and run the full test suite:

```bash
npm run build && npm test
```

The same build-plus-test check is wired into `.husky/pre-commit`.

## Project structure

- `src/` - TypeScript source for the orchestration core and Pi extension
- `src/flows/` - single, chain, parallel, and DAG workflow implementations
- `tests/` - Node test runner suites
- `examples/workflows/` - reusable DAG YAML workflow templates
- `schemas/` - JSON Schema for workflow authoring
- `docs/adr/` - architecture decision records
- `README.md` - user-facing overview, usage, and development docs

## Contribution workflow

1. Create a focused branch for your change.
2. Prefer tests-first changes for behavior fixes or features.
3. Keep changes small and explain the motivation in the PR description.
4. Run `npm run build && npm test` before asking for review.
5. Include any manual Pi testing notes when the change affects extension behavior or rendering.

## Testing expectations

Add or update tests when you change:

- workflow execution behavior
- DAG validation or planning
- policy checks and tool allowlists
- run history recording
- SDK runner behavior
- Pi extension rendering or LLM-facing prompt guidance
- public exports or schemas

Use the existing test suites as examples:

```bash
npm test
```

For TypeScript compilation only:

```bash
npm run build
```

## Documentation expectations

Keep documentation synchronized with behavior. In particular, update all relevant files when you change architecture, project scope, public APIs, install/test commands, validation behavior, schema fields, or design rationale:

- `README.md`
- relevant ADRs in `docs/adr/`
- `src/extension.ts` prompt snippet and prompt guidelines for the `subflow` tool
- `schemas/subflow-dag.schema.json`, if workflow input shape changes
- examples in `examples/workflows/`, if recommended usage changes

## Coding guidelines

- Keep workflow functions independent from Pi UI concerns.
- Preserve the `SubagentRunner` boundary between orchestration and real Pi execution.
- Validate DAGs before starting any subagent work.
- Keep verifier fan-in behavior explicit and tested.
- Use narrow tool allowlists for subagents in examples and docs.
- Do not retry mutating or external-side-effect tasks.
- Prefer clear errors over silent fallback behavior.

## Local Pi extension testing

After building, load the extension locally with Pi:

```bash
npm run build
pi -e ./dist/extension.js
```

For repeated local development, you can symlink the built extension:

```bash
ln -sfn "$PWD/dist" ~/.pi/agent/extensions/subflow
```

Then run `/reload` inside Pi after rebuilding.

## Pull request checklist

Before opening or marking a PR ready for review, confirm:

- [ ] Tests were added or updated when behavior changed.
- [ ] `npm run build && npm test` passes.
- [ ] README, ADRs, schemas, examples, and Pi prompt guidance are synchronized where relevant.
- [ ] Public API changes are documented.
- [ ] Any manual Pi testing is described in the PR.

## License

By contributing, you agree that your contributions will be licensed under the repository's ISC license.
