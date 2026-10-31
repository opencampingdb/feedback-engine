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
3. Each hourly apply run fetches that page and looks for the code. Once it is there, the claim goes to the `feedback/review` PR on the data repository with an approval box and the label `owner-claim`. After 7 days without it, the claim goes there without another fetch, marked as not found.
4. A person checks that the proof page belongs to the place, ticks the box and merges the PR. The box shows the address the code was found at, and flags it when a redirect led to a different site from the one submitted. The next run writes the owner record in the private inbox and marks the place `owner_verified: true`, or adds the farm stay, through the automatic PR. Unticked boxes in a merged PR, and claims in a PR closed without merging, are refused.
5. From then on the owner sends updates (`owner_update`) with the token. A matching token is applied within the hour. A wrong token, or a token for another place, is refused.

A lost token means claiming again. Once approved, the new claim replaces the old token.

Pages that need a login to see, which includes most Facebook pages, cannot be checked. A person can still approve the claim, but asks the owner to use a public page where possible.

## What an owner can change

Applied directly, each with the source `owner`:

- facts: `fee`, `power`, `pets`, `tents`, `caravans`, `toilets`, `showers`, `drinking_water`, `dump_station`, `max_stay`, `opening_hours`, `entry`, `phone`, `website` and `booking_url`
- `description`: plain text, up to 500 characters, checked like review text. An empty string removes it.
- `status: "temporarily_closed"` with a `reopens` date (`YYYY-MM-DD`, after today), on a place that is not `closed`. The place reopens by itself on that date. `status: "open"` ends a temporary closure early.

Sent to a person instead: a new name, a new location, and reopening a place that is `closed`.

Owners never change reviews, ratings or checks. When two devices report a value that differs from one the owner set, a person decides. When two devices report that an `owner_verified` place, or one whose status the owner set, has closed, a person decides too. One report changes nothing.

## Private property listings

A listing becomes a record with kind `farm_stay` (group `overnight`), `osm: null`, the fact `entry: "private"`, the fact `booking_required: true`, and the `booking_url` or `phone` the owner gave. Open Camping DB never lists private land unless its owner adds it.

Apps should show, for every `farm_stay`: **Private property. Book with the owner first.**

## Showing owner data in an app

- `owner_verified: true`: the place's owner has been checked by a person. A small "Owner verified" label is enough.
- `status: "temporarily_closed"` with `reopens`: show "Closed until" and the date.
- `description`: the owner's own words. Show it as written, as plain text.
- `fact_sources` values of `owner` mark facts the owner set.

## Submissions

All three go to `POST /v1/feedback` with the `X-App-Key` header, like other feedback. They carry `terms_accepted: true` instead of `consent`, and count against a limit of 5 owner submissions per device, and 10 per client network, a day.

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
- A listing needs `booking_url` or `phone` in its facts.
- A description holding an email address, phone number or link is refused with `400`. Use the phone, website and booking fields.
- `owner` (name and email) is stored only in the private inbox and is never written to the data or a PR.

Answers: `202 {"id","code","token"}` for a claim or listing, `202 {"id"}` for an update, `400` with `details`, `401` for the app key, `429` for the limit.

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

- Claims and listings arrive in the `feedback/review` PR under "Owner claims", each with the proof check result. Owner names and emails are not in the PR; they are in `inbox/owner-claims/<claim id>.json`.
- Open the proof page and check that it is the place's own site, then tick the box. Leave it unticked to refuse. Merge when done.
- A claim that says "Replaces the current owner" will retire the earlier owner's token once approved.
- The inbox keeps approved owners in `owners/<place id>.json` (token hash, claim id, approval date, email and name). To remove an owner, delete that file. The place keeps `owner_verified` until someone edits the record.
