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

// A fact: an attested report changes it at once.
await feedback.report({
  place,
  report: { kind: "fact", fact: "power", value: true },
  consent: true,
});

// A traveller's edit of a place: every fact they set, in one call. Each fact
// is its own report, decided on its own, and the call answers one result per
// fact. An install's reports about one place in a day count once against the
// daily limits, however many facts the edit has (up to 100).
const results = await feedback.reportFacts({
  place,
  facts: { toilets: true, pets: "leashed", fee: false, caravans: true },
  consent: true,
  ref: "edit-42", // each fact's report gets the ref "edit-42:<fact>"
});

// Details for a place the traveller has just added, before its id is known:
// give the new_place report a ref, and name the place as { newPlace: <ref> }.
// Any report, reportFacts, check, fee or review can do this. The SDK keeps
// those items in its queue, unsent, until the new place is sent, then gives
// them its ocdb_ id and sends them in order. It survives restarts, and a
// waiting item never holds up the items behind it. If the new place is
// dropped or refused, the waiting items are dropped too: onAnswered gets
// { kind: "dropped", httpStatus: 0, reason: "new_place_dropped" }.
await feedback.report({
  place: null,
  location: { lat: -32.040723, lon: 152.540633 },
  report: { kind: "new_place", name: "Diamond Beach Holiday Park" },
  consent: true,
  ref: "draft-7",
});
await feedback.reportFacts({ place: { newPlace: "draft-7" }, facts: { toilets: true, showers: true }, consent: true });
// A ref that names no queued or sent new place throws FeedbackValidationError.
// feedback.newPlace(ref) says where it stands: waiting, sent (with its ocdb_
// id), dropped or unknown. Photos of the new place can wait too: see
// docs/photos.md, "A photo of a place the traveller has just added".

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
- `pets_months`, the months dogs are allowed at a place whose `pets` is `seasonal`: one OSM month range such as `May-Sep`, which may wrap the year end (`Dec-Feb`), as in OSM's `dog:conditional=yes @ (May-Sep)` (`isMonthRange`)
- `power`, `tents`, `toilets`, `showers`, `drinking_water`, `dump_station` and `booking_required` (true or false)
- the site features in `SITE_FEATURES`, each true or false: who can get in (`wheelchair`, `generators`, `motorhomes`, `camper_trailers`, `motorbikes`, `big_rigs`), what is there (`non_drinking_water`, `laundry`, `kitchen`, `bbq`, `drive_through`, `ensuite_sites`, `bins`, `picnic_tables`, `campfires`, `cabins`, `pub`), what to do (`swimming`, `fishing`, `walking_tracks`, `scenery`, `wildlife`, `playground`, `games_room`, `shade`, `cycling_tracks`, `offroad_tracks`, `boat_ramp_nearby`, `near_road`), services (`telstra_signal`, `mobile_signal`, `wifi`, `tv_reception`, `pet_sitting`, `fuel`, `lpg`, `car_wash`, `vehicle_storage`) and warnings (`self_contained_only`, `crocodiles`, `seasonal_closure`, `dangerous_when_wet`, `over_50s`, `nudist`)
- `brand`, one of `BRANDS` (`big4`, `discovery`, `nrma` and the other chains and clubs)
- `access` (`2wd`, `awd`, `4wd`, `unknown`), `entry` (`public`, `customers`, `permit`, `private`), `vehicle_access` (`heavy_vehicles_only`, from `VEHICLE_ACCESS_VALUES`, which may gain values such as cars only: show nothing for a value your app does not know), `max_stay` (such as `48h`, `2d`, `1w`), `opening_hours` (with no email address, phone number or link)
- contacts: `website`, `facebook`, `instagram`, `tiktok` and `x` (https only), `phone`, `phone_2` and `email`
- `address`, an object (`PlaceAddress`) with a `street` or, for a rural address, a named `place`, and any of `unit`, `housenumber`, `suburb`, `state` (one of `ADDRESS_STATES`: `NSW`, `VIC`, `QLD`, `SA`, `WA`, `TAS`, `NT`, `ACT`) and `postcode` (four digits)

A fact from an attested report is applied at once, unless another device reported a different value within 90 days or the owner set it: then a person decides. Without attestation, two devices must agree within 90 days. Contacts (website, phones, email and social pages) and addresses follow the same rule, but an attested one is applied at once only when it passes `contactProblem`; one that fails, and any without attestation, goes to a person. `booking_url` comes only from the owner.

**Dog months.** `pets_months` only means something while `pets` is `seasonal`. A report of it for a place whose `pets` is anything else is held for a person (`not_seasonal`). When `pets` is set to a value other than `seasonal`, the place's `pets_months` comes off with it: the intake lists both changes, the second with `value: null`. To clear the months alone, send a `doubt` about `pets_months`. `monthsInRange(range)` gives the months a range covers, 1 to 12 from its first month, so the app can tell whether dogs are allowed on the day a traveller is going:

```ts
import { monthsInRange } from "@opencampingdb/feedback";

await feedback.report({ place, report: { kind: "fact", fact: "pets_months", value: "May-Sep" }, consent: true });
monthsInRange("Dec-Feb"); // [12, 1, 2]
const dogsOk = place.facts.pets !== "seasonal" || monthsInRange(place.facts.pets_months ?? "").includes(month);
```

**Heavy vehicles only.** `vehicle_access: "heavy_vehicles_only"` says only heavy vehicles may use a place, such as a rest area or truck bay where others may be fined for stopping. The data sets it from OSM's `hgv` and `access` tags. A place that says so only in its name is a case for a reviewer, who may confirm it. A traveller sets it with a `fact` report and clears it with a `doubt`, decided as other facts are.

**Link and spam checks.** `contactProblem(fact, value)` returns what is wrong with a contact or an address, or `null` when it passes, so the app can check before sending. A website or social page must be an https address on a public host (no IP addresses or local names, see `isPublicHttpsUrl`) and not a link shortener (`LINK_SHORTENERS`: bit.ly, tinyurl.com, t.co and the rest). `facebook` must be on facebook.com or fb.com, `instagram` on instagram.com, `tiktok` on tiktok.com and `x` on x.com or twitter.com, or a subdomain such as www or m (`SOCIAL_HOSTS`). A phone or email is checked as its fact is, and an address with `addressProblems`. The facts it covers are `CONTACT_FACTS`.

```ts
import { contactProblem } from "@opencampingdb/feedback";

contactProblem("facebook", "https://www.facebook.com/lakecamp"); // null
contactProblem("website", "https://bit.ly/camp"); // "must not be a link shortener"
contactProblem("instagram", "https://park.example.org/insta"); // "must be on instagram.com"
```

**Reporting a contact.** A `contact` report says a contact on a place is wrong or spam: `fact` is one of `CONTACT_FACTS` and `reason` is `wrong` or `spam` (`CONTACT_REPORT_REASONS`). It needs the place and carries no `value`. One report goes to a person. Reports from two different sources within 90 days, at least one of them attested, take the contact off the place at the next apply run, and a person, a bot or an AI reviewer then decides whether it comes back. A contact the owner set is left to a person, and a report about a contact the place does not have is refused.

```ts
await feedback.report({ place, report: { kind: "contact", fact: "website", reason: "spam" }, consent: true });
```

**Confirming or doubting a fact.** A traveller who sees a fact is still right confirms it with a `fact` report of the same value, so a "Still right? Yes" button needs no new kind. A `doubt` report says one fact on a place is wrong when the traveller doesn't know the right value: `fact` is any reportable fact except the contacts and the address (`isDoubtFact`), which use the `contact` kind. It needs the place, carries no `value`, and may carry a `note`, which is kept for reviewers and never published. Each source counts once, however many times it sends. One doubt goes to a reviewer and the fact stays. Doubts from two different sources within 90 days, at least one attested and more than the sources confirming the value, take the fact off the place at once: it comes through the recent list as a change with `value: null`, and a reviewer gets the case. The fact comes back by itself when two new travellers confirm it (one of them attested, and more than any newer doubts), and is replaced when someone reports a new value. A fact from OSM or the owner is never taken down, and a doubt about a fact the place doesn't have is refused. Doubts sent before a fact was last set are about an older value and don't count.

```ts
await feedback.report({ place, report: { kind: "fact", fact: "toilets", value: true }, consent: true }); // still right
await feedback.report({ place, report: { kind: "doubt", fact: "toilets", note: "None I could find" }, consent: true }); // wrong, right value unknown
```

**A Commons photo that is not of the place.** Apps show Wikimedia Commons photos from `commons.ndjson.gz`. A `commons_mismatch` report says one of them is not of the place: it needs the place and `file`, the photo's `file` from that line (1 to 255 characters on one line, `MAX_COMMONS_FILE_LENGTH`), and may carry a `note` for reviewers. Hide the photo for the traveller who sent it at once, and keep it hidden on that phone: the intake answers `held` (`commons_report`) and a reviewer gets the case. Reports from two different sources within 90 days, at least one attested, add the place and file to the data's `moderation/commons-do-not-match.json` at the next apply run, and later releases leave the photo out for everyone. A reviewer may add it on one report too. A person can undo either, and the app should offer the traveller a way to show the photo again.

```ts
await feedback.report({ place, report: { kind: "commons_mismatch", file: "Brunswick River and Pool Precinct 6.jpg" }, consent: true });
hiddenCommons.add(`${place}/${file}`); // the app's own list, for this traveller
```

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

**Contacts on a new place.** A `new_place` report may carry `contacts`, with any of `phone`, `website` and `email`, each checked as the fact of that name is. Keep them out of the note. When the place is published, each contact that passes `contactProblem` is published with it, and a person checks the rest. `contacts` is refused on every other report kind.

**Description and fee on a new place.** A `new_place` report may carry `description`, checked as a `description` report's value is (1 to 500 characters, no email address, phone number or link) and stored trimmed, and `fee` (true, false or `donation`). Both are published with the place. A description that fails `firstProblem` after `tidyText` is left off and a person checks it, so run the text checks before sending. Both are refused on every other report kind.

```ts
await feedback.report({
  place: null,
  location: { lat: -36.851234, lon: 144.551234 },
  report: { kind: "new_place", name: "Creek Bend Free Camp", description: "Flat sites beside the creek.", fee: false },
  consent: true,
});
```

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

A `new_place` report may carry `report.address`, checked the same way and published with the place like its contacts when it passes `contactProblem`. It still needs its `location`, so an app that lets a traveller add a place by address finds the spot first. `address` is refused on every other report kind.

**Reporting a new place.** A `remove` report says a new place should come down, with a `reason` from `NEW_PLACE_REPORT_REASONS`: `not_there`, `fake`, `offensive`, `private_land` or `duplicate`. `reason` is refused on every report kind but `remove` and `contact`.

```ts
await feedback.report({ place: newPlace, report: { kind: "remove", reason: "private_land" }, consent: true });
```

**Withdrawing a new place.** A new place has its id as soon as its report is sent: `newPlaceId(result.id)` when the result is `sent`, which is `ocdb_` and the feedback id without its `fb_`. When the report was queued, the id comes to your `onAnswered` hook instead (see section 8). Keep it. The install that sent the place can take it back:

```ts
const newPlace = newPlaceId(result.id);
await feedback.withdraw({ place: newPlace, consent: true });
```

It is sent to `/v1/feedback` with `type: "withdraw"`, from the same install and with the same attestation as the report. Within 24 hours of the report the place is withdrawn. While the place is on the recent list, the intake answers `403 not_your_place` to any other install and `409 withdraw_window_closed` after 24 hours. After 24 hours send a `remove` report instead, which counts as one more report.

**The recent list.** A new place, and a change that went live (see "Live or held" below), shows to everyone within about 30 seconds of its report, without waiting for the apply run or the next data release:

```sh
curl "https://<intake>/v1/places/recent?bbox=146.5,-37.2,147.5,-36.0"
```

It needs no app key. `bbox` is optional: west, south, east and north in degrees. The intake grows the box out to whole degrees (`146.5,-37.2,147.5,-36.0` is answered as `146,-38,148,-36`) and caches the answer at the edge for 30 seconds by that box, so every map view inside the same degrees shares one cached list and the store is read once per box each 30 seconds. The list can therefore hold places a little outside the box you asked for; draw them or filter them on the phone. Other query parameters are ignored.

```json
{"places": [{"id": "ocdb_01JC...", "location": {"lat": -36.12345, "lon": 146.88765}, "kind": "free_camp",
  "name": "Creek Bend Free Camp", "standing": "shown", "added": "2026-11-03T09:00:00Z", "contributor": "ctr_5d1c0e2a9b7f4436",
  "description": "Flat sites beside the creek.", "fee": false, "contacts": {"phone": "+61 3 5555 0100"}}],
 "changes": [{"place": "ocdb_01JB...", "fact": "toilets", "value": true, "accepted": "2026-11-03T09:00:00Z", "in_data_at": null},
  {"place": "ocdb_01JB...", "fact": "website", "value": null, "accepted": "2026-11-03T09:05:00Z", "in_data_at": "2026-11-03T10:00:00Z"}]}
```

The SDK types the answer as `RecentList`, with `RecentPlace` and `RecentChange`.

A place is listed when its report came from an attested install (an app key with `requires_attestation`) and its note, with contact details stripped as the inbox keeps it, passes `textProblem`. A report without a `contributor` is listed under the attested key's contributor id on iOS, and on Android under one the intake makes from the hashed install, so a moderator can still block that install. Other new places reach a person through the apply run as before. `kind` is the code the traveller picked, or `null`; look its group up in `data/schema/kinds.json`. `name` is the report's `name` after `tidyName`, or `null` when it had none. `standing` is `shown` or `confirmed` until the place reaches the data, worked out with `newPlaceStanding` as checks and `remove` reports on the place's id arrive, so a place two other devices report leaves the list on the next refresh. Only `still_there` checks with `nearby: true` count towards `confirmed`. `description`, `fee` and `contacts` (the contact facts and the `address`) are there when the report carried them and they passed the checks, as the place will be published with them. The list never carries the note or a device id. `contributor` is the hashed id, so hide what a traveller blocked on the phone. The intake also keeps the block list the apply run sends: a blocked contributor's new places leave the list, and later ones are accepted to the inbox but not listed.

**A new place added twice.** A new place within 150 m of a place in the same group is held as a possible duplicate. When the two have the same name once tidied, are less than 50 m apart and the road data shows no major road between them, the apply run merges the new place into the other place without anyone asked. Otherwise, and whenever the run has no road data, a reviewer approves, merges or takes it down. A merged new place reaches the data as a tombstone with `merged_into`, and a release lists it in `merged.ndjson.gz`. A person can reverse any merge.

**After a place reaches the data.** Once the apply run has written a place into the data (or settled its adder's withdraw), the entry gains `in_data_at`, when that happened, and stays on the list for 7 more days with its current standing, which can then also be `hidden` or `withdrawn`. Checks, `remove` reports, a withdraw within 24 hours and the block list still count for it, so a place hidden after it reached the data is listed as `hidden`. Intakes from before SDK 0.10.1 have no `in_data_at` and drop the place as soon as it reaches the data.

A phone that showed the place from the recent list keeps showing it until its next release, so for 7 days:

- When your release has the place, show the release record, as it may have changed since, but apply the recent list's standing: hide the place when the entry is `hidden` or `withdrawn`.
- When your release does not have it yet, keep showing the recent list's entry as before, and hide it when its standing says so.
- When your release lists the place's id in `merged.ndjson.gz`, it was merged into another place (a new place added twice): show the place it was merged into, and move anything your app keeps under the old id to the new one.
- When the place has left the list, show what your release says.

```ts
const recentStanding = new Map(recent.places.map((p) => [p.id, p.standing]));
const visible = places.filter((place) => {
  const standing = recentStanding.get(place.id);
  return standing !== "hidden" && standing !== "withdrawn";
});
```

**Recent changes.** `changes` holds the changes to released places that went live: for each place and fact, the latest one, by map area like the places. `value` is the fact's new value, or `null` when the change takes the fact down (a contact taken down after reports, or a fact after doubts). `accepted` is when the intake accepted it, and `in_data_at` when the apply run put it into the data, or `null` until it has. A change stays on the list for 7 days after it reaches the data, so an app with an older release still shows it. Changes from a blocked contributor leave the list. Intakes from before SDK 0.10.0 have no `changes`.

Lay the changes over each place of your release with `withRecentChanges(place, changes, dataVersion)`, where `dataVersion` is the `data_version` of the release you have. It sets each fact (with `fact_sources` `feedback` and the `fact_dates` entry the time it was accepted), takes off a fact whose value is `null`, and skips changes your release already has: those whose `in_data_at` is earlier than the commit time at the front of `dataVersion` (`20261030T160000Z-abc1234` is 16:00 UTC on 30 October 2026; `dataVersionTime` reads it). When the version is not in that form, every change is laid over. It returns a new record, or the same one when no change applies, and leaves the release record as it was.

```ts
import { withRecentChanges, type RecentList } from "@opencampingdb/feedback";

const recent = (await (await fetch(`${endpoint}/v1/places/recent?bbox=${bbox}`)).json()) as RecentList;
const shown = places.map((place) => withRecentChanges(place, recent.changes ?? [], manifest.data_version));
```

Each contributor (or install, without one) may send 10 new places a day. The eleventh gets `429 rate_limited`.

**Keeping the data fresh.** A data release follows each merge into the data within minutes, and the recent list covers only the minutes in between. On launch and once a day, read the release's `manifest.json`, and when its `data_version` is newer than the one you have, download the new release.

### What became of a contribution

Every item the intake accepts gets a progress record: where it is, from received to in the data. Ask with `feedback.progress(ids)`, by the id the intake answered when the item was sent: `outcome.id` in `onAnswered`, or `id` in a `sent` result. Keep that id with your own record of the contribution. Ask on launch and when the app shows the traveller their contributions.

```ts
import { progressInRelease } from "@opencampingdb/feedback";

const progress = await feedback.progress(mine.map((c) => c.feedbackId)); // one answer per id, in the same order
for (const p of progress) {
  if (p.state === "in_data") showDone(p.id, progressInRelease(p, manifest.data_version) ? "in your data" : "in the next data update");
  else if (p.state === "refused") showRefused(p.id, p.reason);
  else showWaiting(p.id, p.state);
}
```

`progress` calls the public `GET /v1/feedback/progress?ids=fb_...,fb_...` at once and never queues. It asks for up to 100 ids a call and splits a longer list. An id that is not a feedback id, such as a photo's `pho_` id, is answered `unknown` without asking. It throws `ProgressRequestError` when the intake cannot be reached (`httpStatus` 0) or refuses the call (`httpStatus` is the HTTP code), so try again later. The states are `PROGRESS_STATES`:

| State | What it means | What to show |
| --- | --- | --- |
| `received` | The intake has it, and nothing is decided yet. `held_reason` says why when the intake held it at send time. | Sent, waiting for a decision. |
| `live` | The intake put it live when it was sent, and it is not in the data yet. | Live: it shows through the recent changes. |
| `waiting` | It needs more reports, or its place is not in the data yet. `reason` says which. | Waiting for others to confirm it. |
| `accepted` | The rules accepted it, and it is on its way into the data. | Accepted. |
| `held` | A reviewer decides it, as for a name, a description or an owner claim. | With a reviewer. |
| `refused` | Refused, with `reason`. `by` is `rules` when the rules refused it, or `reviewer` when the review PR was merged or closed without it. | Not taken, with the reason. |
| `in_data` | Its change is in the data, as of `in_data_at`. | Done. It shows from the next data release, or at once through the recent changes for a fact that went live. |
| `unknown` | The intake has no record of it: not sent to this intake, or more than 90 days without a change. | Nothing. |

`progressInRelease(progress, dataVersion)` is true when the change is `in_data` and its `in_data_at` is earlier than the commit time in your release's `data_version`, as `withRecentChanges` reads it. A new place merged into another place answers `in_data` with `place` set to the place it went into. A record never carries the traveller's words, a device or a contributor: only the state, the engine's reason, `held_reason`, `by`, the place and times. Records are kept for 90 days after they last change. A state this SDK does not know is answered `unknown`.

## 6. Reviews: contributors, reports and blocking

App stores ask any app that shows reviews to filter objectionable content, let people report it and block abusive users. The engine does each part; the app supplies who wrote a review and the buttons.

**Contributor.** Send `contributor` with every review and review report: an opaque id for the signed-in account, such as an HMAC of the account id with a key only your server knows. Never send a name, email or the raw account id. It is 16 to 128 characters of letters, digits, `_` and `-`. The intake hashes it again with its own salt and the app's name before storing it, so the published id (`ctr_` and 16 hex characters) cannot be traced back to your account, and the same account has different ids in different apps. Reviews without a contributor get `400 contributor_required`, unless your app key uses App Attest (section 7), in which case the attested install stands in for an account.

**What happens to a review.**

- One review per contributor per place: a newer one replaces the older.
- A contributor's first review is held for a person. Once one of their reviews or other feedback has been accepted, later reviews are published at the next apply run.
- Text sent word for word for another place is held for a person.
- Each contributor may send 200 submissions a day (the app key can set `contributor_daily_limit`), and so may each install and each App Attest key. Each client network may send 500. An install's reports about one released place in a day count as one submission, up to 100 reports a place, so a full edit of a place (`reportFacts`) costs one.

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

**Connecting answers to your own records.** The client normalises a submission before it queues it: a location is rounded to 6 decimal places and names are trimmed. So what was queued can differ from what you passed in, and matching an answer to your record by content fails. Tidy what the traveller typed with `tidyName` and `tidyText`, round a location with `sdkCoordinate`, and store those values if you keep a copy.

A new place's id arrives only to the send that carried it: the `report()` call when it went at once, or a later `flush()` when it was queued. To receive it either way, pass a `ref` of your own (1 to 100 characters) with each submission, and an `onAnswered` hook when you create the client. The client keeps `ref` with the queued item and never sends it. `onAnswered({ ref, type, outcome })` is called once for each queued item when it is settled, after the queue is saved, with `outcome` either `{ kind: "sent", id, state?, heldReason? }` or `{ kind: "dropped", httpStatus }` (0 when the item was dropped unsent for its age or a full queue). Errors in the hook are caught, so they never stop the queue.

```ts
export const feedback = createFeedbackClient({
  // ...
  onAnswered: async ({ ref, outcome }) => {
    if (!ref) return; // items queued before SDK 0.8.0 carry no ref
    const draft = await drafts.get(ref);
    if (draft && outcome.kind === "sent") await drafts.setPlace(ref, newPlaceId(outcome.id));
    if (draft && outcome.kind === "dropped") await drafts.markRefused(ref, outcome.httpStatus);
  },
});

await feedback.report({ place: null, location, report: { kind: "new_place", name: tidyName(name) }, consent: true, ref: draft.id });
```

**Live or held.** The intake decides fact reports, contact reports, doubts and new places when they arrive, and answers every `commons_mismatch` report `held`, with the apply run's own rules and then its checks, and says what it decided. A `sent` outcome, and the `sent` result of a call that sent at once, then carries `state`: `live` when the change shows at once on the recent list, or `held` when it waits for a reviewer, with `heldReason`. Every other kind of item, and every item sent to an intake from before SDK 0.10.0, comes back with neither, and the apply run decides it as before. The apply still writes every item into the data, and may yet decide a live item differently, for example when two reports collide in one run; the change then leaves the recent list.

```ts
onAnswered: async ({ ref, outcome }) => {
  if (!ref || outcome.kind !== "sent") return;
  if (outcome.state === "live") await drafts.markLive(ref);
  else if (outcome.state === "held") await drafts.markHeld(ref, outcome.heldReason); // undefined for a code this SDK does not know
  else await drafts.markSent(ref);
},
```

The codes are exported as `HELD_REASONS` and the type as `HeldReason`. Show your own message for each:

| `heldReason` | Why |
| --- | --- |
| `not_attested` | The report was not from an attested install: a person reads a contact, and a second device has to agree on any other fact. On a doubt, or a confirmation of a fact doubts took down, none of the reports counted was attested. |
| `owner_value` | The place's owner set the value. |
| `disagreement` | Another source reported a different value within 90 days. On a doubt, as many sources confirm the value as doubt it, or more. |
| `link_check` | A link failed `contactProblem` or the malware check. |
| `text_check` | Free text failed the text checks. |
| `unconfirmed` | A contact report from one source, or with none attested. |
| `no_contributor` | A new place sent without a contributor. |
| `daily_cap` | The contributor, their network or their install's App Attest key has had 50 live changes today (UTC). |
| `ai_check` | The AI check flagged its free text. |
| `check_unavailable` | A check could not run, so it waits rather than going live unchecked. |
| `unknown_place` | The intake does not have the place yet, such as a place newer than the last release. |
| `blocked` | The contributor is blocked. |
| `no_value` | A contact report or doubt about a fact the place does not have. |
| `invalid_value` | Not a valid value for the fact. |
| `single_doubt` | One traveller doubts the fact, so a reviewer reads it. The fact stays. |
| `protected_source` | A doubt about a fact from OSM or the owner, which doubts never take down. |
| `taken_down` | A report of a value doubts took down: it comes back when two new travellers confirm it. |
| `not_seasonal` | `pets_months` for a place whose `pets` is not `seasonal`, so a person checks it. |
| `commons_report` | A report that a Commons photo is not of the place. Hide it for the traveller who sent it; a reviewer decides, and two sources hide it for everyone. |

Being held is not a refusal: a reviewer (a person, bot or AI the maintainers allow) decides the item. Adding a code later is additive. A code this version does not know is left out of `heldReason`, and `state` is still `held`. `itemDecision(answer)` reads `state` and `heldReason` from an intake answer you fetched yourself.

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
