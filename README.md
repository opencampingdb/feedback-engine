# Open Camping DB feedback engine

Lets any app send reports, reviews, checks and fees about places in [Open Camping DB](https://github.com/opencampingdb/data). Each submission passes quality rules and reaches the public `opencampingdb/data` repository as a pull request.

It has five parts, and a photo kit that each app runs for itself (see Photos below):

| Package | What it does |
|---|---|
| [`packages/sdk`](packages/sdk) (`@opencampingdb/feedback`) | Client for React Native, Expo and the web. Queues submissions offline, retries with backoff, keeps a random per-install device id and refuses to send without consent. Sends a traveller's whole edit of a place in one call (`reportFacts`), and holds reports, checks, fees, reviews and photos about a place the traveller has just added until it has its id. |
| [`packages/intake`](packages/intake) | Cloudflare Worker at `POST /v1/feedback` (and `POST /v1/feedback/batch` for up to 50 items under one attestation, with `RECENT_LIST`), and at `POST /v1/photos` when an app deploys it as its own photo service. Checks the app key, the schema and consent, App Attest or Play Integrity when the key requires it, rate limits, removes contact details from free text, hashes the device and contributor ids and writes one JSON file per submission to the private `inbox` repository. |
| [`packages/photos`](packages/photos) | Photo kit: a Cloudflare Worker an app runs to serve its published photos and photo records from R2 to its attested installs with a photo pass, and to servers with a photo key, behind the edge cache, with a per-address limit, daily read caps and an off switch. |
| [`packages/apply`](packages/apply) | Script and reusable GitHub workflow that runs hourly in `inbox`, applies the quality rules and keeps up to two PRs open on `data`: one for automatic changes, one for a person. |
| [`packages/osm-notes`](packages/osm-notes) | Retired. It passed accepted changes to OpenStreetMap as notes; the data repository's MapRoulette challenges do that now. Kept because their tag rules follow its `tags.ts` and `changes.ts`. |

The contract between the parts, and with the `data` repository, is the Open Camping DB `SPEC.md`.

## Add feedback to an app

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createFeedbackClient, CONSENT_TEXT, ATTRIBUTION } from "@opencampingdb/feedback";

const feedback = createFeedbackClient({
  endpoint: "https://feedback.example.org",
  appKey: "your-app-key",
  appVersion: "1.4.0",
  storage: AsyncStorage,
});

// After the user agrees to CONSENT_TEXT:
await feedback.check({ place: "ocdb_01JBX...", check: { visited: "2026-10-30", still_there: true }, consent: true });

// A traveller's edit of a place, every fact in one call:
await feedback.reportFacts({ place: "ocdb_01JBX...", facts: { toilets: true, pets: "leashed" }, consent: true });

// A place the traveller has just added: give its report a ref, and name it
// as { newPlace: ref } until it has an id. The SDK holds the details, then
// sends them with the place's id.
await feedback.report({ place: null, location, report: { kind: "new_place", name }, consent: true, ref: "draft-7" });
await feedback.reportFacts({ place: { newPlace: "draft-7" }, facts: { showers: true }, consent: true });
```

Show `ATTRIBUTION` wherever the data appears, and call `feedback.flush()` when the app returns to the foreground. The intake answers a fact report, contact report, doubt or new place `live` or `held` (with a reason code) as it arrives, and a live change reaches every app within about 30 seconds on the recent list, which apps lay over their release with `withRecentChanges`. An install's reports about one place in a day count once against the install's and the contributor's daily limits, so a full edit of a place costs the traveller one submission. Each report still counts against the app's limit. [docs/integration.md](docs/integration.md) walks through an Expo app step by step. To get an app key, open an issue with the **App key** form in this repository.

## Reviews

Reviews carry an opaque contributor id from the app's signed-in account. One review per contributor per place, a contributor's first review goes to a person, and advertising and offensive language are refused, also when disguised. Travellers can report a review; three reports hide it until a person decides, and a person can block a contributor. Apps can require App Attest or Play Integrity so that only a genuine copy of the app can post. [docs/integration.md](docs/integration.md) sections 6 and 7 cover the app side, and [SECURITY.md](SECURITY.md) the safeguards.

## Photos

Open Camping DB holds no photos. The photo kit lets an app run its own photo service on its own Cloudflare account and GitHub repositories: `createPhotoClient` in the SDK, the intake with a photo bucket for uploads and photo passes, the photo server, the apply rules in photos-only mode for the app's records repository, and `ocdb-photos` to sync its buckets and check its records. A contributor's first photo goes to a person, three reports hide a photo, a report of illegal content stops it being served at once, SafeSearch can refuse adult or violent uploads, and a traveller's photos are removed when they delete their account. Photos of a place the traveller has just added wait in the SDK until it has its id, while the app keeps the files. [docs/photos.md](docs/photos.md) walks through running it.

## Owners

The people who run a place can claim it, keep its facts (including every site feature, the brand and contacts), description and booking details current, and close it for a while. Owners of private land can list it as a farm stay. A person approves every claim before anything about an owner is published, and owner names and emails stay in the private inbox. [docs/owners.md](docs/owners.md) explains the flow and the SDK calls, and [docs/owner-terms.md](docs/owner-terms.md) holds the terms owners accept.

## Passing changes back to OpenStreetMap

Accepted changes reach OpenStreetMap's mappers as [MapRoulette](https://maproulette.org) tasks, built in the data repository at each OSM sync. The "What travellers report" challenge has one task for each place where a value from travellers or the owner, for a fact OSM has a tag for, the name or a permanent closure, still differs from OSM. A mapper checks the place and edits OSM if they agree, and the task goes away once OSM shows the value. Changes that came from OSM, contributed places, kinds, descriptions, locations, booking details, facts OSM does not map (such as scenery or mobile signal), temporary closures and reviews are never passed on. Open Camping DB never edits OSM itself. The data repository's [maproulette/README.md](https://github.com/opencampingdb/data/blob/main/maproulette/README.md) explains the challenges, and [docs/osm.md](docs/osm.md) what retired the OSM notes.

## Run your own intake

The intake runs on the Cloudflare Workers free plan. You need a Cloudflare account, a KV namespace, a GitHub App installed on your inbox repository and a few secrets. [docs/self-hosting.md](docs/self-hosting.md) covers each step, including the GitHub Apps and the inbox workflow.

## How the quality rules work

Every hour the apply workflow reads `inbox/pending/`, compares each item with the current `data` checkout and decides:

- **Fee:** what a traveller paid per night (Australian dollars, more than 0 and at most 1,000), for an unpowered or powered site or a cabin, and the month they paid, within the last 24 months. It needs a contributor and holds no free text, so it is published at once in `fees/<place id>.ndjson`. One fee per contributor per place per site type: a newer one replaces the older.
- **Review:** accepted when the text is at most 2,000 characters and has no links, contact details, social media handles, personal names or offensive language. It is appended to `reviews/<place id>.ndjson` and the place's rating is recalculated.
- **Closed report:** marks the place `reported_closed` at once. It becomes `closed` when two different devices report it, or a check finds it gone, within 90 days. A `reopened` report or a check that finds it there clears `reported_closed`. A `closed` place needs two devices within 90 days to reopen. For a place that is `owner_verified`, or whose status its owner set, reports from two devices go to a person instead of closing it, and one report changes nothing.
- **Fact report:** an attested report changes the fact at once and records it as coming from feedback. When another device reported a different value for that fact within 90 days, or the owner set it, a person decides instead. A report without attestation changes the fact only when two different devices report the same value within 90 days, and two reports from one device count once. A report that matches the current value is accepted with no change. Facts include 44 site features (who can get in, what is there, what to do, signal, warnings), each true or false, plus `booking_required`, the park chain (`brand`), contacts and the address, `vehicle_access` (`heavy_vehicles_only` for a rest area only heavy vehicles may use), and `pets_months`, the months dogs are allowed at a seasonal place (an OSM month range such as `May-Sep`), which is held for a person on a place whose `pets` is not `seasonal` and comes off when `pets` stops being `seasonal`. An attested contact or address is applied at once only when it passes the SDK's `contactProblem` link and spam checks (an https page on a public host, no link shorteners, social pages on their own network's host); one that fails goes to a person, and so does a contact or address report without attestation.

Devices count as different only when they also sent from different networks. The intake keeps a salted hash of each submission's network (the client address cut to its IPv4 /24 or IPv6 /48), never the address, and the rules count distinct networks, so one client cannot meet the two-device rule by sending new device ids.
- **Check:** changes nothing on its own, but counts as evidence for closing or reopening.
- **Contact report:** a traveller says a contact on a place (website, phones, email, social pages or the address) is `wrong` or `spam`. One report goes to a person. Reports from two different sources within 90 days, at least one of them attested, take the contact off the place at once, and the review PR lists it as a `contact_withdrawn` case for a person, a bot or an AI reviewer, who restores it by setting the fact back on the place. A contact the owner set is left to a person, and a report about a contact the place does not have is refused.
- **Doubt:** a traveller says one fact on a place is wrong without giving the right value (not a contact or the address, which use the contact report). A fact report of the same value confirms it. One doubt goes to a reviewer and the fact stays. Doubts from two different sources within 90 days, at least one attested and more than the sources confirming the value, take the fact off the place at once, and a reviewer gets a `fact_doubted` case. The fact comes back by itself when two new travellers confirm it, and is replaced when someone reports a new value. Facts from OSM or the owner are never taken down by doubts. The note goes to reviewers and is never published.
- **Heavy vehicle candidates:** a name alone never sets a fact. The places in the data repository's `moderation/heavy-vehicle-candidates.csv` (rest areas whose name says only heavy vehicles may use them, while OSM does not) are for a mapper to tag in OSM, and `vehicle_access` reaches them from OSM. The review PR no longer lists them, and a `vehicle_access_candidate` line an older run wrote is always left.
- **Commons photo not of this place:** a `commons_mismatch` report names a place and a Wikimedia Commons file. The app hides the photo for that traveller, and one report is a `commons_mismatch` case for a person or the AI reviewer, who may confirm or dismiss it. Reports from two different sources within 90 days, at least one attested, add the pair to the data repository's `moderation/commons-do-not-match.json`, so releases leave the photo out and it is never matched to the place again. A person undoes it by deleting the entry.
- **New place:** published as `shown` with its description, fee, contacts and address when the place itself is published. A contact or address that fails the link checks, or a description that fails the text checks, is left off and goes to a person.
- **Duplicate new place:** a new place within 150 m of a place in the same group is held as a possible duplicate. It is merged into that place without anyone asked when the two have the same name once tidied and are less than 50 m apart with no major road between them (the data repository's opposite-side rule, read from its geometry sidecar with `--geometry`; a run without the sidecar merges nothing on its own), unless that place has a verified owner or `moderation/distinct_places.json` lists the pair. The new place stays in the data as a tombstone (`status: "merged"`, `merged_into`), which releases list in `merged.ndjson.gz`, and the facts travellers gave it that the other place lacks move across. Other duplicates are `duplicate` cases, which the AI reviewer may approve, merge or take down. It never merges a pair across a major road when it has road data, and without road data it merges only the same name less than 25 m apart. A person reverses a merge by setting the tombstone's `status` back to `open`, removing `merged_into` and listing the pair in `moderation/distinct_places.json`.
- **Wrong location, name, description, kind and other reports, and new places that are held or hidden:** go to a person on the review PR, with a draft change where there is one. An accepted kind, name or description is kept through later OSM syncs.

Items waiting for a second device (unattested facts, closures and reopenings) stay in `pending/` and are looked at again each hour. After 90 days without agreement they are refused. Accepted items move to `inbox/applied/` and refused ones to `inbox/refused/` with the reason.

Each run keeps at most two open PRs to `data`, on fixed branches:

- `feedback/auto` holds only changes from the automatic rules and merges itself once CI passes.
- `feedback/review` holds everything a person must look at and is labelled `needs-review`.

When a PR from that branch is already open, the run adds a commit and a comment to it instead of opening another. Runs are idempotent: running again with no new inbox files changes nothing and opens nothing, and a run repeated after a failed inbox push writes nothing it already wrote.

The intake and the workflow use two GitHub Apps. `opencampingdb-intake` is installed on `inbox` with `contents: write`, plus `actions: write` when it starts the apply workflow, and on `data` with `contents: write` and `pull_requests: write` when the AI reviewer is on, and its key lives in the Worker. `opencampingdb-bot` has `contents: write` on `inbox` and `contents: write` plus `pull_requests: write` on `data`, plus `actions: write` when it starts the data release, and its key lives only in GitHub Actions secrets.

## Develop

Needs Node 22.12 or later.

```sh
npm install
npm test          # all packages
npm run typecheck
npm run build     # SDK, apply and the retired OSM notes scripts
```

## Licence

Apache 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The data the engine handles is published under ODbL 1.0 and DbCL 1.0. Security problems: see [SECURITY.md](SECURITY.md).
