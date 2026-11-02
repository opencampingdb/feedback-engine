# Photos

Travellers can add photos of a place. Each photo is the traveller's own work, licensed to everyone under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Its record goes into `opencampingdb/data` like a review, and the files are served by the photo server to apps with a key.

## How a photo travels

1. The app sends the photo to the intake at `POST /v1/photos`. The intake checks the app key, the attestation, the contributor, the rate limits and the files, puts the files in the private `ocdb-photos-pending` bucket and writes the item to the inbox.
2. The apply rules add a line to `photos/<place id>.ndjson`. A contributor's first photo, or a file also sent for another place, goes to a person on the review PR. Once a contributor has a visible photo, their later photos are published at the next apply run.
3. When the PR with the line merges, the data repository's Photos workflow copies the files to the `ocdb-photos` bucket.
4. The next release lists the photo in `photos.ndjson.gz`, and the photo server serves it.

Nothing about a photo is public until step 3. A refused photo's files are deleted.

## Send a photo

Make two JPEGs on the phone, with the EXIF data (location, camera, time) removed: a full size one about 1600 pixels on the long side (at most 1.5 MB, about 400 KB is typical) and a thumbnail about 400 pixels (at most 200 KB). Photos need the signed-in traveller's contributor id.

```ts
import { PHOTO_CONSENT_TEXT } from "@opencampingdb/feedback";

// After the traveller agrees to CONSENT_TEXT and PHOTO_CONSENT_TEXT:
const result = await feedback.photo({ place, contributor, consent: true, full, thumb });
```

`full` and `thumb` are the file bytes, as an `ArrayBuffer` or `Uint8Array`. The result is one of:

| Result | Meaning |
|---|---|
| `{ status: "sent", id }` | The intake has it. `id` is the photo's id, `pho_<ulid>`. |
| `{ status: "rejected", httpStatus, error }` | The intake refused it. `error` says why, for example `rate_limited`, `not_jpeg`, `sha256_mismatch` or `attestation_invalid`. |
| `{ status: "offline" }` | The intake could not be reached, or the platform could not attest. Nothing was sent. |

Photos are never queued, because the files are too big for the queue's storage. On `offline`, keep the files and call `photo` again later. The client checks that both files are JPEGs within the size limits before sending and throws `FeedbackValidationError` if not.

On the wire, the SDK sends the photo's meta (place, contributor, device, app version, consent and the SHA-256 and size of each file) as base64url JSON in the `x-photo-meta` header, and the full size file followed by the thumbnail as the body. Attestation covers the meta text, so the intake can check the files against the hashes it carries.

Each contributor may send 10 photos a day, as well as the usual limits per device, network and app key.

## Report and remove

Give each photo a Report action:

```ts
import { PHOTO_REPORT_REASONS } from "@opencampingdb/feedback";
// spam_ad, offensive, off_topic, not_this_place, personal_details, copyright

await feedback.reportPhoto({ place, photo: "pho_01JC...", reason: "personal_details", contributor, consent: true });
```

Every report goes to a person on the review PR. Reports from three different contributors hide the photo at the next apply run, until the person decides. Hide a photo the traveller reported on their own phone straight away.

Before deleting a traveller's account, remove their photos:

```ts
await feedback.erasePhotos({ contributor, consent: true });
```

The next apply run takes every photo from that contributor out of the data, and the Photos workflow deletes their files from both buckets. Photos they send later in the same run are refused.

A person can hide a photo by setting `"hidden": "moderator"` on its line, or delete it for good by taking the line out and adding its id to `moderation/removed_photos.json` with the reason `moderator`. Use this for a copyright complaint or a photo showing a person who did not agree to it. A photo leaves the photo server's cache within 24 hours of leaving the bucket.

## Show a photo

An app on a phone shows photos with a photo pass, never with a fixed key: anything built into an app can be read out of it. The intake gives a pass only to an install that proves itself with App Attest or Play Integrity, and a pass works for an hour.

```ts
const pass = await feedback.photoPass();
if (pass.status === "ok") {
  // Send pass.pass in the x-photo-pass header of every photo request.
}
```

`photoPass` keeps the pass in memory and asks for a new one when less than five minutes are left, so call it before each photo request. It needs an app key with `requires_attestation`. Otherwise the intake answers `403 attestation_not_required_for_app_key`. On `offline`, show placeholders and try again later.

```
GET https://photos.example.com/v1/photos/<id>/full.jpg
GET https://photos.example.com/v1/photos/<id>/thumb.jpg
X-Photo-Pass: <pass>
```

A server that shows photos can use a photo key in `X-App-Key` instead, since it can keep the key secret. Never put a photo key in an app.

Answers are cached for a day, at the edge and on the phone. Credit each photo shown, for example "Photo: Open Camping DB traveller, CC BY 4.0".

| Status | Meaning |
|---|---|
| `200` | the JPEG |
| `401 invalid_pass` | the pass is altered or has expired. Get a new one with `photoPass` |
| `401 invalid_app_key` | no pass, and a missing or unknown photo key |
| `404 not_found` | no such photo, or it is no longer published |
| `429 rate_limited` | too many requests from one address: 300 a minute |
| `503 daily_read_cap` | the app's daily read limit, or the server's, is reached. `retry-after` says when it resets, at midnight UTC |
| `503 paused` | serving is switched off |

## Run the photo storage and server

These steps need the Cloudflare account that runs the intake.

1. **Buckets.** In R2, create `ocdb-photos-pending` and `ocdb-photos`. Leave both private: neither gets public access or an r2.dev address. On `ocdb-photos-pending`, add a lifecycle rule that deletes objects with the prefix `pho_` 180 days after upload. Files under `kept/` are kept.
2. **Intake.** The intake's `wrangler.toml` binds `ocdb-photos-pending` as `PHOTOS_PENDING`. Deploy the intake again (see [self-hosting.md](self-hosting.md)). Without the binding, `/v1/photos` answers 404.
3. **KV for the photo server.** Create a namespace, for example `npx wrangler kv namespace create ocdb-photos-state`, and put its id in `packages/photos/wrangler.toml` (or an untracked `wrangler.deploy.toml`, as for the intake).
4. **Pass secret and photo keys.** Make one long random secret, for example with `openssl rand -base64 48`, and set it as `PHOTO_PASS_SECRET` on both Workers: `npx wrangler secret put PHOTO_PASS_SECRET` in `packages/intake` and again in `packages/photos`. Then set `PHOTO_KEYS` in `packages/photos`, with JSON such as `{"<random key, 32 characters>": {"app": "example-app", "daily_limit": 100000}}`. The entry gives the app's daily limit to its passes as well. Its key is only for servers, so Example App never ships it. `daily_limit` counts the reads that reach R2, not those served from the cache. `DAILY_READ_CAP` in `wrangler.toml` caps all apps together. Changing `PHOTO_PASS_SECRET` on both Workers ends every pass at once.
5. **Custom domain.** The `routes` line in `packages/photos/wrangler.toml` names the photo server's host, `photos.example.com`. Its zone, `example.com`, must be in the same Cloudflare account. Wrangler adds the DNS record and certificate on deploy. Change the line to run the server on another host. The photo server is served only there, so the edge cache sits in front of R2.
6. **Deploy** the photo server: `npx wrangler deploy` in `packages/photos`.
7. **Data repository secrets.** Create an R2 API token with Object Read and Write on both buckets, and add `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` as Actions secrets in `opencampingdb/data`. The Photos workflow does nothing without them.

To stop serving at once, run `npx wrangler kv key put --binding STATE off 1` in `packages/photos`: the server answers `503 paused` within a minute. Delete the key to start again. Removing the custom domain also stops all serving.

R2 bills each read that reaches it. The edge cache, the per-address limit, the daily caps and the off switch keep that bill bounded. Cloudflare's budget alerts only warn and never stop anything, so set the caps to what you are willing to pay for.
