# pi-subflow Agent Notes

- Keep `README.md`, `doc/wiki/`, and `doc/adr/` in sync; use ADR tools when editing ADRs.
- Treat `doc/wiki/` as the source of truth for GitHub Wiki pages; publish with `npm run wiki:sync` or `npm run wiki:sync:push` instead of editing the GitHub Wiki directly.
- Keep all LLM-facing instructions registered in `registerPiSubflowExtension` in `src/extension.ts` in sync with behavior, schema, validation, public API, and documentation changes so Pi knows how to use the loaded extension correctly. This includes each tool's `promptSnippet`, `promptGuidelines`, descriptions, schemas, and workflow-command guidance.
- If you change architecture, project scope, public APIs, install/test commands, or design rationale, update both the README and the relevant ADR in the same change.
- Before claiming completion, run `npm run build && npm test` from this directory and report the result.
- Use red-green TDD for project changes: write or update a failing test first, make it pass with the smallest change, then refactor while keeping tests green.
- Prefer tests-first changes for behavior. The main verification command is `npm run build && npm test`.
