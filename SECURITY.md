# Security

## Reporting a problem

Email abuse@camporacle.com.au with a description of the problem and how to reproduce it. Please do not open a public issue for a security problem. We aim to reply within five working days.

Use the same address to report abuse of the feedback intake, such as a flood of fake reports or a leaked app key.

## What this repository handles

- **App keys** identify an app to the intake. They ship inside apps, so treat them as public identifiers that can be revoked, not as secrets. Each key has its own daily limit. To revoke one, remove it from the `APP_KEYS` secret and redeploy.
- **Device ids** are random per-install UUIDs. The intake stores only the first 16 hex characters of SHA-256 over a secret salt and the id. Raw device ids are never stored, and hashes are never written to the public `data` repository or a PR body.
- **Free text** (report notes and review text) has email addresses, phone numbers and links replaced with `[removed]` by the intake. The apply step refuses reviews that still contain contact details, links, social media handles, personal names or offensive language, and withholds such notes from PR bodies.
- **Secrets** (`APP_KEYS`, `DEVICE_SALT`, GitHub App keys) live in Cloudflare Worker secrets and GitHub Actions secrets. None are in this repository; `wrangler.toml` holds placeholders only.

## GitHub App permissions

- `opencampingdb-intake` is installed on the `inbox` repository only, with `contents: write`. Its private key lives only in the Worker's secrets. Each installation token it requests is limited to `inbox` and `contents: write`.
- `opencampingdb-bot` is used by the apply workflow. It has `contents: write` on `inbox`, and `contents: write` plus `pull_requests: write` on `data`. Its private key lives only in the inbox repository's Actions secrets, never in the Worker. Each token the workflow requests is limited to one repository.
- A leaked intake key can add files to `inbox/pending/` but cannot touch `data`. A leaked bot key cannot be used from the Worker, and its PRs to `data` still pass through CI and, for anything outside the automatic rules, a person.

## Workflows

Every third-party action is pinned to a full commit SHA. Workflows default to `contents: read`, and no untrusted value is expanded inside a `run:` script; values reach scripts through environment variables.
