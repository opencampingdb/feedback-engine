# Self-hosting the intake and the apply workflow

This guide sets up the whole feedback path: the intake Worker and its D1 database on Cloudflare, a private `inbox` repository, two GitHub Apps, and the workflow in `inbox` that applies feedback to `data` as pull requests. The intake starts that workflow a few minutes after new feedback arrives, and an hourly schedule runs it as a back-up. A small intake fits the Cloudflare Workers free plan. [limits.md](limits.md) lists the limits a busy one runs into.

You need Node 22.12 or later, a Cloudflare account, a GitHub organisation that holds both `inbox` and `data` (the workflow expects them in the same organisation), and this repository cloned. Every command below runs from `packages/intake` unless it says otherwise.

## 1. Install and sign in

From the repository root:

```sh
npm ci
npm approve-scripts workerd esbuild   # only if npm asks to approve install scripts
cd packages/intake
npx wrangler login
```

## 2. Create the Cloudflare resources

```sh
npx wrangler kv namespace create RATE_LIMIT
npx wrangler kv namespace create ATTEST
npx wrangler d1 create ocdb-recent-list
```

Note each `id` and the `database_id` they print. Never commit them to this repository.

- `RATE_LIMIT` (KV) is a required binding. With `RECENT_LIST` bound it is never read or written, because the daily counters live in D1. Without `RECENT_LIST` the counters live here.
- `ATTEST` (KV) holds registered App Attest keys and their challenges. It is needed only when an app key has `ios`. Without one, skip it and delete the `ATTEST` block from your deploy copy in step 3.
- `RECENT_LIST` (D1) holds the recent list, the place index, the daily counters, the idempotency keys, the inbox queue and each item's progress. Any intake that serves a public app needs it.
- `PER_IP` (a rate limiting binding, optional) limits the public reads per client network (the IPv4 /24 or IPv6 /48 the daily budgets count, so one network cannot spread its reads over many addresses): `GET /v1/places/recent`, `GET /v1/feedback/progress` and `GET /v1/photos/progress`. These need no app key, and the recent list is read from the same database the daily counters and the queue use. Past the limit a read answers `429` with `retry-after: 60`, before the edge cache or the database is read. Uncomment the `[[ratelimits]]` block in your deploy copy to turn it on. Without it, the reads are not limited per network, so put a Cloudflare rate limiting rule in front of them instead.

Without `RECENT_LIST`, the recent-list routes and `POST /v1/feedback/batch` answer `404`, idempotency keys are ignored, every item is a commit of its own and the counters fall back to KV. KV takes one write a second to a key, and every submission writes the app's counter, so a KV-only intake takes about one submission a second across every user of every app. On the free plan KV also allows 1,000 writes a day, and each accepted submission makes three or more (device, network and app, plus contributor and attested key), so about 200 to 330 submissions a day. Keep KV-only intakes for tests.

## 3. Make your deploy copy

`wrangler.toml` is tracked and holds placeholders. Make an untracked copy (`wrangler.deploy.toml` is in `.gitignore`) once, with your ids:

```sh
sed -e "s/REPLACE_ME_KV_NAMESPACE_ID/<RATE_LIMIT id>/" \
    -e "s/REPLACE_ME_ATTEST_KV_NAMESPACE_ID/<ATTEST id>/" \
    -e "s/REPLACE_ME_RECENT_LIST_D1_DATABASE_ID/<RECENT_LIST database_id>/" wrangler.toml > wrangler.deploy.toml
```

Then edit `wrangler.deploy.toml` by hand:

- `INBOX_REPO`: `<your organisation>/inbox`. `INBOX_BRANCH` defaults to `main`.
- `ALLOWED_ORIGINS`: the web origins allowed to call the intake from a browser, comma separated, or `*`. Native apps send no origin and are not affected.
- Optional, under `[vars]`: `APPLY_WORKFLOW` (step 10), and `AI_REVIEWER`, `DATA_REPO`, `REVIEW_BOT_LOGINS` and `REVIEW_MODEL` ([The AI reviewer](#the-ai-reviewer)). An app's photo service adds its own bindings and variables ([photos.md](photos.md)).

From now on, edit this copy. Running the `sed` command again starts from `wrangler.toml` and drops every value you set by hand, such as `APPLY_WORKFLOW`, `AI_REVIEWER`, `DATA_REPO` and `REVIEW_BOT_LOGINS`, or a `GH_APP_ID` and `GH_INSTALLATION_ID` kept as plain variables.

Apply the database schema with the copy:

```sh
npx wrangler d1 migrations apply RECENT_LIST --remote -c wrangler.deploy.toml
```

The schema is the numbered files in `packages/intake/migrations`.

## 4. Create the inbox repository

Create `inbox` in your organisation, private, with a `README.md` on `main` so the branch exists. The intake writes each submission to `pending/<yyyy-mm-dd>/`, and the apply workflow moves it to `applied/` or `refused/`.

## 5. Create the intake's GitHub App

In the organisation settings, under Developer settings, create a GitHub App:

- Name: `opencampingdb-intake`, or your own name for the same role.
- Homepage URL: your intake URL or this repository.
- Webhook: off.
- Repository permissions: **Contents: Read and write**. Add **Actions: Read and write** if the intake starts the apply workflow (`APPLY_WORKFLOW`), and **Pull requests: Read and write** if it runs the AI reviewer. Nothing else.
- Where can it be installed: only this account.

Generate a private key and download the `.pem` file. This key goes only into the Worker (step 6), never into GitHub Actions. Note the App ID. Install the App on the organisation with **Only select repositories** and choose `inbox`, plus `data` if the AI reviewer will run. The installation id is the number at the end of the installation page URL (`.../settings/installations/<id>`).

Each token the intake asks for covers one repository and only the permissions that call needs. Adding a permission to an installed App asks the organisation owner to accept it on the installation page before it takes effect.

## 6. Set the Worker secrets

```sh
npx wrangler secret put APP_KEYS -c wrangler.deploy.toml
npx wrangler secret put DEVICE_SALT -c wrangler.deploy.toml
npx wrangler secret put GH_APP_ID -c wrangler.deploy.toml
npx wrangler secret put GH_APP_PRIVATE_KEY -c wrangler.deploy.toml < path/to/intake-app.private-key.pem
npx wrangler secret put GH_INSTALLATION_ID -c wrangler.deploy.toml
npx wrangler secret put PLACES_TOKEN -c wrangler.deploy.toml
npx wrangler secret put URLHAUS_KEY -c wrangler.deploy.toml
```

- `APP_KEYS` is a JSON map from app key to its settings ([App keys](#app-keys)).
- `DEVICE_SALT` is a long random string, for example from `openssl rand -hex 32`. Changing it makes every device look new, which resets the two-device rule for pending items, so set it once.
- `GH_APP_PRIVATE_KEY` accepts the PEM GitHub gives you (PKCS#1) or PKCS#8.
- `PLACES_TOKEN`, needed with `RECENT_LIST`, is a long random string (`openssl rand -hex 32`). The apply workflow and the data release send it to call the intake's operator routes. Keep the value: steps 9 and 10 need it again.
- `URLHAUS_KEY`, needed with `RECENT_LIST`, is a free abuse.ch auth key from the abuse.ch authentication portal. The intake checks every link an item would publish with URLhaus. The `[ai]` binding in `wrangler.toml` gives the intake Workers AI for the Llama Guard check, so the Cloudflare account needs Workers AI. A check that isn't set up holds every item that needs it.
- `GOOGLE_SERVICE_ACCOUNT`, needed only for an app key with `android`, is the JSON key file of a Google Cloud service account in the project linked to the app in Play Console, allowed to decode integrity tokens: `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT -c wrangler.deploy.toml < key.json`.

Setting a secret deploys it at once. To revoke an app key, set `APP_KEYS` again without it.

### App keys

A minimal entry:

```json
{"<app key>": {"app": "example-app", "daily_limit": 5000}}
```

Keys must be at least 16 characters: make them with `openssl rand -hex 16`. App names are 1 to 40 lower case letters, digits, `_` and `-`, starting with a letter or digit. An entry that breaks a rule is ignored, so its key answers `401 invalid_app_key`. Optional fields:

| Field | What it does |
|---|---|
| `owner_daily_limit` | The key's daily limit for owner claims, listings and updates, counted apart from its other feedback. Defaults to `daily_limit`. |
| `kinds` | `["feedback"]` for reports, reviews and checks, `["owner"]` for owner submissions, or both. Anything else answers `403 type_not_allowed_for_app_key`. Left out, the key may send everything. Give an owner page's key, which ships in a public web page, `["owner"]`. |
| `contributor_daily_limit` | Submissions one contributor may send a day. Defaults to 200. |
| `requires_visited_nearby` | `true` refuses reviews without `visited_nearby` (`400 visited_nearby_required`). |
| `requires_attestation` | `true` takes feedback only from genuine copies of the app. Needs `ios`, `android` or both. |
| `ios` | `app_id` (your team id, a dot and the bundle id) and optionally `environment` (`production` or `development`). |
| `android` | `package`, and optionally `certificate_sha256`, the signing certificate digests Play reports. |
| `contributor_proof_key` | Your app server's Ed25519 public key, the raw 32 bytes in base64. With it, review erasures, photo removals and photo erasures need a proof your server signed for the account, and a review that carries a valid proof is marked proved, so it may replace the contributor's earlier review without waiting for a person ([photos.md](photos.md), "Prove the account for removal and erasure"). Export it with `Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64")`. |
| `photo_pass_unattested` | Photo services only: lets a development key get photo passes without attestation ([photos.md](photos.md)). |

```json
{"<app key>": {"app": "example-app", "daily_limit": 5000, "requires_attestation": true,
  "ios": {"app_id": "ABCDE12345.com.example.app"}, "android": {"package": "com.example.app"}},
 "<owner page key>": {"app": "owner-page", "daily_limit": 1000, "owner_daily_limit": 200, "kinds": ["owner"]}}
```

## 7. Deploy and send a test

```sh
npx wrangler deploy -c wrangler.deploy.toml
```

Check that the binding list Wrangler prints shows your ids, not `REPLACE_ME`. Wrangler prints the Worker URL. Send a test check with a key from `APP_KEYS` and a place id from `data`:

```sh
curl -i https://<your worker>/v1/feedback \
  -H "content-type: application/json" -H "x-app-key: <key>" \
  -d '{"type":"check","place":"ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA","device":"3b241101-e2bb-4255-8caf-4136c566a962","app_version":"0.0.1","consent":true,"check":{"visited":"2026-10-30","still_there":true}}'
```

A `202` with an `fb_` id means the item is queued, and the intake writes it to `inbox/pending/` within about a minute (at once, without `RECENT_LIST`). To use your own domain, add a custom domain to the Worker in the Cloudflare dashboard. The recent list's edge cache works only on a custom domain.

## 8. Create the bot GitHub App

The apply workflow uses a second App. Its tokens open PRs that trigger the data repository's CI, which `GITHUB_TOKEN` cannot do.

- Name: `opencampingdb-bot`, or your own name for the same role.
- Webhook: off.
- Repository permissions: **Contents: Read and write** and **Pull requests: Read and write**, plus **Actions: Read and write** if the workflow starts the data release (`release-workflow`, step 10). Nothing else.

Install it on `inbox` and `data` only. The workflow asks for a token with `contents: write` on `inbox`, a second with `contents: write` and `pull_requests: write` on `data`, and with `release-workflow` a third with only `actions: write` on `data`. Generate a private key and note the App's **Client ID**. This key goes only into the inbox repository's Actions secrets (step 10), never into the Worker.

## 9. Prepare the data repository

- In Settings, General, turn on **Allow auto-merge**.
- Create the labels `needs-review` and `owner-claim`. The run opens the review PR without them when they are missing, with a warning.
- Protect `main` with the required check the data repository's CI reports, so auto-merge waits for it.
- Set the Actions variable `INTAKE_URL` to the intake's base URL and the secret `INTAKE_PLACES_TOKEN` to the Worker's `PLACES_TOKEN`. The release workflow then loads the place index into the intake after each release, which the intake needs to decide items at send time, and tells it the new release.

## 10. Add the apply workflow to the inbox

Copy [`packages/apply/examples/inbox-apply-feedback.yml`](../packages/apply/examples/inbox-apply-feedback.yml) to `.github/workflows/apply-feedback.yml` in `inbox` and fill it in:

- Replace both `REPLACE_WITH_ENGINE_SHA` values with the same full 40 character commit SHA of this repository. One pins the reusable workflow (`uses: ...@<sha>`), and the other (`engine-ref`) is the engine code it checks out and runs. Always move them together.
- Replace `REPLACE_WITH_INTAKE_URL` with the intake's base URL, such as `https://intake.example.org`. Remove the `intake-url` and `places-token` lines for an intake without `RECENT_LIST`.
- Remove `release-workflow: release.yml` to leave releases to their own schedule.

Add the Actions secrets in `inbox`:

```sh
gh secret set OCDB_BOT_CLIENT_ID --repo <owner>/inbox
gh secret set OCDB_BOT_PRIVATE_KEY --repo <owner>/inbox < path/to/bot-app.private-key.pem
gh secret set PLACES_TOKEN --repo <owner>/inbox   # the Worker's PLACES_TOKEN
```

To change `PLACES_TOKEN`, set the new value on the Worker, in `inbox` and in `data` (`INTAKE_PLACES_TOKEN`).

To have the intake start the workflow a few minutes after feedback arrives, set `APPLY_WORKFLOW = "apply-feedback.yml"` in your deploy copy, give the intake's App **Actions: Read and write**, and deploy ([Starting the apply from the intake](#starting-the-apply-from-the-intake)).

Run the workflow once by hand from the Actions tab. With items in `pending/` it commits the moved files to `inbox` and keeps up to two PRs open on `data` ([The review PR](#the-review-pr)).

The OSM notes workflow (`osm-notes.yml`) is retired, so don't add it. [osm.md](osm.md) explains what replaced it.

## Update a running intake

1. See what the new release changes in the configuration and the schema, then move your checkout to it and reinstall. From the repository root:

   ```sh
   git fetch origin
   git diff HEAD origin/main -- packages/intake/wrangler.toml packages/intake/migrations
   git checkout --detach origin/main && npm ci
   ```

2. If the diff adds a binding or variable to `wrangler.toml`, add it to your deploy copy by hand. Don't regenerate the copy.
3. Apply any new migrations, then deploy. Code newer than its schema answers `500`: without `0010` and `0011` to every submission, without `0012` to a photo service's progress calls, and without `0013` to every request with an idempotency key, which every SDK from 0.21.0 sends. Without `0014` the AI reviewer still goes on past a case whose model call fails, but never counts its failed runs, so it never leaves that case to a person. Without `0015` a new place report the intake would put on the recent list answers `500`, because the intake keeps the adder's client network with the place.

   ```sh
   cd packages/intake
   npx wrangler d1 migrations apply RECENT_LIST --remote -c wrangler.deploy.toml
   npx wrangler deploy -c wrangler.deploy.toml
   ```

4. Move both SHAs in the inbox's `apply-feedback.yml` to the same new commit.

Secrets stay in Cloudflare and need no change. The intake validates every submission, so a release that adds facts or report kinds needs this redeploy before apps send them. Until then the intake refuses them with `400`.

### Moving to SDK 0.33.0: a photo's point of interest

SDK 0.33.0 lets an app send a photo's `focus` ([photos.md](photos.md#a-photos-point-of-interest)). An older photo intake refuses a photo meta that carries it, so in this order:

1. Deploy the photo intake at the new commit. It needs no new setting.
2. Move the apply workflow's engine pin to the same commit, so the apply run publishes `focus` in photo records. An older apply run publishes the photo without it.
3. Only then ship app builds on SDK 0.33.0 that send `focus`.

The photo server serves records as the apply run writes them and needs no change.

### Photo passes that name the install

For an app's photo service, this release has passes name the install they went to, and the photo server counts its rate limit per install instead of per address ([photos.md](photos.md#rate-limits)). Neither the SDK nor the apps change. In this order:

1. In the photo server's deploy copy, add the rate limiting bindings `PER_INSTALL` (the template has 120 a minute) and `PER_IP_CEILING` (3,000 a minute), each with a `namespace_id` unique in your Cloudflare account, and keep `PER_IP` (300 a minute) for photo keys and older passes. Deploy the photo server.
2. Then deploy the photo intake at the same commit. It needs no new setting. An older photo server answers `401 invalid_pass` to the new passes, so the photo server goes first.

Passes issued before the intake moved keep working until they expire, within an hour, and are counted per address meanwhile.

### Moving to SDK 0.32.0

The release with SDK 0.32.0 asks this of a running deployment, in this order:

1. Apply migrations `0014` and `0015` to `RECENT_LIST` (step 3 above says what each one is for). Without `0015`, new place reports that go live answer `500`.
2. To limit the public reads per client network, add the `PER_IP` rate limiting binding to your deploy copy ([section 2](#2-create-the-cloudflare-resources)). It is optional: without it, put a Cloudflare rate limiting rule in front of those reads.
3. To refuse photos that still carry metadata, set `PHOTO_REFUSE_METADATA = "on"` on your photo intake once every app build that uploads photos uses SDK 0.32.0 or later ([photos.md](photos.md)). Unset, photos are stored as they were sent. Each upload now costs two SafeSearch requests, one for each file.
4. Deploy the intake at the new commit, and only then move both SHAs in `apply-feedback.yml` to it. The new apply run reads records only the new intake writes: an item held for a reason of the rules that sets a link goes to a person unless the intake recorded that its links passed the link checks, and a review that replaces an earlier one from another install is published only when the intake marked it `proved`. Items the old intake stored keep working, and go to a person where those records are missing.

Apps on earlier SDK versions keep working against this intake. It refuses only input a genuine app does not send: one-line texts holding a line separator, text holding a lone surrogate, and a `commons_mismatch` file that is not a Commons file name. An App Attest key registered under a non-standard spelling of its key id answers `unknown_key` once, and an app that drops the keys `keyIsUnusable` names registers a new one. The data release's `POST /v1/release` refuses a release name dated more than 7 days ahead of the intake's clock.

## How the intake works

### Daily counters

The intake counts submissions per UTC day. A network is the client address from `CF-Connecting-IP`, cut to its IPv4 /24 or IPv6 /48 and kept only as a salted hash.

| Counter | Daily limit |
|---|---|
| Feedback per device | 200 |
| Owner submissions per device | 5 |
| Feedback per network | 500 |
| Owner submissions per network | 10 |
| Feedback per contributor | 200, or the key's `contributor_daily_limit` |
| Feedback per App Attest key | 200 |
| New places per contributor (per device without one) | 10 |
| Reports about one place from one device | 100 |
| App Attest key registrations per network | 500 |
| App Attest challenges and refused Play Integrity tokens per network | 500 |
| Photo passes per device, and per network | 48, and 500 |
| Photo uploads per contributor | 10 |
| Per app key | `daily_limit`, and `owner_daily_limit` for owner submissions |

A device's first report about a place in a day counts against every limit. The rest of the same edit counts against the app's, the network's and the attested key's limits but not the device's or the contributor's, so a full edit of a place costs the traveller one submission.

With `RECENT_LIST` the counters are rows in `rate_counts`, one per counter and day. Each counter is counted and checked in one statement that adds one and returns the new count, so a limit holds however requests are timed. When any count is over its limit, the intake takes back what it added for the item and refuses it with `429` and `retry-after` (seconds to midnight UTC). An item is counted on its own device, contributor, key and network counters first and on the app's counter last, so an item refused for its own limits never adds to the count every sender of the app shares. A batch counts the network's and then the app's counters for all its items at once, keeps what fits under each limit for its items, and gives back what they do not use. A network at its limit holds nothing of the app's count, and its items are refused one by one. While a batch is in flight, a `held:` row beside each counter it reserved records what it holds, so a request refused only because batches in flight hold the app's count is asked to wait 60 seconds, not until midnight. When a counter cannot be written, the intake gives back exactly the additions that landed and answers `503` with `retry-after: 60`. Each URLhaus lookup for the links of an item the rules hold counts against a daily cap of 100 for the client network ([limits](limits.md#urlhaus)). An item that is counted but then not stored, because storage failed, has its counts given back. Photo uploads, photo passes and key registrations keep their counts once checked, so a refused or failed upload still counts. A challenge is counted before it is stored. A Play Integrity token is counted before it is sent to Google and given back when Google accepts it or cannot answer, so only refused tokens use up the network's budget, and past it the intake answers `429` without asking Google. Without `RECENT_LIST` the counters are in KV, which reads and then writes each counter, so requests that arrive together can pass a limit by a few. The scheduled job deletes counters from before yesterday.

### Idempotency keys

From SDK 0.21.0, every request carries a key that stays the same each time the SDK sends that item again: in the `Idempotency-Key` header of `POST /v1/feedback` and `POST /v1/photos`, and in `keys` beside `items` in a batch, one different key per item, in order. A key is 16 to 128 letters, digits, `_` and `-`. A malformed key, or a batch whose `keys` don't match its items one for one, answers `400`. A queued item's key is its id in the SDK's queue, which survives restarts. A photo upload's key is a hash of its place, contributor, install and file hashes.

The intake keeps each key per app, with its `202` answer, in `request_keys`, in the same transaction that stores the item. When the same key comes again, for example because the first answer was lost on a weak signal, the intake gives the first answer again and stores and counts nothing. In a batch, only the items not taken before are stored. Two requests with one key at the same moment can't both be stored: the second answers `503`, and the SDK's next try gets the first answer. Refusals are not kept, and neither are owner claims and listings, whose answer holds a token that is never stored.

Keys are kept for 31 days, a day more than the SDK keeps an unsent item by default (`maxQueueAgeMs`). An app that sets a longer `maxQueueAgeMs` can have an item stored twice after 31 days. Without `RECENT_LIST`, keys are ignored.

### Batches

`POST /v1/feedback/batch` takes `{"items": [...], "keys"?: [...]}` with 1 to 50 feedback submissions and one attestation over the whole body. It needs `RECENT_LIST` and answers `404` without it. Each item is taken as `POST /v1/feedback` would take it, in order, and the answer is `200 {"items": [...]}` with each item's own answer in the same order: `{"status": 202, "id", ...}` or `{"status", "error", "details"?}`, with `retry_after` in seconds on a `429`. Owner submissions and photos are refused per item with `type_not_allowed_in_batch`. A bad attestation, a bad app key, a body that is not a batch or is too large, and an app over its daily limit are answered for the whole batch. The accepted items are stored in one transaction, so a storage failure stores none of them and answers `503`.

### Batched inbox writes

With `RECENT_LIST`, the intake queues each stored item in `inbox_queue`, in the same transaction as its send-time decision, and answers `202` once that commits (`503 storage_unavailable` when it can't). Every minute the scheduled job writes up to 200 queued items, at most 2 MiB, to `INBOX_BRANCH` as one commit through the Git Data API: it reads the branch head, creates a tree on it, creates a commit and moves the branch, never by force, starting again from the new head when the branch has moved on. That is three content-creating requests a minute however busy the intake is: up to 200 items a minute, 12,000 an hour, against GitHub's 80 a minute and 500 an hour for one commit per item.

One flush runs at a time, under a 5 minute lease in the `runs` table, and each GitHub call is given 15 seconds. When GitHub refuses a tree, the flush splits the files until it finds the refused ones and writes the others. An item refused 5 times is `stuck`: it waits behind every other item and is tried again once a minute until a person looks at it in `inbox_queue`. While GitHub is down, items wait in the queue. Each failed flush is logged as an error, and so is every tick while the oldest queued item is more than 15 minutes old. Apps are still told their changes are live, so watch for it:

```sh
curl -H "authorization: Bearer <PLACES_TOKEN>" https://<your intake>/v1/health/queue
# {"queued": <count>, "oldest_age_seconds": <seconds or null>, "stale": <true past 15 minutes>, "stuck": <count>}
```

The apply skips, and logs, a pending item whose id is already in `applied/` or `refused/`, so an item written twice is never decided twice. Remove such a file from `pending/` by hand.

Photo uploads are queued the same way: the files go to the pending bucket during the request, the photo's record is queued, and the files are deleted again when the record cannot be queued.

### Starting the apply from the intake

With `RECENT_LIST` and `APPLY_WORKFLOW` set, the scheduled job starts that workflow on `INBOX_BRANCH` once the inbox has had no new write for 2 minutes, or once the oldest write since the last start is 10 minutes old, and at most once every 10 minutes. A flush counts as an inbox write. It uses a token with only `actions: write` on `inbox`. Until the App has that permission, each start fails, is logged as a warning and is tried again the next minute, while feedback still reaches the inbox and the hourly schedule still runs. The job keeps its times in the `runs` table.

### The recent list and recent changes

`GET /v1/places/recent?bbox=<west>,<south>,<east>,<north>` is public and answers `{"places", "changes", "release"?}`: the new places not in the data yet, with their standing, and the recent changes to released places. The box is grown out to whole degrees before the query and the cache, so map views in the same degrees share one cached answer for 30 seconds. Each new place, check, removal report or withdraw is one row written.

The apply workflow keeps the list in step with these routes, each with `authorization: Bearer <PLACES_TOKEN>`. Each answers `401 unauthorised` for a wrong token and `404` without `RECENT_LIST` or `PLACES_TOKEN`.

| Route | Body | What it does | Answer |
|---|---|---|---|
| `POST /v1/places/recent/remove` | `{"ids": [...]}`, 1 to 500 place ids | Marks places written into the data, or withdrawn, with `in_data_at` (the first time only). Each stays on the list for 7 days from then, when the scheduled job deletes it and its evidence. | `{"removed"}` |
| `POST /v1/places/recent/block` | `{"contributors": [...]}`, up to 5,000 `ctr_` ids, `[]` for none | Replaces the block list. A blocked contributor's places leave the list and later ones aren't listed. One taken off the block list is listed again. | `{"blocked"}` |
| `POST /v1/places/recent/in-data` | `{"ids": [...], "at": "<ISO time>"}`, 1 to 500 feedback ids | Says data `main` holds those items' changes as of `at` (the intake's own time when `at` is later). Each recent change keeps the first time it is told and is deleted 7 days later. | `{"marked"}` |
| `POST /v1/places/recent/overruled` | `{"ids": [...], "refused": [...]}` | Names items the apply decided other than applying them, and among them the ones it refused. Their recent changes leave the list at once and their reports count as held. Only a refused item counts against its contributor's track record. `refused` may be left out. | `{"removed"}` |
| `POST /v1/places/recent/doubt-cases` | `{"cases": [{"place", "fact", "value", "taken_down_at", "feedback_id"}]}`, 1 to 500 | Names facts the apply took down after doubts in the last 90 days, with the value each had, when the doubt that took it down was received (to the second, UTC) and that doubt. The intake opens the same case its own takedowns open, so a later report of the value is decided as a confirmation. A case replaces the one kept for its place and fact only when its takedown is later and that one was not closed after it. | `{"opened"}` |

`in-data` and `overruled` skip ids with no recent change, and the apply sends every doubt case on every run, so sending again changes nothing. A recent change the data never takes leaves the list 7 days after it was accepted.

### Progress

The apply sends each item's progress with the same token: `POST /v1/feedback/progress` with `{"items": [{"id", "state", "reason"?, "by"?, "place"?, "decided_at"?, "in_data_at"?}]}` (1 to 500), answering `{"updated"}`. `state` is `waiting`, `accepted`, `held`, `refused` (with `by`: `rules` or `reviewer`) or `in_data` (with `in_data_at`, the commit time of the last commit on `main` that touched the file the change is in). A record never moves back: `in_data` is final, `refused` changes only to `in_data`, and `in_data_at` keeps the first time sent (the intake's own time when that is later).

The intake writes the first record itself, in the batch that queues an accepted feedback item: `live` when the send-time decision put it live, otherwise `received`, with the `held_reason` when it held it. Owner submissions and photos get none then. `GET /v1/feedback/progress?ids=fb_...,fb_...` (1 to 100 ids) is public, never cached at the edge, and answers `{"items"}` with each id's record, or `{"id", "state": "unknown"}`. The scheduled job deletes records 90 days after they last changed.

### The newest release

After loading the place index, the data release tells the intake its `data_version` with `POST /v1/release`, `{"data_version": "<yyyymmdd>T<hhmmss>Z-<short sha>", "layout_version": <number>?}`, and the same token. The intake keeps the newest it is told in `latest_release`, never going back to an older one, and answers `{"release": {"data_version", "published", "layout_version"?}}`, where `published` is when it was first told. `GET /v1/places/recent` carries the same `release`, so an app with an older release can fetch the new one. It answers `400` for a `data_version` that is not a release name (the short sha in lower-case hex) or is dated more than 7 days ahead of the intake's clock.

### The place index

The same database holds the place index: each released place's facts, who set each one (`fact_sources`) and when (`fact_dates`), filed by whole-degree map cell, so the intake can decide items at send time. The data release loads it after each release (step 9):

- `GET /v1/place-index/cells` answers `{"cells": [{"cell": [<lon>, <lat>], "hash": "<sha256>"}, ...]}` for every cell the intake holds.
- `PUT /v1/place-index` sends only the cells whose hash differs, as NDJSON, gzipped or not, up to 4 MiB. Its first line names the cells the call replaces, `{"cells": [{"cell": [<lon>, <lat>], "hash": "<sha256>" or null}, ...]}` (null for a cell that no longer holds a place), and every other line is a place in one of them, `{"id", "cell", "facts", "fact_sources", "fact_dates"}`. Each call replaces its cells in one transaction and answers `{"cells", "places"}`.

The first load writes about two rows per place, so on the D1 free plan a large index can take more than one day: calls refused past the daily limit fail the upload step, and the next release sends the cells still missing.

### Deciding at send time

With the place index loaded, the intake decides `fact`, `contact` and `doubt` reports about a released place, and `new_place` reports, while the app waits. It uses the apply's own rules and then its checks: text checks, link rules, at most 50 live changes a day for each contributor, client network and App Attest key, URLhaus for links, and Llama Guard for free text from a contributor without a track record. When the rules hold an item that would set a link (a place the index does not have yet, an owner's value, a disagreement), its links still go through the link rules and URLhaus: a link that fails is held as `link_check`, and the inbox item records `"links": "passed"` when they pass. The apply sends a held item that sets a link without that record to a person. A `commons_mismatch` report is always held. The answer adds `"state": "live"` or `"state": "held"` with a `held_reason`.

A live fact, contact takedown or doubt takedown is a recent change, listed under `changes` (a takedown has a null `value`). A live new place is listed with its description, fee and contacts. The inbox item records the decision as `intake`, and the apply still writes the data. It decides each item again with its own rules, but an item the intake held for a check (`text_check`, `link_check`, `ai_check`, `daily_cap` or `check_unavailable`) goes to a person on the review PR, never into the data on its own.

The database also keeps each contributor's track record, the reports the intake decided in the last 90 days, so later reports about the same place and fact are decided against them, and, for 90 days, each fact doubts took down with the value it had, so two new travellers confirming that value bring it back and a report of another value replaces it.

### The AI reviewer

The AI reviewer runs from the scheduled job, at most once every 10 minutes, on the held cases in the open `feedback/review` PR. It needs all of these:

- `AI_REVIEWER = "on"`, the `AI` binding and `RECENT_LIST`;
- `DATA_REPO` set to the data repository (`<owner>/data`);
- `REVIEW_BOT_LOGINS` set to the bot logins whose PR comments count, comma separated: `<app slug>[bot]` for the apply's App and for the intake's (often one App does both);
- the intake's App installed on `data` in the same installation as `inbox`, so `GH_INSTALLATION_ID` stays the same, with **Pull requests: Read and write**. Its token has only `contents: write` and `pull_requests: write` on `data`.

It reads the `held-case` lines in the PR body and in comments from those bot logins and from the repository's owners, members and collaborators, never from anyone else, other GitHub Apps included. The rules settle what they can first, without the model: a contact or description that waits in the inbox, a place with a verified owner or a contact the owner set, a blocked contributor, a contact taken down after a `spam` report, a doubted fact the owner set or that came from OSM, a case the apply's rules closed and a case that is out of date are all left to a person.

It asks the model (`REVIEW_MODEL`, by default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) about up to 5 of the rest a run. Each case allows only its own decisions:

| Case | Decisions |
|---|---|
| `duplicate` | `approve`, `merge`, `take_down`, `leave` |
| `hidden`, `first_place` | `approve`, `take_down`, `leave` |
| `contact_withdrawn` | `restore`, `leave` |
| `fact_doubted`, taken down | `restore`, `keep_down`, `leave` |
| `fact_doubted`, still on the place | `dismiss`, `leave` |
| `commons_mismatch` | `confirm`, `dismiss`, `leave` |
| any other | `leave` |

An answer the model isn't sure of, or one that can't be read, is `leave`. A model call that fails or takes longer than 30 seconds is logged, and the run goes on to the next case. The case is asked about again next run. Its failure counts in the `review_failures` table only when another model call in the same run answered, so an outage counts nothing, or when it was the run's only model call and its last counted failure was at least 30 minutes earlier. Once a case has 3 counted failures it is `leave`, for a person, so a lone case is left only after its failures span at least an hour. The decisions that change a place go to `feedback/review` as one commit at the end of the run, through the Git Data API, with the reviewer (`ai:<model>`) and each reason in the message. A file another writer changed on the branch since the run read it is left out with its decisions, which are decided again next run. Each run adds one comment with a `review-decision` line per decision that landed. A case with a decision is not asked about again. A person can reverse any decision on the PR before merging it.

## The apply workflow

### The review PR

Each run keeps up to two PRs open on `data`:

- `feedback/auto`: changes from the automatic rules, new places included. It merges itself once CI passes. Without **Allow auto-merge** or a required check, the run says on the PR that it needs merging by hand and shows an error annotation, without failing.
- `feedback/review`: held cases, location changes, contact changes that need a person, owner claims and other reports, labelled `needs-review`. Edit the files on the branch if needed, then merge it, or close it to refuse them.

When a PR from either branch is already open, later runs add a commit and a comment to it. Each run reads the PR's state again just before and just after it pushes: when the PR was merged or closed during the run, the run's commit goes on `main` as it is then, for a new PR, or is left out when `main` already holds it. Once it is merged or closed, the next run starts the branch again from `main`. With nothing to do the workflow ends without changes.

The review PR text stays under GitHub's limit for a body or comment. Each run sends at most 20 owner claims and listings, oldest first, and the rest wait in `pending/` for the next run. Held and closed case lines that do not fit in the body or comment follow, in order, in more comments from the bot. Change lines that still do not fit are counted, and every change is in the run's job summary. When GitHub refuses a PR or a PR text anyway, the run shows an error annotation and still records its other inbox moves, but the items that PR was to carry go back to `pending/` for a later run: for the review PR the owner claims and every item for a person, and for the automatic PR the items behind its changes. The run reads every comment on a PR, 100 at a time, and stops with an error on a PR with more than 3,000.

A run that stops after it published its automatic changes, before it recorded its inbox moves, is repeated by the next run with the same items. A doubt or contact takedown that run made is found in the data's history and decided the same way again, with its held case listed again, never refused.

The workflow reads the recent bot PRs and their comments through GitHub's GraphQL API, which gives each author's account type. A PR or comment counts as the bot's only when its author is an account of type Bot with the bot App's login: a person's account with the same name never counts.

The review PR body lists every held case under "Held cases", one line each: `- held-case` and a JSON object with `case` (`duplicate`, `hidden`, `contacts`, `description`, `first_place`, `contact_withdrawn`, `fact_doubted` or `commons_mismatch`), `place`, `standing` (left out for a place travellers did not add), `location`, `kind`, the case's details (`duplicate_of` and `distance_m`, `reports` and `reasons` or `blocked`, the facts left off in `contacts`, which may include `address`, the text check a description failed in `problem`, the `contributor`) and the `feedback` ids to read in the inbox. A triage agent, a bot or the AI reviewer can read these lines instead of the prose.

- A `contact_withdrawn` case is a contact taken off a place after reports from two sources within 90 days, one of them attested. It carries `fact`, `value` and `reasons`. `value` is the place's own published contact, not something a traveller sent, so it is in the PR body. The contact is already off the place through `feedback/auto`. To restore it, set `facts.<fact>` back to `value` on the place in the review PR. Reports sent before the takedown no longer count against it.
- A `fact_doubted` case is a fact travellers say is wrong without giving the right value. It carries `fact`, `value` (what the place published), `taken_down`, `sources` (the travellers doubting it) and the `doubts` and `confirmations` weighed, by feedback id. With `taken_down`, the fact is already off the place through `feedback/auto`, and to restore it you set `facts.<fact>` back to `value` in the review PR. Without it the fact stays: only one traveller doubts it, no doubt was attested, as many travellers confirm it, or it came from OSM or the owner. Doubt notes stay in the inbox. Two new travellers confirming the value after a takedown (one attested, neither of them a traveller who reported the value before, and more than any doubts since) restore it, and a new value replaces it. Either way the review PR lists a `- closed-case` line under "Closed cases" with `case`, `place`, `fact`, `settles` (`restored` or `replaced`) and `feedback`, which closes the earlier `fact_doubted` cases for that place and fact.

### New places

New places are written with their `standing` from the SDK's `newPlaceStanding`. A `shown` or `confirmed` place goes on `feedback/auto` when its report was attested, has a contributor and its note passes the SDK's text checks, as the intake requires to list it. Checks, `remove` reports and the adder's `withdraw` on a place added in the last 90 days work its standing out again: reports from two devices on two client networks (three once confirmed) set it to `hidden`, and a place withdrawn within 24 hours is not written, or its record is deleted. A place within 150 m of another in the same group, a place hidden before it was published, and a place the intake would not list are drafted on `feedback/review` with standing `held` or `hidden`: set `standing` to `shown` to publish it, or close the PR. A published new place carries its description, fee, contacts and address. A contact or address that fails the SDK's `contactProblem` link checks, or a description that fails the text checks, stays in the inbox for a person.

Reports set a place's `standing` again on later runs unless a person's decision is on its record. To restore a hidden place, set `"standing": "shown"` and `"moderator": {"action": "restore", "at": "<now>"}` on the record, on the review PR or in a PR to `main`. Reports up to `at` no longer count. To hide one, set `"standing": "hidden"` and `"moderator": {"action": "hide", "at": "<now>"}`: it stays hidden whatever travellers send. `at` is a UTC time such as `2026-11-03T09:00:00Z` or a day such as `2026-11-03`. Only the latest decision is kept. The note on a place hidden before it was published gives the line to paste.

### What the workflow tells the intake

With `intake-url` set, each run passes `--main <checkout of data main> --intake <intake URL>` and the `places-token` secret to `ocdb-apply`. The run then:

- takes new places off the recent list once the PR that writes them has merged, and withdrawn ones at once;
- sends the contributors in `moderation/blocked_contributors.json` on `main` as the block list;
- sends the ids of the items it decided other than applying them, and of the fact and contact reports applied in the last 90 days whose change `main` now holds;
- sends the progress of every item from the last 90 days whose progress changed since the last send.

`main` is checked out before the run, so a change counts as in the data only at the first run after its PR merged. Each change in the data is dated by the last commit on `main` that touched its file (the place file, the place's review file or the do-not-match file), so the workflow fetches the last 14 days of `main`'s history. A file last changed before then is dated by `main`'s last commit. The inbox keeps the state last sent for each item in `progress/sent.json`, so a failed send goes again next run. An item last sent `in_data` or `refused` is final and not sent again, and the first run after 00:00 UTC each Monday sends every item of the 90 days.

The workflow reads the 100 most recent `feedback/review` and `feedback/auto` PRs before it checks out `main`. A held change counts as refused by a reviewer when a merged or closed review PR names it, no open review PR names it and `main` lacks it. An applied change counts the same way when a closed automatic PR names it and no open one does. A call that fails is logged and the run goes on.

### Other workflow inputs

- `recent-places-url`: an intake's base URL. Each run passes `--recent-places <url>` and reads that intake's public `GET /v1/places/recent`. Feedback about a new place on that list that is not in the data yet waits in `pending/` instead of being refused, and while the list can't be read, all feedback about places not in the data waits. An app's own photo inbox needs this ([photos.md](photos.md)).
- `release-workflow`: the data repository's release workflow file (`release.yml`), which must run on `workflow_dispatch`. A run that opened or added to `feedback/auto` waits up to 10 minutes for it to merge, then starts the release on `data-base-branch`. A PR without auto-merge, one still waiting after 10 minutes, a missing Actions permission or a failed start leaves the change to the release's schedule, with a notice or warning, and never fails the run.
- `places-repository`, `photo-licence`, `hold-first-photo`, `review-preview-url` and the `review-preview-secret` secret: for an app's photo service ([photos.md](photos.md)).
- `data-repository-name` (default `data`) and `data-base-branch` (default `main`).

### Running the apply script locally

With `inbox` and `data` checked out next to this repository, from its root:

```sh
npm run build
node packages/apply/dist/cli.js --inbox ../inbox --data ../data \
  --auto-pr-body auto.md --review-pr-body review.md --summary summary.json
```

Without `--review-data`, automatic and review changes land in the same checkout. It changes files in both checkouts and commits nothing, so you can read the diff before deciding what to do with it.

## Moving an old intake off RECENT_PLACES

Intakes set up before the recent list moved to D1 kept it in a `RECENT_PLACES` KV namespace, which the current intake no longer reads. The command that copied it into D1 was removed after [`db7fc14`](https://github.com/opencampingdb/feedback-engine/tree/db7fc145aa4e00549dcb168aaac11bd3003b82f8). To move such an intake, check out that commit (`git checkout db7fc14 && npm ci`) and follow steps 1 to 4 of [its guide](https://github.com/opencampingdb/feedback-engine/blob/db7fc145aa4e00549dcb168aaac11bd3003b82f8/docs/self-hosting.md#moving-the-recent-list-from-kv-to-d1). Where it says to regenerate `wrangler.deploy.toml`, add the `RECENT_LIST` block to your existing copy by hand instead, so you keep your hand-set values.

A week later, once the recent list has served from D1 without trouble, clear the namespace and remove the binding. List what is left first:

```sh
npx wrangler kv key list --namespace-id <RECENT_PLACES namespace id> --prefix np: --remote > recent-places-keys.json
```

If the list is not empty (`[]`), delete those keys, then the block list key:

```sh
npx wrangler kv bulk delete recent-places-keys.json --namespace-id <RECENT_PLACES namespace id> --remote
rm recent-places-keys.json
npx wrangler kv key delete blocked:contributors --namespace-id <RECENT_PLACES namespace id> --remote
```

Take the binding out of your deploy copy by editing it, and deploy from a checkout of the release you already run, so only the binding changes:

```sh
cp wrangler.deploy.toml wrangler.deploy.toml.bak
# delete the [[kv_namespaces]] block whose binding is "RECENT_PLACES"
diff wrangler.deploy.toml.bak wrangler.deploy.toml
npx wrangler deploy -c wrangler.deploy.toml
```

Check that `diff` shows only that block, and that the binding list Wrangler prints has every binding it had before except `RECENT_PLACES`. Then delete the backup and the namespace:

```sh
rm wrangler.deploy.toml.bak
npx wrangler kv namespace delete --namespace-id <RECENT_PLACES namespace id>
```

## Abuse

Report abuse of a public intake, or a leaked app key, with **Report a vulnerability** on this repository's Security tab.
