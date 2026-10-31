#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { ReviewPr } from "./owners.js";
import { run } from "./run.js";

const USAGE = `Usage: ocdb-apply --inbox <dir> --data <dir> [--review-data <dir>]
                  [--auto-pr-body <file>] [--review-pr-body <file>]
                  [--review-prs <file>] [--bot-login <login>]
                  [--summary <file>] [--now <ISO time>]

Applies feedback in <inbox>/pending. Automatic changes go to the data checkout
in --data, changes for a person to the checkout in --review-data (the same
tree when left out). Decided items move to <inbox>/applied or <inbox>/refused.
--review-prs is JSON from \`gh pr list --head feedback/review --state all
--json number,state,body,comments,author,isCrossRepository\`; ticked owner
claim boxes in merged PRs approve those claims. Only PRs opened by --bot-login
from the data repository itself, and only comments by --bot-login, count.
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
