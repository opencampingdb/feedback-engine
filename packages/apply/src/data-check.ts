/**
 * What the data repository's validator (`pipeline/validate.py`) accepts, for
 * the files the apply run writes to the automatic branch. The rules here
 * repeat the validator's rules for one place record, one review line and one
 * do-not-match pair, with Python's character classes, so a record that
 * passes here passes there. The run sends an item whose result fails to a
 * person instead of writing it (see `applyRules`).
 *
 * Rules that need the whole repository (ids used twice, ratings against every
 * review, merged records) are left to the rules that write those files.
 */

import { hasLoneSurrogate, isCommonsFileName, isMonthRange } from "@opencampingdb/feedback";
import { PY_DIGIT, PY_SPACE, PY_WORD } from "./python-classes.js";
import type { DoNotMatchEntry } from "./review.js";
import type { Place, Review } from "./types.js";

/** Python's \s, \d and \w as JavaScript classes, for patterns with the `u` flag. */
const S = `[${PY_SPACE}]`;
const D = `[${PY_DIGIT}]`;
const W = `[${PY_WORD}]`;
const NOT_W = `[^${PY_WORD}]`;
/** Python's \b: a word character on one side only. */
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;

/**
 * Letters Python's case-insensitive matching (`(?i)`) takes as the same
 * ASCII letter, beyond its other case: the dotted capital I and dotless i,
 * the long s and the Kelvin sign.
 */
const FOLDS: Record<string, string> = { i: "\\u{130}\\u{131}", k: "\\u{212a}", s: "\\u{17f}" };

/** `word` matched as Python's `(?i)` matches it, with no flag: each letter is a class of its forms. */
function ci(word: string): string {
  return [...word].map((c) => (/[a-z]/.test(c) ? `[${c}${c.toUpperCase()}${FOLDS[c] ?? ""}]` : c === " " ? " " : c)).join("");
}
/** `[a-z0-9-]` under Python's `(?i)`. */
const CI_ALNUM = `[a-zA-Z0-9\\u{130}\\u{131}\\u{17f}\\u{212a}-]`;
const alt = (words: readonly string[]) => `(?:${words.map(ci).join("|")})`;

/** validate.py's ISO_DATE: dates are blanked before the text rules, so a date is never a phone number. */
const ISO_DATE = new RegExp(`(?<!${D})${D}{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]${D}|3[01]))?(?!${D})`, "gu");

/** validate.py's TEXT_RULES, in its order, with the reason each gives. */
const TEXT_RULES: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u, "an email address"],
  [new RegExp(`(?<!${W})\\+?${D}(?:[${PY_SPACE}().\\-]{0,2}${D}){7,}`, "u"), "a phone number"],
  [new RegExp(`${ci("http")}${ci("s")}?://|${B}${ci("www")}\\.|${B}${CI_ALNUM}+\\.${alt(["com", "net", "org", "au", "io", "me"])}${B}`, "u"), "a link"],
  [new RegExp(`(?<![${PY_WORD}.])@[A-Za-z0-9_]{2,}`, "u"), "a social media handle"],
  [new RegExp(`${B}${ci("my name")}(?:'${ci("s")}| ${ci("is")})${B}`, "u"), "a personal name"],
  [new RegExp(`${B}${alt(["call", "text", "ring", "contact", "email", "message", "dm"])} ${ci("me")}${B}`, "u"), "a request for contact"],
  [
    new RegExp(`(?:^|[.!?\\n]${S}*)${alt(["cheers", "regards", "thanks", "thank you", "love", "from"])}[,!${PY_SPACE}\\-]+[A-Z][a-z]+[.!]?${S}*$`, "u"),
    "a personal name",
  ],
];

/** The reasons validate.py's `text_problems` gives for review text and descriptions. Empty when it accepts the text. */
export function textProblems(text: string): string[] {
  const withoutDates = text.replace(ISO_DATE, " ");
  return TEXT_RULES.filter(([pattern]) => pattern.test(withoutDates)).map(([, reason]) => reason);
}

/** Compares two strings by code point, as Python compares them. JavaScript's `<` compares UTF-16 units, which differs above U+FFFF. */
export function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/** Length in code points, as Python and JSON Schema count it. */
const length = (text: string) => [...text].length;

/** Every string in `value` that is not well formed, by its path. */
function illFormed(value: unknown, path: string, out: string[] = []): string[] {
  if (typeof value === "string") {
    if (hasLoneSurrogate(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => illFormed(v, `${path}/${i}`, out));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, v] of Object.entries(value)) {
      if (hasLoneSurrogate(key)) out.push(`${path}/${key}`.replace(/^\//, ""));
      illFormed(v, path === "" ? key : `${path}/${key}`, out);
    }
  }
  return out;
}

/** A string field's limits in place.schema.json. */
interface StringRule {
  min?: number;
  max?: number;
  pattern?: RegExp;
}

/** `$` in a Python pattern also matches before a final newline. */
const PY_END = "\\n?$";
const HTTP = /^https?:\/\//u;
const HTTPS = /^https:\/\//u;
const SCHEMA_EMAIL = new RegExp(`^[^@${PY_SPACE}]+@[^@${PY_SPACE}]+\\.[^@${PY_SPACE}]+${PY_END}`, "u");
const SCHEMA_POSTCODE = new RegExp(`^${D}{4}${PY_END}`, "u");

/** place.schema.json's limits on the string facts travellers and owners set. */
const FACT_STRINGS: Record<string, StringRule> = {
  max_stay: { min: 1, max: 100 },
  opening_hours: { min: 1, max: 255 },
  charge: { min: 1, max: 255 },
  charge_conditional: { min: 1, max: 255 },
  charge_powered: { min: 1, max: 255 },
  website: { max: 500, pattern: HTTP },
  phone: { min: 1, max: 100 },
  phone_2: { min: 1, max: 100 },
  operator: { min: 1, max: 200 },
  email: { max: 254, pattern: SCHEMA_EMAIL },
  facebook: { max: 500, pattern: HTTPS },
  instagram: { max: 500, pattern: HTTPS },
  tiktok: { max: 500, pattern: HTTPS },
  x: { max: 500, pattern: HTTPS },
  booking_url: { max: 500, pattern: HTTPS },
};
const ADDRESS_STRINGS: Record<string, StringRule> = {
  unit: { min: 1, max: 100 },
  housenumber: { min: 1, max: 100 },
  street: { min: 1, max: 100 },
  place: { min: 1, max: 100 },
  suburb: { min: 1, max: 100 },
  postcode: { pattern: SCHEMA_POSTCODE },
};

function stringProblems(value: unknown, path: string, rule: StringRule): string[] {
  if (typeof value !== "string") return [];
  const out: string[] = [];
  if (rule.min !== undefined && length(value) < rule.min) out.push(`${path} is empty`);
  if (rule.max !== undefined && length(value) > rule.max) out.push(`${path} is longer than ${rule.max} characters`);
  if (rule.pattern !== undefined && !rule.pattern.test(value)) out.push(`${path} does not match the schema's pattern`);
  return out;
}

/** Keys `fact_sources` may hold besides the facts. */
const EXTRA_SOURCE_KEYS = new Set(["name", "location", "kind", "status", "description"]);
/** Facts only OSM sets. */
const OSM_ONLY_FACTS = ["nearest_beach", "nearest_boat_ramp", "nearest_major_road"];

const list = (keys: Iterable<string>) => `[${[...keys].sort().join(", ")}]`;
const differ = (a: ReadonlySet<string>, b: ReadonlySet<string>) => new Set([...a, ...b].filter((k) => a.has(k) !== b.has(k)));
const has6Places = (x: number) => Number(x.toFixed(6)) === x;
const isRealDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

export interface PlaceCheckOptions {
  /** Time of the check, ISO 8601 UTC: `last_confirmed` may not be after it. */
  now: string;
  /** Kind code to group, from `schema/kinds.json`. The group is not checked when left out. */
  kinds?: ReadonlyMap<string, string>;
}

/**
 * The reasons validate.py's `check_place_file` would refuse the record,
 * written in canonical form at its path. Empty when it would accept it.
 */
export function placeProblems(place: Place, options: PlaceCheckOptions): string[] {
  const out: string[] = [];
  const facts = place.facts as Record<string, unknown>;
  const sources = place.fact_sources as Record<string, string>;

  // The schema, for the values the apply run writes.
  if (typeof place.name === "string") out.push(...stringProblems(place.name, "name", { min: 1, max: 300 }));
  if (place.description !== undefined) out.push(...stringProblems(place.description, "description", { min: 1, max: 500 }));
  for (const [fact, rule] of Object.entries(FACT_STRINGS)) out.push(...stringProblems(facts[fact], `facts/${fact}`, rule));
  const address = facts.address as Record<string, unknown> | undefined;
  if (typeof address === "object" && address !== null) {
    for (const [field, rule] of Object.entries(ADDRESS_STRINGS)) out.push(...stringProblems(address[field], `facts/address/${field}`, rule));
  }
  // Python writes a lone surrogate as it is, which no file can hold, so the canonical form check fails.
  for (const path of illFormed(place, "")) out.push(`${path} is not well formed text, so the file cannot be in canonical form`);

  if (options.kinds !== undefined) {
    const group = options.kinds.get(place.kind);
    if (group !== undefined && group !== place.group) out.push(`group ${place.group} does not match kind ${place.kind}, which is in group ${group}`);
  }
  for (const axis of ["lat", "lon"] as const) {
    if (!has6Places(place.location[axis])) out.push(`location/${axis} has more than 6 decimal places`);
  }

  const factKeys = new Set(Object.keys(facts));
  const sourceKeys = new Set(Object.keys(sources).filter((k) => !EXTRA_SOURCE_KEYS.has(k)));
  const sourcesDiffer = differ(factKeys, sourceKeys);
  if (sourcesDiffer.size > 0) out.push(`fact_sources must have an entry for every fact and no other fact, differ on ${list(sourcesDiffer)}`);

  const dates = (place.fact_dates ?? {}) as Record<string, string>;
  const notOsm = new Set(Object.keys(sources).filter((k) => sources[k] !== "osm" && sources[k] !== "rule"));
  const datesDiffer = differ(new Set(Object.keys(dates)), notOsm);
  if (datesDiffer.size > 0) out.push(`fact_dates must have an entry for every fact_sources entry that is not osm and no other, differ on ${list(datesDiffer)}`);
  const later = Object.keys(dates).filter((k) => dates[k]! > place.updated);
  if (later.length > 0) out.push(`fact_dates later than updated for ${list(later)}`);

  const reported = OSM_ONLY_FACTS.filter((k) => k in sources && sources[k] !== "osm");
  if (reported.length > 0) out.push(`${list(reported)} come from OSM only, so their source must be osm`);
  if ("pets_months" in facts) {
    if (facts.pets !== "seasonal") out.push("pets_months is only for a place whose pets fact is seasonal");
    const months = facts.pets_months;
    if (typeof months !== "string" || !isMonthRange(months) || months.slice(0, 3) === months.slice(4)) out.push("pets_months must be two different months, such as May-Sep");
  }
  const ruled = Object.keys(sources).filter((k) => sources[k] === "rule");
  if (ruled.length > 0 || "fact_rules" in place) out.push("rule facts and fact_rules are set by the release, never stored in places/");
  if ((place.last_confirmed ?? "") > options.now) out.push(`last_confirmed ${place.last_confirmed} is in the future`);
  if (place.standing !== undefined && place.osm !== null) out.push("standing is only for a place a traveller added, which has osm null");
  if (place.moderator !== undefined && place.osm !== null) out.push("moderator is only for a place a traveller added, which has osm null");

  // owner_errors
  const owned = Object.keys(sources).filter((k) => sources[k] === "owner");
  if (owned.length > 0 && place.owner_verified !== true) out.push(`${list(owned)} have the source owner, so owner_verified must be true`);
  if (place.kind === "farm_stay" && place.osm === null) {
    if (facts.entry !== "private") out.push("a farm_stay must have the fact entry private");
    if (facts.booking_required !== true) out.push("a farm_stay must have the fact booking_required true");
    if (!("booking_url" in facts) && !("phone" in facts)) out.push("a farm_stay needs a booking_url or a phone fact");
  }
  if (typeof place.description === "string") for (const reason of textProblems(place.description)) out.push(`description contains ${reason}`);
  if (place.reopens !== undefined) {
    if (place.status !== "temporarily_closed") out.push("reopens is set but status is not temporarily_closed");
    if (!isRealDay(place.reopens)) out.push(`reopens ${place.reopens} is not a real date`);
  }
  return out;
}

const REVIEW_ID = /^rev_[0-9A-HJKMNP-TV-Z]{26}$/;
const PLACE_ID = /^ocdb_[0-9A-HJKMNP-TV-Z]{26}$/;
const VISITED = /^[0-9]{4}-(0[1-9]|1[0-2])\n?$/;
const CREATED = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\n?$/;
const APP = /^[a-z0-9][a-z0-9-]{0,39}\n?$/;
const CONTRIBUTOR = /^ctr_[0-9a-f]{16}\n?$/;

/** The reasons validate.py's `check_reviews` would refuse the review line. Empty when it would accept it. */
export function reviewProblems(review: Review): string[] {
  const out: string[] = [];
  if (!REVIEW_ID.test(review.id)) out.push("id does not match the schema's pattern");
  if (!PLACE_ID.test(review.place)) out.push("place does not match the schema's pattern");
  if (!Number.isInteger(review.stars) || review.stars < 1 || review.stars > 5) out.push("stars must be 1 to 5");
  if (length(review.text) > 2000) out.push("text is longer than 2000 characters");
  if (!VISITED.test(review.visited)) out.push("visited does not match the schema's pattern");
  if (!CREATED.test(review.created)) out.push("created does not match the schema's pattern");
  if (!APP.test(review.app)) out.push("app does not match the schema's pattern");
  if (!CONTRIBUTOR.test(review.contributor)) out.push("contributor does not match the schema's pattern");
  for (const path of illFormed(review, "")) out.push(`${path} is not well formed text, so the line cannot be in canonical form`);
  for (const reason of textProblems(review.text)) out.push(`text contains ${reason}`);
  return out;
}

/** The reasons `check_do_not_match`, or the SDK's `isCommonsFileName`, would refuse the pair. Empty when both accept it. */
export function doNotMatchProblems(entry: Pick<DoNotMatchEntry, "place" | "file">): string[] {
  const out: string[] = [];
  if (!PLACE_ID.test(entry.place)) out.push("place does not match the schema's pattern");
  // The SDK's rule, which the intake applies to the report, covers the schema's prefix and length rules and more.
  if (!isCommonsFileName(entry.file)) out.push("file is not a Commons file name");
  if (hasLoneSurrogate(entry.file)) out.push("file is not well formed text, so the list cannot be in canonical form");
  return out;
}

/** The problems in `after` that `before` did not have: what a change brings. */
export function newProblems(before: readonly string[], after: readonly string[]): string[] {
  const had = new Set(before);
  return after.filter((p) => !had.has(p));
}
