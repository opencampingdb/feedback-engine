import { textProblem, tidyText } from "@opencampingdb/feedback";
import { hasProfanity, isAdvertising, moderateReview } from "./moderation.js";
import { approvalLine, type ClaimForReview } from "./owners.js";
import type { Change, ClosedCase, Decision, HeldCase } from "./rules.js";
import type { Place } from "./types.js";

/**
 * Markdown body for the data PR. It names places and changes but never a
 * device hash. It quotes a note only when the note passes review moderation,
 * and any other quoted traveller value only when it passes the text rules,
 * with markdown punctuation escaped, so nothing personal or abusive reaches
 * the public repository, no traveller text makes a link, and no one is
 * mentioned with an @.
 */

const QUOTED = /: "([\s\S]*)"/;
/** A JSON string literal, as a summary quotes a value with `JSON.stringify`. */
const LITERAL = /"(?:[^"\\]|\\.)*"/g;
const WITHHELD = "(withheld, read it in the inbox)";

/** `text` with markdown punctuation escaped, so it reads as written and never as a link, image, table or heading. */
const escapeMarkdown = (text: string) => text.replace(/[\\[\]()!*_#|~&]/g, "\\$&");

/** Whether a quoted traveller value is kept out of the PR: the text rules call it rude or spam, or it reads as abuse or advertising. */
function valueWithheld(value: string): boolean {
  if (!/\p{L}/u.test(value)) return false;
  const problem = textProblem(tidyText(value));
  return problem === "rude" || problem === "spam" || hasProfanity(value) || isAdvertising(value);
}

function safeSummary(summary: string): string {
  const match = QUOTED.exec(summary);
  const head = match ? summary.slice(0, match.index) : summary;
  let tail = match ? summary.slice(match.index) : "";
  if (match) {
    const note = match[1] ?? "";
    tail = tail.replace(QUOTED, () => (moderateReview(note).length > 0 ? ": (note withheld, read it in the inbox)" : `: "${escapeMarkdown(note)}"`));
  }
  const values = head.replace(LITERAL, (literal) => {
    let value: unknown;
    try {
      value = JSON.parse(literal);
    } catch {
      return escapeMarkdown(literal);
    }
    return typeof value === "string" && valueWithheld(value) ? WITHHELD : escapeMarkdown(literal);
  });
  return `${values}${tail}`.replace(/[<>`]/g, "").replace(/@/g, "@​").replace(/\s+/g, " ");
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

/** Longest proof address a claim line shows. The full address is in the claim's file in the inbox. */
const SHOWN_ADDRESS_CHARS = 120;

/** `text` cut to `max` characters (code points, so a pair of surrogates is never split), ending with `...` when it was longer. */
const shortened = (text: string, max: number) => {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 3).join("")}...`;
};

/** Plain text with all markdown punctuation escaped, on one line, mentioning no one. */
const plainText = (text: string) => escapeMarkdown(text).replace(/[<>`]/g, "").replace(/@/g, "@​").replace(/\s+/g, " ");

/**
 * A web address a stranger chose, shortened and written as code, so it never
 * makes a link, an image or a mention. A backtick or space in it is
 * percent-encoded, so it cannot end the code span.
 */
const shownAddress = (address: string) =>
  `\`${shortened(address, SHOWN_ADDRESS_CHARS).replace(/[`\s]/gu, (ch) => encodeURIComponent(ch))}\``;

/** The facts that hold a place's own web pages, in the order a claim line shows them. */
const OWN_PAGE_FACTS = ["website", "facebook", "instagram", "tiktok", "x"] as const;

/** A page address reduced to what two addresses of one page share: its site, and its path in lower case without a trailing slash. */
function pageOf(address: string): { site: string; path: string } | undefined {
  try {
    const url = new URL(address);
    return { site: siteOf(address), path: url.pathname.toLowerCase().replace(/\/+$/, "") };
  } catch {
    return undefined;
  }
}

/**
 * Whether `proof` is on the page `own` or under it: the same site, and the
 * same path or one below it. A site's front page covers the whole site, while
 * a page on a host many people publish to covers only its own path, so
 * another page of that host does not count.
 */
export function onOwnPage(proof: string, own: string): boolean {
  const [a, b] = [pageOf(proof), pageOf(own)];
  if (!a || !b || a.site === "" || a.site !== b.site) return false;
  return a.path === b.path || a.path.startsWith(`${b.path}/`);
}

/**
 * What the data says the place's own pages are, beside the proof address, so
 * the reviewer compares instead of guessing. A value travellers or an owner
 * set is shown with its date: one changed just before a claim is no proof.
 */
function ownPages(proofAddress: string, place: Place | undefined): string {
  const pages = OWN_PAGE_FACTS.flatMap((fact) => {
    const value = (place?.facts as Record<string, unknown> | undefined)?.[fact];
    if (typeof value !== "string" || !pageOf(value)) return [];
    const source = place!.fact_sources[fact] ?? "unknown";
    const date = source === "osm" ? "" : ` on ${plainText((place!.fact_dates?.[fact] ?? "an unknown date").slice(0, 10))}`;
    return [{ value, from: `${fact}, from ${source}${date}`, checked: source === "osm" }];
  });
  if (pages.length === 0) return "The place has no website or social page in the data to compare the proof with.";
  const match = pages.find((page) => onOwnPage(proofAddress, page.value));
  if (match) {
    const caution = match.checked ? "" : ": check that value was not changed for this claim";
    return `The proof MATCHES the place's page in the data, ${shownAddress(match.value)} (${match.from})${caution}.`;
  }
  return `The proof does NOT match the place's pages in the data: ${pages.map((page) => `${shownAddress(page.value)} (${page.from})`).join(", ")}.`;
}

/** An address with its host as a browser sends it, so a name written in another alphabet shows as its `xn--` form. The rest is as submitted. */
function plainAddress(address: string): string {
  const parts = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*(.*)$/is.exec(address);
  try {
    return parts ? `${parts[1]}${new URL(address).host}${parts[2]}` : address;
  } catch {
    return address;
  }
}

/** What finding the code in that part of the page is worth, for the reviewer. */
const FOUND_WHERE: Record<NonNullable<ClaimForReview["proof"]["where"]>, string> = {
  head: ", in the page's `opencampingdb-claim` meta tag, which a visitor to the site cannot add",
  text: ", in the page's text: check it is not in a comment or review a visitor wrote",
};

function claimSummary(c: ClaimForReview, places: ReadonlyMap<string, Place>): string {
  // The code may have been found after a redirect. Show where, and flag another site.
  const foundAt = c.proof.url ?? plainAddress(c.proofUrl);
  const submitted = shownAddress(plainAddress(c.proofUrl));
  const code = plainText(c.code);
  const where = c.proof.where ? FOUND_WHERE[c.proof.where] : "";
  const proof = !c.proof.found
    ? `code ${code} NOT found at ${submitted} (${plainText(shortened(c.proof.detail, SHOWN_ADDRESS_CHARS * 2))})`
    : siteOf(foundAt) === siteOf(c.proofUrl)
      ? `code ${code} found at ${shownAddress(foundAt)}${where}`
      : `code ${code} found at ${shownAddress(foundAt)}${where}, ON A DIFFERENT SITE from the submitted ${submitted}: check both belong to the place`;
  const replaces = c.replaces ? ` Replaces the current owner (claim ${c.replaces.claim}, approved ${c.replaces.approved}).` : "";
  const again = c.again !== undefined ? ` Listed again: review PR #${c.again} was merged or closed with no decision on it.` : "";
  if (c.type === "owner_listing" && c.listing) {
    // Nobody has approved the listing yet, and this PR is public: its name, description,
    // fact values and exact location stay in the inbox until a person approves it.
    const facts = Object.keys(c.listing.facts).sort().join(", ");
    const description = c.listing.description ? ", description sent" : "";
    return (
      `new private farm stay \`${c.place}\` near ${coarse(c.listing.location.lat)}, ${coarse(c.listing.location.lon)}. ` +
      `Facts sent: ${facts || "none"}${description}. Read the listing in inbox/owner-claims/${c.claim}.json before ticking. Proof: ${proof}.${again}`
    );
  }
  return `${label(c.place, places)}. Proof: ${proof}. ${ownPages(foundAt, places.get(c.place))}${replaces}${again}`;
}

/**
 * Room kept in a body or comment for the case sections' headings, blank lines
 * and the line that says more cases follow, which the case lines' budget does
 * not count.
 */
const SECTION_ROOM_CHARS = 400;

/** What a run posts on the `feedback/review` PR: the body (or first comment), and follow-up comments for held and closed cases that did not fit. */
export interface ReviewPrTexts {
  body: string;
  /** Posted in order after the body. Empty when everything fits in the body. */
  comments: string[];
}

/**
 * Body for the `feedback/review` PR, or for a comment on it when the PR is
 * already open. See `reviewPrTexts`.
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
  return reviewPrTexts(runAt, changes, places, claims, held, previews, closed).body;
}

const HELD_INTRO =
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
  "`commons_mismatch` is a Commons photo `file` travellers say is not of the place: to confirm it, add the place and file to `moderation/commons-do-not-match.json`.";

const CLOSED_INTRO =
  "Held cases the rules settled, one per line: `closed-case` and a JSON object. Each closes the `fact_doubted` cases for its place and fact listed before it: " +
  "travellers `restored` the value by confirming it again, or `replaced` it with another value, in the reports `feedback` names.";

/**
 * The texts for the `feedback/review` PR. The body lists the changes and
 * reports a person has to decide on, an approval box for each owner claim or
 * listing (at most MAX_CLAIMS_PER_RUN, so they always fit), the held cases
 * and the closed cases. Owner names and emails never appear. Every part is
 * budgeted against MAX_BODY_CHARS: held and closed case lines that do not fit
 * after the claims go, in order, to follow-up comments of the same size, and
 * change lines that do not fit after that are counted and listed in the run's
 * job summary.
 */
export function reviewPrTexts(
  runAt: string,
  changes: readonly Change[],
  places: ReadonlyMap<string, Place>,
  claims: readonly ClaimForReview[] = [],
  held: readonly HeldCase[] = [],
  previews: ReadonlyMap<string, string> = new Map(),
  closed: readonly ClosedCase[] = [],
): ReviewPrTexts {
  // Held lines first and closed lines after them, as a closed case closes the cases listed before it.
  const caseLines = [...held.map(heldLine), ...closed.map((c) => `- closed-case ${lineJson(c)}`)];
  const build = (changeLines: readonly string[], inBody: number): string => {
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
        "Each claim or listing has two boxes. Tick **Approve** or **Refuse** for each one, then merge this PR. " +
          "Tick before you merge: a box ticked after the merge does not count. A claim with neither box ticked, or both, " +
          "comes back on the next review PR. Nothing about an owner is published until you approve: " +
          "the next apply run then writes the owner record and adds `owner_verified` or the farm stay through the automatic PR. " +
          "Check that the proof page belongs to the place before ticking Approve.",
        "",
        ...claims.map((c) => approvalLine(c, claimSummary(c, places))),
        "",
      );
    }
    lines.push(...caseSections(caseLines.slice(0, inBody), held.length, inBody < caseLines.length));
    lines.push(FOOTER);
    return `${lines.join("\n")}\n`;
  };
  // As many case lines as fit in the body with no change lines, then change lines in what is left.
  const inBody = fitting(caseLines, MAX_BODY_CHARS - build([], 0).length - HELD_INTRO.length - CLOSED_INTRO.length - SECTION_ROOM_CHARS);
  const body = fitted(changes.map((c) => line(c, places, previews)), (changeLines) => build(changeLines, inBody));
  return { body, comments: followUps(runAt, caseLines.slice(inBody), held.length - inBody) };
}

/** How many of `lines`, from the start, fit in `budget` characters with a newline each. */
function fitting(lines: readonly string[], budget: number): number {
  let used = 0;
  let n = 0;
  for (const l of lines) {
    if (used + l.length + 1 > budget) break;
    used += l.length + 1;
    n += 1;
  }
  return n;
}

/** The held and closed case sections for `lines`, of which the first `heldCount` are held cases. */
function caseSections(lines: readonly string[], heldCount: number, more: boolean): string[] {
  const held = lines.slice(0, Math.max(0, heldCount));
  const closed = lines.slice(Math.max(0, heldCount));
  const out: string[] = [];
  if (held.length > 0) out.push("## Held cases", "", HELD_INTRO, "", ...held, "");
  if (closed.length > 0) out.push("## Closed cases", "", CLOSED_INTRO, "", ...closed, "");
  if (more) out.push("More cases follow in the next comments.", "");
  return out;
}

/** Follow-up comments for case lines the body had no room for, each under MAX_BODY_CHARS. `heldCount` of them are held cases. */
function followUps(runAt: string, lines: readonly string[], heldCount: number): string[] {
  const comments: string[] = [];
  let done = 0;
  while (done < lines.length) {
    const head = `Cases from ${runAt}, continued.`;
    const n = Math.max(1, fitting(lines.slice(done), MAX_BODY_CHARS - head.length - HELD_INTRO.length - CLOSED_INTRO.length - SECTION_ROOM_CHARS));
    const page = caseSections(lines.slice(done, done + n), heldCount - done, done + n < lines.length);
    comments.push(`${[head, "", ...page, FOOTER].join("\n")}\n`);
    done += n;
  }
  return comments;
}

/**
 * One held case as a line a triage agent can parse. Characters that GitHub
 * would read as markup or a mention are written as JSON escapes, so the
 * line still parses to the same values.
 */
function heldLine(c: HeldCase): string {
  return `- held-case ${lineJson(c)}`;
}

// Inside each string: every character outside printable ASCII, and those markdown or GitHub read as markup, a link or a mention.
const lineJson = (value: unknown) =>
  JSON.stringify(value).replace(LITERAL, (literal) =>
    literal.replace(/[^\x20-\x7e]|[<>`@&[\]()]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`),
  );
