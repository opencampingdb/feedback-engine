import { moderateReview } from "./moderation.js";
import type { Change, Decision } from "./rules.js";
import type { Place } from "./types.js";

/**
 * Markdown body for the data PR. It names places and changes but never a
 * device hash, and quotes a note only when the note passes review moderation,
 * so nothing personal or abusive reaches the public repository and no one is
 * mentioned with an @.
 */

const QUOTED = /: "([\s\S]*)"/;

function safeSummary(summary: string): string {
  const match = QUOTED.exec(summary);
  let text = summary;
  if (match && moderateReview(match[1] ?? "").length > 0) {
    text = summary.replace(QUOTED, ": (note withheld, read it in the inbox)");
  }
  return text.replace(/[<>`]/g, "").replace(/@/g, "@​").replace(/\s+/g, " ");
}

function label(placeId: string, places: ReadonlyMap<string, Place>): string {
  const name = places.get(placeId)?.name;
  return name ? `\`${placeId}\` ${safeSummary(name)}` : `\`${placeId}\``;
}

const line = (c: Change, places: ReadonlyMap<string, Place>) =>
  `- ${label(c.place, places)}: ${safeSummary(c.summary)} (${c.feedback.join(", ")})`;

const FOOTER =
  "Written by the Open Camping DB apply-feedback workflow. No names, emails or device ids are written to this repository.";

/**
 * Body for the `feedback/auto` PR, or for a comment on it when the PR is
 * already open. Lists only changes the automatic rules made.
 */
export function autoPrBody(
  runAt: string,
  changes: readonly Change[],
  decisions: readonly Decision[],
  places: ReadonlyMap<string, Place>,
): string {
  const count = (o: Decision["outcome"]) => decisions.filter((d) => d.outcome === o).length;
  const lines = [
    `Feedback applied at ${runAt}. Every change below came from the automatic rules, so this PR merges itself once CI passes.`,
    "",
    "## Automatic changes",
    "",
    ...changes.map((c) => line(c, places)),
    "",
    "## Feedback in this run",
    "",
    `- applied: ${count("applied")}`,
    `- for a person: ${count("needs_review")} (on the feedback/review PR)`,
    `- refused: ${count("refused")} (reasons are kept in the inbox)`,
    `- waiting for agreement: ${count("waiting")}`,
    "",
    FOOTER,
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Body for the `feedback/review` PR, or for a comment on it when the PR is
 * already open. Lists the changes and reports a person has to decide on.
 */
export function reviewPrBody(runAt: string, changes: readonly Change[], places: ReadonlyMap<string, Place>): string {
  const plural = changes.length === 1 ? "" : "s";
  const lines = [
    `Feedback from ${runAt}.`,
    "",
    `**This PR needs a person.** ${changes.length} item${plural} below came from reports the automatic rules do not decide. ` +
      "Edit the files in this PR if needed, then merge it, or close it to refuse them. " +
      "A new place is drafted as a campground with no name: set its kind, group and name before merging.",
    "",
    "## For a person to check",
    "",
    ...changes.map((c) => line(c, places)),
    "",
    FOOTER,
  ];
  return `${lines.join("\n")}\n`;
}
