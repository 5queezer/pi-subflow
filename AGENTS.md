# pi-subflow Agent Notes

- Keep `README.md`, `doc/wiki/`, and `doc/adr/` in sync.
- Treat `doc/wiki/` as the source of truth for GitHub Wiki pages; publish with `npm run wiki:sync` or `npm run wiki:sync:push` instead of editing the GitHub Wiki directly.
- Keep the `subflow` tool's LLM-facing `promptSnippet` and `promptGuidelines` in `src/extension.ts` in sync with behavior, schema, validation, public API, and documentation changes so Pi knows how to use the loaded extension correctly.
- If you change architecture, project scope, public APIs, install/test commands, or design rationale, update both the README and the relevant ADR in the same change.
- Before claiming completion, run `npm run build && npm test` from this directory and report the result.
- Prefer tests-first changes for behavior. The main verification command is `npm run build && npm test`.
