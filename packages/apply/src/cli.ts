#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ReviewPr } from "./owners.js";
import { intakeRecentList, intakeRecentStore, sendBlockList, sendDoubtCases, sendOverruled, settleRecentChanges, settleRecentPlaces } from "./recent.js";
import { sendPhotoProgress } from "./photo-progress.js";
import { sendProgress } from "./progress.js";
import { run } from "./run.js";

const USAGE = `Usage: ocdb-apply --inbox <dir> --data <dir> [--review-data <dir>]
                  [--auto-pr-body <file>] [--review-pr-body <file>] [--job-summary <file>]
                  [--review-prs <file>] [--auto-prs <file>] [--bot-login <login>]
                  [--summary <file>] [--now <ISO time>] [--places <dir>]
                  [--photo-licence <id>] [--main <dir> --intake <url>]
                  [--recent-places <url>] [--review-preview <url>]
                  [--geometry <file>]

Applies feedback in <inbox>/pending. Automatic changes go to the data checkout
in --data, changes for a person to the checkout in --review-data (the same
tree when left out). Decided items move to <inbox>/applied or <inbox>/refused.
--review-prs is JSON from \`gh pr list --head feedback/review --state all
--json number,state,body,comments,author,isCrossRepository\`; ticked owner
claim boxes in merged PRs approve those claims. Only PRs opened by --bot-login
from the data repository itself, and only comments by --bot-login, count.
--places makes it a photo repository run for an app's own photo service:
<data> holds only photos and moderation files, place records are read from the
Open Camping DB data checkout in <dir>, and anything but photos is refused.
--main and --intake take new places that are now in the data on main, and
withdrawn ones, out of the intake's recent places store, and send it the
contributors blocked on main, with the token in PLACES_TOKEN. <dir> is a checkout of the data repository's main branch, so a
place leaves the store only once the PR that writes it is merged. They also
tell the intake which applied fact and contact reports now have their change
on main, so it keeps those recent changes for 7 days from this run, and which
items this run decided other than applying them, so their recent changes leave
the list. They also send the intake every item's progress from the last 90
days, for GET /v1/feedback/progress. Each change in the data is dated by the
last commit on <dir> that touched its file, so <dir> needs its last 14 days
of history. Only items whose progress changed since the last send are sent,
recorded in <inbox>/progress/sent.json, and every item on the first run
after 00:00 UTC each Monday.
With --places, --main and --intake instead send the app's photo intake each
photo's progress from the last 90 days, for GET /v1/photos/progress, and
nothing else: <dir> is a checkout of the records repository's main, and what
was sent is recorded in <inbox>/progress/photos-sent.json.
--review-prs (up to 100; owner approvals read the 30 most recent) and
--auto-prs (the same JSON for --head feedback/auto) must be read before <dir>
is checked out, so a merged PR's changes are on it.
--recent-places reads the recent list at GET <url>/v1/places/recent, with no
token. Feedback about a new place on it that is not in the data yet stays in
<inbox>/pending for a later run, instead of being refused. While the list
cannot be read, all feedback about places not in the data stays there.
--review-preview puts a link to each held photo in the review PR body, served
by the intake at that URL and signed with REVIEW_PREVIEW_SECRET. Use it only
with a private data repository: anyone who can read the PR can open the links.
--geometry reads the major roads in the data repository's geometry sidecar
(pipeline.extract --geometry). A new place held as a possible duplicate is
merged into the place it duplicates only when the two have the same name once
tidied, are in the same group and less than 50 m apart, and no major road runs
between them. Without it the run has no road data and merges no duplicate on
its own: each goes to a reviewer as a duplicate case.
When GITHUB_OUTPUT is set, also writes auto_changed, review_changed,
owner_claims and inbox_changed as step outputs.`;

/** How many of the most recent review PRs owner approvals read. */
const OWNER_REVIEW_PRS = 30;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      inbox: { type: "string" },
      data: { type: "string" },
      "review-data": { type: "string" },
      "auto-pr-body": { type: "string" },
      "review-pr-body": { type: "string" },
      "job-summary": { type: "string" },
      "review-prs": { type: "string" },
      "auto-prs": { type: "string" },
      "bot-login": { type: "string", multiple: true },
      summary: { type: "string" },
      now: { type: "string" },
      places: { type: "string" },
      "photo-licence": { type: "string" },
      main: { type: "string" },
      intake: { type: "string" },
      "recent-places": { type: "string" },
      "review-preview": { type: "string" },
      geometry: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.inbox || !values.data) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  const now = values.now ? new Date(values.now) : undefined;
  if (now && Number.isNaN(now.getTime())) {
    console.error(`--now is not a valid time: ${values.now}`);
    return 2;
  }

  if (values["recent-places"] !== undefined && !URL.canParse(values["recent-places"])) {
    console.error(`--recent-places is not a URL: ${values["recent-places"]}`);
    return 2;
  }
  const previewSecret = process.env.REVIEW_PREVIEW_SECRET;
  if (values["review-preview"] !== undefined && (!URL.canParse(values["review-preview"]) || !previewSecret)) {
    console.error("--review-preview needs the intake's URL and REVIEW_PREVIEW_SECRET");
    return 2;
  }
  const token = process.env.PLACES_TOKEN;
  if ((values.main === undefined) !== (values.intake === undefined) || (values.intake && !token)) {
    console.error("--main and --intake go together, and need PLACES_TOKEN");
    return 2;
  }

  const reviewPrs = values["review-prs"]
    ? (JSON.parse(await readFile(values["review-prs"], "utf8")) as ReviewPr[])
    : undefined;
  const autoPrs = values["auto-prs"] ? (JSON.parse(await readFile(values["auto-prs"], "utf8")) as ReviewPr[]) : undefined;
  const summary = await run({
    inbox: values.inbox,
    data: values.data,
    // Owner approvals read the 30 most recent review PRs; progress reads them all.
    ...(reviewPrs ? { reviewPrs: reviewPrs.slice(0, OWNER_REVIEW_PRS) } : {}),
    ...(values["bot-login"] ? { botLogins: values["bot-login"] } : {}),
    ...(values["review-data"] ? { reviewData: values["review-data"] } : {}),
    ...(now ? { now } : {}),
    ...(values.places ? { places: values.places } : {}),
    ...(values["photo-licence"] ? { photoLicence: values["photo-licence"] } : {}),
    ...(values.geometry ? { geometry: values.geometry } : {}),
    ...(values["recent-places"] ? { recentList: intakeRecentList(values["recent-places"]) } : {}),
    ...(values["review-preview"] && previewSecret ? { reviewPreview: { url: values["review-preview"], secret: previewSecret } } : {}),
  });

  if (values["auto-pr-body"]) await writeFile(values["auto-pr-body"], summary.auto_pr_body, "utf8");
  if (values["review-pr-body"]) await writeFile(values["review-pr-body"], summary.review_pr_body, "utf8");
  // Appended: GitHub's job summary file may hold other steps' summaries.
  if (values["job-summary"] && summary.job_summary) await appendFile(values["job-summary"], summary.job_summary, "utf8");
  if (values.summary) await writeFile(values.summary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  // The progress sent is recorded in the inbox, so the inbox commit carries it too.
  let progressRecorded = false;
  if (values.places && values.main && values.intake && token) {
    // A photo run tells the photo intake only where each photo is.
    const progress = await sendPhotoProgress({
      inbox: values.inbox,
      main: values.main,
      store: intakeRecentStore(values.intake, token),
      decisions: summary.photo_decisions,
      ...(reviewPrs ? { reviewPrs } : {}),
      ...(autoPrs ? { autoPrs } : {}),
      ...(values["bot-login"] ? { botLogins: values["bot-login"] } : {}),
      ...(now ? { now } : {}),
    }).catch((error: unknown) => {
      console.warn(`working out the progress of photos failed, trying again next run: ${String(error)}`);
      return { sent: 0, failed: 0, recorded: false };
    });
    progressRecorded = progress.recorded;
    console.log(`progress of ${progress.sent} photo(s) sent to the photo intake${progress.failed > 0 ? `, ${progress.failed} not sent` : ""}`);
  } else if (values.main && values.intake && token) {
    const store = intakeRecentStore(values.intake, token);
    const settled = await settleRecentPlaces({ inbox: values.inbox, main: values.main, store, ...(now ? { now } : {}) });
    console.log(`${settled.length} new place(s) taken out of the recent places store`);
    const blocked = await sendBlockList({ main: values.main, store });
    console.log(`block list of ${blocked.length} contributor(s) sent to the intake`);
    const overruled = await sendOverruled({ ids: summary.not_applied, refused: summary.refused, store });
    console.log(`${overruled.length} item(s) decided other than applied sent to the intake`);
    const inData = await settleRecentChanges({ inbox: values.inbox, main: values.main, store, ...(now ? { now } : {}) });
    console.log(`${inData.length} applied report(s) in the data on main sent to the intake`);
    const cases = await sendDoubtCases({ inbox: values.inbox, store, ...(now ? { now } : {}) });
    console.log(`${cases.length} fact(s) taken down after doubts sent to the intake`);
    // Failures are logged inside and never fail the run.
    const progress = await sendProgress({
      inbox: values.inbox,
      main: values.main,
      store,
      decisions: summary.decisions,
      ...(reviewPrs ? { reviewPrs } : {}),
      ...(autoPrs ? { autoPrs } : {}),
      ...(values["bot-login"] ? { botLogins: values["bot-login"] } : {}),
      ...(now ? { now } : {}),
    }).catch((error: unknown) => {
      console.warn(`working out the progress of items failed, trying again next run: ${String(error)}`);
      return { sent: 0, failed: 0, recorded: false };
    });
    progressRecorded = progress.recorded;
    console.log(`progress of ${progress.sent} item(s) sent to the intake${progress.failed > 0 ? `, ${progress.failed} not sent` : ""}`);
  }
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const lines = [
      `auto_changed=${summary.auto_changed}`,
      `review_changed=${summary.review_changed}`,
      `owner_claims=${summary.owner_claims}`,
      `inbox_changed=${summary.inbox_changed || progressRecorded}`,
    ];
    await appendFile(output, `${lines.join("\n")}\n`, "utf8");
  }
  const c = summary.counts;
  console.log(
    `applied ${c.applied}, for a person ${c.needs_review}, owner claims sent ${c.awaiting_approval}, ` +
      `refused ${c.refused}, waiting ${c.waiting}; ` +
      `${summary.auto_files.length} automatic and ${summary.review_files.length} review file(s) changed`,
  );
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
