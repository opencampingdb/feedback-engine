# @opencampingdb/feedback

Client for sending reports, reviews, checks and photos about places in Open Camping DB, and for keeping an app's copy of the data current. Works in React Native, Expo and the browser, with no dependencies.

It isn't published to npm: build and pack it from this repository, as [docs/integration.md](../../docs/integration.md#2-install) shows, and install the package file. The full guide, with a quick start, is [docs/integration.md](../../docs/integration.md).

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createFeedbackClient } from "@opencampingdb/feedback";

const feedback = createFeedbackClient({
  endpoint: "https://feedback.example.org",
  appKey: "your-app-key",
  appVersion: "1.0.0",
  storage: AsyncStorage,
});

// After the traveller agreed to CONSENT_TEXT:
await feedback.review({ place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA", review: { stars: 5, text: "Quiet and shady", visited: "2026-10" }, contributor, consent: true });
// When the app comes back to the foreground:
await feedback.flush();
```

## What it does

- Nothing is sent unless `consent: true` is passed. Show `CONSENT_TEXT` first, and `ATTRIBUTION` wherever the data appears.
- Every call checks its input first and throws `FeedbackValidationError` (or `ConsentRequiredError`) before anything is queued.
- Submissions are saved in the storage you pass, sent, and retried with backoff. A call answers `sent`, `queued` or `rejected`. Only the intake's own JSON refusal drops an item: offline, a timeout, 408, 429, 5xx and a refused proof keep it.
- Make one client for each storage prefix (`ocdb.feedback` by default) and keep it for the life of the app. The keys under the prefix are private to the SDK and may change in any release.
- `flush()` sends due items in batches of up to 50 (`maxBatchSize`) in one `POST /v1/feedback/batch`, with one `attest` call over each batch, so an Android app spends one Play Integrity token a batch.
- Every send carries an idempotency key that stays the same when the SDK sends an item again, so the intake stores it once.

## Calls

**Feedback client** (`createFeedbackClient(options)`):

| Call | What it does |
| --- | --- |
| `report(input, { wait? })` | A report about a place: a fact, a doubt, a contact, closed or reopened, a new place and the other `REPORT_KINDS`. |
| `reportFacts({ place, facts, first_hand?, ref? }, { wait? })` | A traveller's edit of one place, every fact they set, checked together and sent in one batch. Resolves with each fact's result. |
| `review(input, { wait? })`, `check(input, { wait? })` | A review (1 to 5 stars, text, month of visit, and an optional `contributorProof` from your server) and a check that the place is still there. |
| `reportReview(input)`, `eraseReviews({ contributor })` | Reports a published review, and removes every review a contributor wrote. |
| `withdraw({ place })` | Takes back a new place this install sent, within 24 hours. |
| `ownerClaim`, `ownerListing`, `ownerUpdate` | Owner requests, sent at once and never queued. They throw `OwnerTermsRequiredError` or `OwnerRequestError`. |
| `flush({ ignoreBackoff? })`, `pending()` | Sends due items (or every item, skipping the client's own backoff), and counts what is waiting. |
| `queueSummary()`, `queuedRefs()` | How the queue stands, in counts and times only, and the `ref` of each item still with the SDK. |
| `newPlace(ref)` | Where a new place a `new_place` report's `ref` names stands. |
| `progress(ids)` | What became of each contribution, by the id the intake answered (`PROGRESS_STATES`). Throws `ProgressRequestError`. |

`report`, `reportFacts`, `check` and `review` take `{ wait: false }` to resolve as soon as the input is saved, with the outcome sent to `onAnswered`. A place the traveller has just added can be named as `{ newPlace: <its report's ref> }` in `report`, `reportFacts`, `check` and `review`: the items wait unsent until the new place has its id.

**Photo client** (`createPhotoClient(options)`, for an app's own photo service, [docs/photos.md](../../docs/photos.md)): `photo`, `photoPass`, `reportPhoto`, `removePhoto`, `erasePhotos`, `flush`, `pending`, `queueSummary`, `queuedRefs` and `progress`. `photo` removes the Exif, XMP, IPTC and comment metadata, the multi-picture index and anything after the end of the image from both JPEGs before it uploads them. `stripJpegMetadata(bytes)` does the same for any JPEG, and `jpegMetadata(bytes)` names what a JPEG still carries. Where it meets a segment it can't read, it removes the metadata before that point and keeps the rest.

**Release updater** (`createReleaseUpdater({ adapter, readableLayouts, readableFormats, gunzip?, fetch?, storage? })`): `update({ knownDataVersion })` keeps the app's SQLite copy of the release database current, by a chain of changesets in one transaction or a whole new database. It answers `up_to_date`, `updated`, `replaced`, `older_release`, `layout_unsupported`, `format_unsupported` or `failed` (with a `reason` and a `cause`), and never throws. Data releases are at format 13 and layout 2. See [docs/integration.md](../../docs/integration.md#10-keeping-the-data-current) section 10 for the adapter, a worked Expo SQLite adapter and the phone's peak memory.

**Helpers**: `tidyName`, `tidyText`, `textProblem`, `firstProblem` and `hasLoneSurrogate` for text, `factFreeText` and `FREE_TEXT_FACTS` for the free words in a fact value, `isCommonsFileName` for a `commons_mismatch` report's file, `contactProblem` and `addressProblems` for contacts and addresses, `openingHoursProblem`, `openMonths`, `withOpenMonths` and `withoutOpenMonths` for `opening_hours`, `parseCharge` and `chargeConditions` for charges, `monthsInRange` for `pets_months`, `withRecentChanges`, `dataVersionTime` and `dataVersionProblem` for the recent list and release names, `progressInRelease`, `newPlaceId` and `sdkCoordinate`.

## Options

`endpoint`, `appKey`, `appVersion` and `storage` are required. The others:

- `attest({ body, bodySha256 })` returns the App Attest or Play Integrity headers for an app key that requires them, and `onAttestationRejected(error, refusal?)` hears of a refused proof ([Refused proof](#refused-proof)).
- `onAnswered({ ref, type, outcome })` is called once for each queued item when it is settled, after the queue is saved. Give each submission a `ref` (1 to 100 characters, or 1 to 90 on `reportFacts`) to connect the answer to your own record.
- `onQueueUnreadable({ keptAt })` is called when the stored queue can't be read: its text is moved to `<storagePrefix>.queue.corrupt` and its items are not sent.
- `deviceId` (a UUID) sends a caller's own device id in place of the stored one, for a server with one client per install. It is never written to storage.
- `timeoutMs` (default 30,000) gives up on a request or `attest` call, which then counts as offline.
- `maxQueueLength` (default 100) drops the oldest item past it, but never an erasure (`eraseReviews`, `erasePhotos`, `removePhoto`). `maxQueueAgeMs` (default 30 days) drops older items unsent.
- `maxBatchSize` (1 to 50, default 50), `storagePrefix`, `fetch`, `randomUUID`, `now` and `random`.

## Refused proof

When the intake refuses an item's proof it answers `401` with `attestation_required` (no proof was sent) or `attestation_invalid`. For `attestation_invalid` it also sends a `reason` code and readable `details`, and the client passes both to your hook. The item stays queued either way. A `503 unavailable` is a storage error at the intake, not a refusal: the item waits, the hook is not called and the key is kept.

```ts
import { createFeedbackClient, keyIsUnusable } from "@opencampingdb/feedback";

const feedback = createFeedbackClient({
  ...options,
  onAttestationRejected: async (error, refusal) => {
    report(error, refusal?.reason, refusal?.details);
    if (keyIsUnusable(refusal?.reason)) await dropStoredKey(); // register a new key before the next try
  },
});
```

`keyIsUnusable(reason)` is the one rule for dropping the key: it is true only for the codes marked below, and false when there is no reason. Every other refusal keeps the key, so it does not spend one of the network's daily key registrations. A hook written for one argument still works.

| `reason` | Meaning | Drops the key |
| --- | --- | --- |
| `unknown_key` | The intake has no usable registered key with this id: none was registered, or its record is from before records named the build environment. | Yes |
| `wrong_app` | The key is registered for another app key. | Yes |
| `bad_signature` | The assertion's signature does not verify against the registered key over this body. | Yes |
| `counter_not_increased` | The assertion's counter is not above the last one seen, as with a replay or a send that arrived out of order. | No |
| `category_not_accepted` | The build's launch category is not accepted for this app key's environment. | No |
| `malformed` | The proof could not be read. | No |
| `integrity_not_met` | Android: the Play Integrity verdict falls short of what the app key requires. | No |

Key registration refusals use the same codes. Registration also answers `malformed` for an unknown or used challenge (`401`) and for a key that is already registered (`409`), `counter_not_increased` when a new key's counter is not 0, and `category_not_accepted` when the key is not from this app key's environment. The reason type is exported as `RefusalReason`, and the hook's second argument as `AttestationRefusal`. A code this version does not know is left out of `reason`, and its `details` still reach the hook.

## Versions

A patch version (0.28.1) is a fix or a small change to an existing call. A minor version (0.32.0) adds a call, option, field or type, and before 1.0.0 may also mark a breaking change, which its release notes spell out. [docs/integration.md](../../docs/integration.md#what-changed-by-version), "What changed by version", lists the recent ones.

This is 0.32.0. What an app moving to it needs to know:

- A review can carry a contributor proof (`contributorProof`, action `review`). A review that replaces the contributor's earlier review of a place from another install is held for a person unless the intake checked such a proof.
- `photo()` removes all the metadata listed above, not only Exif and XMP, and `jpegMetadata` is new. A photo service may refuse uploads that still carry metadata, so move every build that uploads photos to this version.
- The release updater refuses a manifest whose `data_version` is not a release name or is dated more than 7 days ahead of the phone's clock (`dataVersionProblem`).
- `jpegMetadata` reads a JPEG whose image data runs to the end of the file, with no end of image marker, as complete, so every file a camera or picker makes passes a photo service's metadata check once `photo()` has cleaned it. A file still `unreadable` after `stripJpegMetadata` is damaged and needs encoding again.
- A Commons file name's length is counted in characters (code points), as the data repository counts it, and `PYTHON_SPACE` is exported.
- An intake asks a batch refused while other batches hold the app's daily count to try again in 60 seconds, not at midnight.
- Texts other than notes, review text and descriptions must be on one line, no text may hold a lone surrogate, and an App Attest key id may be sent in any base64 spelling of its 32 bytes. A key registered under another spelling answers `unknown_key` once, and `keyIsUnusable` says to register a new one.

Licence: Apache 2.0.
