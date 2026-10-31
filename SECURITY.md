# Security

## Reporting a problem

Email abuse@camporacle.com.au with a description of the problem and how to reproduce it. Please do not open a public issue for a security problem. We aim to reply within five working days.

Use the same address to report abuse of the feedback intake, such as a flood of fake reports or a leaked app key.

## What this repository handles

- **App keys** identify an app to the intake. They ship inside apps, so treat them as public identifiers that can be revoked, not as secrets. Each key has its own daily limit, with owner submissions counted apart from other feedback, and may be limited to feedback or to owner submissions with `kinds` (see [docs/self-hosting.md](docs/self-hosting.md)). To revoke one, remove it from the `APP_KEYS` secret and redeploy.
- **Device ids** are random per-install UUIDs. The intake stores only the first 16 hex characters of SHA-256 over a secret salt and the id. Raw device ids are never stored, and hashes are never written to the public `data` repository or a PR body.
- **Client networks.** The intake reads the client address from `CF-Connecting-IP`, cuts it to its IPv4 /24 or IPv6 /48 and stores only the same kind of salted hash, never the address. It limits submissions per network a day, and the apply rules count distinct networks, so new device ids from one client do not count as more people.
- **Free text** (report notes and review text) has email addresses, phone numbers and links replaced with `[removed]` by the intake. The apply step refuses reviews that still contain contact details, links, social media handles, personal names or offensive language, and withholds such notes from PR bodies.
- **Secrets** (`APP_KEYS`, `DEVICE_SALT`, GitHub App keys) live in Cloudflare Worker secrets and GitHub Actions secrets. None are in this repository; `wrangler.toml` holds placeholders only.

## Owners

- **Tokens.** A claim or listing returns a 32 byte random token once. The intake stores only its SHA-256, in the claim and in `owners/<place id>.json` once approved, and replaces an update's token with its hash before storage. Nothing logs the token.
- **Contact details.** Owner names and emails stay in the private inbox (`owner-claims/`, `owners/` and the stored submissions). They are never written to `data` or a PR.
- **Approval.** A claim reaches `data` only after a person ticks its box in the `feedback/review` PR and merges it. Boxes count only in review PRs the bot opened in the `data` repository itself, never in a PR from a fork, and only in the PR body and in comments written by the bot, at the start of a line, so text from an owner cannot add or tick one.
- **Proof pages.** The apply run fetches an owner's proof page with https only, on public host names, checking every resolved address before connecting (no loopback, private, link-local or shared ranges), following at most three redirects that are each checked again, with a 10 second timeout and a 1 MB cap. Each run spends at most 3 minutes on proof pages, 4 at a time and oldest first, and claims it did not reach wait for the next run.

## GitHub App permissions

- `opencampingdb-intake` is installed on the `inbox` repository only, with `contents: write`. Its private key lives only in the Worker's secrets. Each installation token it requests is limited to `inbox` and `contents: write`.
- `opencampingdb-bot` is used by the apply workflow. It has `contents: write` on `inbox`, and `contents: write` plus `pull_requests: write` on `data`. Its private key lives only in the inbox repository's Actions secrets, never in the Worker. Each token the workflow requests is limited to one repository.
- A leaked intake key can add files to `inbox/pending/` but cannot touch `data`. A leaked bot key cannot be used from the Worker, and its PRs to `data` still pass through CI and, for anything outside the automatic rules, a person.

## Workflows

Every third-party action is pinned to a full commit SHA. Workflows default to `contents: read`, and no untrusted value is expanded inside a `run:` script; values reach scripts through environment variables.
