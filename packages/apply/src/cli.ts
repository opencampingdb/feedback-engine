#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ReviewPr } from "./owners.js";
import { intakeRecentList, intakeRecentStore, sendBlockList, sendOverruled, settleRecentChanges, settleRecentPlaces } from "./recent.js";
import { run } from "./run.js";

const USAGE = `Usage: ocdb-apply --inbox <dir> --data <dir> [--review-data <dir>]
                  [--auto-pr-body <file>] [--review-pr-body <file>]
                  [--review-prs <file>] [--bot-login <login>]
                  [--summary <file>] [--now <ISO time>] [--places <dir>]
                  [--photo-licence <id>] [--main <dir> --intake <url>]
                  [--recent-places <url>]

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
the list.
--recent-places reads the recent list at GET <url>/v1/places/recent, with no
token. Feedback about a new place on it that is not in the data yet stays in
<inbox>/pending for a later run, instead of being refused. While the list
cannot be read, all feedback about places not in the data stays there.
When GITHUB_OUTPUT is set, also writes auto_changed, review_changed,
owner_claims and inbox_changed as step outputs.`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      inbox: { type: "string" },
      data: { type: "string" },
      "review-data": { type: "string" },
      "auto-pr-body": { type: "string" },
      "review-pr-body": { type: "string" },
      "review-prs": { type: "string" },
      "bot-login": { type: "string", multiple: true },
      summary: { type: "string" },
      now: { type: "string" },
      places: { type: "string" },
      "photo-licence": { type: "string" },
      main: { type: "string" },
      intake: { type: "string" },
      "recent-places": { type: "string" },
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
  const token = process.env.PLACES_TOKEN;
  if ((values.main === undefined) !== (values.intake === undefined) || (values.intake && !token)) {
    console.error("--main and --intake go together, and need PLACES_TOKEN");
    return 2;
  }

  const reviewPrs = values["review-prs"]
    ? (JSON.parse(await readFile(values["review-prs"], "utf8")) as ReviewPr[])
    : undefined;
  const summary = await run({
    inbox: values.inbox,
    data: values.data,
    ...(reviewPrs ? { reviewPrs } : {}),
    ...(values["bot-login"] ? { botLogins: values["bot-login"] } : {}),
    ...(values["review-data"] ? { reviewData: values["review-data"] } : {}),
    ...(now ? { now } : {}),
    ...(values.places ? { places: values.places } : {}),
    ...(values["photo-licence"] ? { photoLicence: values["photo-licence"] } : {}),
    ...(values["recent-places"] ? { recentList: intakeRecentList(values["recent-places"]) } : {}),
  });

  if (values["auto-pr-body"]) await writeFile(values["auto-pr-body"], summary.auto_pr_body, "utf8");
  if (values["review-pr-body"]) await writeFile(values["review-pr-body"], summary.review_pr_body, "utf8");
  if (values.summary) await writeFile(values.summary, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const lines = [
      `auto_changed=${summary.auto_changed}`,
      `review_changed=${summary.review_changed}`,
      `owner_claims=${summary.owner_claims}`,
      `inbox_changed=${summary.inbox_changed}`,
    ];
    await appendFile(output, `${lines.join("\n")}\n`, "utf8");
  }
  if (values.main && values.intake && token) {
    const store = intakeRecentStore(values.intake, token);
    const settled = await settleRecentPlaces({ inbox: values.inbox, main: values.main, store, ...(now ? { now } : {}) });
    console.log(`${settled.length} new place(s) taken out of the recent places store`);
    const blocked = await sendBlockList({ main: values.main, store });
    console.log(`block list of ${blocked.length} contributor(s) sent to the intake`);
    const overruled = await sendOverruled({ ids: summary.not_applied, store });
    console.log(`${overruled.length} item(s) decided other than applied sent to the intake`);
    const inData = await settleRecentChanges({ inbox: values.inbox, main: values.main, store, ...(now ? { now } : {}) });
    console.log(`${inData.length} applied report(s) in the data on main sent to the intake`);
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
