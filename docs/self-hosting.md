# Self-hosting the intake and the apply workflow

This sets up the whole feedback path: the intake Worker on Cloudflare, the private `inbox` repository and the workflow that applies it to `data`, which the intake starts a few minutes after new feedback and which also runs hourly. Everything fits the Cloudflare Workers free plan and GitHub Actions.

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

**Batched inbox writes.** With `RECENT_LIST` bound, the intake does not write each item to the inbox as it arrives. It puts the stored feedback item or owner submission in the database's `inbox_queue` table, in the same transaction as its send-time decision, and answers `202` once that commits (`503 storage_unavailable` when it can't, as before). The scheduled job, every minute, writes up to 200 queued items (and at most 2 MiB of them) to `INBOX_BRANCH` as one commit through the Git Data API: it reads the branch head, creates a tree with the files on the head's tree, creates a commit and moves the branch to it, never by force, starting again from the new head when the branch has moved on. That is three content-creating requests a minute however busy the intake is, so the inbox takes up to 200 items a minute, 12,000 an hour, against GitHub's 80 a minute and 500 an hour for one commit per item. Queued items reach the inbox within about a minute, and a flush counts as the inbox write for starting the apply. One flush runs at a time, under a 5 minute lease in the `runs` table, and each GitHub call it makes is given 15 seconds. As a backstop, the apply skips, and logs, a pending item whose id is already in `applied/` or `refused/`, so an item written twice is never decided twice. Remove such a file from `pending/` by hand. While GitHub is down or refusing, items wait in the queue and are written once it answers again. Each failed flush, and a flush that gives up on a branch that keeps moving, is logged as an error, and so is every tick while the oldest queued item is more than 15 minutes old: apps are still told their changes are live, so watch for it. `GET /v1/health/queue` with `authorization: Bearer <PLACES_TOKEN>` answers `{"queued": <count>, "oldest_age_seconds": <seconds or null>, "stale": <true past 15 minutes>, "stuck": <count>}`. One bad item never holds up the rest: when GitHub refuses a tree, the flush splits the files until it finds the ones refused and writes the others, and an item refused 5 times (`stuck`) waits behind every other item, tried again once a minute until a person looks at it in the `inbox_queue` table. A recent change the data never takes leaves the list 7 days after it was accepted. Two writes stay direct, one commit per item: photo uploads (`POST /v1/photos`), whose files go to the pending bucket in the same request and are deleted when the item cannot be written, and which the photo caps keep to a few a day for each contributor; and everything on an intake without `RECENT_LIST`.

Each new place, check, removal report or withdraw is one row written. Each refresh of the list that misses the edge cache is one query. The box a request names is grown out to whole degrees before the query and the cache, so map views in the same degrees share one cached answer for 30 seconds. This fits the D1 free plan.

The apply run keeps the recent list in step with two calls, each with `authorization: Bearer <PLACES_TOKEN>`. `POST /v1/places/recent/remove` with `{"ids": [...]}` (1 to 500 place ids) names places it has written into the data or whose adder withdrew them, answering `{"removed": <count>}`. Each is marked with `in_data_at` from the intake's clock, the first time only, and stays on the list with its current standing for 7 days from then, when the scheduled job deletes it and its evidence. `POST /v1/places/recent/block` with `{"contributors": [...]}` (up to 5,000 hashed `ctr_` ids, `[]` for none) replaces the block list the intake keeps, answering `{"blocked": <count>}`. A blocked contributor's places leave the list and later ones aren't listed; one taken off the block list is listed again. Both answer `401` for a wrong token and `404` without `RECENT_LIST` or `PLACES_TOKEN`.

Three more calls, with the same token, keep the recent changes (below) in step. `POST /v1/places/recent/in-data` with `{"ids": [...], "at": "<ISO time>"}` (1 to 500 feedback ids) says the data's main branch now holds those items' changes, as of `at` (the intake's own time when `at` is later). Each recent change keeps the first time it is told, is listed for 7 days from then, and is then deleted by the scheduled job. It answers `{"marked": <count>}`. `POST /v1/places/recent/overruled` with `{"ids": [...], "refused": [...]}` names items the apply decided other than applying them, and among them the ones it refused. Their recent changes leave the list at once and their reports count as held. Only a refused item's change counts against its contributor's track record: an item that went to a person, for a disagreement or an owner's value, does not. `refused` may be left out, and then nothing counts. It answers `{"removed": <count>}`. Both skip ids with no recent change, so sending them again changes nothing. `POST /v1/places/recent/doubt-cases` with `{"cases": [{"place", "fact", "value", "taken_down_at", "feedback_id"}]}` (1 to 500) names the facts the apply took down after doubts in the last 90 days, with the value each had, when the doubt that took it down was received (to the second, in UTC) and that doubt. The intake opens the same case its own takedowns open, so a report of the value is decided as a confirmation once the release no longer has the fact. A case replaces the one kept for its place and fact only when its takedown is later and that one was not closed after it, so the apply sends them all on every run. It answers `{"opened": <count>}`.

The apply sends each item's progress with the same token: `POST /v1/feedback/progress` with `{"items": [{"id", "state", "reason"?, "by"?, "place"?, "decided_at"?, "in_data_at"?}]}` (1 to 500). `state` is `waiting`, `accepted`, `held`, `refused` (with `by`: `rules` or `reviewer`) or `in_data` (with `in_data_at`, the commit time of the last commit on `main` that touched the file the change is in). An item it has no record of is taken, received at the time in its id. A record never moves back: `in_data` is final, `refused` changes only to `in_data`, and `in_data_at` keeps the first time it is sent (the intake's own time when that is later). A record changes only when its state, reason, refusal or place does, so the apply sends them all on every run. It answers `{"updated": <count>}`. The intake writes a record itself in the batch that queues each accepted feedback item: `live` when the send-time decision put it live, otherwise `received` with the `held_reason` when it held it. Owner submissions and photos get none then. `GET /v1/feedback/progress?ids=fb_...,fb_...` (1 to 100 ids) is public, never cached at the edge, and answers each id's record, or `{"id", "state": "unknown"}`. The scheduled job deletes records 90 days after they last changed.

The same database holds the place index: each released place's facts, who set each one (`fact_sources`) and when (`fact_dates`), filed by whole-degree map cell, so the intake can decide an item at send time. The data repository's release workflow loads it with the same token after each release, when the repository has the `INTAKE_URL` variable and the `INTAKE_PLACES_TOKEN` secret. `GET /v1/place-index/cells` answers `{"cells": [{"cell": [<lon>, <lat>], "hash": "<sha256>"}, ...]}`, the hash of every cell the intake holds. The release sends only the cells whose hash differs, with `PUT /v1/place-index`: NDJSON, gzipped or not, up to 4 MiB. Its first line names the cells the call replaces, `{"cells": [{"cell": [<lon>, <lat>], "hash": "<sha256>" or null}, ...]}` (null for a cell that no longer holds a place), and every other line is a place in one of them, `{"id", "cell", "facts", "fact_sources", "fact_dates"}`. Each call replaces its cells in one transaction and answers `{"cells": <count>, "places": <count>}`. A release that changes a few places writes only their cells. The first load writes about two rows per place, so on the D1 free plan a large index can take more than one day: calls refused past the daily limit fail the upload step, and the next release sends the cells still missing.

With the place index loaded, the intake decides `fact`, `contact` and `doubt` reports about a released place, and `new_place` reports, while the app waits, using the apply's own rules and then its checks (text checks, link rules, at most 50 live changes a day for each contributor, each client network and each App Attest key, so an install that changes its contributor id is still capped, URLhaus for links, and Llama Guard for free text from a contributor without a track record). Its answer adds `"state": "live"` or `"state": "held"` with a `held_reason`. A live fact, contact takedown or doubt takedown is a recent change, listed by `GET /v1/places/recent` under `changes` (a takedown with a null `value`), and a live new place is listed with its description, fee and contacts. The inbox item records the decision as `intake`, and the apply still writes the data: it decides each item with its own rules again, but an item the intake held for a check (`text_check`, `link_check`, `ai_check`, `daily_cap` or `check_unavailable`) goes to a person on the review PR, never into the data on its own. The same database keeps each contributor's track record and, for 90 days, the reports the intake decided, so later reports about the same place and fact are decided against them, and, for 90 days, each fact doubts took down, at send time or by the apply, with the value it had, so two new travellers confirming that value bring it back and a report of another value replaces it. A check that isn't set up holds every item that needs it, so set `URLHAUS_KEY` and the `AI` binding (step 5) before relying on it.

### Moving the recent list from KV to D1

Intakes set up before the recent list moved to D1 kept it in a `RECENT_PLACES` KV namespace. A copy command moves its new places, their evidence and the block list into `RECENT_LIST`. It runs from your own machine through Wrangler's platform proxy, signed in with `npx wrangler login`, and needs no endpoint on the intake. It lists the `np:` keys once and reads each place's value, and every row it writes is skipped when D1 has it already. Evidence whose place has already left KV is not copied. Add `--local` to rehearse against the local state `wrangler dev` keeps in `.wrangler/state`.

Go live in this order, running every command from `packages/intake`:

1. Note the `RECENT_PLACES` namespace id before anything else: it is the `id` under `binding = "RECENT_PLACES"` in your current `wrangler.deploy.toml`, or find it with `npx wrangler kv namespace list`. The new `wrangler.toml` no longer names it, so regenerating the deploy copy drops it. Then create the D1 database, regenerate `wrangler.deploy.toml` with the `sed` command in step 6 (which adds the `RECENT_LIST` `database_id`), and apply the migration with that copy:

   ```sh
   npx wrangler d1 create ocdb-recent-list
   npx wrangler d1 migrations apply RECENT_LIST --remote -c wrangler.deploy.toml
   ```

2. Run the first copy. It copies everything, the block list too, and ends by printing the `--since` to use in step 4: the time it started, less five minutes.

   ```sh
   npm run copy-to-d1 -- --kv <RECENT_PLACES namespace id> --d1 <RECENT_LIST database_id>
   ```

3. Deploy the intake with `npx wrangler deploy -c wrangler.deploy.toml` (step 6).
4. Run the second copy, with the time the first one printed, to pick up what the old intake wrote to KV while the deploy went out:

   ```sh
   npm run copy-to-d1 -- --kv <RECENT_PLACES namespace id> --d1 <RECENT_LIST database_id> --since <time the first copy printed>
   ```

   With `--since` it copies only the new places added and the evidence sent from that time on, and leaves the block list alone. D1 is the recent list by then, so a place the apply run has removed from it, or a contributor it has taken off the block list, stays that way.

5. A week later, once the recent list has served from D1 without trouble, delete the `np:` keys and the `blocked:contributors` key from `RECENT_PLACES`. Until then the old keys are there to fall back to.

   ```sh
   npx wrangler kv key list --namespace-id <RECENT_PLACES namespace id> --prefix np: --remote > recent-places-keys.json
   npx wrangler kv bulk delete recent-places-keys.json --namespace-id <RECENT_PLACES namespace id> --remote
   npx wrangler kv key delete blocked:contributors --namespace-id <RECENT_PLACES namespace id> --remote
   rm recent-places-keys.json
   ```

   Then delete the namespace with `npx wrangler kv namespace delete --namespace-id <RECENT_PLACES namespace id>`.

## 3. Create the private inbox repository

Create `inbox` in your organisation, private, with a `README.md` on `main` so the branch exists. The intake writes to `pending/<yyyy-mm-dd>/`, and the workflow moves files to `applied/` and `refused/`.

## 4. Create the opencampingdb-intake GitHub App

In the organisation settings, under Developer settings, create a GitHub App:

- Name: `opencampingdb-intake` (or your own name for the same role).
- Homepage URL: your intake URL or this repository.
- Webhook: off.
- Repository permissions: **Contents: Read and write**, **Actions: Read and write** when the intake starts the apply, and **Pull requests: Read and write** for the AI reviewer (both below). Nothing else.
- Where can it be installed: only this account.

Generate a private key and download the `.pem` file. This key goes only into the Worker (step 5), never into GitHub Actions. Note the App ID. Install the App on the organisation, choosing **Only select repositories** and only `inbox`. The installation id is the number at the end of the installation page URL (`.../settings/installations/<id>`).

**Starting the apply from the intake.** With `RECENT_LIST` and the `APPLY_WORKFLOW` variable set to the inbox's apply workflow file (`apply-feedback.yml`), the intake's scheduled job runs every minute and starts that workflow on `INBOX_BRANCH` once the inbox has had no new write for 2 minutes, or once the oldest write since the last start is 10 minutes old, so a steady stream of feedback still gets a run. Either way it starts at most once every 10 minutes. It asks for a token with only `actions: write` on `inbox` for this, apart from the `contents: write` token it writes with. Adding the Actions permission to an installed App asks the organisation owner to accept it on the installation page before it takes effect. Until then each start fails, is logged as a warning in the Worker's logs, and is tried again the next minute, while feedback still reaches the inbox and the workflow's hourly schedule still runs. The job keeps its times in the `runs` table, so apply the migrations (step 2) before deploying.

**The AI reviewer.** With `AI_REVIEWER = "on"`, the `AI` binding (Workers AI), `RECENT_LIST`, `DATA_REPO` set to the data repository (`<owner>/data`) and `REVIEW_BOT_LOGINS` set to the bot logins whose PR comments count (`<app slug>[bot]` for the apply's GitHub App and for this intake's, comma separated, often one App for both), the same scheduled job reviews the held cases on the open `feedback/review` PR, at most once every 10 minutes. Add `data` to the App's installation (the same installation, so `GH_INSTALLATION_ID` stays the same) and give the App **Pull requests: Read and write**. It asks for a token with only `contents: write` and `pull_requests: write` on `data`. It reads the `held-case` lines in the PR body and in comments from those bot logins and the repository's owners, members and collaborators, never from anyone else, other GitHub Apps included. The rules settle what they can first, without the model: a contact or description that waits in the inbox, a place with a verified owner or a contact the owner set, a blocked contributor, a contact taken down after a `spam` report, a doubted fact the owner set or that came from OSM, a case the apply's rules closed and a case that is out of date are all left to a person. It asks the model (`REVIEW_MODEL`, by default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`) about the rest, at most 5 a run, for `approve` (keep a held or hidden new place), `restore` (put a withdrawn contact, or a fact doubts took down, back), `take_down` (hide a new place that is clear spam, with a `hide` decision), `keep_down` (leave a fact doubts took down off the place), `dismiss` (doubts about a fact that stays) or `leave`. Each case allows only its own decisions. An answer the model isn't sure of, or one that can't be read, is `leave`. A decision that changes a place is a commit to `feedback/review` with the reviewer (`ai:<model>`) and the reason, and each run adds one comment to the PR with a `review-decision` line per decision. A case with a decision is not asked about again. A person can reverse any decision on the PR before merging it. Off when any of these is left out.

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
- `URLHAUS_KEY`, needed only with `RECENT_LIST`, is an abuse.ch auth key, free from the abuse.ch authentication portal. The intake checks the links an item would publish with URLhaus. Set it with `npx wrangler secret put URLHAUS_KEY`. The `[ai]` binding `AI` in `wrangler.toml` gives the intake Workers AI for the Llama Guard check, so the Cloudflare account needs Workers AI.
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

A `202` with an `fb_` id means a file is now in `inbox/pending/`, or, with `RECENT_LIST` bound, queued for it and written there within about a minute. To use your own domain, add a custom domain to the Worker in the Cloudflare dashboard.

## 7. Create the opencampingdb-bot GitHub App

The apply workflow uses a second App. Its tokens open PRs that trigger the data repository's CI, which `GITHUB_TOKEN` cannot do.

- Name: `opencampingdb-bot` (or your own name for the same role).
- Webhook: off.
- Repository permissions: **Contents: Read and write** and **Pull requests: Read and write**, and **Actions: Read and write** when the workflow starts the data release (`release-workflow`, step 9). Nothing else.

Install it on only `inbox` and `data`. The workflow asks for a token limited to `contents: write` on `inbox`, and a second token for `data` with `contents: write` and `pull_requests: write`. With `release-workflow` set it asks for a third, with only `actions: write` on `data`. Generate a private key and note the App's **Client ID**. This key goes only into the inbox repository's Actions secrets (step 9), never into the Worker.

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
- `feedback/review`: held cases, location changes, contact changes that need a person and other reports, labelled `needs-review`. Edit the files on the branch if needed, then merge it, or close it to refuse them.

New places are written with their `standing` from the SDK's `newPlaceStanding`. A `shown` or `confirmed` place goes on `feedback/auto` when its report was attested, has a contributor and its note passes the SDK's text checks, as the intake requires to list it. Checks, `remove` reports and the adder's `withdraw` on a place added in the last 90 days work its standing out again: reports from two devices (three once confirmed) set it to `hidden`, and a place withdrawn within 24 hours is not written, or its record is deleted. A place within 150 m of another in the same group, a place hidden before it was published, and a place the intake would not list are drafted on `feedback/review` with standing `held` or `hidden`: set `standing` to `shown` to publish it, or close the PR. A published new place carries its description, fee, contacts and address. A contact or address that fails the SDK's `contactProblem` link checks, or a description that fails the text checks, stays in the inbox for a person and never reaches the record unchecked.

The review PR body lists every held case under "Held cases", one line each: `- held-case` and a JSON object with `case` (`duplicate`, `hidden`, `contacts`, `description`, `first_place`, `contact_withdrawn` or `fact_doubted`), `place`, `standing` (left out for a place travellers did not add), `location`, `kind`, the case's details (`duplicate_of` and `distance_m`, `reports` and `reasons` or `blocked`, the facts left off in `contacts`, which may include `address`, the text check a description failed in `problem`, the `contributor`) and the `feedback` ids to read in the inbox. A triage agent, a bot or an AI reviewer can read these lines instead of the prose.

A `contact_withdrawn` case is a contact taken off a place after reports from two sources within 90 days, one of them attested. It carries `fact`, `value` and `reasons`. `value` is the place's own published contact, not something a traveller sent, so unlike other contact details it is in the PR body. The contact is already off the place through `feedback/auto`. To restore it, set `facts.<fact>` back to `value` on the place in the review PR. Reports sent before the contact was taken down no longer count against it.

A `fact_doubted` case is a fact travellers say is wrong without giving the right value. It carries `fact`, `value` (what the place published), `taken_down`, `sources` (the travellers doubting it) and the `doubts` and `confirmations` weighed, by feedback id. With `taken_down`, doubts from two sources within 90 days, one attested, took the fact off the place through `feedback/auto`; to restore it, set `facts.<fact>` back to `value` on the place in the review PR. Without it, the fact stays: one traveller doubts it, none of the doubts was attested, as many travellers confirm it, or it came from OSM or the owner. The apply lists one such case for each place and fact in a run, with every doubt it weighed. Doubt notes stay in the inbox. The apply finds an open case in later runs from the doubt that took the fact down, which keeps `doubted` (the fact, its value and the date set on it) in its outcome in `applied/`, while the fact is still off the place with that date. Two new travellers confirming the value after the takedown (one attested, neither of them a traveller who reported the value before it, and more than any doubts since) restore it, and a new value replaces it; either way the review PR lists a `- closed-case` line under "Closed cases" with `case`, `place`, `fact`, `settles` (`restored` or `replaced`) and `feedback`, which closes the `fact_doubted` cases for that place and fact listed before it.

**A person's decision on a new place.** Reports set aside a place's `standing` again on later runs unless a person's decision is on its record. To restore a hidden place, set `"standing": "shown"` and `"moderator": {"action": "restore", "at": "<now>"}` on the record, on the review PR or in a PR to `main`. Reports up to `at` no longer count, and later ones count as usual. To hide one, set `"standing": "hidden"` and `"moderator": {"action": "hide", "at": "<now>"}`: it stays hidden whatever travellers send. `at` is a UTC time such as `2026-11-03T09:00:00Z` or a day such as `2026-11-03`. Only the latest decision is kept, so a new one replaces the old. The note on a place hidden before it was published gives the line to paste.

With `intake-url` set, each run passes `--main <checkout of data main> --intake <intake URL>` and the `PLACES_TOKEN` secret to `ocdb-apply`. It takes new places off the intake's recent list once the PR that writes them is merged, and withdrawn ones at once, then sends the intake the contributors in `moderation/blocked_contributors.json` on `main`, so a blocked contributor's new places leave the recent list. It also sends the ids of the items the run decided other than applying them, so a recent change the intake put live for one of them leaves the list, and the ids of the fact and contact reports applied in the last 90 days whose change `main` now holds, with the run's time. `main` is checked out before the run, so a change counts as in the data only at the first run after its PR merged. It then sends every item's progress from the last 90 days (`POST /v1/feedback/progress`), for apps to read with `GET /v1/feedback/progress`. Each change in the data is dated by the last commit on `main` that touched its file (the place file, or the fee, review or do-not-match file), so the workflow fetches the last 14 days of `main`'s history. A file last changed before then is dated by `main`'s last commit. Only items whose progress changed since the last send go to the intake: the inbox keeps the state last sent for each in `progress/sent.json`, so a failed send goes again next run. An item last sent `in_data` or `refused` is final and not sent again. The first run after 00:00 UTC each Monday sends every item of the 90 days. The workflow reads the 100 most recent `feedback/review` and `feedback/auto` PRs before it checks out `main`, so a merge it reads is in that checkout. A held change counts as refused by a reviewer when a merged or closed review PR names it, no open review PR names it and `main` lacks it. An applied change counts the same way when a closed automatic PR names it and no open one does. A call that fails is logged and the run goes on.

With `recent-places-url` set to an intake's base URL, each run passes `--recent-places <url>` to `ocdb-apply`, which reads that intake's public `GET /v1/places/recent`. Feedback about a new place on that list that is not in the data yet waits in `pending/` for a later run instead of being refused, and while the list can't be read, all feedback about places not in the data waits. An app's own photo inbox needs this, see [photos.md](photos.md). Off when empty.

With `release-workflow` set to the data repository's release workflow file (`release.yml`), a run that opened or added to `feedback/auto` waits up to 10 minutes for that PR to merge, then starts the release workflow on `data-base-branch`, so the change reaches apps without waiting for the release's own schedule. A PR without auto-merge, one still waiting after 10 minutes, a missing Actions permission or a failed start leaves the change to the release's schedule, with a notice or warning on the run, and never fails it. The release workflow must run on `workflow_dispatch`. Off when empty.

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
