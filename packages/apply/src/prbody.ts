import { moderateReview } from "./moderation.js";
import { approvalLine, type ClaimForReview } from "./owners.js";
import type { Change, ClosedCase, Decision, HeldCase } from "./rules.js";
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

/**
 * The longest body this writes. GitHub refuses a PR body or comment over 65,536
 * characters, and a refused body would stop the run before it records its
 * inbox moves, so change lines past this are counted, not listed.
 */
export const MAX_BODY_CHARS = 60_000;

/**
 * `changeLines` cut to fit a body whose other parts take `rest` characters,
 * ending with a count of the lines left out. The full list goes to the run's
 * job summary (`jobSummary`).
 */
function capped(changeLines: readonly string[], rest: number): string[] {
  const budget = MAX_BODY_CHARS - rest - 200;
  const out: string[] = [];
  let used = 0;
  for (const l of changeLines) {
    if (used + l.length + 1 > budget) break;
    out.push(l);
    used += l.length + 1;
  }
  if (out.length < changeLines.length) out.push(`- and ${changeLines.length - out.length} more, listed in the run's job summary on GitHub Actions`);
  return out;
}

/** `build` with every change line, or with as many as keep the body under MAX_BODY_CHARS. */
function fitted(changeLines: readonly string[], build: (lines: readonly string[]) => string): string {
  const whole = build(changeLines);
  if (whole.length <= MAX_BODY_CHARS) return whole;
  return build(capped(changeLines, build([]).length));
}

/** Every change of a run, for the run's job summary, where the PR bodies point when they are too long to list them all. */
export function jobSummary(runAt: string, auto: readonly Change[], review: readonly Change[], places: ReadonlyMap<string, Place>): string {
  const section = (title: string, changes: readonly Change[]) => (changes.length > 0 ? [`## ${title}`, "", ...changes.map((c) => line(c, places)), ""] : []);
  return [`# Feedback applied at ${runAt}`, "", ...section("Automatic changes", auto), ...section("For a person to check", review)].join("\n") + "\n";
}

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
  return fitted(changes.map((c) => line(c, places)), (changeLines) => {
    const lines = [
      `Feedback applied at ${runAt}. Every change below came from the automatic rules, so this PR merges itself once CI passes.`,
      "",
      "## Automatic changes",
      "",
      ...changeLines,
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
  });
}

/** Host name without a leading `www.`, or an empty string for an address that does not parse. */
function siteOf(address: string): string {
  try {
    return new URL(address).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** A coordinate to 1 decimal place (about 11 km), enough to say roughly where a listing is. */
function coarse(degrees: number): string {
  return (Math.round(degrees * 10) / 10).toFixed(1);
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
    // Nobody has approved the listing yet, and this PR is public: its name, description,
    // fact values and exact location stay in the inbox until a person approves it.
    const facts = Object.keys(c.listing.facts).sort().join(", ");
    const description = c.listing.description ? ", description sent" : "";
    return safeSummary(
      `new private farm stay \`${c.place}\` near ${coarse(c.listing.location.lat)}, ${coarse(c.listing.location.lon)}. ` +
        `Facts sent: ${facts || "none"}${description}. Read the listing in inbox/owner-claims/${c.claim}.json before ticking. Proof: ${proof}.`,
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
  closed: readonly ClosedCase[] = [],
): string {
  return fitted(changes.map((c) => line(c, places, previews)), (changeLines) => {
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
        ...changeLines,
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
          "`contacts`, `description`, `first_place`, `contact_withdrawn`, `fact_doubted`, `vehicle_access_candidate` or `commons_mismatch`, and `feedback` names the inbox items it comes from. To keep a held or hidden place, " +
          "set its `standing` to `shown` in this PR. `contacts` and `description` name what was left off a published new place: " +
          "contact details, addresses and descriptions travellers sent are in the inbox items, never here. " +
          "`contact_withdrawn` is a contact taken off a place after reports from two sources: its `value` is the place's own published contact, " +
          "not something a traveller sent, so it is shown here. To restore it, set `facts.<fact>` back to `value` on the place in this PR. " +
          "`fact_doubted` is a fact travellers say is wrong without giving the right value: with `taken_down` doubts from two sources took it off the place, " +
          "otherwise one traveller doubts it and it stays. `value` is what the place published, and `doubts` and `confirmations` name the reports weighed. " +
          "To restore it, set `facts.<fact>` back to `value`. Doubt notes are in the inbox, never here. " +
          "`vehicle_access_candidate` lines come from older runs and are always left: a name alone never sets a fact, so tag the place in OpenStreetMap instead. " +
          "It comes from the data, so its `feedback` is empty, and each place is listed once. " +
          "`commons_mismatch` is a Commons photo `file` travellers say is not of the place: to confirm it, add the place and file to `moderation/commons-do-not-match.json`.",
        "",
        ...held.map(heldLine),
        "",
      );
    }
    if (closed.length > 0) {
      lines.push(
        "## Closed cases",
        "",
        "Held cases the rules settled, one per line: `closed-case` and a JSON object. Each closes the `fact_doubted` cases for its place and fact listed before it: " +
          "travellers `restored` the value by confirming it again, or `replaced` it with another value, in the reports `feedback` names.",
        "",
        ...closed.map((c) => `- closed-case ${lineJson(c)}`),
        "",
      );
    }
    lines.push(FOOTER);
    return `${lines.join("\n")}\n`;
  });
}

/**
 * One held case as a line a triage agent can parse. Characters that GitHub
 * would read as markup or a mention are written as JSON escapes, so the
 * line still parses to the same values.
 */
function heldLine(c: HeldCase): string {
  return `- held-case ${lineJson(c)}`;
}

const lineJson = (value: unknown) => JSON.stringify(value).replace(/[<>`@&]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
