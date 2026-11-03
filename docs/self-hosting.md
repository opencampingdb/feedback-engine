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

The intake counts submissions per device, per client network and per app in Workers KV. A network is the client address from `CF-Connecting-IP`, cut to its IPv4 /24 or IPv6 /48 and kept only as a salted hash. Each network may send 100 feedback submissions and, counted separately, 10 owner submissions a day. Each network may also register 500 App Attest keys a day.

```sh
npx wrangler kv namespace create RATE_LIMIT
```

Note the `id` it prints. It replaces `REPLACE_ME_KV_NAMESPACE_ID` in your deploy configuration (step 6). Never commit your ids to this repository.

On the free plan KV allows 1,000 writes a day. Each accepted submission makes three (one device counter, one network counter, one app counter), plus one per contributor and one per attested key, so the free plan carries about 200 to 330 submissions a day. Above that, use the Workers paid plan.

If an app key uses App Attest, create a second namespace for registered keys and challenges, and note its `id` for the `ATTEST` binding:

```sh
npx wrangler kv namespace create ATTEST
```

To serve new places at once (`GET /v1/places/recent`, see [integration.md](integration.md) section 5), create a D1 database for the recent list, note its `database_id` for the `RECENT_LIST` binding, and apply its schema once the deploy copy of `wrangler.toml` holds that id (step 6):

```sh
npx wrangler d1 create ocdb-recent-list
npx wrangler d1 migrations apply RECENT_LIST --remote -c wrangler.deploy.toml
```

The schema is kept as numbered migrations in `packages/intake/migrations`. After updating to a release that adds one, run the same `migrations apply` command before deploying. Without `RECENT_LIST` the recent-list routes answer `404` and feedback still reaches the inbox.

Each new place, check, removal report or withdraw is one row written. Each refresh of the list that misses the edge cache is one query. The box a request names is grown out to whole degrees before the query and the cache, so map views in the same degrees share one cached answer for 30 seconds. This fits the D1 free plan.

The apply run keeps the store in step with two calls, each with `authorization: Bearer <PLACES_TOKEN>`. `POST /v1/places/recent/remove` with `{"ids": [...]}` (1 to 500 place ids) takes places it has written into the data off the list, answering `{"removed": <count>}`. `POST /v1/places/recent/block` with `{"contributors": [...]}` (up to 5,000 hashed `ctr_` ids, `[]` for none) replaces the block list the intake keeps, answering `{"blocked": <count>}`. A blocked contributor's places leave the list and later ones aren't listed; one taken off the block list is listed again. Both answer `401` for a wrong token and `404` without `RECENT_LIST` or `PLACES_TOKEN`.

### Moving the recent list from KV to D1

Intakes set up before the recent list moved to D1 kept it in a `RECENT_PLACES` KV namespace. A copy command moves its new places, their evidence and the block list into `RECENT_LIST`. It runs from your own machine through Wrangler's platform proxy, signed in with `npx wrangler login`, and needs no endpoint on the intake. From `packages/intake`:

```sh
npm run copy-to-d1 -- --kv <RECENT_PLACES namespace id> --d1 <RECENT_LIST database_id>
```

It lists the `np:` keys once, reads each place's value and the block list, and writes rows that are not in D1 yet, so it is safe to run more than once. The block list is added to the one D1 holds, never replacing it, so a list the apply run sent after the deploy is kept. Evidence whose place has already left KV is not copied. Add `--local` to rehearse against the local state `wrangler dev` keeps in `.wrangler/state`.

Go live in this order:

1. Create the D1 database and apply the migration (above).
2. Run the copy.
3. Deploy the intake with the `RECENT_LIST` binding (step 6).
4. Run the copy again, to pick up anything written to KV while the deploy went out.
5. A week later, once the recent list has served from D1 without trouble, delete the `np:` keys and the `blocked:contributors` key from `RECENT_PLACES`, then remove the namespace. Until then the old keys are there to fall back to.

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
- `PLACES_TOKEN`, needed only with `RECENT_LIST`, is a long random string, for example from `openssl rand -hex 32`. The apply run sends it to take places it has written into the data off the recent list, and to send the block list. Set it with `npx wrangler secret put PLACES_TOKEN` and keep the same value for the apply workflow.
- `GH_APP_PRIVATE_KEY` accepts the PEM GitHub gives you (PKCS#1) or PKCS#8.
- `GOOGLE_SERVICE_ACCOUNT`, needed only for `android`, is the JSON key file of a Google Cloud service account in the project linked to the app in Play Console, allowed to decode integrity tokens. Set it with `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT < key.json`.

`INBOX_REPO`, `INBOX_BRANCH` and `ALLOWED_ORIGINS` are plain variables in `wrangler.toml`. Set `INBOX_REPO` to `<your organisation>/inbox`. `ALLOWED_ORIGINS` lists the web origins allowed to call the intake from a browser, comma separated, or `*`. Native apps do not send an origin and are not affected.

## 6. Deploy

`wrangler.toml` holds placeholders for the namespace and database ids. Keep your ids in a copy that git does not track, so updating your checkout never resets them, and deploy with that copy:

```sh
cd packages/intake
sed -e "s/REPLACE_ME_KV_NAMESPACE_ID/<RATE_LIMIT id>/" \
    -e "s/REPLACE_ME_ATTEST_KV_NAMESPACE_ID/<ATTEST id>/" \
    -e "s/REPLACE_ME_RECENT_LIST_D1_DATABASE_ID/<RECENT_LIST database_id>/" wrangler.toml > wrangler.deploy.toml
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

Copy [`packages/apply/examples/inbox-apply-feedback.yml`](../packages/apply/examples/inbox-apply-feedback.yml) to `.github/workflows/apply-feedback.yml` in `inbox`. Replace both `REPLACE_WITH_ENGINE_SHA` values with the same full commit SHA of this repository. Replace `REPLACE_WITH_INTAKE_URL` with the intake's base URL, for example `https://intake.example.org`, or remove the `intake-url` and `places-token` lines when the intake has no `RECENT_LIST`. Then add the Actions secrets in `inbox`:

- `OCDB_BOT_CLIENT_ID`: the bot App's Client ID.
- `OCDB_BOT_PRIVATE_KEY`: the contents of the bot App's `.pem` file.
- `PLACES_TOKEN`, only with `intake-url`: the same value as the Worker's `PLACES_TOKEN` (step 5). Make it once with `openssl rand -hex 32`, set it on the Worker with `npx wrangler secret put PLACES_TOKEN`, then add it to `inbox` with `gh secret set PLACES_TOKEN --repo <owner>/inbox` (or Settings, Secrets and variables, Actions). To change it, set the new value in both places.

Run the workflow once by hand from the Actions tab. With items in `pending/` it commits the moved files to `inbox` and keeps up to two PRs open on `data`:

- `feedback/auto`: changes from the automatic rules, new places included. It merges itself once CI passes.
- `feedback/review`: held new places, location changes, website and phone changes and other reports, labelled `needs-review`. Edit the files on the branch if needed, then merge it, or close it to refuse them.

New places are written with their `standing` from the SDK's `newPlaceStanding`. A `shown` or `confirmed` place goes on `feedback/auto` when its report was attested, has a contributor and its note passes the SDK's text checks, as the intake requires to list it. Checks, `remove` reports and the adder's `withdraw` on a place added in the last 90 days work its standing out again: reports from two devices (three once confirmed) set it to `hidden`, and a place withdrawn within 24 hours is not written, or its record is deleted. A place within 150 m of another in the same group, a place hidden before it was published, and a place the intake would not list are drafted on `feedback/review` with standing `held` or `hidden`: set `standing` to `shown` to publish it, or close the PR. Contact details sent with a new place stay in the inbox for a person and never reach the record unchecked.

The review PR body lists every held new place under "Held new places", one line each: `- held-case` and a JSON object with `case` (`duplicate`, `hidden`, `contacts` or `first_place`), `place`, `standing`, `location`, `kind`, the case's details (`duplicate_of` and `distance_m`, `reports` and `reasons` or `blocked`, the facts named in `contacts`, which may include `address`, the `contributor`) and the `feedback` ids to read in the inbox. A triage agent can read these lines instead of the prose.

**A person's decision on a new place.** Reports set aside a place's `standing` again on later runs unless a person's decision is on its record. To restore a hidden place, set `"standing": "shown"` and `"moderator": {"action": "restore", "at": "<now>"}` on the record, on the review PR or in a PR to `main`. Reports up to `at` no longer count, and later ones count as usual. To hide one, set `"standing": "hidden"` and `"moderator": {"action": "hide", "at": "<now>"}`: it stays hidden whatever travellers send. `at` is a UTC time such as `2026-11-03T09:00:00Z` or a day such as `2026-11-03`. Only the latest decision is kept, so a new one replaces the old. The note on a place hidden before it was published gives the line to paste.

With `intake-url` set, each run passes `--main <checkout of data main> --intake <intake URL>` and the `PLACES_TOKEN` secret to `ocdb-apply`. It takes new places off the intake's recent list once the PR that writes them is merged, and withdrawn ones at once, then sends the intake the contributors in `moderation/blocked_contributors.json` on `main`, so a blocked contributor's new places leave the recent list.

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

Report abuse of a public intake, or a leaked app key, with **Report a vulnerability** on this repository's Security tab.
