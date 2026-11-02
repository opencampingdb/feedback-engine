# Self-hosting the intake and the apply workflow

This sets up the whole feedback path: the intake Worker on Cloudflare, the private `inbox` repository and the hourly workflow that opens PRs to `data`. Everything fits the Cloudflare Workers free plan and GitHub Actions.

You need Node 22.12 or later, a GitHub organisation that holds `inbox` and `data` (the workflow expects both in the same organisation), and this repository cloned.

## 1. Create a Cloudflare account and sign in

Sign up at cloudflare.com (the free plan is enough), then sign in from this repository:

```sh
npm install
npm approve-scripts workerd esbuild   # once, if npm asks to approve install scripts
cd packages/intake
npx wrangler login
```

## 2. Create the KV namespace

The intake counts submissions per device, per client network and per app in Workers KV. A network is the client address from `CF-Connecting-IP`, cut to its IPv4 /24 or IPv6 /48 and kept only as a salted hash. Each network may send 100 feedback submissions and, counted separately, 10 owner submissions a day.

```sh
npx wrangler kv namespace create RATE_LIMIT
```

Note the `id` it prints. It replaces `REPLACE_ME_KV_NAMESPACE_ID` in your deploy configuration (step 6). Never commit your ids to this repository.

On the free plan KV allows 1,000 writes a day. Each accepted submission makes three (one device counter, one network counter, one app counter), plus one per contributor and one per attested key, so the free plan carries about 200 to 330 submissions a day. Above that, use the Workers paid plan.

If an app key uses App Attest, create a second namespace for registered keys and challenges, and note its `id` for the `ATTEST` binding:

```sh
npx wrangler kv namespace create ATTEST
```

## 3. Create the private inbox repository

Create `inbox` in your organisation, private, with a `README.md` on `main` so the branch exists. The intake writes to `pending/<yyyy-mm-dd>/`, and the workflow moves files to `applied/` and `refused/`.

## 4. Create the opencampingdb-intake GitHub App

In the organisation settings, under Developer settings, create a GitHub App:

- Name: `opencampingdb-intake` (or your own name for the same role).
- Homepage URL: your intake URL or this repository.
- Webhook: off.
- Repository permissions: **Contents: Read and write**. Nothing else.
- Where can it be installed: only this account.

Generate a private key and download the `.pem` file. This key goes only into the Worker (step 5), never into GitHub Actions. Note the App ID. Install the App on the organisation, choosing **Only select repositories** and only `inbox`. The installation id is the number at the end of the installation page URL (`.../settings/installations/<id>`).

## 5. Set the Worker secrets

From `packages/intake`:

```sh
npx wrangler secret put APP_KEYS
npx wrangler secret put DEVICE_SALT
npx wrangler secret put GH_APP_ID
npx wrangler secret put GH_APP_PRIVATE_KEY < path/to/intake-app.private-key.pem
npx wrangler secret put GH_INSTALLATION_ID
```

- `APP_KEYS` is a JSON map from app key to app name and daily limit. Keys must be at least 16 characters, and app names lower case letters, digits and dashes:

  ```json
  {"9f3c1d0e7b2a4c5d8e6f": {"app": "example-app", "daily_limit": 5000}}
  ```

  Two optional fields limit what a key may do. `owner_daily_limit` is the key's daily limit for owner claims, listings and updates, counted apart from its other feedback so that feedback cannot use up the owners' share. It defaults to `daily_limit`. `kinds` lists what the key may send: `["feedback"]` for reports, reviews and checks, `["owner"]` for owner submissions, or both. A key without `kinds` may send everything, and any other submission gets `403`. The owner page's key ships in a public web page, so give it `"kinds": ["owner"]`:

  ```json
  {"0a7e5b2c9d4f1e3a6b8c": {"app": "owner-page", "daily_limit": 1000, "owner_daily_limit": 200, "kinds": ["owner"]}}
  ```

  For reviews, `contributor_daily_limit` sets how many submissions one contributor may send a day (20 when left out), and `requires_visited_nearby: true` refuses reviews without `visited_nearby`. To take feedback only from genuine copies of an app, add `"requires_attestation": true` with `ios` (`app_id`, your team id, a dot and the bundle id; `environment` `production` or `development`), `android` (`package`, and optionally `certificate_sha256`, the signing certificate digests Play reports), or both:

  ```json
  {"9f3c1d0e7b2a4c5d8e6f": {"app": "example-app", "daily_limit": 5000, "requires_attestation": true,
    "ios": {"app_id": "ABCDE12345.com.example.app"}, "android": {"package": "com.example.app"}}}
  ```

  Make keys with `openssl rand -hex 16`. To revoke a key, remove it and set the secret again.
- `DEVICE_SALT` is a long random string, for example from `openssl rand -hex 32`. Changing it makes every device look new, which resets the two-device rule for pending items, so set it once.
- `GH_APP_PRIVATE_KEY` accepts the PEM GitHub gives you (PKCS#1) or PKCS#8.
- `GOOGLE_SERVICE_ACCOUNT`, needed only for `android`, is the JSON key file of a Google Cloud service account in the project linked to the app in Play Console, allowed to decode integrity tokens. Set it with `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < key.json`.

`INBOX_REPO`, `INBOX_BRANCH` and `ALLOWED_ORIGINS` are plain variables in `wrangler.toml`. Set `INBOX_REPO` to `<your organisation>/inbox`. `ALLOWED_ORIGINS` lists the web origins allowed to call the intake from a browser, comma separated, or `*`. Native apps do not send an origin and are not affected.

## 6. Deploy

`wrangler.toml` holds placeholders for the namespace ids. Keep your ids in a copy that git does not track, so updating your checkout never resets them, and deploy with that copy:

```sh
cd packages/intake
sed -e "s/REPLACE_ME_KV_NAMESPACE_ID/<RATE_LIMIT id>/" \
    -e "s/REPLACE_ME_ATTEST_KV_NAMESPACE_ID/<ATTEST id>/" wrangler.toml > wrangler.deploy.toml
npx wrangler deploy -c wrangler.deploy.toml
```

Check that the binding list Wrangler prints shows your ids, not `REPLACE_ME`.

To update a running intake to a new release of this repository, move your checkout to it, reinstall and deploy the same way. Secrets set with `wrangler secret put` stay in Cloudflare and need no change:

```sh
git fetch origin && git checkout --detach origin/main && npm ci
cd packages/intake && npx wrangler deploy -c wrangler.deploy.toml
```

The SDK validates each submission, so a release that adds facts or report kinds needs this redeploy before apps send them. Until then the intake refuses them with `400`.

Wrangler prints the Worker URL. Send a test check with a key from `APP_KEYS` and a place id from `data`:

```sh
curl -i https://<your worker>/v1/feedback \
  -H "content-type: application/json" -H "x-app-key: <key>" \
  -d '{"type":"check","place":"ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA","device":"3b241101-e2bb-4255-8caf-4136c566a962","app_version":"0.0.1","consent":true,"check":{"visited":"2026-10-30","still_there":true}}'
```

A `202` with an `fb_` id means a file is now in `inbox/pending/`. To use your own domain, add a custom domain to the Worker in the Cloudflare dashboard.

## 7. Create the opencampingdb-bot GitHub App

The apply workflow uses a second App. Its tokens open PRs that trigger the data repository's CI, which `GITHUB_TOKEN` cannot do.

- Name: `opencampingdb-bot` (or your own name for the same role).
- Webhook: off.
- Repository permissions: **Contents: Read and write** and **Pull requests: Read and write**. Nothing else.

Install it on only `inbox` and `data`. The workflow asks for a token limited to `contents: write` on `inbox`, and a second token for `data` with `contents: write` and `pull_requests: write`. Generate a private key and note the App's **Client ID**. This key goes only into the inbox repository's Actions secrets (step 9), never into the Worker.

## 8. Prepare the data repository

- In Settings, General, turn on **Allow auto-merge**.
- Create the labels `needs-review` and `owner-claim`.
- Protect `main` with the required check the data repository's CI reports, so auto-merge waits for it.

## 9. Add the workflow to the inbox

Copy [`packages/apply/examples/inbox-apply-feedback.yml`](../packages/apply/examples/inbox-apply-feedback.yml) to `.github/workflows/apply-feedback.yml` in `inbox`. Replace both `REPLACE_WITH_ENGINE_SHA` values with the same full commit SHA of this repository. Then add two Actions secrets in `inbox`:

- `OCDB_BOT_CLIENT_ID`: the bot App's Client ID.
- `OCDB_BOT_PRIVATE_KEY`: the contents of the bot App's `.pem` file.

Run the workflow once by hand from the Actions tab. With items in `pending/` it commits the moved files to `inbox` and keeps up to two PRs open on `data`:

- `feedback/auto`: changes from the automatic rules. It merges itself once CI passes.
- `feedback/review`: new places, location changes, website and phone changes and other reports, labelled `needs-review`. Edit the files on the branch if needed, then merge it, or close it to refuse them.

When a PR from either branch is already open, later runs add a commit and a comment to it. Once a PR is merged or closed, the next run starts the branch again from `main`. With nothing to do the workflow ends without changes.

## 10. Pass changes to OpenStreetMap (optional)

Copy [`packages/apply/examples/inbox-osm-notes.yml`](../packages/apply/examples/inbox-osm-notes.yml) to `.github/workflows/osm-notes.yml` in `inbox`, with the same engine SHA. It uses the same bot App secrets. Without the `OSM_NOTES_TOKEN` secret it is a dry run that lists in the job summary the notes it would post. [osm.md](osm.md) covers the OSM token and the limits.

## Running the apply script locally

With both repositories checked out next to each other:

```sh
npm run build
node packages/apply/dist/cli.js --inbox ../inbox --data ../data \
  --auto-pr-body auto.md --review-pr-body review.md --summary summary.json
```

With no `--review-data`, automatic and review changes land in the same checkout. It changes files in both checkouts and commits nothing, so you can read the diff before deciding what to do with it.

## Abuse

Report abuse of a public intake, or a leaked app key, to abuse@example.org.
