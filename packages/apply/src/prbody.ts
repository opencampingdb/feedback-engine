import { moderateReview } from "./moderation.js";
import { approvalLine, type ClaimForReview } from "./owners.js";
import type { Change, Decision, HeldCase } from "./rules.js";
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

/** A preview link for a held photo, from `previews` (photo id to URL); none when previews are off. */
const preview = (c: Change, previews: ReadonlyMap<string, string>) => {
  const url = c.photo ? previews.get(c.photo) : undefined;
  return url ? ` [View the photo](${url})` : "";
};

const line = (c: Change, places: ReadonlyMap<string, Place>, previews: ReadonlyMap<string, string> = new Map()) =>
  `- ${label(c.place, places)}: ${safeSummary(c.summary)} (${c.feedback.join(", ")})${preview(c, previews)}`;

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

/** Host name without a leading `www.`, or an empty string for an address that does not parse. */
function siteOf(address: string): string {
  try {
    return new URL(address).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function claimSummary(c: ClaimForReview, places: ReadonlyMap<string, Place>): string {
  // The code may have been found after a redirect. Show where, and flag another site.
  const foundAt = c.proof.url ?? c.proofUrl;
  const proof = !c.proof.found
    ? `code ${c.code} NOT found at ${c.proofUrl} (${safeSummary(c.proof.detail)})`
    : siteOf(foundAt) === siteOf(c.proofUrl)
      ? `code ${c.code} found at ${foundAt}`
      : `code ${c.code} found at ${foundAt}, ON A DIFFERENT SITE from the submitted ${c.proofUrl}: check both belong to the place`;
  const replaces = c.replaces ? ` Replaces the current owner (claim ${c.replaces.claim}, approved ${c.replaces.approved}).` : "";
  if (c.type === "owner_listing" && c.listing) {
    const facts = Object.entries(c.listing.facts)
      .map(([k, v]) => `${k} ${JSON.stringify(v)}`)
      .join(", ");
    const description = c.listing.description ? ` Description: "${safeSummary(c.listing.description)}".` : "";
    return safeSummary(
      `new private farm stay \`${c.place}\` "${c.listing.name}" at ${c.listing.location.lat}, ${c.listing.location.lon}. ` +
        `Facts: ${facts || "none"}.${description} Proof: ${proof}.`,
    );
  }
  return `${label(c.place, places)}. Proof: ${safeSummary(proof)}.${replaces}`;
}

/**
 * Body for the `feedback/review` PR, or for a comment on it when the PR is
 * already open. Lists the changes and reports a person has to decide on, and
 * an approval box for each owner claim or listing. Owner names and emails
 * never appear.
 */
export function reviewPrBody(
  runAt: string,
  changes: readonly Change[],
  places: ReadonlyMap<string, Place>,
  claims: readonly ClaimForReview[] = [],
  held: readonly HeldCase[] = [],
  previews: ReadonlyMap<string, string> = new Map(),
): string {
  const lines = [`Feedback from ${runAt}.`, ""];
  if (changes.length > 0) {
    const plural = changes.length === 1 ? "" : "s";
    lines.push(
      `**This PR needs a person.** ${changes.length} item${plural} below came from reports the automatic rules do not decide. ` +
        "Edit the files in this PR if needed, then merge it, or close it to refuse them. " +
        "A new place is drafted as a campground (or the kind the user picked) with no name: check its kind, group and name before merging.",
      "",
      "## For a person to check",
      "",
      ...changes.map((c) => line(c, places, previews)),
      "",
    );
    if (changes.some((c) => preview(c, previews))) {
      lines.push("Photo links show a held photo to anyone who has them and stop working after 30 days.", "");
    }
  }
  if (claims.length > 0) {
    lines.push(
      "## Owner claims",
      "",
      "Tick the box for each claim or listing you approve, then merge this PR. Unticked boxes in a merged PR are refused, " +
        "and closing the PR without merging refuses every claim in it. Nothing about an owner is published until you approve: " +
        "the next apply run then writes the owner record and adds `owner_verified` or the farm stay through the automatic PR. " +
        "Check that the proof page belongs to the place before ticking.",
      "",
      ...claims.map((c) => approvalLine(c, claimSummary(c, places))),
      "",
    );
  }
  if (held.length > 0) {
    lines.push(
      "## Held cases",
      "",
      "Cases a person, a bot or an AI reviewer should look at, one per line: `held-case` and a JSON object. `case` is `duplicate`, `hidden`, " +
        "`contacts`, `description`, `first_place` or `contact_withdrawn`, and `feedback` names the inbox items it comes from. To keep a held or hidden place, " +
        "set its `standing` to `shown` in this PR. `contacts` and `description` name what was left off a published new place: " +
        "contact details, addresses and descriptions travellers sent are in the inbox items, never here. " +
        "`contact_withdrawn` is a contact taken off a place after reports from two sources: its `value` is the place's own published contact, " +
        "not something a traveller sent, so it is shown here. To restore it, set `facts.<fact>` back to `value` on the place in this PR.",
      "",
      ...held.map(heldLine),
      "",
    );
  }
  lines.push(FOOTER);
  return `${lines.join("\n")}\n`;
}

/**
 * One held case as a line a triage agent can parse. Characters that GitHub
 * would read as markup or a mention are written as JSON escapes, so the
 * line still parses to the same values.
 */
function heldLine(c: HeldCase): string {
  const json = JSON.stringify(c).replace(/[<>`@&]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `- held-case ${json}`;
}
