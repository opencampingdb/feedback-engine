# Owners: claims, updates and private property listings

The people who run a place can claim it, keep its details up to date and close it for a while. Owners of private land can list it as a farm stay. There are no accounts: a claim returns a token, and a person approves each claim before anything about an owner is published.

The owner page at https://opencampingdb.github.io/owners/ does all of this in a browser. Apps can send owners there, or use the SDK calls below.

## Add a "Do you run this place?" link

The simplest integration is a link from your place screen:

```
https://opencampingdb.github.io/owners/claim.html?place=ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA
```

The page fills in the place id, shows the owner terms and takes the owner through the claim.

## How a claim works

1. The owner sends a claim (`owner_claim`) for a place in the data, or a listing (`owner_listing`) for private land that is not. The intake answers with an id, a short code such as `OCDB-7KQ2`, and a token. The token is shown once and never stored: the intake keeps only its SHA-256.
2. The owner puts the code on their own website or public Facebook page, at the address they gave as `proof_url`.
3. Each apply run fetches that page and looks for the code. Once it is there, the claim goes to the `feedback/review` PR on the data repository with an approval box and the label `owner-claim`. After 7 days without it, the claim goes there marked as not found, with that run's fetch. A claim the run had no time to fetch waits for the next run, so the box always shows a fresh check. Each run sends at most 20 claims and listings to a person, oldest first, so every approval box fits in the PR text. The rest wait for the next run. A claim is recorded as sent only once GitHub has accepted the PR text with its box: if GitHub refuses it, the claim waits in the inbox and goes with a later run.
4. A person checks that the proof page belongs to the place, ticks the box and merges the PR. The box shows the address the code was found at, written as code so it is never a link, and flags it when a redirect led to a different site from the one submitted. The next run writes the owner record in the private inbox and marks the place `owner_verified: true`, or adds the farm stay, through the automatic PR. Unticked boxes in a merged PR, claims in a PR closed without merging, and claims with no decision within 60 days of reaching the PR are refused.
5. From then on the owner sends updates (`owner_update`) with the token. A matching token is applied within the hour. A wrong token, or a token for another place, is refused. An update that would leave the record failing the data repository's checks goes to a person with the reason instead: `pets_months` on a place whose `pets` is not `seasonal`, or a farm stay the owner listed losing `entry: private` or `booking_required: true`. Setting `pets` to anything but `seasonal` takes `pets_months` off.

A lost token means claiming again. Once approved, the new claim replaces the old token.

Pages that need a login to see, which includes most Facebook pages, cannot be checked. A person can still approve the claim, but asks the owner to use a public page where possible.

## What an owner can change

Applied directly, each with the source `owner`:

- facts: every fact a traveller may report (see integration.md section 5), including the site features, `brand`, `email`, `phone_2` and the social pages, plus `booking_url` and `booking_required`. Road `access` and `water_type` are left to travellers and OSM
- `description`: plain text, up to 500 characters, checked like review text. An empty string removes it.
- `status: "temporarily_closed"` with a `reopens` date (`YYYY-MM-DD`, after today), on a place that is not `closed`. The place reopens by itself on that date. `status: "open"` ends a temporary closure early.

Sent to a person instead: a new name, a new location, and reopening a place that is `closed`.

Owners never change reviews, ratings or checks. When a device reports a value that differs from one the owner set, a person decides, and the owner's value stays until then. The same goes for `contact` reports that say a contact the owner set is wrong or spam: however many arrive, a person decides and the contact stays until then. When two devices report that an `owner_verified` place, or one whose status the owner set, has closed, a person decides too. One report changes nothing.

## Private property listings

A listing becomes a record with kind `farm_stay` (group `overnight`), `osm: null`, the fact `entry: "private"`, the fact `booking_required: true`, and the `booking_url` or `phone` the owner gave. Open Camping DB never lists private land unless its owner adds it.

Apps should show, for every `farm_stay`: **Private property. Book with the owner first.**

## Showing owner data in an app

- `owner_verified: true`: the place's owner has been checked by a person. A small "Owner verified" label is enough.
- `status: "temporarily_closed"` with `reopens`: show "Closed until" and the date.
- `description`: the owner's own words. Show it as written, as plain text.
- `fact_sources` values of `owner` mark facts the owner set.
- `fact_dates` gives, for each of those values, when it was accepted (UTC). Apply writes a date with every `feedback` and `owner` value it sets.

## Submissions

All three go to `POST /v1/feedback` with the `X-App-Key` header, never in a batch. They carry `terms_accepted: true` instead of `consent`. Each device may send 5 owner submissions a day and each client network 10, and the app key's `owner_daily_limit` counts them apart from its other feedback.

```json
{
  "type": "owner_claim",
  "place": "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
  "device": "3b241101-e2bb-4255-8caf-4136c566a962",
  "app_version": "1.0.0",
  "terms_accepted": true,
  "owner": { "name": "Jo Bloggs", "email": "jo@example.com" },
  "claim": { "proof_url": "https://riverbend.example/about" }
}
```

```json
{
  "type": "owner_listing",
  "place": null,
  "location": { "lat": -36.85, "lon": 144.55 },
  "device": "3b241101-e2bb-4255-8caf-4136c566a962",
  "app_version": "1.0.0",
  "terms_accepted": true,
  "owner": { "name": "Jo Bloggs", "email": "jo@example.com" },
  "claim": { "proof_url": "https://riverbend.example/stay" },
  "listing": {
    "name": "Riverbend Farm Stay",
    "description": "Six grassy sites beside the river on a working sheep farm.",
    "facts": { "booking_url": "https://riverbend.example/book", "toilets": true }
  }
}
```

```json
{
  "type": "owner_update",
  "place": "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
  "device": "3b241101-e2bb-4255-8caf-4136c566a962",
  "app_version": "1.0.0",
  "terms_accepted": true,
  "token": "<the 43 character token>",
  "update": {
    "facts": { "power": true },
    "description": "Shady sites by the river, with power at six of them.",
    "status": "temporarily_closed",
    "reopens": "2026-12-01"
  }
}
```

Rules worth knowing:

- `proof_url` must be https on a public website (no IP addresses or local names).
- A listing needs `booking_url` or `phone` in its facts. A listing whose farm stay the data repository's checks would refuse, such as one with `pets_months` but no `pets: seasonal`, is refused at the next apply run with the reason.
- A description holding an email address, phone number or link is refused with `400`. Use the phone, website and booking fields.
- `owner` (name and email) is stored only in the private inbox and is never written to the data or a PR.

Answers: `202 {"id","code","token"}` for a claim or listing, `202 {"id"}` for an update, `400 invalid` with `details`, `401 invalid_app_key`, `403 type_not_allowed_for_app_key` for a key without `owner` in its `kinds`, `429 rate_limited` with `retry-after`, and `503 storage_unavailable` when the intake could not store it.

## SDK

Owner calls send at once and never queue, because the token in the answer is shown only once. They throw `OwnerTermsRequiredError` without the tick, `FeedbackValidationError` for a bad payload and `OwnerRequestError` (with `httpStatus`, 0 when offline) when the intake refuses or cannot be reached.

```ts
import { OWNER_TERMS_SUMMARY, OWNER_TERMS_URL } from "@opencampingdb/feedback";

// Show OWNER_TERMS_SUMMARY, a link to OWNER_TERMS_URL and a tick box first.
const { id, code, token } = await feedback.ownerClaim({
  place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
  owner: { name: "Jo Bloggs", email: "jo@example.com" },
  proofUrl: "https://riverbend.example/about",
  termsAccepted: true,
});
// Show code and token to the owner now, and tell them to keep the token.

await feedback.ownerUpdate(token, {
  place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
  update: { status: "temporarily_closed", reopens: "2026-12-01" },
  termsAccepted: true,
});
```

Do not store the token in your app unless the owner asks you to, and never send it anywhere but the intake.

## For the people who approve claims

- Claims and listings arrive in the `feedback/review` PR under "Owner claims", each with the proof check result. Owner names and emails are not in the PR; they are in `inbox/owner-claims/<claim id>.json`. The PR is public and nobody has approved a listing yet, so a listing's line shows only its id, where it is to 1 decimal place (about 11 km), the names of the facts it sent and whether it has a description. Read its name, description, fact values and exact location in the same inbox file before ticking. They are published only after you approve.
- A claim line shows the proof address cut to 120 characters. The full address is in the same inbox file.
- Each claim line says whether the proof address matches the website or social page the data holds for the place, and where that value came from. A match means the same site, and for a page on a host many people publish to, the same page or one under it. "Does NOT match" and "no website or social page in the data" mean the code alone proves nothing about the place: find the place's real site another way before ticking. A match with a value travellers or an owner set shows its date, because a value changed just before a claim is no proof.
- Open the proof page and check that it is the place's own site and that the code sits in the site's own content, not in a comment or review a visitor could have written. Then tick the box. Leave it unticked to refuse. Merge when done.
- Only boxes the bot wrote count: in the body of a PR the bot opened, or in a comment by the bot's own account (an account of type Bot, never a person's account with a similar name). A box counts only at the start of a line.
- A claim that says "Replaces the current owner" will retire the earlier owner's token once approved.
- The inbox keeps approved owners in `owners/<place id>.json` (token hash, claim id, approval date, email and name). To remove an owner, delete that file. The place keeps `owner_verified` until someone edits the record.
