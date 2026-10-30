# @opencampingdb/feedback

Client for sending reports, reviews and checks about places in Open Camping DB. Works in React Native, Expo and the browser, with no dependencies.

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

The full guide is [docs/integration.md](../../docs/integration.md). Licence: Apache 2.0.
