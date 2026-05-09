# pi-subflow Agent Notes

- Keep `README.md` and `docs/adr/` in sync.
- If you change architecture, project scope, public APIs, install/test commands, or design rationale, update both the README and the relevant ADR in the same change.
- Before claiming completion, run `npm run build && npm test` from this directory and report the result.
- Prefer tests-first changes for behavior. The main verification command is `npm run build && npm test`.
