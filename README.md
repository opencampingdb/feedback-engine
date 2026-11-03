# Open Camping DB feedback engine

Lets any app send reports, reviews, checks, fees and photos about places in [Open Camping DB](https://github.com/opencampingdb/data). Each submission passes quality rules and reaches the public `opencampingdb/data` repository as a pull request.

It has five parts:

| Package | What it does |
|---|---|
| [`packages/sdk`](packages/sdk) (`@opencampingdb/feedback`) | Client for React Native, Expo and the web. Queues submissions offline, retries with backoff, keeps a random per-install device id and refuses to send without consent. |
| [`packages/intake`](packages/intake) | Cloudflare Worker at `POST /v1/feedback` and `POST /v1/photos`. Checks the app key, the schema and consent, App Attest or Play Integrity when the key requires it, rate limits, removes contact details from free text, hashes the device and contributor ids and writes one JSON file per submission to the private `inbox` repository. |
| [`packages/photos`](packages/photos) | Cloudflare Worker that serves published photos from R2 to attested installs with a photo pass, and to servers with a photo key, behind the edge cache, with a per-address limit, daily read caps and an off switch. |
| [`packages/apply`](packages/apply) | Script and reusable GitHub workflow that runs hourly in `inbox`, applies the quality rules and keeps up to two PRs open on `data`: one for automatic changes, one for a person. |
| [`packages/osm-notes`](packages/osm-notes) | Script and reusable GitHub workflow that runs daily in `inbox` and passes changes accepted into `data` to OpenStreetMap as notes for its mappers to check. It never edits OSM. |

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
```

Show `ATTRIBUTION` wherever the data appears, and call `feedback.flush()` when the app returns to the foreground. [docs/integration.md](docs/integration.md) walks through an Expo app step by step. To get an app key, email dev@camporacle.com.au.

## Reviews

Reviews carry an opaque contributor id from the app's signed-in account. One review per contributor per place, a contributor's first review goes to a person, and advertising and offensive language are refused, also when disguised. Travellers can report a review; three reports hide it until a person decides, and a person can block a contributor. Apps can require App Attest or Play Integrity so that only a genuine copy of the app can post. [docs/integration.md](docs/integration.md) sections 6 and 7 cover the app side, and [SECURITY.md](SECURITY.md) the safeguards.

## Photos

Signed-in travellers can add photos of a place, licensed under CC BY 4.0. A contributor's first photo goes to a person, three reports hide a photo, and a traveller's photos are removed when they ask before deleting their account. The files stay in a private bucket until their record is merged, and are served only through the photo server, to installs that prove themselves with App Attest or Play Integrity. [docs/photos.md](docs/photos.md) covers the app side, moderation and how to run the storage.

## Owners

The people who run a place can claim it, keep its facts (including every site feature, the brand and contacts), description and booking details current, and close it for a while. Owners of private land can list it as a farm stay. A person approves every claim before anything about an owner is published, and owner names and emails stay in the private inbox. [docs/owners.md](docs/owners.md) explains the flow and the SDK calls, and [docs/owner-terms.md](docs/owner-terms.md) holds the terms owners accept.

## Passing changes back to OpenStreetMap

Once a day the OSM notes workflow looks at what changed on `data` `main` and posts a note on OpenStreetMap for each place where travellers or the owner changed a fact that OSM has a tag for, the name or a permanent closure. Changes that came from OSM, contributed places, kinds, descriptions, locations, booking details, facts OSM does not map (such as scenery or mobile signal), temporary closures and reviews are never sent. At most 10 notes go out a day, a place gets at most one every 30 days, and a note is never sent twice. [docs/osm.md](docs/osm.md) explains the flow and its limits.

## Run your own intake

The intake runs on the Cloudflare Workers free plan. You need a Cloudflare account, a KV namespace, a GitHub App installed on your inbox repository and a few secrets. [docs/self-hosting.md](docs/self-hosting.md) covers each step, including the GitHub Apps and the inbox workflow.

## How the quality rules work

Every hour the apply workflow reads `inbox/pending/`, compares each item with the current `data` checkout and decides:

- **Fee:** what a traveller paid per night (Australian dollars, more than 0 and at most 1,000), for an unpowered or powered site or a cabin, and the month they paid, within the last 24 months. It needs a contributor and holds no free text, so it is published at once in `fees/<place id>.ndjson`. One fee per contributor per place per site type: a newer one replaces the older.
- **Review:** accepted when the text is at most 2,000 characters and has no links, contact details, social media handles, personal names or offensive language. It is appended to `reviews/<place id>.ndjson` and the place's rating is recalculated.
- **Closed report:** marks the place `reported_closed` at once. It becomes `closed` when two different devices report it, or a check finds it gone, within 90 days. A `reopened` report or a check that finds it there clears `reported_closed`. A `closed` place needs two devices within 90 days to reopen. For a place that is `owner_verified`, or whose status its owner set, reports from two devices go to a person instead of closing it, and one report changes nothing.
- **Fact report:** changes the fact only when two different devices report the same value within 90 days, and records the fact as coming from feedback. Two reports from one device count once. A report that matches the current value is accepted with no change. Facts include 44 site features (who can get in, what is there, what to do, signal, warnings), each true or false, plus `booking_required`, the park chain (`brand`) and contacts.

Devices count as different only when they also sent from different networks. The intake keeps a salted hash of each submission's network (the client address cut to its IPv4 /24 or IPv6 /48), never the address, and the rules count distinct networks, so one client cannot meet the two-device rule by sending new device ids.
- **Check:** changes nothing on its own, but counts as evidence for closing or reopening.
- **New place, wrong location, name, description, kind and other reports, and contact facts** (website, phones, email and social pages): go to a person on the review PR, with a draft change where there is one. An accepted kind, name or description is kept through later OSM syncs.

Items waiting for a second device stay in `pending/` and are looked at again each hour. After 90 days without agreement they are refused. Accepted items move to `inbox/applied/` and refused ones to `inbox/refused/` with the reason.

Each run keeps at most two open PRs to `data`, on fixed branches:

- `feedback/auto` holds only changes from the automatic rules and merges itself once CI passes.
- `feedback/review` holds everything a person must look at and is labelled `needs-review`.

When a PR from that branch is already open, the run adds a commit and a comment to it instead of opening another. Runs are idempotent: running again with no new inbox files changes nothing and opens nothing, and a run repeated after a failed inbox push writes nothing it already wrote.

The intake and the workflow use two GitHub Apps. `opencampingdb-intake` is installed on `inbox` only with `contents: write`, and its key lives in the Worker. `opencampingdb-bot` has `contents: write` on `inbox` and `contents: write` plus `pull_requests: write` on `data`, and its key lives only in GitHub Actions secrets.

## Develop

Needs Node 22.12 or later.

```sh
npm install
npm test          # all packages
npm run typecheck
npm run build     # SDK, apply and OSM notes scripts
```

## Licence

Apache 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The data the engine handles is published under ODbL 1.0 and DbCL 1.0. Security problems: see [SECURITY.md](SECURITY.md).
