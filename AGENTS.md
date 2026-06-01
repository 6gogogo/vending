## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for `6gogogo/vending`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default Matt Pocock skills triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo: read root `CONTEXT.md` and `docs/adr/` when present. See `docs/agents/domain.md`.

### Language defaults

Use Chinese by default for code comments, README files, and repository documentation unless a task explicitly requires another language. See `docs/agents/domain.md`.

### Release and public deployment workflow

When preparing a version for the public server, follow the project workflow in `docs/发布与公网部署验证流程.md`.

Required order:

1. Validate the latest code locally first.
2. Commit and push only after local validation passes.
3. On the public server, update only by pulling from Git.
4. Build and run on the public server.
5. Validate again from public URLs before considering the deployment complete.

Do not edit production code directly on the server, and do not treat local-only testing as public deployment verification.
