# @opencampingdb/feedback

Client for sending reports, reviews, checks, fees and photos about places in Open Camping DB. Works in React Native, Expo and the browser, with no dependencies.

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createFeedbackClient, CONSENT_TEXT, ATTRIBUTION } from "@opencampingdb/feedback";

const feedback = createFeedbackClient({ endpoint, appKey, appVersion: "1.0.0", storage: AsyncStorage });
await feedback.review({ place, review: { stars: 5, text: "Quiet and shady", visited: "2026-10" }, consent: true });
```

- Submissions are validated, queued in the storage you pass and retried with backoff. Network errors, 429 and 5xx keep an item; 400 and 401 drop it.
- `flush()` sends due items together, up to `maxBatchSize` (1 to 50, default 50) in one `POST /v1/feedback/batch` with one `attest` call over the batch body, so an Android app spends one Play Integrity token a batch, not one an item (Google's default is 10,000 requests a day across all installs). Each item is answered and settled as it would be alone; a whole-batch failure keeps every item. One due item goes alone to `POST /v1/feedback`, and an intake without the batch route (404 or 405) is sent one item at a time. See docs/integration.md, "Batches".
- A random per-install device id is made once and kept in storage.
- Nothing is sent unless `consent: true` is passed. Show `CONSENT_TEXT` first.
- Show `ATTRIBUTION` wherever the data appears.
- Reviews, fees and `reportReview()` carry the signed-in traveller's opaque `contributor` id. Pass an `attest` function when the app key requires App Attest or Play Integrity; it gets the exact body and its SHA-256 at send time. A refused assertion keeps the item queued and calls `onAttestationRejected` (see below).
- Photos of a new place can wait for its id too: give the photo client `resolveNewPlace: feedback.newPlace`, `loadPhoto` and `onPhotoSettled`, and call `photos.photo({ place: { newPlace }, key, ... })`. See docs/photos.md.
- A place the traveller has just added can be named before its id is known, as `{ newPlace: <the new_place report's ref> }`, in `report`, `reportFacts`, `check`, `fee` and `review`. The items wait in the queue, unsent, until the new place is sent, then go with its `ocdb_` id in order. They're dropped with `reason: "new_place_dropped"` if it is dropped or refused.
- `reportFacts({ place, facts, consent })` sends a traveller's edit of one place, every fact they set, in one call, and resolves with each fact's result. The intake counts an install's reports about one place in a day once against its daily limits.
- Facts include `pets_months` (an OSM month range such as `May-Sep`, read with `monthsInRange`) and `vehicle_access` (`heavy_vehicles_only`). A `commons_mismatch` report says a Wikimedia Commons photo shown for a place is not of it.
- `progress(ids)` says what became of each contribution, by the id the intake answered when it was sent: `received`, `live`, `waiting`, `accepted`, `held`, `refused` (with `reason` and `by`), `in_data` (with `in_data_at`) or `unknown` (`PROGRESS_STATES`). `progressInRelease(progress, dataVersion)` says whether the app's data release has the change. See docs/integration.md, "What became of a contribution".
- `photos.progress(ids)` on the photo client answers the same way for photos, by the `pho_` id the upload answered, from the app's photo intake (`GET /v1/photos/progress`): `received`, `waiting`, `accepted`, `held` (with `held_reason`, one of `PHOTO_HELD_REASONS`), `refused`, `in_data` (published) or `unknown`. A published photo can go back to `held` when reports hide it, or to `refused` when it is removed. See docs/photos.md, "What became of a photo".
- `createReleaseUpdater({ adapter, readableLayouts, gunzip })` keeps the app's copy of the release database (`ocdb.sqlite.gz`) current: `update({ knownDataVersion })` applies the manifest's changesets in order, or downloads the whole database with none, across a layout change, with no chain or past 50 files, checks every download's size and SHA-256, and never moves to a layout the build can't read. It answers `up_to_date`, `updated`, `replaced`, `layout_unsupported` or `failed` (with a `reason`), and the release the database is on. A failure leaves the database on a whole release. The adapter is four calls over the app's SQLite library. Ask at most once an hour, and only when the recent list's `release` is newer. Pass `gunzip` where there is no `DecompressionStream`, as in React Native. See docs/integration.md, "Keeping the data current", for keeping the traveller's own data in tables apart from the release and a worked Expo SQLite adapter.
- `tidyName`, `tidyText` and `textProblem` tidy what a traveller types and find rude words, contact details and spam before it is sent. `withdraw()` takes back a new place the same install sent.

## Refused assertion

When the intake refuses an item's proof it answers `401` with `attestation_required` (no proof was sent) or `attestation_invalid`. For `attestation_invalid` it also sends a `reason` code and readable `details`, and the client passes both to your hook. The item stays queued either way. A `503 unavailable` is a storage error at the intake, not a refusal: the item waits, the hook is not called and the key is kept.

```ts
import { keyIsUnusable } from "@opencampingdb/feedback";

const feedback = createFeedbackClient({
  // ...
  onAttestationRejected: async (error, refusal) => {
    report(error, refusal?.reason, refusal?.details);
    if (keyIsUnusable(refusal?.reason)) await dropStoredKey(); // register a new key before the next try
  },
});
```

A hook written for one argument still works. `keyIsUnusable(reason)` is the one rule for dropping the key: it is true only for the codes marked below, and false when there is no reason. Every other refusal keeps the key, so it does not spend one of the network's daily key registrations.

| `reason` | Meaning | Drops the key |
| --- | --- | --- |
| `unknown_key` | The intake has no registered key with this id. | Yes |
| `wrong_app` | The key is registered for another app key. | Yes |
| `bad_signature` | The assertion's signature does not verify against the registered key over this body. | Yes |
| `counter_not_increased` | The assertion's counter is not above the last one seen, as with a replay or a send that arrived out of order. | No |
| `category_not_accepted` | The build's launch category is not accepted for this app key's environment. | No |
| `malformed` | The proof could not be read. | No |
| `integrity_not_met` | Android: the Play Integrity verdict falls short of what the app key requires. | No |

Key registration refusals use the same codes. Registration also answers `malformed` for an unknown or used challenge (`401`) and for a key that is already registered (`409`), `counter_not_increased` when a new key's counter is not 0, and `category_not_accepted` when the key is not from this app key's environment. The reason type is exported as `RefusalReason`, and the second argument of the hook as `AttestationRefusal`. Adding a code later is additive; a code this version does not know is left out of `reason`, and its `details` still reach the hook.

## What is queued, and connecting answers to your records

The client normalises a submission before it queues it, so the queue can hold something other than what you passed in. A location is rounded to 6 decimal places (`sdkCoordinate`), and names are trimmed. To keep exactly what was queued, tidy the traveller's words with `tidyName` and `tidyText` before you submit them, round with `sdkCoordinate`, and store those values. Never match an answer to your own record by comparing content: a value you held before normalising will not match.

A new place's id arrives only to the send that carried it. When the place is sent at once, `report()` answers `{ status: "sent", id }`. When it was queued, the id comes back later to whichever `flush()` sends it, and `flush()` itself returns only counts.

To connect answers to your records, give each submission a `ref` of your own (1 to 100 characters, such as your record's id) and pass `onAnswered`. The client keeps `ref` with the queued item and never sends it to the intake. `onAnswered` is called once for each queued item when it is settled, whether by the call that submitted it or by a later flush, after the queue is saved:

```ts
import type { Answer } from "@opencampingdb/feedback";

const feedback = createFeedbackClient({
  // ...
  onAnswered: async ({ ref, type, outcome }: Answer) => {
    if (!ref) return; // items queued before 0.8.0 have no ref
    if (outcome.kind === "sent") {
      await markSent(ref, type, outcome.id); // for a new place, newPlaceId(outcome.id) is its place id
    } else {
      await markDropped(ref, outcome.httpStatus); // 0 when it grew too old or the queue was full
    }
  },
});

await feedback.report({ place: null, location, report: { kind: "new_place", name }, consent: true, ref: draft.id });
```

`outcome` is `{ kind: "sent", id, state?, heldReason? }` or `{ kind: "dropped", httpStatus }`. On a fact report, contact report, doubt or new place, `state` is `live` when the change shows at once on the recent list, or `held` when it waits for a reviewer, with `heldReason`, one of `HELD_REASONS` (absent for a code this version does not know). A `commons_mismatch` report is always `held` (`commons_report`): hide the photo for that traveller at once. Other items, and items sent to an intake from before 0.10.0, have neither. `httpStatus` is the intake's refusal, or 0 when the client dropped the item unsent because it was older than `maxQueueAgeMs` or pushed out past `maxQueueLength`. An item still waiting to be retried has no answer yet. Errors thrown by the hook are caught and never stop the queue. `ref` works on every call that queues: `report`, `review`, `check`, `fee`, `reportReview`, `withdraw`, and on the photo client `reportPhoto` and `erasePhotos`. Owner requests and photo uploads are sent at once and answer directly, so they take no `ref`.

## Recent changes

`GET /v1/places/recent` on the intake answers a `RecentList`: new places not yet in a release, and `changes`, the changes to released places that went live. Lay them over a release place record with `withRecentChanges(place, changes, dataVersion)`, passing the `data_version` of the release you have. A change with `value` null takes the fact off. Changes the release already has, those whose `in_data_at` is earlier than the commit time at the front of `dataVersion` (`dataVersionTime` reads it), are skipped. `release`, a `RecentRelease`, names the newest data release the intake was told of, when it has been told of one.

The full guide is [docs/integration.md](../../docs/integration.md). Licence: Apache 2.0.

## Versions

A patch version (0.14.1) is a fix or a small change to an existing call. A minor version (0.15.0) adds a call, option, field or type, and before 1.0.0 also marks a breaking change, which its release notes spell out.
