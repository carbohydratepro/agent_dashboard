# Local development handoff rule

This rule exists only for machines that cannot push to the git remote. There, changes
reach the maintainer as a zip, so the archive and its Japanese summary are the handoff.

- On a machine that can push to the remote, ignore this rule: commit and push instead.
  Do not update `DEVELOPER_HANDOFF_JA.md` or build the archive just because code changed.
- On a machine that cannot push:
  - After changing source code, tests, configuration, or documentation in this repository,
    review and update `DEVELOPER_HANDOFF_JA.md` when the described behavior or known
    limitations changed.
  - Before handing work back to the user, run `./scripts/build-developer-handoff` so the
    generated `<repo>-developer-handoff.zip` always contains the latest working tree.
  - Keep local credentials, runtime state, `.codex/`, and the unrelated `mcp/confluence/`
    integration out of the developer handoff archive.
