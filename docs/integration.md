# Integrating with an Expo app

This guide adds Open Camping DB feedback to an Expo (React Native) app. The same client works on the web with a `localStorage` adapter.

## 1. Get an app key

Open an issue with the **App key** form in [opencampingdb/feedback-engine](https://github.com/opencampingdb/feedback-engine/issues/new/choose), giving your app's name and roughly how many submissions a day you expect. You get an app key and the intake URL. The key ships inside your app, so it is an identifier with a daily limit, not a secret.

## 2. Install

The SDK isn't published to npm. Build it from this repository and install the package file it makes:

```sh
git clone https://github.com/opencampingdb/feedback-engine.git
cd feedback-engine
npm ci
npm run build -w packages/sdk
npm pack -w packages/sdk   # writes opencampingdb-feedback-<version>.tgz
```

Then, in your app:

```sh
npx expo install @react-native-async-storage/async-storage
npm install /path/to/opencampingdb-feedback-<version>.tgz
```

Keep the `.tgz` in your repository (or a folder it can reach) so every build installs the same version. To update, pull, build and pack again. The version is in `packages/sdk/package.json`, and the commit history says what each version changed.

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

The client keeps its queue and a random device id in storage under keys starting `ocdb.feedback.`. Those keys are the SDK's own: see [The stored queue belongs to the SDK](#the-stored-queue-belongs-to-the-sdk).

One client owns a storage prefix. Make the client once, in a module of its own, and use that one client everywhere in the app. It reads the queue and device id on its first call, not when it is made, so anything the app puts in storage before that call is seen. After that it works from its own copy in memory, saving every item before it is sent and the queue again after each flush. A second client over the same prefix does not see the first one's copy, and the two can overwrite each other's items. The photo client uses the `ocdb.photos` prefix, so it can run beside the feedback client.

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

## 5. Send reports, reviews, checks and charges

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
// fact. Every fact is checked first: one refused fact throws and nothing is
// queued. The facts then go in one batch with one attestation. An install's
// reports about one place in a day count once against the daily limits,
// however many facts the edit has (up to 100).
const results = await feedback.reportFacts({
  place,
  facts: { toilets: true, pets: "leashed", fee: false, caravans: true },
  consent: true,
  ref: "edit-42", // each fact's report gets the ref "edit-42:<fact>"
  first_hand: "says_so", // optional: the traveller was at the place in the last month
});

// To close a screen without waiting for the network, pass { wait: false } to
// report, reportFacts, check or review. The call resolves { status: "queued" }
// once the input is checked and saved, starts a send, and the outcome reaches
// onAnswered (section 8). A refused input still throws first, so the screen
// can stay open. Leave it out where the answer is needed at once, such as
// the id of a new place.
await feedback.report({ place, report: { kind: "closed" }, consent: true, ref: "close-9" }, { wait: false });

// Details for a place the traveller has just added, before its id is known:
// give the new_place report a ref, and name the place as { newPlace: <ref> }.
// Any report, reportFacts, check or review can do this. The SDK keeps
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

// Charges: the price the place publishes on its sign or website, in
// OpenStreetMap's charge syntax.
await feedback.reportFacts({
  place,
  facts: { charge: "57 AUD/night", charge_powered: "68 AUD/night", charge_conditional: "75 AUD/night @ (Dec-Jan)" },
  consent: true,
});
```

**Charges.** `charge` is what a standard site costs, `charge_powered` what a powered site costs, and `charge_conditional` the exceptions to `charge`, such as a holiday season. They are OSM's `charge` and `charge:conditional` tags (`charge_powered` has no OSM tag yet). A value is `<amount> <currency>[/<unit>][/<time unit>]`, as the [OSM wiki](https://wiki.openstreetmap.org/wiki/Key:charge) writes it: an amount with at most 2 decimal places, an ISO 4217 currency code, then optionally what it is for (`person`, `vehicle`, `kWh`) and the time it covers, written out in full (`night`, `day`, `hour`, `week`). Spaces may stand around a slash. `charge_conditional` is one or more `<charge> @ <condition>` pairs separated by `;`, with the condition in OSM's [conditional syntax](https://wiki.openstreetmap.org/wiki/Conditional_restrictions), such as `(Dec-Jan)`. A condition holding a `;` goes in parentheses, and when several match, the last one wins. `isCharge` and `isChargeConditional` check a value. A report that fails is refused (`invalid_value`). When a place publishes a range ("powered $68 to $70"), send the lowest, and show it as "from".

A charge is decided as other facts are, with one more hold: a `charge` or `charge_powered` over 250 AUD a night, or more than 50% above or below the place's current charge in the same currency and units, goes to a person (`unlikely_charge`).

Values from OpenStreetMap are kept as OSM has them, so a place may hold a charge out of the syntax, such as `$12`. `parseCharge(value)` reads a charge into `{ amount, currency, unit?, per? }` and returns null for one it can't read: show that value as written. `chargeConditions(value)` reads each exception of a `charge_conditional` into `{ charge, condition }`, or returns null. Prices change, so show when a charge was set: `fact_dates` for a value from feedback, or the place's `osm.timestamp` for one from OSM.

**Fee reports are gone.** What a traveller paid is no longer collected. The intake answers a `fee` submission from any SDK version with `410 {"error": "fee_retired"}`, and a client queue drops it as `rejected`. The `fee` fact (true, false or `donation`) is unchanged.

A check that finds an open place still there sets the record's `last_confirmed` to the time of the next apply run. One check is enough. Checks on a closed or temporarily closed place do not set it.

Facts a report may name:

- `fee` (true, false or `donation`), `caravans` (true, false or `offroad`), `pets` (`yes`, `no`, `leashed`, `seasonal`)
- `charge`, `charge_powered` and `charge_conditional`, in OSM's charge syntax (see **Charges** above)
- `pets_months`, the months dogs are allowed at a place whose `pets` is `seasonal`: one OSM month range such as `May-Sep`, which may wrap the year end (`Dec-Feb`), as in OSM's `dog:conditional=yes @ (May-Sep)` (`isMonthRange`)
- `power`, `tents`, `toilets`, `showers`, `drinking_water`, `dump_station`, `booking_required`, `hot_water` (hot water in the showers or basins) and `air` (air for tyres) (true or false)
- `toilet_type`, how the toilets work: one of `TOILET_TYPES` (`flush`, `pit`, `chemical`, `dry`, where `dry` is composting or bucket)
- `operator`, who runs the place (a council, a parks agency, a company): 1 to 200 characters once trimmed (`MAX_OPERATOR_LENGTH`), with no email address, phone number or link. It is stored trimmed.
- the site features in `SITE_FEATURES`, each true or false: who can get in (`wheelchair`, `generators`, `motorhomes`, `camper_trailers`, `motorbikes`, `big_rigs`), what is there (`non_drinking_water`, `laundry`, `kitchen`, `bbq`, `drive_through`, `ensuite_sites`, `bins`, `picnic_tables`, `campfires`, `cabins`, `pub`), what to do (`swimming`, `fishing`, `walking_tracks`, `scenery`, `wildlife`, `playground`, `games_room`, `shade`, `cycling_tracks`, `offroad_tracks`, `boat_ramp_nearby`, `near_road`), services (`telstra_signal`, `mobile_signal`, `wifi`, `tv_reception`, `pet_sitting`, `fuel`, `lpg`, `car_wash`, `vehicle_storage`) and warnings (`self_contained_only`, `crocodiles`, `sharks`, `marine_stingers`, `dangerous_when_wet`, `over_50s`, `nudist`). `SITE_FEATURES` also lists `seasonal_closure`, which is retired (`RETIRED_FACTS`): see "Retired facts" below
- `brand`, one of `BRANDS` (`big4`, `discovery`, `nrma` and the other chains and clubs)
- `access` (`2wd`, `awd`, `4wd`, `unknown`), `entry` (`public`, `customers`, `permit`, `private`), `vehicle_access` (`heavy_vehicles_only`, from `VEHICLE_ACCESS_VALUES`, which may gain values such as cars only: show nothing for a value your app does not know), `max_stay` (such as `48h`, `2d`, `1w`), `opening_hours` (OSM opening_hours syntax, such as `Mo-Fr 08:00-17:00; Sa 09:00-12:00` or `24/7`, whose comments hold no email address, phone number or link; see "Opening hours" below)
- contacts: `website`, `facebook`, `instagram`, `tiktok` and `x` (https only), `phone`, `phone_2` and `email`
- `address`, an object (`PlaceAddress`) with a `street` or, for a rural address, a named `place`, and any of `unit`, `housenumber`, `suburb`, `state` (one of `ADDRESS_STATES`: `NSW`, `VIC`, `QLD`, `SA`, `WA`, `TAS`, `NT`, `ACT`) and `postcode` (four digits)

A fact from an attested report is applied at once, unless another device reported a different value within 90 days or the owner set it: then a person decides. Without attestation, two devices must agree within 90 days. Contacts (website, phones, email and social pages) and addresses follow the same rule, but an attested one is applied at once only when it passes `contactProblem`; one that fails, and any without attestation, goes to a person. `booking_url` comes only from the owner. `fuels` and the nearby facts `nearest_beach` and `nearest_boat_ramp` come only from OSM, so no report or owner names them.

**Retired facts.** `seasonal_closure` is retired: the open months in `opening_hours` replace it (see "Open months" below). Released places may still carry it, and `PlaceFacts` keeps it (marked deprecated) so they type-check and read. A `fact` report, a doubt or owner facts that name it are refused with `seasonal_closure is retired: send the months in opening_hours with withOpenMonths`. To say a place opens only some months, send an `opening_hours` fact report built with `withOpenMonths`. `RETIRED_FACTS` lists the retired facts, so a report screen built from `SITE_FEATURES` can leave them out, and `retiredFactProblem(fact)` gives the refusal reason, or null for a fact that can be sent.

```ts
const reportable = SITE_FEATURES.filter((f) => !RETIRED_FACTS.includes(f));
await feedback.report({ place, report: { kind: "fact", fact: "opening_hours", value: withOpenMonths(hours, "Apr-Oct") }, consent: true });
```

**Opening hours.** `opening_hours` must be OSM opening_hours syntax, as the [specification](https://wiki.openstreetmap.org/wiki/Key:opening_hours/specification) (version 0.7.4) writes it and opening_hours.js 3.15, the reference implementation the OSM wiki names, reads it, so every app and the OSM editors can read it. `openingHoursProblem(value)` answers null for a good value, or why it isn't one, naming the first character that doesn't fit and, for common mistakes, how to write it: weekdays as two letters (`Mo` to `Su`), and times as `HH:MM` in 24 hour form. `isOpeningHours` answers true or false. A report that fails is refused with the same reason after `report.value`.

Every value the check accepts parses in opening_hours.js, and it accepts every Australian value in OSM that opening_hours.js accepts: a test runs each one through both. Like opening_hours.js, it takes any spacing between the parts of a value (`Mo-Fr 08:00 - 17:00`, `Fr 11:00-16:00;Sa 11:00-17:00`), a comma between rules after times (`Mo-Fr 08:00-17:00,Sa 08:00-14:00`), day lists (`Dec 25,26 off`), days of one digit (`Jan 1 off`), and a day offset on an nth weekday date (`Apr Su[1]-Oct Su[1] -1 day 07:00-19:00`). It refuses what opening_hours.js refuses: a time on its own and `10:00-16:00/90`, which belong to other tags, a plain date with an offset such as `Dec 25 +1 day` or an open end such as `Apr 01+`, and days a month doesn't have, such as `Apr 31`. It does not take forms opening_hours.js reads leniently, most of them with a warning: other forms of weekday and month names (`Mon`, `apr`), `am` and `pm`, times such as `8:00` or `08.00`, a rule separator at the end, and selectors out of order. `SH` (school holidays) is accepted, though opening_hours.js has no Australian school holiday dates. Nothing is rewritten: show the reason and let the traveller fix the value, or build it from a form of weekdays and times.

```ts
import { openingHoursProblem } from "@opencampingdb/feedback";

openingHoursProblem("Mo-Su 06:00-22:00"); // null
openingHoursProblem("Mon-Sun 6am-10pm"); // 'not OSM opening_hours syntax at character 1 ("Mon-Sun 6am-"): write weekdays as two letters: Mo Tu We Th Fr Sa Su'
```

**Open months.** `openMonths(value)` reads the months an `opening_hours` value says the place is open, so every app can show a season the same way, such as "Open Apr to Oct". It answers one month range of two different months, such as `Apr-Oct` or `Dec-Feb`, which `monthsInRange` reads, when the value is one rule made of that range alone or followed by weekdays and clock times that apply in it. A date range of whole months reads as that month range: `Feb 01-Nov 30` is `Feb-Nov`, with Feb 28 or Feb 29 as the end of February. A month range on its own that is `closed` or `off` reads as the months around it: `Feb-Apr closed` is `May-Jan`. It answers null for anything it can't read with certainty: times only, sunrise and sunset, week numbers, years, dates that aren't whole months, holidays, more than one month range or rule, closed months that leave one month or none, `closed` or `off` with anything more, `unknown`, comments, and values that aren't OSM syntax. Show no season for null.

```ts
import { openMonths } from "@opencampingdb/feedback";

openMonths("Apr-Oct Mo-Su 08:00-18:00"); // "Apr-Oct"
openMonths("Dec-Feb"); // "Dec-Feb"
openMonths("Feb 01-Nov 30 Mo-Fr 08:00-17:00"); // "Feb-Nov"
openMonths("Feb-Apr closed"); // "May-Jan"
openMonths("Mo-Fr 08:00-17:00"); // null
openMonths("Jan-Mar,Jun-Aug"); // null
```

Write open months with `withOpenMonths(value, range)`, from one From and To month pair, so `openMonths` always reads it back. It puts the range, such as `Apr-Oct` or `Dec-Feb`, in front of the weekly hours and replaces the months `openMonths` reads, so a date range of whole months becomes a month range and closed months on their own become the range alone. It throws a `RangeError` and writes nothing when the range isn't two different months, or when the value is anything other than empty, plain weekdays and clock times, or one month range followed by them: more than one rule, sunrise and sunset, holidays, open ends, `off`, comments and values that aren't OSM syntax. Leave such a value for the traveller to edit by hand. `withoutOpenMonths(value)` takes the open months off again and gives the weekly hours, or `""` for a month or date range on its own and for closed months on their own. A value `openMonths` answers null for comes back unchanged.

```ts
import { withOpenMonths, withoutOpenMonths } from "@opencampingdb/feedback";

withOpenMonths("", "Apr-Oct"); // "Apr-Oct"
withOpenMonths("Mo-Su 08:00-18:00", "Apr-Oct"); // "Apr-Oct Mo-Su 08:00-18:00"
withOpenMonths("Apr-Oct Mo-Fr 09:00-17:00", "May-Sep"); // "May-Sep Mo-Fr 09:00-17:00"
withOpenMonths("Mo-Fr 08:00-17:00; Sa 09:00-12:00", "Apr-Oct"); // throws RangeError
withoutOpenMonths("Apr-Oct Mo-Su 08:00-18:00"); // "Mo-Su 08:00-18:00"
withoutOpenMonths("Dec-Feb"); // ""
```

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

**First-hand reports.** A report of what a person at the place sees may carry `first_hand`, to say the traveller was at the place in the last month (`FIRST_HAND`). These are the kinds in `FIRST_HAND_KINDS`: `fact`, `doubt`, `name`, `closed`, `reopened`, `kind` and `wrong_location`. The two values are:

- `seen_nearby` when your app saw the device within its set distance of the place in the last 30 days, for example from a check or a saved visit.
- `says_so` when location is off and the traveller answered yes to "Are you at this place now, or were you here in the last month?". Ask that question in these words, and only when your app has no location to go on.

Leave it out when neither is true, and never send the location itself. Any other value, or `first_hand` on another report kind (`other`, `description`, `remove`, `contact`, `commons_mismatch` and `new_place`), is refused. The intake keeps it on the report, reviewers see it, and the apply run writes it on the applied item in the inbox as `report.first_hand`, so the data's MapRoulette tasks can count first-hand sources: a traveller's value reaches mappers only when at least one of its sources is first-hand.

```ts
await feedback.report({ place, report: { kind: "fact", fact: "toilets", value: true, first_hand: "seen_nearby" }, consent: true });
await feedback.report({ place, report: { kind: "doubt", fact: "pets", first_hand: "says_so" }, consent: true });
await feedback.report({ place, report: { kind: "closed", first_hand: "seen_nearby" }, consent: true });
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

A place is listed when its report came from an attested install (an app key with `requires_attestation`) and its note, with contact details stripped as the inbox keeps it, passes `textProblem`. A report without a `contributor` is listed under the attested key's contributor id on iOS, and on Android under one the intake makes from the hashed install, so a moderator can still block that install. Other new places reach a person through the apply run as before. `kind` is the code the traveller picked, or `null`; look its group up in `data/schema/kinds.json`. `name` is the report's `name` after `tidyName`, or `null` when it had none. `standing` is `shown` or `confirmed` until the place reaches the data, worked out with `newPlaceStanding` as checks and `remove` reports on the place's id arrive, so a place two other devices on two different client networks report leaves the list on the next refresh. Only `still_there` checks with `nearby: true` count towards `confirmed`. `description`, `fee` and `contacts` (the contact facts and the `address`) are there when the report carried them and they passed the checks, as the place will be published with them. The list never carries the note or a device id. `contributor` is the hashed id, so hide what a traveller blocked on the phone. The intake also keeps the block list the apply run sends: a blocked contributor's new places leave the list, and later ones are accepted to the inbox but not listed.

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

**Keeping the data fresh.** A data release follows each merge into the data within minutes, and the recent list covers only the minutes in between. The recent list names the newest release once the release workflow has told the intake of it, `"release": {"data_version": "20261107T110000Z-abc1234", "published": "2026-11-07T11:04:00Z"}` (with `layout_version` when the release sends one). Fetch the release's `manifest.json` only when that `release.data_version` differs from the one the phone has, and at most once an hour. Never poll GitHub on a timer: every phone asking on a schedule adds up to load that GitHub's Acceptable Use Policies let it throttle. The release updater (section 10) does this when it is given the list's `release.data_version`. Compare times with `dataVersionTime`. Intakes from before SDK 0.17.0, and one not yet told of a release, have no `release`, and then there is nothing to ask GitHub about.

### What became of a contribution

Every item the intake accepts gets a progress record: where it is, from received to in the data. Ask with `feedback.progress(ids)`, by the id the intake answered when the item was sent: `outcome.id` in `onAnswered`, or `id` in a `sent` result. Keep that id with your own record of the contribution. Ask on launch and when the app shows the traveller their contributions.

```ts
import { progressInRelease } from "@opencampingdb/feedback";

const progress = await feedback.progress(mine.map((c) => c.feedbackId)); // one answer per id, in the same order
for (const p of progress) {
  if (p.state === "in_data") showDone(p.id, progressInRelease(p, manifest.data_version) ? "in your data" : "in the next data release");
  else if (p.state === "refused") showRefused(p.id, p.reason);
  else showWaiting(p.id, p.state);
}
```

`progress` calls the public `GET /v1/feedback/progress?ids=fb_...,fb_...` at once and never queues. It asks for up to 100 ids a call and splits a longer list. An id that is not a feedback id, such as a photo's `pho_` id, is answered `unknown` without asking: ask the photo client's `photos.progress(ids)` for photos, which answers in the same shape (see [photos.md](photos.md), "What became of a photo"). It throws `ProgressRequestError` when the intake cannot be reached (`httpStatus` 0) or refuses the call (`httpStatus` is the HTTP code), so try again later. The states are `PROGRESS_STATES`:

| State | What it means | What to show |
| --- | --- | --- |
| `received` | The intake has it, and nothing is decided yet. `held_reason` says why when the intake held it at send time. | Sent, waiting for a decision. |
| `live` | The intake put it live when it was sent, and it is not in the data yet. | Live: it shows through the recent changes. |
| `waiting` | It needs more reports, or its place is not in the data yet. `reason` says which. | Waiting for others to confirm it. |
| `accepted` | The rules accepted it, and it is on its way into the data. | Accepted. |
| `held` | A reviewer decides it, as for a name, a description or an owner claim. | With a reviewer. |
| `refused` | Refused, with `reason`. `by` is `rules` when the rules refused it, or `reviewer` when a person merged or closed the review PR without it, or closed the automatic PR without merging. | Not taken, with the reason. |
| `in_data` | Its change is in the data, as of `in_data_at`. | Done. It shows from the next data release, or at once through the recent changes for a fact that went live. |
| `unknown` | The intake has no record of it: not sent to this intake, or more than 90 days without a change. | Nothing. |

`in_data_at` is the time of the data commit that brought the change in. `progressInRelease(progress, dataVersion)` is true when the change is `in_data` and its `in_data_at` is no later than the commit time in your release's `data_version`, as `withRecentChanges` reads it. A new place merged into another place answers `in_data` with `place` set to the place it went into. A record never carries the traveller's words, a device or a contributor: only the state, the engine's reason, `held_reason`, `by`, the place and times. Records are kept for 90 days after they last change. An owner claim's progress stops at `accepted` or `held`: owner submissions answer directly, and what becomes of them after that is outside progress. A state this SDK does not know is answered `unknown`.

## 6. Reviews: contributors, reports and blocking

App stores ask any app that shows reviews to filter objectionable content, let people report it and block abusive users. The engine does each part; the app supplies who wrote a review and the buttons.

**Contributor.** Send `contributor` with every review and review report: an opaque id for the signed-in account, such as an HMAC of the account id with a key only your server knows. Never send a name, email or the raw account id. It is 16 to 128 characters of letters, digits, `_` and `-`. The intake hashes it again with its own salt and the app's name before storing it, so the published id (`ctr_` and 16 hex characters) cannot be traced back to your account, and the same account has different ids in different apps. Reviews without a contributor get `400 contributor_required`, unless your app key uses App Attest (section 7), in which case the attested install stands in for an account. For photos the contributor value also decides who may remove and erase a traveller's photos, so keep it secret from other users, or give the photo app key `contributor_proof_key` so a removal needs a proof from your server (docs/photos.md).

**What happens to a review.**

- One review per contributor per place: a newer one replaces the older.
- A contributor's first review is held for a person. Once one of their reviews or other feedback has been accepted, later reviews are published at the next apply run.
- Text sent word for word for another place is held for a person.
- Each contributor may send 200 submissions a day (the app key can set `contributor_daily_limit`), and so may each install and each App Attest key. Each client network may send 500. An install's reports about one released place in a day count as one of the install's and the contributor's submissions, up to 100 reports a place, so a full edit of a place (`reportFacts`) costs the traveller one. Each report still counts against the app's daily limit and the client network's.

**Was there.** Set `review.visited_nearby: true` only when your app saw the phone within its set distance of the place in the 60 days before the review, for example from a check or a saved visit. Never send the location. It is published with the review so apps can show it. An app key with `requires_visited_nearby` refuses reviews without it (`400 visited_nearby_required`).

**Reporting a review.** Every published review has a stable `id`. Give each review a Report action:

```ts
import { REVIEW_REPORT_REASONS } from "@opencampingdb/feedback";
// spam_ad, offensive, off_topic, fake, personal_details

await feedback.reportReview({ place, review: "rev_01JC...", reason: "offensive", contributor, consent: true });
```

Every report goes to a person on the `feedback/review` PR, who looks at reported reviews within 24 hours. Reports from three different contributors, on three different client networks, hide the review at the next apply run, until the person decides. A person can hide a review, or block its contributor: everything a blocked contributor sends is refused (except a request to erase their own reviews, or to remove or erase their own photos), and their reviews are left out of the release and the rating. For personal details or a takedown, a person removes the review from the data (`python -m pipeline.moderate remove` in `data`), which lists its id in `moderation/removed_reviews.json`. The apply run refuses a review with a listed id, so a removed review is never written back.

**Erasing a traveller's reviews.** When a traveller deletes their account, or deletes their data in your app, remove every review they wrote:

```ts
await feedback.eraseReviews({ contributor, consent: true });
```

Send the same `contributor` value their reviews were sent with. The next apply run takes every one of their reviews out of the data, on every place, works out the ratings again, and drops any review still waiting for a person. Reviews they sent before the erasure and still in the queue are refused. The erasure is queued and retried like other feedback, its progress is `accepted` once a run has decided it, and the reviews leave the data when the automatic PR merges. It is honoured for a blocked contributor too. Erasing a contributor with no reviews succeeds. The data repository is a public git repository, so earlier commits still hold the removed lines: they leave the release, the ratings and the current files, not the history.

The contributor value is all an erasure names, so anyone who learns it could erase that traveller's reviews. Keep it secret from other users, or give the app key `contributor_proof_key` (self-hosting.md): the intake then takes an erasure only with a proof your server signed for the signed-in account, with `action: "review_erasure"` and `photo: "*"`, the same as for photos (docs/photos.md, "Prove the account for removal and erasure"):

```ts
// On your server, for the signed-in account only:
const proof = await signContributorProof(privateKey, { app: "example-app", contributor, action: "review_erasure", photo: "*", issued: now, expires: now + 600 });
// In the app:
await feedback.eraseReviews({ contributor, contributorProof: proof, consent: true });
```

Photos are erased separately, with the photo client's `erasePhotos`, on your own photo service.

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

Items older than 30 days, or past the 100 newest, are dropped unsent. A full queue never drops an erasure (`eraseReviews`, `erasePhotos` or `removePhoto`) to make room: the oldest item of any other kind goes instead, and when only erasures are left, the queue keeps all of them past the limit. `onAnswered` hears of each item dropped this way, with `httpStatus` 0, and a call whose own item was dropped answers `rejected` with `httpStatus` 0.

**A wrong clock.** A queued item whose `queuedAt` is ahead of the phone's clock was queued while the clock was ahead, so on the next flush it is counted as queued now and is due at once. No item waits past the longest backoff, 6 hours, from the flush, or a day when the intake asked it to wait. A `Retry-After` or a batch item's `retry_after` waits at most a day.

**A failed save after a send.** When the queue can't be saved after a flush has sent or dropped items (storage full, say), the call still answers from what the intake said, and `onAnswered` is still called, instead of rejecting with the storage error. The stored queue still holds those items until a later save succeeds, and after a restart they go again under the same idempotency keys, so the intake stores each once. A flush that settled nothing still rejects when its save fails.

**An unreadable queue.** When the stored queue can't be read (a write cut short, or text that is not a list), the client moves its text to `<storagePrefix>.queue.corrupt`, which keeps the latest such text, before anything is saved over it, starts again with an empty queue, and calls `onQueueUnreadable({ keptAt })` if you passed it. The items in that text are not sent and `onAnswered` is not called for them, so report it, for example to an error tracker, and read the kept text from storage if you need to find out what was in it. The hook is not waited for, and errors it throws are caught.

```ts
const feedback = createFeedbackClient({
  // ...
  onQueueUnreadable: ({ keptAt }) => reportToTracker("feedback queue unreadable", { keptAt }),
});
```

**Timeouts.** Each request to the intake, including reading its answer, and each call of your `attest` function is given up on after `timeoutMs` (default 30 000), and treated as offline: the item stays queued and is tried again later. The client passes an `AbortSignal` as `signal` in the fetch's `init`, and abandons a fetch that ignores it. Without a timeout, one stalled connection on weak coverage would hold every later call. The queue saves one change at a time, so a call made while a send is under way, even with `{ wait: false }`, waits for it, at most `timeoutMs`.

**Which refusals drop an item.** An item is dropped only on the intake's own refusal, which is always JSON with a string `error`. A 4xx answer without one, such as a firewall's or a proxy's HTML page, keeps the item to try again with backoff, so a block page in front of the intake never empties a queue.

**Batches.** A flush sends its due items together, up to 50 in one `POST /v1/feedback/batch`, with one attestation over the whole batch body: your `attest` function is called once a batch, with the batch's body and its SHA-256. On Android that is one Play Integrity token a batch instead of one an item. Google's default is "up to 10,000 total requests per day across all installs" (developer.android.com/google/play/integrity/overview), and you can ask for more, so sending one token per item would stop an app's Android contributions at 10,000 a day across every user. Set `maxBatchSize` (1 to 50, default 50) to send fewer at a time. A flush with one item due sends it alone to `POST /v1/feedback`, and `report()` and the other calls behave and answer as before.

Each item in a batch is answered as it would be alone, and settled the same way: sent, dropped on a refusal, or kept on a 429 (with its own `retry_after`). An item waiting for a new place's id goes in the next batch of the same flush once a batch has given the new place its id. When the whole batch fails (offline, 408, 429, 5xx or a refused assertion), every item in it is kept and the flush stops. When the intake refuses the batch itself with 400, 403 or 413 (its own JSON refusal; any other such answer keeps every item), which says nothing about any one item, the client sends that batch's items again one at a time, so each gets its own answer, and goes on batching after. Only a 401 `invalid_app_key` drops every item of a batch at once. An intake without the batch route answers 404 or 405, and the client then sends one item at a time for the rest of its life. Owner submissions and photos are never batched. Each item keeps one idempotency key every time it is sent, alone or in a batch, so an intake that took it before answers the same again and stores it once (see [self-hosting.md](self-hosting.md), "Idempotency keys"). An older intake ignores the keys.

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
| `unlikely_charge` | A `charge` or `charge_powered` over 250 AUD a night, or more than 50% above or below the place's current charge, so a person checks it. |
| `commons_report` | A report that a Commons photo is not of the place. Hide it for the traveller who sent it; a reviewer decides, and two sources hide it for everyone. |

Being held is not a refusal: a reviewer (a person, bot or AI the maintainers allow) decides the item. Adding a code later is additive. A code this version does not know is left out of `heldReason`, and `state` is still `held`. `itemDecision(answer)` reads `state` and `heldReason` from an intake answer you fetched yourself.

### The stored queue belongs to the SDK

The keys under the storage prefix (`ocdb.feedback.` and `ocdb.photos.` by default) are private to the SDK. What they hold and how it is laid out may change in any release, so an app never reads, parses or writes them. From SDK 0.29.0 an app uses three calls instead, on either client. Each answers for its own client's queue, sees every item queued by an earlier call, and the last two make no request and change nothing in the queue. The only write they can cause is a one-off save of new idempotency keys, when one of them is the client's first call over a stored queue holding an item whose key the intake would refuse.

`flush({ ignoreBackoff: true })` tries every queued item now, for example when the app opens on good signal after a day offline. It skips the client's own backoff after a failed try, but each item waits out the wait the intake gave it (a 429 with `Retry-After`, or a batch item's `retry_after`). The wait is kept per item, so an item the intake has not yet answered is tried once, even when another item is waiting out a long wait. An item that went into an intake wait under an SDK older than 0.29.0 carries no record of that wait, so the first `flush({ ignoreBackoff: true })` after an app updates tries it once. An item waiting for a new place's id still waits, and items older than 30 days are still dropped.

```ts
const sub = AppState.addEventListener("change", (state) => {
  if (state === "active") void feedback.flush({ ignoreBackoff: true });
});
```

`queueSummary()` says how the queue stands, in counts and times only, so it is safe to send to an error tracker: it never holds what a traveller wrote, the device or the contributor.

```ts
const summary = await feedback.queueSummary();
// { items, tried, oldestQueuedAt, mostAttempts, types, nextAttemptAt, intakeWaitUntil, waitingForNewPlace }
const stuck = summary.oldestQueuedAt !== null && Date.now() - summary.oldestQueuedAt > 3 * 24 * 60 * 60 * 1000;
if (stuck && summary.intakeWaitUntil === null) reportToTracker("feedback queue stuck", summary);
```

`intakeWaitUntil` is the end of the longest wait the intake asked for, or null, so a queue the intake has asked to wait is not reported as a fault. `nextAttemptAt` is when the next item is due, or null when every item is due now or waits for a new place. On the photo client `waitingForNewPlace` is always 0, because its photos waiting for a new place are not queue items: they are in `queuedRefs().waitingPhotoKeys`.

`queuedRefs()` answers the `ref` of each item still queued, in queue order, then of each item already settled whose answer `onAnswered` has not finished with yet, leaving out items queued without one, so an app can tell an item still with the SDK from one that is lost. On the photo client it also answers `waitingPhotoKeys`, the `key` of each photo still waiting for a new place's id: keep those files.

```ts
const { refs } = await feedback.queuedRefs();
const unsent = new Set(refs);
for (const draft of await drafts.all()) if (!unsent.has(draft.id)) await drafts.markLeftQueue(draft.id);

const { waitingPhotoKeys } = await photos.queuedRefs();
await photoFiles.deleteAllExcept(waitingPhotoKeys);
```

An older SDK ignores the one field 0.29.0 adds to a queued item and waits as before, so after a rollback a queue written by 0.29.0 is still read and sent.

## 9. Show the attribution

Wherever Open Camping DB data appears, show `ATTRIBUTION`:

```tsx
import { Text } from "react-native";
import { ATTRIBUTION } from "@opencampingdb/feedback";

<Text style={{ fontSize: 11, opacity: 0.7 }}>{ATTRIBUTION}</Text>;
```

## 10. Keeping the data current

Each Open Camping DB release comes as an SQLite database, `ocdb.sqlite.gz`, with changesets that update the databases of the last 50 releases to it. The tables, columns and indexes, and how the changesets are made, are in the data repository's [CONNECTING.md](https://github.com/opencampingdb/data/blob/main/CONNECTING.md), sections "The SQLite database" and "Changesets". `layout_version`, in the manifest and in the database's `release` table, names the version of those tables, and no changeset crosses a change of it.

### The release updater

`createReleaseUpdater` keeps the app's copy of the database at the newest release. The app gives it an adapter over its own SQLite library:

```ts
interface ReleaseDatabaseAdapter {
  currentDataVersion(): Promise<string | null>; // release.data_version, or null with no database
  currentLayoutVersion(): Promise<number | null>; // release.layout_version, or null with no database
  applyChangesets(chain: Uint8Array[]): Promise<void>; // the whole chain in order, in one exclusive transaction, all or nothing
  replaceDatabase(bytes: Uint8Array): Promise<void>; // swap the whole file in one step
  candidateDataVersion?(bytes: Uint8Array): Promise<string | null>; // optional: release.data_version in a downloaded file, before the swap
}

const updater = createReleaseUpdater({
  adapter,
  readableLayouts: [1], // the layout versions this build reads
  readableFormats: [12], // the format versions this build reads
  gunzip, // where there is no DecompressionStream, as in React Native
  // fetch: defaults to globalThis.fetch, which must follow redirects
  // manifestUrl: defaults to https://github.com/opencampingdb/data/releases/latest/download/manifest.json
  // storage: optional, such as AsyncStorage, to remember a release that did not match across restarts
});

const result = await updater.update({ knownDataVersion: recent.release?.data_version });
// { status: "up_to_date" | "updated" | "replaced" | "older_release" | "layout_unsupported" | "format_unsupported" | "failed", dataVersion, reason?, cause? }
```

`update()` does this:

1. When `knownDataVersion`, the recent list's `release.data_version`, is the database's own, it answers `up_to_date` with no request.
2. Otherwise it fetches the manifest, one request. When its `format_version` is higher than every one in `readableFormats`, it stops, keeps the database and answers `format_unsupported`: the records have changed in a way this build can't read. A lower format is read, as CONNECTING.md says. When its `layout_version` is not in `readableLayouts` it stops the same way and answers `layout_unsupported`. When its `data_version` is the database's own, it answers `up_to_date`. When its `data_version` is older than the database's own (an older release marked latest), it changes nothing and answers `older_release`. When its `data_version` has no readable time and the database's has one, so it can't be shown to be newer, it changes nothing and answers `failed` with `manifest`. A manifest whose database url is not https is refused the same way, before anything is downloaded.
3. It uses only changesets served from the same release downloads as the database. Each changeset url is parsed as `fetch` reads it, which drops tabs and newlines and resolves `..`, and then its origin must be the database url's and its path must start with the database url's path less its last two parts (the release tag and the file), which on GitHub is `https://github.com/<owner>/<repo>/releases/download/`. Any other entry is ignored, so a bad manifest entry cannot send the app to another host or repository, and the url fetched is the one checked. It downloads the whole database when the app has none, when the layout differs from the database's, when no chain of changesets in the manifest leads from the database's `data_version` to the newest, when the chain is more than 50 files (`MAX_CHANGESET_CHAIN`), or when the chain's files add up to at least the database's own `bytes`. It answers `replaced`.
4. Otherwise it takes the chain with the fewest files, and of two as short, the one with more daily changesets. It downloads every file on it and checks each one's `bytes` and `sha256` before applying any, undoes gzip, then hands the whole chain to one `applyChangesets` call, which applies it in order in one exclusive transaction, and answers `updated`.
5. After the chain it reads `data_version` back from the adapter. When that is not the manifest's, it downloads the whole database and replaces the one the chain left, and answers `replaced`. After a replace, it answers `failed` with `mismatch` when the database still names another release.
6. When the adapter has `candidateDataVersion`, the updater asks it for the release a downloaded whole database holds before it calls `replaceDatabase`, and swaps the file in only when that is the manifest's `data_version`. Otherwise it answers `failed` with `mismatch` and the database is not touched, so a manifest that names a new release but points at an older file can't roll the app back. Without the call the release is read only after the swap, as in step 5, so give your adapter this call. It may write the bytes to the file it would swap in and keep that file for `replaceDatabase`, as the Expo adapter below does. When it throws, the update answers `failed` with `read`.
7. A manifest whose database did not hold its release (`mismatch`) is remembered by its `data_version` and the database's `sha256`, and answered `failed` with `mismatch` without a download until the manifest changes. The updater remembers it in memory, and in `storage` under the key `ocdb.release.failed` when you pass `storage`, so an app that calls `update()` on each launch does not download a 12 MB file each time.

A second `update()` call made while one is running gets the running one's result, whatever its options, so two parts of the app asking at once apply one chain.

`update()` never throws. On any failure it answers `failed` with a `reason`: `network` (a request failed or answered other than 2xx), `manifest`, `checksum`, `gunzip`, `read`, `apply` or `replace` (that adapter call threw), or `mismatch`, and a `cause`, `{ name, message }`, that says what went wrong behind it: the error a request, gunzip or adapter call threw (its name and message, no stack), or for the updater's own checks `HttpStatus`, `SizeMismatch`, `ChecksumMismatch`, `ManifestInvalid` or `ReleaseMismatch` with what it found. The message is cut to 500 characters (`MAX_CAUSE_MESSAGE`). Report both: `reason` groups failures, `cause` tells two of them apart. A failed download or checksum leaves the database as it was, because nothing is applied until every file has passed. The chain is one transaction, so when any changeset in it fails, the database stays on the release it started from and `dataVersion` names it. The next run tries the chain again. A failed replace leaves the old database in use. `dataVersion` is always the release the app's database holds after the run, so compare contribution progress against it (`progressInRelease`).

When to ask is the app's decision, within these limits. Ask only when the recent list names a release other than the phone's, and at most once an hour: pass its `release.data_version` as `knownDataVersion`, and the updater makes no request while the two agree. Never run the updater on a timer.

Gzip is undone with `DecompressionStream` where the runtime has it, as in browsers and Node. React Native 0.88 and Expo SDK 58 don't provide it, so pass `gunzip`, a function from the gzipped bytes to the plain bytes, such as `gunzipSync` from the pure JavaScript [`fflate`](https://www.npmjs.com/package/fflate) package. `createReleaseUpdater` throws when there is neither. The fetch must answer `arrayBuffer()`. In an Expo app pass `fetch` from `expo/fetch`: its `arrayBuffer()` hands JavaScript the native download without copying it, where React Native's own fetch reads a body as an `ArrayBuffer` through a base64 data URL (`FileReader.readAsArrayBuffer` in React Native 0.88), which makes more copies of a 12.2 MB file.

### Keep the traveller's own data apart

A changeset expects the release tables exactly as the release left them, and a whole database replaces them. So treat the release database as read only: add no rows, tables or triggers to it. Keep what the traveller makes, such as the places they added, their edits to released places, and links from the ids the app stored to the places they moved to, in a database of the app's own, attach the release to it, and read both through views.

```sql
-- In the app's own database, traveller.sqlite.
CREATE TABLE IF NOT EXISTS added_places (
  id TEXT PRIMARY KEY, -- the ocdb_ id from newPlaceId once the report is sent
  name TEXT,
  kind TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  record TEXT NOT NULL, -- the place as the app shows it, as JSON
  added TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS place_edits (
  place TEXT PRIMARY KEY, -- a released place's id
  name TEXT, -- NULL keeps the release's
  kind TEXT,
  facts TEXT, -- a JSON object of the facts the traveller set, laid over the release's
  edited TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS merged_ids (
  id TEXT PRIMARY KEY, -- an id the app stored
  merged_into TEXT NOT NULL -- the place it now points at
);
```

With the release database open as `main` and the app's own attached as `own`, these views read both. A view in `main` cannot name a table in an attached database, and the release database is read only, so make them `TEMP` views, again each time the connection opens:

```sql
CREATE TEMP VIEW all_places AS
SELECT p.id, COALESCE(e.name, p.name) AS name, COALESCE(e.kind, p.kind) AS kind, p."group", p.lat, p.lon, p.state,
  CASE WHEN e.facts IS NULL THEN p.record
       ELSE json_set(p.record, '$.facts', json_patch(json_extract(p.record, '$.facts'), e.facts)) END AS record,
  'release' AS source
FROM main.places AS p
LEFT JOIN own.place_edits AS e ON e.place = p.id
UNION ALL
SELECT a.id, a.name, a.kind, NULL, a.lat, a.lon, NULL, a.record, 'traveller'
FROM own.added_places AS a
WHERE NOT EXISTS (SELECT 1 FROM main.places WHERE id = a.id) -- the release has it now
  AND NOT EXISTS (SELECT 1 FROM main.merged WHERE id = a.id)
  AND NOT EXISTS (SELECT 1 FROM own.merged_ids WHERE id = a.id);

CREATE TEMP VIEW place_redirects AS
SELECT id, merged_into FROM main.merged
UNION ALL
SELECT id, merged_into FROM own.merged_ids WHERE id NOT IN (SELECT id FROM main.merged);
```

`all_places` prefers the traveller's name, kind and facts over a released place's, and shows a place the traveller added until a release has it under the same id, when the release's version takes over. Look an id the app stored up in `place_redirects` when `all_places` doesn't have it. Removing the traveller's data clears the app's own tables and leaves the release as it is.

### Expo SQLite

This adapter uses `expo-sqlite` (Expo SDK 58), whose `SQLiteSession.applyChangesetAsync` applies a session changeset, `expo-file-system` to write a whole database straight to a file, `expo/fetch` for the downloads, and `fflate` for gzip:

```sh
npx expo install expo-sqlite expo-file-system
npm install fflate
```

Each release database is a file of its own, and the name of the one in use is kept in `expo-sqlite/kv-store`. Replacing the database writes the new file, opens it and only then moves the name over, so the app reads its old database until the new one is ready, and an interrupted replace leaves it on the old one.

```ts
// release-database.ts
import { fetch } from "expo/fetch";
import { Directory, File, FileMode } from "expo-file-system";
import Storage from "expo-sqlite/kv-store";
import { defaultDatabaseDirectory, deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from "expo-sqlite";
import { gunzipSync } from "fflate";
import { createReleaseUpdater, type ReleaseDatabaseAdapter, type ReleaseFetchLike } from "@opencampingdb/feedback";

const CURRENT = "example-app.release-file";
const TRAVELLER_TABLES = `...`; // the CREATE TABLE statements above
const TRAVELLER_VIEWS = `...`; // the CREATE TEMP VIEW statements above
const SLICE_BYTES = 1024 * 1024;

let traveller: SQLiteDatabase | null = null;
let release: SQLiteDatabase | null = null;

async function travellerDatabase(): Promise<SQLiteDatabase> {
  if (!traveller) {
    traveller = await openDatabaseAsync("traveller.sqlite");
    await traveller.execAsync(TRAVELLER_TABLES);
  }
  return traveller;
}

async function openRelease(name: string): Promise<SQLiteDatabase> {
  const db = await openDatabaseAsync(name);
  try {
    // Throws when the file is not an SQLite database with a release table.
    await db.getFirstAsync("SELECT data_version FROM main.release");
    await db.runAsync("ATTACH DATABASE ? AS own", (await travellerDatabase()).databasePath);
    await db.execAsync(TRAVELLER_VIEWS);
    return db;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}

/** The release database, with the traveller's tables attached, or null before the first one. */
export async function releaseDatabase(): Promise<SQLiteDatabase | null> {
  if (release) return release;
  const name = await Storage.getItemAsync(CURRENT);
  if (name) release = await openRelease(name);
  return release;
}

async function releaseRow() {
  const db = await releaseDatabase();
  return db ? await db.getFirstAsync<{ data_version: string; layout_version: number }>("SELECT data_version, layout_version FROM main.release") : null;
}

/** A file candidateDataVersion wrote, kept for replaceDatabase. Deleted when it is not swapped in. */
let staged: { bytes: Uint8Array; name: string; file: File } | null = null;
function dropStaged() {
  try {
    staged?.file.delete();
  } catch {
    // Nothing to tidy.
  }
  staged = null;
}

/** Writes `bytes` to a new file in expo-sqlite's directory, a slice at a time. */
async function writeDatabaseFile(name: string, bytes: Uint8Array): Promise<File> {
  const directory = new Directory(`file://${defaultDatabaseDirectory}`);
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, name);
  file.create();
  const handle = file.open(FileMode.WriteOnly);
  try {
    // writeBytes copies what it is given into native memory, so slices keep that copy to 1 MiB.
    for (let at = 0; at < bytes.length; at += SLICE_BYTES) await handle.writeBytes(bytes.subarray(at, at + SLICE_BYTES));
  } finally {
    handle.close();
  }
  return file;
}

const adapter: ReleaseDatabaseAdapter = {
  currentDataVersion: async () => (await releaseRow())?.data_version ?? null,
  currentLayoutVersion: async () => (await releaseRow())?.layout_version ?? null,

  async applyChangesets(chain) {
    const db = await releaseDatabase();
    if (!db) throw new Error("no release database");
    // One exclusive transaction for the whole chain, on a connection of its own with only the
    // release database open: a throw anywhere rolls every changeset back.
    await db.withExclusiveTransactionAsync(async (txn) => {
      const session = await txn.createSessionAsync();
      try {
        for (const changeset of chain) await session.applyChangesetAsync(changeset);
      } finally {
        await session.closeAsync();
      }
    });
  },

  // Writes the download to the file replaceDatabase will swap in, and reads its release.
  async candidateDataVersion(bytes) {
    dropStaged();
    const name = `ocdb-${Date.now()}.sqlite`;
    const file = await writeDatabaseFile(name, bytes);
    try {
      const db = await openDatabaseAsync(name);
      try {
        const row = await db.getFirstAsync<{ data_version: string }>("SELECT data_version FROM main.release");
        staged = { bytes, name, file };
        return row?.data_version ?? null;
      } finally {
        await db.closeAsync();
      }
    } catch (error) {
      file.delete();
      throw error;
    }
  },

  async replaceDatabase(bytes) {
    // The file candidateDataVersion wrote for these bytes, or a new one.
    const kept = staged?.bytes === bytes ? staged : null;
    if (!kept) dropStaged();
    staged = null;
    const name = kept?.name ?? `ocdb-${Date.now()}.sqlite`;
    let file: File | null = kept?.file ?? null;
    let next: SQLiteDatabase | null = null;
    try {
      file ??= await writeDatabaseFile(name, bytes);
      next = await openRelease(name);
      const previous = await Storage.getItemAsync(CURRENT);
      await Storage.setItemAsync(CURRENT, name); // the step that moves the app to the new release
      const old = release;
      release = next;
      // The app is on the new release now, so tidying up must not fail the replace.
      await old?.closeAsync().catch(() => {});
      if (previous) await deleteDatabaseAsync(previous).catch(() => {});
    } catch (error) {
      if (next && release !== next) await next.closeAsync().catch(() => {});
      if (release !== next) {
        try {
          file?.delete();
        } catch {
          // Nothing to tidy.
        }
      }
      throw error;
    }
  },
};

export const releaseUpdater = createReleaseUpdater({
  adapter,
  readableLayouts: [1],
  readableFormats: [12],
  fetch: fetch as unknown as ReleaseFetchLike,
  gunzip: (bytes) => gunzipSync(bytes),
});

const HOUR = 60 * 60 * 1000;
let lastAsked = 0;

/**
 * Call each time the app reads the recent list, with the list's newest release.
 * Asks GitHub only when that differs from the phone's, and at most once an hour.
 */
export async function updateRelease(knownDataVersion: string | undefined) {
  if (knownDataVersion === undefined) return; // the list names no release, so there is nothing to ask about
  if (knownDataVersion === (await adapter.currentDataVersion())) return;
  if (Date.now() - lastAsked < HOUR) return;
  lastAsked = Date.now();
  const result = await releaseUpdater.update({ knownDataVersion });
  if (result.status === "failed") console.warn("data update failed", result.reason, result.cause); // try again next time
  return result;
}
```

Things to know about it:

- **Conflicts are replaced, not refused.** expo-sqlite 58's `applyChangesetAsync` settles every conflict with `SQLITE_CHANGESET_REPLACE` (in `ios/NativeSession.swift` and `android/src/main/cpp/NativeSessionBinding.cpp`), and takes no conflict handler. So a changeset that `sqlite3changeset_apply` would refuse, as the data repository's own check does, goes through and overwrites the row it meets. That is safe for two reasons only. The app never writes to the release tables (above), so a changeset applied to its own `from` release meets no conflict. And after the chain the updater reads `data_version` back from the `release` table: when it is not the manifest's, it downloads the whole database and replaces the one the chain left. That check sees a chain that ended on the wrong release. It can't see a row the app changed elsewhere in the release tables, which is why they must stay read only.
- `withExclusiveTransactionAsync` runs on a new connection, so the attached `own` database and the temp views are not on it, and the chain touches the release tables alone. Other writes to the release database would fail with `database is locked` meanwhile, and the app makes none.
- The app's other code should read through `releaseDatabase()` each time rather than keep the connection, because a replace closes the old one. Run `updateRelease` when no screen is in the middle of reading the release, or reopen what a screen shows after it answers `updated` or `replaced`.

An app that ships a database in its build can copy it in on first launch with `importDatabaseFromAssetAsync`, then set `CURRENT` to its name. Until then `currentDataVersion` answers null, and the first update downloads the whole database.

### Memory on a phone

A whole database is the largest thing the updater handles: 67.4 MB, 12.2 MB gzipped, with 96,364 places, as opencampingdb/data#105 measured it. With the adapter above, the phone holds at most the download and the plain database at once:

| Step | Held | Peak |
|---|---|---|
| `expo/fetch` downloads the file, and `arrayBuffer()` hands JavaScript the native buffer without a copy | 12.2 MB gzipped | 12.2 MB |
| The updater checks its size and SHA-256 in place, copying only the last 64 or 128 bytes | 12.2 MB | 12.2 MB |
| `gunzipSync` allocates exactly the size the gzip trailer gives and inflates into it | 12.2 MB + 67.4 MB | **79.6 MB** |
| The updater lets go of the download and calls `candidateDataVersion`, then `replaceDatabase`, with the one plain copy | 67.4 MB (the 12.2 MB until it is collected) | 79.6 MB |
| `writeDatabaseFile` writes 1 MiB slices, each copied to native memory once, in `candidateDataVersion`, and `replaceDatabase` swaps in that file | 67.4 MB + 1 MiB | 79.6 MB |
| SQLite opens the file and reads pages as queries need them | its page cache | |

So the peak is about 80 MB, while gunzip runs, and the JavaScript copy is free to be collected once `replaceDatabase` returns. Writing with `File.write(bytes)` instead would copy the whole 67.4 MB once more on iOS (`FileSystemFile.write` builds a `Data` from the buffer), and opening the bytes with `deserializeDatabaseAsync` would hold a second whole copy as an in-memory database. A chain's downloads add up to fewer bytes than the database's (step 3), and the chain is held only while one transaction applies it.

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
