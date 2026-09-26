# Local development handoff rule

- After changing source code, tests, configuration, or documentation in this repository,
  review and update `DEVELOPER_HANDOFF_JA.md` when the described behavior or known limitations changed.
- Before handing work back to the user, run `./scripts/build-developer-handoff` so
  the generated `<repo>-developer-handoff.zip` always contains the latest working tree.
- Keep local credentials, runtime state, `.codex/`, and the unrelated `mcp/confluence/`
  integration out of the developer handoff archive.
