# @opencampingdb/feedback

Client for sending reports, reviews, checks, fees and photos about places in Open Camping DB. Works in React Native, Expo and the browser, with no dependencies.

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createFeedbackClient, CONSENT_TEXT, ATTRIBUTION } from "@opencampingdb/feedback";

const feedback = createFeedbackClient({ endpoint, appKey, appVersion: "1.0.0", storage: AsyncStorage });
await feedback.review({ place, review: { stars: 5, text: "Quiet and shady", visited: "2026-10" }, consent: true });
```

- Submissions are validated, queued in the storage you pass and retried with backoff. Network errors, 429 and 5xx keep an item; 400 and 401 drop it.
- A random per-install device id is made once and kept in storage.
- Nothing is sent unless `consent: true` is passed. Show `CONSENT_TEXT` first.
- Show `ATTRIBUTION` wherever the data appears.
- Reviews, fees and `reportReview()` carry the signed-in traveller's opaque `contributor` id. Pass an `attest` function when the app key requires App Attest or Play Integrity; it gets the exact body and its SHA-256 at send time. A refused assertion keeps the item queued and calls `onAttestationRejected` (see below).
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

The full guide is [docs/integration.md](../../docs/integration.md). Licence: Apache 2.0.
