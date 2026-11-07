# Run a photo service for your app

Open Camping DB holds no photos. This kit lets an app run its own photo service, so its travellers can add photos of Open Camping DB places, on the app's own Cloudflare account and GitHub repositories, under the app's own terms and licence:

| Part | What it does |
|---|---|
| `createPhotoClient` in the SDK | Uploads photos, gets photo passes, reports photos and erases a traveller's photos. Kept apart from the feedback client. |
| The intake (`packages/intake`) with a photo bucket | `POST /v1/photos` takes uploads into a private pending bucket, and `POST /v1/photos/pass` gives attested installs an hour-long photo pass. Optional SafeSearch checks. |
| The photo server (`packages/photos`) | Serves published photos and each place's photo records to installs with a pass and servers with a key, behind the edge cache, with daily caps and an off switch. |
| The apply rules, photos only (`ocdb-apply --places`) | Turn the inbox into photo lines in the app's records repository. A contributor's first photo goes to a person on a review PR. |
| `ocdb-photos` and the Photo sync workflow | Check the records repository's photo lines, and keep the two buckets and the per-place records in step with them. |

The app's photo service runs separately from the Open Camping DB intake. The app keeps using `createFeedbackClient` with Open Camping DB's intake for reports, reviews, checks and fees.

## How a photo travels

1. The app sends the photo to its own intake at `POST /v1/photos`. The intake checks the app key, the attestation, the contributor, the rate limits and the files (and SafeSearch, when on), puts the files in the pending bucket and writes the item to the app's private inbox repository.
2. The hourly apply run adds a line to `photos/<place id>.ndjson` in the app's records repository. A contributor's first photo, a file also sent for another place, and anything SafeSearch flags go to a person on the review PR. Once a contributor has a visible photo, their later photos are published at the next run.
3. When the PR merges, the Photo sync workflow copies the files to the serving bucket and writes `records/<place id>.ndjson`.
4. The photo server serves the photo and lists it in the place's records.

Nothing about a photo is public until step 3. A refused photo's files are deleted.

### Photos of new places

A traveller can photograph a new place minutes after it was added, before it is in Open Camping DB's data. The photo inbox never sees the new place's own report, so without help the apply run refuses the photo with "place ocdb_... is not in the data". Set `recent-places-url` on the Apply feedback workflow to the base URL of the intake that serves the recent list (Open Camping DB's intake), and the run passes `--recent-places <url>` to `ocdb-apply`. It then reads `GET <url>/v1/places/recent`, which needs no token, and:

| The photo's place | What happens |
|---|---|
| In the data | The usual rules. |
| On the recent list, not in the data yet | The photo waits in `pending/` with the reason "place ... is a new place not in the data yet", and is tried again each run. |
| On neither, for example a withdrawn or hidden new place | Refused, as without the option. |
| Not in the data, and the recent list can't be read | The photo waits, so a short intake outage refuses nothing. |

A photo still waiting 90 days after it arrived is refused. The run asks for the recent list only when something in `pending/` is about a place not in the data. Photo reports work the same way. Without `recent-places-url` the run refuses these photos as before.

## Send a photo

```ts
import { createPhotoClient } from "@opencampingdb/feedback";

const photos = createPhotoClient({
  endpoint: "https://photos-upload.example.com", // your photo intake
  appKey: "your-photo-app-key",
  appVersion: "1.4.0",
  storage: AsyncStorage,
  attest, // App Attest or Play Integrity, as for feedback
});

// After the traveller agrees to your photo terms:
const result = await photos.photo({ place, contributor, consent: true, full, thumb });
```

Write your own photo terms and show them, with an agree button, before the first photo is sent. Say who took the photo, who appears in it, which licence it is shared under, how it is credited and how a traveller removes their photos. For example: "You took this photo yourself. It shows the place: people's faces and number plates are not its subject, and anyone you can recognise in it agreed to it being shared. You keep the copyright and share it under CC BY 4.0. Delete your account to remove all your photos."

Make two JPEGs on the phone, with the EXIF data (location, camera, time) removed: a full size one about 1600 pixels on the long side (at most 1.5 MB, about 400 KB is typical) and a thumbnail about 400 pixels (at most 200 KB). Photos need the signed-in traveller's contributor id.

`full` and `thumb` are the file bytes, as an `ArrayBuffer` or `Uint8Array`. The result is one of:

| Result | Meaning |
|---|---|
| `{ status: "sent", id }` | The intake has it. `id` is the photo's id, `pho_<ulid>`. |
| `{ status: "rejected", httpStatus, error }` | The intake refused it. `error` says why, for example `rate_limited`, `not_jpeg`, `sha256_mismatch`, `attestation_invalid` or `photo_not_allowed` (SafeSearch). |
| `{ status: "offline" }` | The intake could not be reached, or the platform could not attest. Nothing was sent. |

Photos are never queued, because the files are too big for the queue's storage. On `offline`, keep the files and call `photo` again later.

### A photo of a place the traveller has just added

A place the traveller has just added has no id until its `new_place` report is sent. Its photos can wait in the SDK. Give the `new_place` report a `ref` (see the integration guide, section 5), and give the photo client the feedback client's `newPlace`, a loader for your files and a callback:

```ts
const photos = createPhotoClient({
  // ...as above...
  resolveNewPlace: feedback.newPlace, // where the new place stands
  loadPhoto: async (key) => readMyFiles(key), // { full, thumb }, or null when gone
  onPhotoSettled: async ({ key, outcome }) => deleteMyFiles(key), // uploaded or dropped
});

const result = await photos.photo({ place: { newPlace: "draft-7" }, key: "photo-123", contributor, consent: true, full, thumb });
// { status: "waiting" } until the new place is sent
```

- While the new place waits, `photo` answers `{ status: "waiting" }`. The client keeps only a small record (`key`, the ref, the contributor and the time) in storage. Your app keeps the files under `key`.
- Each `photos.flush()` uploads the waiting photos whose new place has been sent, in the order they were taken, under its `ocdb_` id, and calls `onPhotoSettled` with `{ status: "sent", id, place }`. Call it when the app comes to the foreground and after the feedback client sends.
- A photo that can't go now (offline, rate limited, the service busy, a refused assertion) stays for the next flush, without holding up the others.
- A photo is dropped, with `onPhotoSettled` saying why:
  - `new_place_dropped`: the new place was dropped or refused;
  - `photo_missing`: `loadPhoto` gave `null`;
  - `rejected`: the photo service refused it, with `httpStatus` and `error`;
  - `expired`: it waited longer than `maxQueueAgeMs`.
- If the new place was sent already, `photo` uploads at once. If it was dropped, or the ref names no new place, `photo` throws `FeedbackValidationError`.
- Waiting photos survive the app restarting. The client checks that both files are JPEGs within the size limits before sending and throws `FeedbackValidationError` if not.

On the wire, the SDK sends the photo's meta (place, contributor, device, app version, consent and the SHA-256 and size of each file) as base64url JSON in the `x-photo-meta` header, and the full size file followed by the thumbnail as the body. Attestation covers the meta text, so the intake can check the files against the hashes it carries.

Each contributor may send 10 photos a day, as well as the usual limits per device, network and app key.

### SafeSearch

With `SAFESEARCH = "on"`, the intake sends each full size file to Google Cloud Vision SafeSearch before keeping it, after the rate limits, as the service account in its `GOOGLE_SERVICE_ACCOUNT` secret. SafeSearch rates five kinds of content from `VERY_UNLIKELY` to `VERY_LIKELY`: adult, violence, racy, medical and spoof. It has no self-harm rating, so that stays with the person who checks first photos, and with reports.

| Ratings | What happens |
|---|---|
| adult or violence `VERY_LIKELY` | Refused: `422 photo_not_allowed`. Nothing is kept. |
| adult or violence `LIKELY`, or racy `VERY_LIKELY` | Kept, and held for a person even from a trusted contributor. |
| Google can't be asked, or answers with an error | Kept as `"unchecked"`, and held for a person. |
| Anything else | The usual rules. |

The stored item carries the ratings in `photo.safesearch`, and the review PR note says why a photo was held. The rule is `safeSearchVerdict` in the SDK, shared by the intake and apply.

Google processes these requests in memory, doesn't keep the images, and doesn't train on them ([Cloud Vision data usage](https://cloud.google.com/vision/docs/data-usage)). Name Google Cloud Vision as a processor in your privacy policy before turning it on. The [pricing page](https://cloud.google.com/vision/pricing) lists SafeSearch at the first 1,000 images a month free, then $1.50 per 1,000.

## What became of a photo

Each upload gets a progress record under the photo id it answered, so the app can show a traveller's photos with where each one is. Ask with `photos.progress(ids)`, which calls the photo intake's public `GET /v1/photos/progress?ids=pho_...,pho_...` at once, in calls of up to 100 ids, and answers one `Progress` per id in the order given, the same shape `feedback.progress` answers. An id that is not a photo id is answered `unknown` without asking. It throws `ProgressRequestError` when the photo intake cannot be reached or refuses the call.

```ts
const progress = await photos.progress(myPhotos.map((p) => p.id)); // pho_ ids, one answer each
for (const p of progress) {
  if (p.state === "in_data") showPublished(p.id);
  else if (p.state === "refused") showRemoved(p.id, p.reason);
  else showWaiting(p.id, p.state, p.held_reason);
}
```

| State | What it means |
| --- | --- |
| `received` | The photo intake has it, and the apply has not decided it yet. |
| `waiting` | Its place is a new place not in the data yet. |
| `accepted` | The rules accepted it, and it is on the automatic PR, which has not merged yet. |
| `held` | A person decides it, with `held_reason`: `first_photo` (a contributor's first photo), `same_file` (the same file was sent for another place), `safesearch` (SafeSearch rated it likely adult or violent, or very likely racy), `check_unavailable` (SafeSearch could not check it) or `reported` (hidden after reports, until a person decides). A photo SafeSearch flags is `held` from the moment it is uploaded. |
| `refused` | Not published, or no longer, with `reason`. `by` is `rules` when the rules refused it or the contributor asked for their photos to be removed, and `reviewer` when a person merged or closed its PR without it, hid it, removed it or blocked the contributor. |
| `in_data` | Published: its line is in the photo records on the records repository's `main`, as of `in_data_at`, the time of the commit that put it there. The Photo sync workflow serves it a few minutes later. |
| `unknown` | The photo intake has no record of it: not uploaded to it, or more than 90 days without a change. |

Unlike feedback, a published photo can leave `in_data`: reports that hide it make it `held` with `reported`, and a person who removes it makes it `refused`. A photo SafeSearch refuses at upload never gets an id or a record: the upload answers `422 photo_not_allowed`, and that answer is the app's only word on it.

The records are kept in the photo intake's D1 database (the `item_progress` table, which feedback progress also uses), read from D1 only, and written by the photo apply run only when a photo's state changes, as recorded in `progress/photos-sent.json` in the inbox (every photo is sent again on the first run after 00:00 UTC each Monday). Each update carries the time of the run that sent it, and the photo intake refuses one from a run older than the run that last wrote the record, so two runs that overlap can't move a photo back to where the older one saw it. A record carries only the state, the engine's reason, `held_reason`, `by`, the place and times, never the contributor or a device. The apply follows photos decided in the last 90 days, and a record is kept for 90 days after it last changes.

Photo reports and erasures get records too, under the feedback id their send answered, which the app reads with `GET /v1/feedback/progress?ids=fb_...` on the photo intake. A report is `held` while a person reads it, `in_data` once the records repository's `main` no longer shows the photo (hidden, removed, or its contributor blocked), and `refused` by the reviewer when the person kept it. An erasure is `accepted` until `main` holds none of the contributor's photos, then `in_data`, and `refused` by the reviewer when its automatic PR was closed without merging. Either is `refused` by the rules with their reason, such as a report of a photo not in the records.

## Report and remove

Give each photo a Report action:

```ts
import { PHOTO_REPORT_REASONS } from "@opencampingdb/feedback";
// spam_ad, offensive, off_topic, not_this_place, personal_details, copyright, illegal

await photos.reportPhoto({ place, photo: "pho_01JC...", reason: "personal_details", contributor, consent: true });
```

Every report goes to a person on the review PR. Reports from three different contributors hide the photo at the next apply run, until the person decides. Hide a photo the traveller reported on their own phone straight away.

`illegal` is for child sexual abuse material, an intimate image shared without consent, or terrorist or violent extremist material. One such report is enough:

- The intake puts `withheld:<photo id>` in the photo server's state namespace (bound to the intake as `PHOTO_STATE`). The photo server checks that list before its cache, so the photo stops being served within about two minutes, everywhere.
- The next apply run hides the photo's line and marks the note on the review PR URGENT.
- A person then follows your safety procedure. Deleting the `withheld:` key serves the photo again if the report was wrong.

Before deleting a traveller's account, remove their photos:

```ts
await photos.erasePhotos({ contributor, consent: true });
```

The next apply run takes every photo from that contributor out of the records, and the Photo sync workflow deletes their files from both buckets. Photos they send later in the same run are refused.

A person can hide a photo by setting `"hidden": "moderator"` on its line, or delete it for good by taking the line out and adding its id to `moderation/removed_photos.json` with the reason `moderator`. Use this for a copyright complaint or a photo showing a person who did not agree to it. A photo leaves the edge cache within 24 hours of leaving the bucket, so withhold it first when it must stop sooner, for example on a regulator's removal notice:

```bash
npx wrangler kv key put --binding STATE "withheld:pho_01JC..." '{"by":"moderator","reason":"removal notice"}'
```

Run it with your photo server's configuration. The photo stops within about two minutes, cache or not.

## Show photos

An app on a phone loads photos with a photo pass, never with a fixed key: anything built into an app can be read out of it. The intake gives a pass only to an install that proves itself with App Attest or Play Integrity, and a pass works for an hour.

```ts
const pass = await photos.photoPass();
if (pass.status === "ok") {
  // Send pass.pass in the x-photo-pass header of every photo request.
}
```

`photoPass` keeps the pass in memory and asks for a new one when less than five minutes are left, so call it before each photo request. After `401 invalid_pass`, call `photoPass({ renew: true })` and try once more. It needs an app key with `requires_attestation`. Otherwise the intake answers `403 attestation_not_required_for_app_key`.

Simulators cannot attest. For development builds, set `photo_pass_unattested: true` on a separate development app key, give that key an app name of its own (for example `example-app-dev`), and give that name a small `daily_limit` in `PHOTO_KEYS`, such as 2000. Anyone who reads the development key out of a development build can then use at most that much. Never put the development key in a store build.

```
GET https://photos.example.com/v1/places/<place id>/photos.ndjson
GET https://photos.example.com/v1/photos/<id>/full.jpg
GET https://photos.example.com/v1/photos/<id>/thumb.jpg
X-Photo-Pass: <pass>
```

A place's records list its visible photos, one JSON line each: `id`, `place`, `contributor`, `created`, `app`, `licence`, `width`, `height` and `sha256`. A place without photos answers an empty list. Records are cached for five minutes and photos for a day, at the edge and on the phone.

A server that shows photos can use a photo key in `X-App-Key` instead, since it can keep the key secret. Never put a photo key in an app. Credit each photo shown in the way your photo terms say.

| Status | Meaning |
|---|---|
| `200` | the JPEG, or the records |
| `401 invalid_pass` | the pass is altered or has expired. Get a new one with `photoPass({ renew: true })` |
| `401 invalid_app_key` | no pass, and a missing or unknown photo key |
| `404 not_found` | no such photo, it is no longer published, or it is withheld |
| `429 rate_limited` | too many requests from one address: 300 a minute |
| `503 daily_read_cap` | the app's daily read limit, or the server's, is reached. `retry-after` says when it resets, at midnight UTC |
| `503 paused` | serving is switched off |

## Set it up

You need a Cloudflare account with a zone for the photo hosts, a GitHub account or organisation, and this repository cloned. Name every resource with one prefix for your app, so it is clear what belongs to the service.

1. **Repositories.** Create two private repositories under one owner: a records repository (for example `example-app-photos`) and an inbox repository (`example-app-photos-inbox`), each with a `README.md` on `main`. Add `moderation/blocked_contributors.json` holding `{"contributors": []}` to the records repository.
2. **GitHub App.** Create a GitHub App for the service with repository permissions Contents (read and write) and Pull requests (read and write), no webhook, installable only on your account. Install it on the two repositories only. Its key goes in the inbox repository's Actions secrets and in the intake's `GH_APP_PRIVATE_KEY` secret.
3. **Buckets.** In R2, create a serving bucket and a pending bucket. Leave both private: neither gets public access or an r2.dev address. On the pending bucket, add a lifecycle rule that deletes objects with the prefix `pho_` 180 days after upload. Files under `kept/` are kept.
4. **KV.** Create a namespace for the photo server's state (the off switch, read counters and withheld photos), and the intake's rate limit and attestation namespaces as in [self-hosting.md](self-hosting.md).
5. **Intake.** Deploy `packages/intake` under its own Worker name with its own configuration, as [self-hosting.md](self-hosting.md) describes, plus: the pending bucket as `PHOTOS_PENDING`, the photo server's state namespace as `PHOTO_STATE`, `INBOX_REPO` set to your inbox repository, a custom domain for uploads, a D1 database as `RECENT_LIST` with the migrations applied, so the daily counters are in D1 and a minute's photos reach the inbox as one commit, and optionally `SAFESEARCH = "on"` with a `GOOGLE_SERVICE_ACCOUNT` that has the Cloud Vision API.
6. **Pass secret and photo keys.** Make one long random secret, for example with `openssl rand -base64 48`, and set it as `PHOTO_PASS_SECRET` on both Workers. Set `PHOTO_KEYS` on the photo server, with JSON such as `{"<random key, 32 characters>": {"app": "example-app", "daily_limit": 100000}}`. The entry gives the app's daily limit to its passes as well. `daily_limit` counts the reads that reach R2, not those served from the cache. `DAILY_READ_CAP` caps all apps together. Changing `PHOTO_PASS_SECRET` on both Workers ends every pass at once.
7. **Photo server.** Set `routes` in `packages/photos/wrangler.toml` (or an untracked deploy copy) to your photo host on a custom domain, bind the serving bucket as `PHOTOS` and the state namespace as `STATE`, and deploy. Serving only on the custom domain puts the edge cache in front of R2.
8. **Workflows.** In the inbox repository, call the Apply feedback workflow hourly with `data-repository-name` set to your records repository, `places-repository: opencampingdb/data`, your `photo-licence` and `recent-places-url` set to Open Camping DB's intake, passing the GitHub App's client id and key. For photo progress, also set `intake-url` to your photo intake and pass its `PLACES_TOKEN` (a long random secret you set on the photo intake) as the `places-token` secret: each run then sends the photo intake where each photo is, and nothing else. Turn on **Allow auto-merge** (`allow_auto_merge`) in the records repository's settings, under General, Pull Requests, and protect `main` with a required status check, so the automatic PR merges itself once CI passes. Without it, photos from trusted contributors are never published until someone merges the automatic PR: the run says on the PR that it needs merging by hand and shows an error annotation naming the repository and the setting, without failing, so the inbox moves are still recorded. In the records repository, call the Photo sync workflow on each push to `main` and once a day, with your bucket names and an R2 API token (Object Read and Write on both buckets) as `r2-account-id`, `r2-access-key-id` and `r2-secret-access-key`. Pin both to a feedback-engine commit.
9. **Check it.** Upload a test photo from a development build, merge the review PR, wait for the sync, then load the place's records and the photo with a pass. Report it as `illegal` and see it withheld, then erase it and see it gone.

To stop serving at once, put the key `off` in the photo server's state namespace: the server answers `503 paused` within a minute. Delete the key to start again. Removing the custom domain also stops all serving.

R2 bills each read that reaches it. The edge cache, the per-address limit, the daily caps and the off switch keep that bill bounded. Cloudflare's budget alerts only warn and never stop anything, so set the caps to what you are willing to pay for.
