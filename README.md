# Open Camping DB feedback engine

Lets any app send reports, reviews and checks about places in [Open Camping DB](https://github.com/opencampingdb/data). Each submission passes quality rules and reaches the public `opencampingdb/data` repository as a pull request.

It has three parts:

| Package | What it does |
|---|---|
| [`packages/sdk`](packages/sdk) (`@opencampingdb/feedback`) | Client for React Native, Expo and the web. Queues submissions offline, retries with backoff, keeps a random per-install device id and refuses to send without consent. |
| [`packages/intake`](packages/intake) | Cloudflare Worker at `POST /v1/feedback`. Checks the app key, the schema and consent, rate limits, removes contact details from free text, hashes the device id and writes one JSON file per submission to the private `inbox` repository. |
| [`packages/apply`](packages/apply) | Script and reusable GitHub workflow that runs hourly in `inbox`, applies the quality rules and keeps up to two PRs open on `data`: one for automatic changes, one for a person. |

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

## Owners

The people who run a place can claim it, keep its facts, description and booking details current, and close it for a while. Owners of private land can list it as a farm stay. A person approves every claim before anything about an owner is published, and owner names and emails stay in the private inbox. [docs/owners.md](docs/owners.md) explains the flow and the SDK calls, and [docs/owner-terms.md](docs/owner-terms.md) holds the terms owners accept.

## Run your own intake

The intake runs on the Cloudflare Workers free plan. You need a Cloudflare account, a KV namespace, a GitHub App installed on your inbox repository and a few secrets. [docs/self-hosting.md](docs/self-hosting.md) covers each step, including the GitHub Apps and the inbox workflow.

## How the quality rules work

Every hour the apply workflow reads `inbox/pending/`, compares each item with the current `data` checkout and decides:

- **Review:** accepted when the text is at most 2,000 characters and has no links, contact details, social media handles, personal names or offensive language. It is appended to `reviews/<place id>.ndjson` and the place's rating is recalculated.
- **Closed report:** marks the place `reported_closed` at once. It becomes `closed` when two different devices report it, or a check finds it gone, within 90 days. A `reopened` report or a check that finds it there clears `reported_closed`. A `closed` place needs two devices within 90 days to reopen.
- **Fact report:** changes the fact only when two different devices report the same value within 90 days, and records the fact as coming from feedback. Two reports from one device count once. A report that matches the current value is accepted with no change.
- **Check:** changes nothing on its own, but counts as evidence for closing or reopening.
- **New place, wrong location, other, website and phone:** go to a person on the review PR, with a draft change where there is one.

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
npm run build     # SDK and apply script
```

## Licence

Apache 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The data the engine handles is published under ODbL 1.0 and DbCL 1.0. Security problems: see [SECURITY.md](SECURITY.md).
