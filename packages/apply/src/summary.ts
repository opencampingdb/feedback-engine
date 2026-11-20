import type { StoredFeedback } from "@opencampingdb/feedback";
import { moderateReview } from "./moderation.js";
import { MAX_BODY_CHARS, plainText, valueWithheld } from "./prbody.js";
import type { Place, Review } from "./types.js";

/**
 * The body of the `feedback/review` PR: everything the PR changes against the
 * base branch, grouped by place, so a moderator can decide each place from the
 * body alone. Each run writes it again from the branch, so it covers every run
 * since the PR opened. The per-run texts with the machine-readable lines
 * (`held-case`, owner claim boxes) are posted as comments instead.
 *
 * Nothing personal is written: a contributor appears only as counts, traveller
 * text is quoted only when it passes the same rules as the run texts, and no
 * app, device or contributor id is shown.
 */

/** First line of the body, so a run can tell its own summary from an older body that still holds machine-readable lines. */
export const SUMMARY_MARKER = "<!-- review-summary -->";

/** One place file the PR changes: the record on the base branch (null for a new place) and on the PR branch. */
export interface ChangedPlace {
  before: Place | null;
  after: Place;
  /** Path of the place file in the data repository. */
  path: string;
  /** Reviews the PR adds for the place. */
  reviews: readonly Review[];
}

/** A contributor's track record in the inbox, as counts only. */
export interface ContributorRecord {
  applied: number;
  toPerson: number;
  refused: number;
}

/** One `review-decision` line from the AI reviewer's comments. */
export interface ReviewerDecision {
  case: string;
  place: string;
  decision: string;
  reviewer: string;
  reason: string;
}

/** What OpenStreetMap holds for a place: its tags, or null when the object could not be read. */
export type OsmTags = Readonly<Record<string, string>> | null;

export interface SummaryInput {
  /** Owner and name of the data repository, for links to the branch's files. */
  repo: string;
  /** The PR branch. */
  branch: string;
  places: readonly ChangedPlace[];
  /** Inbox items for these places that a run sent to this PR, and every other item about them, for agreement counts. */
  items: readonly StoredFeedback[];
  /** Feedback ids a run sent to this PR (outcome needs_review since the PR opened). */
  forPerson: ReadonlySet<string>;
  decisions: readonly ReviewerDecision[];
  osm: ReadonlyMap<string, OsmTags>;
  records: ReadonlyMap<string, ContributorRecord>;
  /** Kind code to label, from the data repository's `schema/kinds.json`. */
  kindLabels: ReadonlyMap<string, string>;
}

/** Fields compared between the two records, in the order the table lists them. */
type Field = { key: string; label: string; value: (p: Place | null) => unknown };

const FIELDS_HEAD: Field[] = [
  { key: "name", label: "name", value: (p) => p?.name },
  { key: "kind", label: "kind", value: (p) => p?.kind },
  { key: "status", label: "status", value: (p) => p?.status },
  { key: "location", label: "location", value: (p) => p?.location },
  { key: "description", label: "description", value: (p) => p?.description },
];

/** The OpenStreetMap tags a fact is read from, as the data pipeline reads them. A fact not listed has no tag. */
export const OSM_TAGS: Readonly<Record<string, readonly string[]>> = {
  name: ["name"],
  kind: ["tourism", "amenity", "leisure", "highway", "operator", "static_caravans", "caravans"],
  caravans: ["caravans"],
  motorhomes: ["motorhome"],
  tents: ["tents"],
  toilets: ["toilets"],
  showers: ["shower"],
  drinking_water: ["drinking_water"],
  power: ["power_supply"],
  fee: ["fee"],
  dump_station: ["sanitary_dump_station"],
  pets: ["dog"],
  bbq: ["bbq"],
  wifi: ["internet_access"],
  laundry: ["laundry"],
  website: ["website", "contact:website"],
  phone: ["phone", "contact:phone"],
  email: ["email", "contact:email"],
  facebook: ["contact:facebook"],
  operator: ["operator"],
  capacity: ["capacity"],
  opening_hours: ["opening_hours"],
  access: ["4wd_only"],
  description: ["description"],
};

/** Plain words for a hold the intake made. Any other hold uses the reason the run recorded. */
const INTAKE_HOLDS: Readonly<Record<string, string>> = {
  daily_cap: "the contributor passed the intake's daily limit of changes, so no check ran on it",
  text_check: "the intake's text check flagged it",
  link_check: "its links were not checked",
  ai_check: "the intake's content check flagged it",
  check_unavailable: "the intake's checks were down when it arrived",
  network_reputation: "it came from a network on a public list of abusive addresses",
  repeated_text: "its text is nearly the same as text other sources sent",
};

const SHOWN_CHARS = 300;

const DAY = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: "UTC" });
const day = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? "an unknown day" : DAY.format(t);
};

/** Traveller or data text as one safe line, cut to SHOWN_CHARS, or a note that it is withheld. */
function shown(text: string): string {
  if (valueWithheld(text)) return "(withheld, read it in the inbox)";
  const chars = [...text.replace(/\s+/g, " ").trim()];
  const cut = chars.length > SHOWN_CHARS ? `${chars.slice(0, SHOWN_CHARS - 3).join("")}...` : chars.join("");
  return plainText(cut);
}

/** A value as a table cell. A blank is "not known". */
function cell(value: unknown, kindLabels: ReadonlyMap<string, string>, key: string): string {
  if (value === undefined || value === null || value === "") return "not known";
  if (value === true) return "yes";
  if (value === false) return "no";
  if (key === "kind" && typeof value === "string") return plainText(kindLabels.get(value) ?? value.replace(/_/g, " "));
  if (key === "location" && typeof value === "object") {
    const { lat, lon } = value as { lat: number; lon: number };
    return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  }
  if (typeof value === "string") return shown(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && value !== null && "name" in value && typeof (value as { name: unknown }).name === "string") {
    return shown((value as { name: string }).name);
  }
  return shown(JSON.stringify(value));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Every field that differs between the two records: the head fields, then each fact, then the rating. */
function changedFields(c: ChangedPlace): { key: string; label: string; before: unknown; after: unknown }[] {
  const out: { key: string; label: string; before: unknown; after: unknown }[] = [];
  for (const f of FIELDS_HEAD) {
    const before = f.value(c.before);
    const after = f.value(c.after);
    if (c.before === null && (after === undefined || after === null)) continue;
    if (!same(before, after)) out.push({ key: f.key, label: f.label, before, after });
  }
  const facts = new Set([...Object.keys(c.before?.facts ?? {}), ...Object.keys(c.after.facts)]);
  for (const fact of [...facts].sort()) {
    const before = (c.before?.facts as Record<string, unknown> | undefined)?.[fact];
    const after = (c.after.facts as Record<string, unknown>)[fact];
    if (!same(before, after)) out.push({ key: fact, label: fact.replace(/_/g, " "), before, after });
  }
  if (!same(c.before?.rating, c.after.rating)) out.push({ key: "rating", label: "rating", before: c.before?.rating, after: c.after.rating });
  return out;
}

/** What OpenStreetMap says for a field: its tags, "not tagged", "n/a" when no tag holds it, or a note when the place is not in OSM. */
function osmCell(key: string, place: Place, tags: OsmTags | undefined): string {
  if (place.osm === null) return "not in OSM";
  const wanted = OSM_TAGS[key];
  if (!wanted) return "n/a";
  if (tags === undefined || tags === null) return "could not be read";
  const found = wanted.filter((t) => tags[t] !== undefined).map((t) => `${t}=${shown(tags[t]!)}`);
  return found.length > 0 ? found.join(", ") : "not tagged";
}

const ratingCell = (r: unknown) => {
  if (r === null || r === undefined) return "none";
  const { count, mean } = r as { count: number; mean: number };
  return `${mean.toFixed(1)} from ${count} review${count === 1 ? "" : "s"}`;
};

/** The field an item sets, when it sets one: a fact, the name, kind, description or location. */
function fieldOf(item: StoredFeedback): string | null {
  if (item.type !== "report") return null;
  const r = item.report as { kind: string; fact?: string };
  if (r.kind === "fact" || r.kind === "contact") return r.fact ?? null;
  if (r.kind === "name" || r.kind === "kind" || r.kind === "description" || r.kind === "location") return r.kind;
  return null;
}

/** The value an item sets for its field, to count which items agree. */
function valueOf(item: StoredFeedback): unknown {
  if (item.type !== "report") return undefined;
  const r = item.report as { kind: string; value?: unknown; place_kind?: unknown; location?: unknown };
  if (r.kind === "kind") return r.place_kind;
  if (r.kind === "location") return r.location;
  return r.value;
}

/** Who sent an item, without saying who: a key for counting distinct sources. */
const sourceKey = (item: StoredFeedback) => {
  const i = item as { contributor?: string; origin?: string; id: string };
  return i.contributor ?? i.origin ?? i.id;
};

/** How an item came in, in plain words, with its first-hand mark. */
function howSent(item: StoredFeedback): string {
  const i = item as { human_checked?: boolean; contributor?: string; attested?: string; received?: string };
  const via = i.contributor ? "in an app" : i.human_checked ? "from a website after its human check" : "with no account";
  return `${via} on ${day(i.received)}`;
}

/** An item's first-hand mark, in plain words. */
function markOf(item: StoredFeedback): string {
  const report = (item as { report?: { first_hand?: string } }).report;
  const review = (item as { review?: { visited_nearby?: boolean } }).review;
  return report?.first_hand === "seen_nearby"
    ? "marked seen nearby"
    : report?.first_hand === "says_so"
      ? "marked says so"
      : review?.visited_nearby
        ? "the app saw the phone near the place"
        : "no first-hand mark";
}

/** Why an item was held, in plain words. */
function heldBecause(item: StoredFeedback): string {
  const intake = (item as { intake?: { state?: string; held_reason?: string } }).intake;
  if (intake?.state === "held" && intake.held_reason && INTAKE_HOLDS[intake.held_reason]) return INTAKE_HOLDS[intake.held_reason]!;
  const reason = (item as { outcome?: { reason?: string } }).outcome?.reason;
  return reason ? plainText(reason.replace(/[.\s]+$/, "")) : "the rules do not decide it on their own";
}

function recordLine(contributor: string | undefined, records: ReadonlyMap<string, ContributorRecord>): string {
  if (!contributor) return "";
  const r = records.get(contributor);
  if (!r || r.applied + r.toPerson + r.refused <= 1) return " This contributor has sent nothing else.";
  return ` Their record: ${r.applied} applied, ${r.toPerson} sent to a person, ${r.refused} refused.`;
}

const mapLink = (p: Place) => {
  const { lat, lon } = p.location;
  return `[map](https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon})`;
};

/** Whether a place needs no decision: a moderator already hid it. */
const noDecision = (p: Place) => p.standing === "hidden" && p.moderator?.action === "hide";

/** The lines for one place that needs a decision. */
function placeSection(n: number, c: ChangedPlace, input: SummaryInput): string[] {
  const p = c.after;
  const id = p.id;
  const title = p.name ? shown(p.name) : `Unnamed ${cell(p.kind, input.kindLabels, "kind").toLowerCase()}`;
  // The kind the place has now, on the base branch, so a kind change reads from the table.
  const kind = cell(c.before?.kind ?? p.kind, input.kindLabels, "kind");
  const where = p.facts && (p.facts as { protected_area?: { name?: string } }).protected_area?.name;
  const links = [
    `${kind}${where ? ` in ${shown(where)}` : ""}${c.before === null ? ", new place" : ""}`,
    mapLink(p),
    ...(p.osm ? [`[OSM ${p.osm.type} ${p.osm.id}](https://www.openstreetmap.org/${p.osm.type}/${p.osm.id})`] : []),
    `[file](https://github.com/${input.repo}/blob/${input.branch}/${c.path})`,
    `\`${id}\``,
  ];
  const lines = [`### ${n}. ${title}`, "", links.join(" · "), ""];
  const fields = changedFields(c);
  const tags = input.osm.get(id);
  if (fields.length > 0) {
    lines.push("| Field | Now | This PR | OpenStreetMap |", "|---|---|---|---|");
    for (const f of fields) {
      const now = f.key === "rating" ? ratingCell(f.before) : c.before === null ? "new" : cell(f.before, input.kindLabels, f.key);
      const next = f.key === "rating" ? ratingCell(f.after) : cell(f.after, input.kindLabels, f.key);
      lines.push(`| ${plainText(f.label)} | ${now} | ${next} | ${f.key === "rating" ? "n/a" : osmCell(f.key, p, tags)} |`);
    }
    lines.push("");
  }

  // The items a run sent to this PR for the place, grouped by why they were held.
  const mine = input.items.filter((i) => input.forPerson.has(i.id) && placeOf(i) === id);
  const reasons = new Map<string, StoredFeedback[]>();
  for (const item of mine) reasons.set(heldBecause(item), [...(reasons.get(heldBecause(item)) ?? []), item]);
  if (reasons.size > 0) {
    const parts = [...reasons.entries()].map(([why, items]) => (reasons.size > 1 ? `${what(items)}: ${why}` : why));
    lines.push(`**Held because** ${parts.join(". ")}.`);
  }

  // Each reporter once, with how many other sources agree with what they set.
  const reporters = new Map<string, StoredFeedback[]>();
  for (const item of mine) reporters.set(sourceKey(item), [...(reporters.get(sourceKey(item)) ?? []), item]);
  const reporterLines = [...reporters.values()].map((items) => {
    const first = items[0]!;
    const agree = new Set(
      input.items
        .filter((o) => placeOf(o) === id && sourceKey(o) !== sourceKey(first))
        .filter((o) => items.some((i) => fieldOf(i) !== null && fieldOf(i) === fieldOf(o) && same(valueOf(i), valueOf(o))))
        .map(sourceKey),
    ).size;
    const count = items.length > 1 ? `${items.length} items ` : "";
    const agreement = agree === 0 ? "No other report agrees." : `${agree} other source${agree === 1 ? "" : "s"} agree${agree === 1 ? "s" : ""}.`;
    const marks = [...new Set(items.map(markOf))].join(" and ");
    return `${count}${howSent(first)}, ${marks}. ${agreement}${recordLine((first as { contributor?: string }).contributor, input.records)}`;
  });
  if (reporterLines.length === 1) lines.push(`**Reporter** ${reporterLines[0]}`);
  else if (reporterLines.length > 1) lines.push(`**Reporters** ${reporterLines.map((l, i) => `(${i + 1}) ${l}`).join(" ")}`);

  for (const r of c.reviews) {
    // A review an intake check held may hold what the content check caught: its text stays in the inbox.
    const from = input.items.find((i) => i.id === r.id.replace(/^rev_/, "fb_"));
    const held = (from as { intake?: { state?: string } } | undefined)?.intake?.state === "held";
    const text = held || moderateReview(r.text).length > 0 ? "(text withheld, read it in the inbox)" : `"${shown(r.text)}"`;
    lines.push(`**Review** ${r.stars} star${r.stars === 1 ? "" : "s"}: ${text}`);
  }

  if (p.moderator) lines.push(`**Moderator** ${p.moderator.action === "hide" ? "hid" : "restored"} it on ${day(p.moderator.at)}.`);
  const decided = input.decisions.filter((d) => d.place === id);
  const latest = new Map<string, ReviewerDecision>();
  for (const d of decided) latest.set(d.case, d);
  const reviewer = [...latest.values()].map((d) => `${d.reviewer.startsWith("ai:") ? "AI" : "a reviewer"} ${verb(d.decision)}: "${shown(d.reason.replace(/[.\s]+$/, ""))}"`);
  lines.push(`**Reviewer** ${reviewer.length > 0 ? reviewer.join(". ") : "none"}.`, "");
  return lines;
}

const verb = (d: string) =>
  ({ approve: "approved", leave: "left it for a person", take_down: "took it down", revert: "reverted it", merge: "merged it", confirm: "confirmed it", dismiss: "dismissed it", restore: "restored it", keep_down: "kept it down" })[d] ??
  plainText(d);

/** The fields a group of items set, for a reason line that covers some of a place's items. */
const what = (items: readonly StoredFeedback[]) => {
  const fields = [...new Set(items.map((i) => fieldOf(i) ?? i.type))];
  return fields.map((f) => f.replace(/_/g, " ")).join(", ");
};

/** The place an item is about. A new place takes its id from its feedback id. */
export function placeOf(item: StoredFeedback): string | null {
  const place = (item as { place?: string | null }).place;
  if (place) return place;
  if (item.type === "report" && (item.report as { kind: string }).kind === "new_place") return item.id.replace(/^fb_/, "ocdb_");
  return null;
}

/** The PR body. Places a moderator has already hidden go in a short "No decision needed" list. */
export function reviewSummary(input: SummaryInput): string {
  const head = (decide: number, none: number, sections: readonly string[], noneLines: readonly string[], cut: number) => {
    const total = decide + none;
    const lines = [
      SUMMARY_MARKER,
      `Feedback for a person to check. This PR changes ${total} place${total === 1 ? "" : "s"}: ${decide} need${decide === 1 ? "s" : ""} a decision, ${none} need${none === 1 ? "s" : ""} none.`,
      "",
      "Merge to accept every change below. To refuse one, put the **Now** value back in that place's file in this PR, then merge. Closing the PR refuses everything in it.",
      "",
    ];
    if (sections.length > 0) lines.push("## Needs a decision", "", ...sections);
    if (cut > 0) lines.push(`And ${cut} more place${cut === 1 ? "" : "s"}, listed under Files changed.`, "");
    if (noneLines.length > 0) lines.push("## No decision needed", "", ...noneLines, "");
    lines.push(
      "n/a: OpenStreetMap has no tag for this field. Machine-readable held cases, owner claims and reviewer decisions for each run are in the comments below.",
      "",
      "Written by the Open Camping DB apply-feedback workflow. No names, emails or device ids are written to this repository.",
    );
    return `${lines.join("\n")}\n`;
  };
  const toDecide = input.places.filter((c) => !noDecision(c.after));
  const none = input.places.filter((c) => noDecision(c.after));
  const noneLines = none.map(
    (c) =>
      `- **${c.after.name ? shown(c.after.name) : "Unnamed place"}** (\`${c.after.id}\`): a moderator hid it on ${day(c.after.moderator?.at)}, and it stays hidden.`,
  );
  const sections = toDecide.map((c, i) => placeSection(i + 1, c, input).join("\n"));
  let kept = sections.length;
  let body = head(toDecide.length, none.length, sections, noneLines, 0);
  while (body.length > MAX_BODY_CHARS && kept > 0) {
    kept -= 1;
    body = head(toDecide.length, none.length, sections.slice(0, kept), noneLines, sections.length - kept);
  }
  return body;
}
