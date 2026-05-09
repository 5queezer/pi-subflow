# Development

```bash
npm install
npm run build
npm test
```

Before claiming a change is complete, run:

```bash
npm run build && npm test
```

Husky installs from the `prepare` script and runs the same build-plus-test check in `.husky/pre-commit` before commits.

The test suite covers orchestration behavior, DAG validation, policy checks, Pi extension rendering, JSONL run history recording, SDK runner behavior, and LLM-facing prompt guidance.
