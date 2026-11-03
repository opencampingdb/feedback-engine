# Integrating with an Expo app

This guide adds Open Camping DB feedback to an Expo (React Native) app. The same client works on the web with a `localStorage` adapter.

## 1. Get an app key

Open an issue with the **App key** form in [opencampingdb/feedback-engine](https://github.com/opencampingdb/feedback-engine/issues/new/choose), giving your app's name and roughly how many submissions a day you expect. You get an app key and the intake URL. The key ships inside your app, so it is an identifier with a daily limit, not a secret.

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

The text tells users that accepted changes may also be passed to OpenStreetMap as notes for its mappers to check. Keep that sentence if you write your own wording. [osm.md](osm.md) explains what is sent.

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

## 5. Send reports, reviews, checks and fees

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
  report: { kind: "new_place", name: "Creek Bend Free Camp", note: "Flat ground beside the creek" },
  consent: true,
});

// A review: 1 to 5 stars, up to 2,000 characters, month of the visit, and the
// signed-in traveller's contributor id (section 6).
await feedback.review({
  place,
  review: { stars: 4, text: "Flat sites, clean toilets.", visited: "2026-10", visited_nearby: true },
  contributor,
  consent: true,
});

// A check: the user was there and the place still exists (or not). nearby:
// true when the app saw the phone near the place at the time.
await feedback.check({ place, check: { visited: "2026-10-30", still_there: true, nearby: true }, consent: true });

// A fee: what the traveller paid per night in Australian dollars, the site
// type (FEE_SITES: unpowered, powered, cabin) and the month they paid.
await feedback.fee({ place, fee: { amount: 32.5, site: "powered", paid: "2026-10" }, contributor, consent: true });
```

A fee's `amount` is more than 0 and at most 1,000, with at most 2 decimal places. `paid` is `YYYY-MM`, not in the future and not more than 24 months ago. Fees need `contributor`, like reviews (`400 contributor_required`). They are published at the next apply run in `fees/<place id>.ndjson`, one per contributor per place per site type, a newer one replacing the older. Releases carry the fees paid in the last 24 months.

A check that finds an open place still there sets the record's `last_confirmed` to the time of the next apply run. One check is enough. Checks on a closed or temporarily closed place do not set it.

Facts a report may name:

- `fee` (true, false or `donation`), `caravans` (true, false or `offroad`), `pets` (`yes`, `no`, `leashed`, `seasonal`)
- `power`, `tents`, `toilets`, `showers`, `drinking_water`, `dump_station` and `booking_required` (true or false)
- the site features in `SITE_FEATURES`, each true or false: who can get in (`wheelchair`, `generators`, `motorhomes`, `camper_trailers`, `motorbikes`, `big_rigs`), what is there (`non_drinking_water`, `laundry`, `kitchen`, `bbq`, `drive_through`, `ensuite_sites`, `bins`, `picnic_tables`, `campfires`, `cabins`, `pub`), what to do (`swimming`, `fishing`, `walking_tracks`, `scenery`, `wildlife`, `playground`, `games_room`, `shade`, `cycling_tracks`, `offroad_tracks`, `boat_ramp_nearby`, `near_road`), services (`telstra_signal`, `mobile_signal`, `wifi`, `tv_reception`, `pet_sitting`, `fuel`, `lpg`, `car_wash`, `vehicle_storage`) and warnings (`self_contained_only`, `crocodiles`, `seasonal_closure`, `dangerous_when_wet`, `over_50s`, `nudist`)
- `brand`, one of `BRANDS` (`big4`, `discovery`, `nrma` and the other chains and clubs)
- `access` (`2wd`, `awd`, `4wd`, `unknown`), `entry` (`public`, `customers`, `permit`, `private`), `max_stay` (such as `48h`, `2d`, `1w`), `opening_hours` (with no email address, phone number or link)
- contacts: `website`, `facebook`, `instagram`, `tiktok` and `x` (https only), `phone`, `phone_2` and `email`
- `address`, an object (`PlaceAddress`) with a `street` or, for a rural address, a named `place`, and any of `unit`, `housenumber`, `suburb`, `state` (one of `ADDRESS_STATES`: `NSW`, `VIC`, `QLD`, `SA`, `WA`, `TAS`, `NT`, `ACT`) and `postcode` (four digits)

A fact two devices agree on within 90 days is applied. Contact changes (website, phones, email and social pages) and addresses are checked by a person, even from one report. `booking_url` comes only from the owner.

Three more report kinds let a traveller fix what Edit site covers on other apps. Each goes to a person, who accepts or rejects it on the review PR:

```ts
await feedback.report({ place, report: { kind: "name", value: "Discovery Parks - Lane Cove" }, consent: true });
await feedback.report({ place, report: { kind: "description", value: "Shady riverside sites, close to the train." }, consent: true });
await feedback.report({ place, report: { kind: "kind", place_kind: "caravan_park" }, consent: true });
```

A name is 1 to 300 characters and a description at most 500. Neither may hold an email address, phone number or link. A `new_place` report carries the place's name in `report.name`, checked the same way and also refused when `textProblem` finds a problem (`report.name must pass the text checks (rude)`). Keep the name out of the note, which holds the traveller's other words. `name` is refused on every other report kind.

A check's `nearby: true` says the app saw the phone near the place at the time, for example within a few hundred metres when the traveller answered. Only `true` is sent; leave it out otherwise. Like a review's `visited_nearby`, the location itself is never sent. `place_kind` is a code from `data/schema/kinds.json`: an unknown code is refused at the next apply run. Once accepted, the new kind is kept through later OSM syncs.

Ask users not to put names, email addresses or phone numbers in notes or reviews. The intake removes contact details it finds, and reviews that still contain personal details, advertising or offensive language (also when spelled with spaces or symbols) are refused.

**Tidy and check text before sending.** The SDK has the checks for names and notes, so the app can catch a problem while the traveller is still typing:

```ts
import { firstProblem, tidyName, tidyText } from "@opencampingdb/feedback";

const name = tidyName("LAKE EPPALOCK REST AREA"); // "Lake Eppalock Rest Area"
const note = tidyText("GREAT SPOT!!!! LOTS OF SHADE"); // "Great spot! Lots of shade"
const problem = firstProblem(name, note); // "rude", "contact", "spam" or null
```

`tidyName` brings a shouted or all lower case name to title case and keeps states and road terms such as `NSW` and `4WD` in capitals. `tidyText` turns shouted text into sentences. Both collapse spacing and runs such as `!!!!` or `sooooo`. `textProblem` checks one text and `firstProblem` several, after tidying: `rude` for rude words and slurs, however they are spelt, `contact` for an email address, link or phone number (opening hours such as 0800-1700 are left alone), and `spam` for advertising wording, a word said over and over, or keyboard mashing. Show your own message for each.

**Contacts on a new place.** A `new_place` report may carry `contacts`, with any of `phone`, `website` and `email`, each checked as the fact of that name is. Keep them out of the note. A person checks them before they are published. `contacts` is refused on every other report kind.

```ts
await feedback.report({
  place: null,
  location: { lat: -36.851234, lon: 144.551234 },
  report: { kind: "new_place", note: "Caravan park by the lake", contacts: { phone: "03 5555 0100", website: "https://park.example.org" } },
  consent: true,
});
```

**Addresses.** An address is checked as the data's `schema/place.schema.json` has it. Each text field is 1 to 100 characters (`MAX_ADDRESS_FIELD_LENGTH`), holds no email address, phone number or link, and passes `textProblem` (a field of digits alone, such as a house number, is only checked for contact details). Fields are stored trimmed, and unknown fields such as `city` are refused. `addressProblems(value)` lists what is wrong, empty for a good address, so the app can show it before sending; `isAddress(value)` is the yes or no.

```ts
import { addressProblems } from "@opencampingdb/feedback";

const address = { housenumber: "12", street: "Lake Road", suburb: "Lakeside", state: "VIC", postcode: "3999" };
addressProblems(address); // []
addressProblems({ suburb: "Lakeside", state: "Victoria" });
// ["address must have a street or a place", "address.state must be one of NSW, VIC, QLD, SA, WA, TAS, NT, ACT"]

await feedback.report({ place, report: { kind: "fact", fact: "address", value: address }, consent: true });
```

A `new_place` report may carry `report.address`, checked the same way and held for a person like its contacts. It still needs its `location`, so an app that lets a traveller add a place by address finds the spot first. `address` is refused on every other report kind.

**Reporting a new place.** A `remove` report says a new place should come down, with a `reason` from `NEW_PLACE_REPORT_REASONS`: `not_there`, `fake`, `offensive`, `private_land` or `duplicate`. `reason` is refused on every other report kind.

```ts
await feedback.report({ place: newPlace, report: { kind: "remove", reason: "private_land" }, consent: true });
```

**Withdrawing a new place.** A new place has its id as soon as its report is sent: `newPlaceId(result.id)` when the result is `sent`, which is `ocdb_` and the feedback id without its `fb_`. Keep it. The install that sent the place can take it back:

```ts
const newPlace = newPlaceId(result.id);
await feedback.withdraw({ place: newPlace, consent: true });
```

It is sent to `/v1/feedback` with `type: "withdraw"`, from the same install and with the same attestation as the report. Within 24 hours of the report the place is withdrawn. While the place is on the recent list, the intake answers `403 not_your_place` to any other install and `409 withdraw_window_closed` after 24 hours. After 24 hours send a `remove` report instead, which counts as one more report.

**The recent places list.** A new place shows to everyone within about 30 seconds of its report, without waiting for the apply run:

```sh
curl "https://<intake>/v1/places/recent?bbox=146.5,-37.2,147.5,-36.0"
```

It needs no app key. `bbox` is optional: west, south, east and north in degrees. The intake grows the box out to whole degrees (`146.5,-37.2,147.5,-36.0` is answered as `146,-38,148,-36`) and caches the answer at the edge for 30 seconds by that box, so every map view inside the same degrees shares one cached list and the store is read once per box each 30 seconds. The list can therefore hold places a little outside the box you asked for; draw them or filter them on the phone. Other query parameters are ignored.

```json
{"places": [{"id": "ocdb_01JC...", "location": {"lat": -36.12345, "lon": 146.88765}, "kind": "free_camp",
  "name": "Creek Bend Free Camp", "standing": "shown", "added": "2026-11-03T09:00:00Z", "contributor": "ctr_5d1c0e2a9b7f4436"}]}
```

A place is listed when its report came from an attested install (an app key with `requires_attestation`) and its note, with contact details stripped as the inbox keeps it, passes `textProblem`. A report without a `contributor` is listed under the attested key's contributor id on iOS, and on Android under one the intake makes from the hashed install, so a moderator can still block that install. Other new places reach a person through the apply run as before. `kind` is the code the traveller picked, or `null`; look its group up in `data/schema/kinds.json`. `name` is the report's `name` after `tidyName`, or `null` when it had none. `standing` is `shown` or `confirmed`, worked out with `newPlaceStanding` as checks and `remove` reports on the place's id arrive, so a place two other devices report leaves the list on the next refresh. Only `still_there` checks with `nearby: true` count towards `confirmed`. The list never carries the note, the contacts, the address or a device id. `contributor` is the hashed id, so hide what a traveller blocked on the phone. The intake also keeps the block list the apply run sends: a blocked contributor's new places leave the list, and later ones are accepted to the inbox but not listed. A place leaves the list once the apply run has written it into the data, where apps find it with the rest.

Each contributor (or install, without one) may send 3 new places a day. The fourth gets `429 rate_limited`.

## 6. Reviews: contributors, reports and blocking

App stores ask any app that shows reviews to filter objectionable content, let people report it and block abusive users. The engine does each part; the app supplies who wrote a review and the buttons.

**Contributor.** Send `contributor` with every review and review report: an opaque id for the signed-in account, such as an HMAC of the account id with a key only your server knows. Never send a name, email or the raw account id. It is 16 to 128 characters of letters, digits, `_` and `-`. The intake hashes it again with its own salt and the app's name before storing it, so the published id (`ctr_` and 16 hex characters) cannot be traced back to your account, and the same account has different ids in different apps. Reviews without a contributor get `400 contributor_required`, unless your app key uses App Attest (section 7), in which case the attested install stands in for an account.

**What happens to a review.**

- One review per contributor per place: a newer one replaces the older.
- A contributor's first review is held for a person. Once one of their reviews or other feedback has been accepted, later reviews are published at the next apply run.
- Text sent word for word for another place is held for a person.
- Each contributor may send 20 submissions a day (the app key can set `contributor_daily_limit`).

**Was there.** Set `review.visited_nearby: true` only when your app saw the phone within its set distance of the place in the 60 days before the review, for example from a check or a saved visit. Never send the location. It is published with the review so apps can show it. An app key with `requires_visited_nearby` refuses reviews without it (`400 visited_nearby_required`).

**Reporting a review.** Every published review has a stable `id`. Give each review a Report action:

```ts
import { REVIEW_REPORT_REASONS } from "@opencampingdb/feedback";
// spam_ad, offensive, off_topic, fake, personal_details

await feedback.reportReview({ place, review: "rev_01JC...", reason: "offensive", contributor, consent: true });
```

Every report goes to a person on the `feedback/review` PR, who looks at reported reviews within 24 hours. Reports from three different contributors hide the review at the next apply run, until the person decides. A person can hide a review, or block its contributor: everything a blocked contributor sends is refused, and their reviews are left out of the release and the rating.

**Blocking on the phone.** Published reviews carry `contributor`, so let a traveller hide everything from one contributor on their own phone, straight away, without waiting for anyone. Keep that list on the device.

Hide a review the traveller reported straight away on their phone as well. The data catches up at the next release.

**Photos.** Open Camping DB takes no photos. To add photos to your app, run your own photo service with the photo kit: [photos.md](photos.md).

## 7. Prove the app with App Attest or Play Integrity

An app key with `requires_attestation` takes reports, reviews, checks and review reports only from a genuine copy of the app on a sound device. Without proof the intake answers `401 attestation_required`, and with proof that fails `401 attestation_invalid`. The SDK calls your `attest` function each time it sends, with the exact body and its SHA-256, and adds the headers it returns:

```ts
export const feedback = createFeedbackClient({
  // ...as in section 3
  attest: async ({ bodySha256 }) => (Platform.OS === "ios" ? appAttestHeaders(bodySha256) : playIntegrityHeaders(bodySha256)),
});
```

If `attest` throws, the item stays queued and is tried later. If the intake refuses the proof (`401 attestation_required` or `attestation_invalid`), the item also stays queued and is tried again with backoff, and the client calls your `onAttestationRejected(error, refusal)` if you pass one. For `attestation_invalid`, `refusal` holds the intake's `reason` code and `details`. Drop the stored App Attest key only when `keyIsUnusable(refusal?.reason)` is true, so a fresh key registers before the next try; every other refusal keeps the key. The codes and what each means are listed in the SDK's README.

**iOS, App Attest.** Once per install, generate a key, get a challenge and register the attestation:

1. `POST /v1/attest/challenge` with your `x-app-key`. The answer is `{ "challenge": "..." }`, usable once within 5 minutes.
2. Call `DCAppAttestService.attestKey` with the key id and the SHA-256 of the challenge text (its UTF-8 bytes) as `clientDataHash`.
3. `POST /v1/attest/register` with `{ "key_id": "<base64 key id>", "attestation": "<base64 attestation object>", "challenge": "<the challenge>" }`. `201` means the key is registered. Keep the key id.

For each submission, call `generateAssertion` with the key id and `bodySha256` (as bytes) as `clientDataHash`, and return `x-attest-platform: ios`, `x-attest-key-id: <key id>` and `x-attest-assertion: <base64 assertion>`. The intake checks the signature against the registered key, that it is for this app, and that its counter has risen since the last one, so an assertion cannot be replayed. With Expo's `@expo/app-integrity`, which hashes the string you pass itself, call `attestKeyAsync(keyId, challenge)` and `generateAssertionAsync(keyId, body)` with the body text, not its hash; on Android, `requestIntegrityCheckAsync(bodySha256)`. Keys from development builds work only with an app key whose `ios.environment` is `development`.

Development builds cannot attest (the Simulator has no App Attest), so give them a separate app key without `requires_attestation`.

When your app sends no `contributor`, an attested iOS install gets one from its key. The key also counts as a second signal beside the account: it has its own daily limit, so one account cannot post from scripts.

**Android, Play Integrity.** Use a standard request with `bodySha256` as the `requestHash`, and return `x-attest-platform: android` and `x-attest-token: <token>`. The intake asks Google to decode the token and checks that it is for this request, from your package (and signing certificate, when the app key lists them), made within the last 5 minutes, that Play recognises the app and that the device meets device integrity.

## 8. Flush when the app comes back

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

## 9. Show the attribution

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
