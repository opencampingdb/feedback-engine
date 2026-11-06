# Agents working in this repository

Open Camping DB is neutral. Nothing specific to any app, company or person that uses it goes in this repository: not in code, tests, examples, docs, configuration, commit messages, issues or pull requests. Examples use `example-app` and `com.example.app`.

When an app needs something Open Camping DB doesn't have, build it here as a generic capability with an SDK or kit and documentation that any developer can use, and keep the app's own configuration, deployment, records and wording in the app's own repositories.

The Neutral workflow fails when a file or commit message matches the organisation's list of terms.

## SDK versions

`@opencampingdb/feedback` (`packages/sdk`) takes a version on every change that reaches apps:

- **Patch** (0.14.1, 0.14.2): a fix or a small change to how an existing call behaves, with no new call, option or type.
- **Minor** (0.15.0): a new call, option, field or type. The patch goes back to 0.
- Before 1.0.0, a breaking change also moves the minor, and its PR says what apps must change.

Bump `packages/sdk/package.json` and the `@opencampingdb/feedback` pins in the other packages' `package.json` in the same PR, run `npm install` so `package-lock.json` follows, and name the version in the PR title. Apps vendor the SDK from the merge commit.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on opencampingdb/feedback-engine, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root, made when first needed. See `docs/agents/domain.md`.
