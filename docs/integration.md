# Integrating with an Expo app

This guide adds Open Camping DB feedback to an Expo (React Native) app. The same client works on the web with a `localStorage` adapter.

## 1. Get an app key

Email dev@camporacle.com.au with your app's name and roughly how many submissions a day you expect. You get an app key and the intake URL. The key ships inside your app, so it is an identifier with a daily limit, not a secret.

## 2. Install

```sh
npx expo install @react-native-async-storage/async-storage
npm install @opencampingdb/feedback
```

The client needs `crypto.randomUUID` or `crypto.getRandomValues` to make the device id. Expo SDK 52 and later provide them. On older setups, add `react-native-get-random-values` and import it first, or pass your own `randomUUID` option.

## 3. Create one client

```ts
// feedback.ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Application from "expo-application";
import { createFeedbackClient } from "@opencampingdb/feedback";

export const feedback = createFeedbackClient({
  endpoint: "https://feedback.example.org", // the intake URL you were given
  appKey: process.env.EXPO_PUBLIC_OCDB_APP_KEY!,
  appVersion: Application.nativeApplicationVersion ?? "0.0.0",
  storage: AsyncStorage,
});
```

The client keeps its queue and a random device id in storage under keys starting `ocdb.feedback.`.

## 4. Ask for consent

Show `CONSENT_TITLE` and `CONSENT_TEXT` before the first submission, with an agree button. Store the answer yourself and pass `consent: true` only when the user agreed. Without it the client throws `ConsentRequiredError` and sends nothing.

```tsx
import { Alert } from "react-native";
import { CONSENT_TEXT, CONSENT_TITLE } from "@opencampingdb/feedback";

export function askConsent(): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(CONSENT_TITLE, CONSENT_TEXT, [
      { text: "Not now", style: "cancel", onPress: () => resolve(false) },
      { text: "I agree", onPress: () => resolve(true) },
    ]),
  );
}
```

## 5. Send reports, reviews and checks

Each call validates the payload, queues it and tries to send it. The result says what happened:

- `{ status: "sent", id }` when the intake accepted it.
- `{ status: "queued" }` when the device is offline, rate limited or the intake is busy. It is sent later.
- `{ status: "rejected", httpStatus }` when the intake refused it (400 or 401). It is dropped.

An invalid payload throws `FeedbackValidationError` with the reasons, before anything is queued.

```ts
const place = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";

// A fact: two devices must agree before it changes.
await feedback.report({
  place,
  report: { kind: "fact", fact: "power", value: true },
  consent: true,
});

// Closed. Use kind "reopened" when it is open again.
await feedback.report({ place, report: { kind: "closed", note: "Gate chained, sign says closed for works" }, consent: true });

// A place that is not in the data yet: place is null and location is required.
await feedback.report({
  place: null,
  location: { lat: -36.851234, lon: 144.551234 },
  report: { kind: "new_place", note: "Free camp beside the creek" },
  consent: true,
});

// A review: 1 to 5 stars, up to 2,000 characters, month of the visit.
await feedback.review({ place, review: { stars: 4, text: "Flat sites, clean toilets.", visited: "2026-10" }, consent: true });

// A check: the user was there and the place still exists (or not).
await feedback.check({ place, check: { visited: "2026-10-30", still_there: true }, consent: true });
```

Facts a report may name: `fee`, `power`, `tents`, `caravans`, `toilets`, `showers`, `drinking_water`, `dump_station` (true or false), `pets` (`yes`, `no`, `leashed`), `access` (`2wd`, `awd`, `4wd`, `unknown`), `entry` (`public`, `customers`, `permit`, `private`), `max_stay` (such as `48h`, `2d`, `1w`), `opening_hours`, `website` (https only) and `phone`. Website and phone changes are checked by a person.

Ask users not to put names, email addresses or phone numbers in notes or reviews. The intake removes contact details it finds, and reviews that still contain personal details are refused.

## 6. Flush when the app comes back

Queued items are retried with backoff from 30 seconds up to 6 hours. Call `flush()` when the app returns to the foreground so a queue built up offline goes out promptly.

```ts
import { useEffect } from "react";
import { AppState } from "react-native";
import { feedback } from "./feedback";

export function useFlushFeedback(): void {
  useEffect(() => {
    void feedback.flush();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void feedback.flush();
    });
    return () => sub.remove();
  }, []);
}
```

Items older than 30 days, or past the 100 newest, are dropped unsent.

## 7. Show the attribution

Wherever Open Camping DB data appears, show `ATTRIBUTION`:

```tsx
import { Text } from "react-native";
import { ATTRIBUTION } from "@opencampingdb/feedback";

<Text style={{ fontSize: 11, opacity: 0.7 }}>{ATTRIBUTION}</Text>;
```

## On the web

Pass a storage adapter over `localStorage`. The intake answers CORS requests from the origins its operator allows.

```ts
const feedback = createFeedbackClient({
  endpoint: "https://feedback.example.org",
  appKey: "your-app-key",
  appVersion: "1.0.0",
  storage: {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: (k) => localStorage.removeItem(k),
  },
});
```
