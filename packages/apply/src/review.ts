import { contactProblem, isCommonsFileName, isContactFact, isDoubtFact, isFactName, isValidFactValue, tidyName, type ContactFactName, type FactName, type FactValue } from "@opencampingdb/feedback";
import type { ContactCheckName } from "./contact-checks.js";
import { byCodePoint } from "./data-check.js";
import type { Settles } from "./decide.js";
import { distanceM, majorRoads, type MajorRoads } from "./roads.js";
import { dumpPlace, placePath } from "./serialise.js";
import { dropSource, setSource } from "./sources.js";
import type { Place, Source } from "./types.js";

/**
 * Held cases as a reviewer reads them from the `feedback/review` PR, and what
 * a reviewer's decision does to a place record. Pure functions with no Node
 * APIs, so the intake's AI reviewer runs them in a Worker.
 *
 * A reviewer decides `approve` (keep a held or hidden new place), `restore`
 * (put a withdrawn contact, or a fact doubts took down, back), `merge` (a
 * held new place into the place it duplicates, with `mergePlaces`),
 * `confirm` (a fact a case suggests), `take_down`
 * (hide a new place that is clear spam), `keep_down` (leave a fact doubts
 * took down off the place), `dismiss` (doubts about a fact that stays) or
 * `leave` (a person decides). `settleByRules` settles what it can before
 * anyone is asked: owner-set values, doubted facts from OSM, blocked
 * contributors, values that wait in the inbox and contacts taken down as spam
 * always go to a person.
 */

export { dumpPlace, majorRoads, placePath };
export type { MajorRoads };
export type { Place };

/**
 * One case for a person, a bot or an AI reviewer to look at, listed in the
 * review PR body as JSON. `duplicate`: a new place held as a possible
 * duplicate of `duplicate_of`. `hidden`: a new place hidden by `reports`
 * reports for `reasons`, or because its contributor is `blocked`. `contacts`:
 * a new place published without the contact facts and address named in
 * `contacts`, which failed the link checks and wait in the inbox for a person.
 * `description`: a new place published without its description, which failed
 * the text checks for `problem` and waits in the inbox. `first_place`: the
 * first place from its contributor, published. `contact_withdrawn`: the
 * contact `fact` taken off a place after reports from two sources for
 * `reasons`; `value` is what the place published, and a reviewer restores it
 * by setting the fact back on the place in the review PR. `fact_doubted`: the
 * fact `fact` doubted by travellers, with `value` the place published, the
 * `sources` doubting it, and the `doubts` and `confirmations` weighed; with
 * `taken_down` the doubts took it off the place, otherwise one traveller
 * doubts it and it stays. `vehicle_access_candidate`: a place whose name
 * suggested `vehicle_access` while its OSM tags did not, listed by older
 * versions of the apply; `feedback` is empty. Such cases are always left: a
 * name alone never sets a fact, so the place is tagged in OSM instead.
 * `commons_mismatch`: travellers say the
 * Commons photo `file` shown for the place is not of it, from `sources`
 * independent sources, not yet enough to put it on the do-not-match list.
 * `contact_check`: a traveller's contact `fact` that failed the automatic
 * contact checks named in `checks`, with what they found in `problem`; it is
 * set on the place in the review PR, and `value` is what the place published
 * before, if anything.
 * `note`: a new place whose report carries a note, published, drafted or
 * merged into the place it duplicates. The note may say something the place
 * should carry, such as an address the app could not confirm on the map, so a
 * person reads it in the inbox and adds what it says by hand.
 * `place_change`: a traveller's report that changes the place's `change`
 * (its name, kind or location) from `from` to `to`, already written to the
 * place on the review branch. `from_source` and `from_date` are where the
 * value it replaces came from and when (`from_group` is the old kind's
 * group), so a reviewer can put it back, and `distance_m` is how far a
 * location moves. A reviewer keeps the change (`approve`) or puts the old
 * value back (`revert`).
 * Contact values a traveller sent, notes and device ids are never in it.
 */
export interface HeldCase {
  case:
    | "duplicate"
    | "hidden"
    | "contacts"
    | "description"
    | "first_place"
    | "contact_withdrawn"
    | "fact_doubted"
    | "vehicle_access_candidate"
    | "commons_mismatch"
    | "contact_check"
    | "note"
    | "place_change";
  place: string;
  /** The place's standing. Left out for a place travellers did not add. */
  standing?: "shown" | "confirmed" | "held" | "hidden";
  location: { lat: number; lon: number };
  kind: string;
  duplicate_of?: string;
  distance_m?: number;
  reports?: number;
  reasons?: string[];
  blocked?: true;
  contacts?: string[];
  /** On `description`: the text check it failed. On `contact_check`: what the failed contact checks found. */
  problem?: string;
  /** On `contact_check`: the contact checks it failed. */
  checks?: ContactCheckName[];
  /** On `contact_withdrawn`: the contact taken off the place. On `fact_doubted`: the fact doubted. On `vehicle_access_candidate`: `vehicle_access`. */
  fact?: FactName;
  /**
   * On `contact_withdrawn` and `fact_doubted`: the value the place published.
   * On `contact_check`: the value the place published before the report, left
   * out when it had none. On `vehicle_access_candidate`: the value its name suggests.
   */
  value?: FactValue;
  /** On `fact_doubted`: the doubts took the fact off the place. */
  taken_down?: boolean;
  /** On `commons_mismatch`: the Commons file name, as `file` in `commons.ndjson.gz`. */
  file?: string;
  /** On `fact_doubted`: independent sources among the doubts. On `commons_mismatch`: among the reports. */
  sources?: number;
  /** On `fact_doubted`: the doubts counted. */
  doubts?: string[];
  /** On `fact_doubted`: the confirmations of the value counted against them. */
  confirmations?: string[];
  contributor?: string;
  /** On `place_change`: what the report changes. */
  change?: PlaceChange;
  /** On `place_change`: the value the change replaces, `null` for a place without a name. */
  from?: string | null | { lat: number; lon: number };
  /** On `place_change`: the value the report sets. */
  to?: string | { lat: number; lon: number };
  /** On `place_change`: where the replaced value came from, left out when it had no source. */
  from_source?: Source;
  /** On `place_change`: when the replaced value was accepted, left out for a value from OSM or with no date. */
  from_date?: string;
  /** On a `place_change` of the kind: the replaced kind's group. */
  from_group?: string;
  /** The feedback ids the case comes from, to read in the inbox. Empty on `vehicle_access_candidate`, which comes from the data. */
  feedback: string[];
}

/**
 * A held case the rules closed, listed in the review PR body as a
 * `closed-case` line: the `fact_doubted` case for `fact` on `place`, settled
 * by travellers `restored` (confirming the value again) or `replaced` (with
 * another value), from the inbox items in `feedback`. It closes every
 * `fact_doubted` case for that place and fact listed before it.
 */
export interface ClosedCase {
  case: "fact_doubted";
  place: string;
  fact: FactName;
  settles: Settles;
  feedback: string[];
}

/** What a `place_change` case changes. */
export type PlaceChange = "name" | "kind" | "location";

/** Every `case` a held-case line can have. */
export const HELD_CASES: readonly HeldCase["case"][] = [
  "duplicate",
  "hidden",
  "contacts",
  "description",
  "first_place",
  "contact_withdrawn",
  "fact_doubted",
  "vehicle_access_candidate",
  "commons_mismatch",
  "contact_check",
  "note",
  "place_change",
];

/** Cases that come from the data rather than from feedback, so they name no feedback ids. */
const FROM_DATA: readonly HeldCase["case"][] = ["vehicle_access_candidate"];

const PLACE_ID = /^ocdb_[0-9A-HJKMNP-TV-Z]{26}$/;
const HELD_LINE = /^- held-case (\{.*\})\s*$/;
const CLOSED_LINE = /^- closed-case (\{.*\})\s*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

const isPoint = (v: unknown): v is { lat: number; lon: number } =>
  isObject(v) && typeof v.lat === "number" && typeof v.lon === "number" && Number.isFinite(v.lat) && Number.isFinite(v.lon);

/** Whether a `place_change` case has a change and the values it needs, of the right type for it. */
function isPlaceChange(v: Record<string, unknown>): boolean {
  if (v.fact !== undefined) return false;
  if (v.from_source !== undefined && typeof v.from_source !== "string") return false;
  if (v.from_date !== undefined && typeof v.from_date !== "string") return false;
  if (v.change === "name") return typeof v.to === "string" && (typeof v.from === "string" || v.from === null);
  if (v.change === "kind") return typeof v.to === "string" && typeof v.from === "string" && typeof v.from_group === "string";
  if (v.change === "location") return isPoint(v.to) && isPoint(v.from);
  return false;
}

/** Whether `v` has the shape the apply writes for a held case. */
export function isHeldCase(v: unknown): v is HeldCase {
  if (!isObject(v)) return false;
  if (!HELD_CASES.includes(v.case as HeldCase["case"])) return false;
  if (typeof v.place !== "string" || !PLACE_ID.test(v.place)) return false;
  if (!isObject(v.location) || typeof v.location.lat !== "number" || typeof v.location.lon !== "number") return false;
  if (typeof v.kind !== "string" || !isStrings(v.feedback)) return false;
  if (v.feedback.length === 0 && !FROM_DATA.includes(v.case as HeldCase["case"])) return false;
  if (v.duplicate_of !== undefined && (typeof v.duplicate_of !== "string" || !PLACE_ID.test(v.duplicate_of))) return false;
  if (v.case === "commons_mismatch") {
    if (typeof v.file !== "string" || v.file.length === 0 || typeof v.sources !== "number" || v.fact !== undefined) return false;
  } else if (v.case === "vehicle_access_candidate") {
    if (v.fact !== "vehicle_access" || !isValidFactValue("vehicle_access", v.value)) return false;
  } else if (v.case === "place_change") {
    if (!isPlaceChange(v)) return false;
  } else if (v.case === "fact_doubted") {
    if (!isDoubtFact(v.fact) || v.value === undefined || typeof v.taken_down !== "boolean") return false;
    if (typeof v.sources !== "number" || !isStrings(v.doubts) || !isStrings(v.confirmations)) return false;
  } else if (v.fact !== undefined && (typeof v.fact !== "string" || !isContactFact(v.fact))) return false;
  if (v.case === "contact_withdrawn" && (v.fact === undefined || v.value === undefined)) return false;
  if (v.case === "contact_check") {
    const names: readonly unknown[] = ["website", "domain_age", "address"];
    if (v.fact === undefined || !Array.isArray(v.checks) || v.checks.length === 0 || !v.checks.every((c) => names.includes(c))) return false;
  }
  if (v.reasons !== undefined && !isStrings(v.reasons)) return false;
  if (v.contacts !== undefined && !isStrings(v.contacts)) return false;
  return true;
}

/**
 * The held cases in a review PR body or comment: each `- held-case` line
 * whose JSON parses to a held case. Other lines, and lines that don't parse,
 * are skipped.
 */
export function parseHeldCases(text: string): HeldCase[] {
  const out: HeldCase[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = HELD_LINE.exec(line);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]!);
      if (isHeldCase(value)) out.push(value);
    } catch {
      // Not a line the apply wrote.
    }
  }
  return out;
}

/** Whether `v` has the shape the apply writes for a closed case. */
export function isClosedCase(v: unknown): v is ClosedCase {
  if (!isObject(v) || v.case !== "fact_doubted") return false;
  if (typeof v.place !== "string" || !PLACE_ID.test(v.place) || !isDoubtFact(v.fact)) return false;
  return (v.settles === "restored" || v.settles === "replaced") && isStrings(v.feedback) && v.feedback.length > 0;
}

/** The closed cases in a review PR body or comment: each `- closed-case` line whose JSON parses to one. */
export function parseClosedCases(text: string): ClosedCase[] {
  const out: ClosedCase[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = CLOSED_LINE.exec(line);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]!);
      if (isClosedCase(value)) out.push(value);
    } catch {
      // Not a line the apply wrote.
    }
  }
  return out;
}

/** One key per held case, the same however often the case is listed: its kind, place, fact and feedback ids. */
export function heldCaseKey(c: HeldCase): string {
  return [c.case, c.place, c.fact ?? c.file ?? "", [...c.feedback].sort().join(",")].join(" ");
}

export type ReviewDecision = "approve" | "restore" | "take_down" | "keep_down" | "dismiss" | "leave" | "confirm" | "merge" | "revert";

/**
 * What a reviewer may decide on a case of each kind. `contacts` and
 * `description` name values that wait in the inbox, so only a person can
 * decide them. A `fact_doubted` case the doubts took down may be restored or
 * kept down, and doubts about a fact that stays may be dismissed.
 */
export function allowedDecisions(c: HeldCase): ReviewDecision[] {
  switch (c.case) {
    case "duplicate":
      return ["approve", "merge", "take_down", "leave"];
    case "hidden":
    case "first_place":
      return ["approve", "take_down", "leave"];
    case "contact_withdrawn":
      return ["restore", "leave"];
    case "fact_doubted":
      return c.taken_down ? ["restore", "keep_down", "leave"] : ["dismiss", "leave"];
    case "vehicle_access_candidate":
      return ["leave"];
    case "commons_mismatch":
      return ["confirm", "dismiss", "leave"];
    case "contact_check":
      return ["confirm", "dismiss", "leave"];
    case "place_change":
      return ["approve", "revert", "leave"];
    default:
      return ["leave"];
  }
}

/** The longest move of a place's location a reviewer decides. A longer one goes to a person. */
export const MAX_REVIEWER_MOVE_M = 500;

/** A name as names are compared: lower case, `&` as "and", and only letters and digits, one space apart. */
const nameWords = (name: string) =>
  ` ${tidyName(name).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/**
 * Whether `name` is confirmed: the same as the name from OSM, `osmName`, once
 * case, accents and punctuation are set aside, or found whole among the words
 * of one of `siteNames`, the title and headings of the place's own website.
 */
export function nameConfirmed(name: string, osmName: string | null | undefined, siteNames: readonly string[] = []): boolean {
  const words = nameWords(name);
  if (words.trim() === "") return false;
  if (typeof osmName === "string" && nameWords(osmName) === words) return true;
  return siteNames.some((text) => nameWords(text).includes(words));
}

/**
 * `leave`, and why, when the rules settle a `place_change` case; null when a
 * reviewer decides it. A person decides an owner's value, a place with a
 * verified owner, a change no longer on the place, a move of more than
 * MAX_REVIEWER_MOVE_M and a name `nameConfirmed` does not confirm.
 */
function settleChange(c: HeldCase, place: Place, siteNames: readonly string[] | undefined): { decision: "leave"; reason: string } | null {
  const leave = (reason: string) => ({ decision: "leave" as const, reason });
  if (c.from_source === "owner" || place.fact_sources[c.change!] === "owner") return leave("the owner set this value, so a person decides");
  if (place.owner_verified === true) return leave("the place has a verified owner");
  const current = c.change === "name" ? place.name : c.change === "kind" ? place.kind : place.location;
  if (JSON.stringify(current) !== JSON.stringify(c.to)) return leave("the place has changed since the report");
  if (c.change === "location") {
    const moved = Math.round(distanceM(c.from as { lat: number; lon: number }, c.to as { lat: number; lon: number }));
    if (moved > MAX_REVIEWER_MOVE_M) return leave(`a move of ${moved} m is more than ${MAX_REVIEWER_MOVE_M} m, so a person checks it`);
  }
  if (c.change === "name") {
    const osmName = c.from_source === "osm" ? (c.from as string | null) : undefined;
    if (!nameConfirmed(c.to as string, osmName, siteNames)) {
      return leave("the new name matches neither the name from OSM nor the place's own website, so a person checks it");
    }
  }
  return null;
}

/**
 * `leave`, and why, when the rules settle a case; null when a reviewer has to
 * look at it. `context.doNotMatch` is the do-not-match list, for a
 * `commons_mismatch` case. `context.siteNames` is the title and headings of
 * the place's own website, for a name change, when they could be read.
 */
export function settleByRules(
  c: HeldCase,
  place: Place | undefined,
  context: { doNotMatch?: readonly Pick<DoNotMatchEntry, "place" | "file">[]; siteNames?: readonly string[] } = {},
): { decision: "leave"; reason: string } | null {
  const leave = (reason: string) => ({ decision: "leave" as const, reason });
  // Only a person reads a traveller's note: it is in the inbox, never in the case.
  if (c.case === "note") return leave("the note is in the inbox, so a person reads it");
  if (!place) return leave("the place record is not on the review branch");
  if (place.status === "merged") return leave("the place was merged into another");
  if (c.case === "contacts" || c.case === "description") return leave("what was left off the place is in the inbox, so a person decides");
  if (c.case === "place_change") return settleChange(c, place, context.siteNames);
  if (c.case === "commons_mismatch") {
    if (context.doNotMatch?.some((p) => p.place === c.place && p.file === c.file)) return leave("the Commons photo is on the do-not-match list already");
    return null;
  }
  // A name alone never sets a fact: a mapper tags the place in OSM instead.
  if (c.case === "vehicle_access_candidate") return leave("a name alone never sets a fact, so the place is tagged in OpenStreetMap");
  if (c.case === "fact_doubted") {
    const fact = c.fact!;
    const current = (place.facts as Record<string, unknown>)[fact];
    // Doubts never move an owner's fact, so neither does a reviewer.
    if (place.fact_sources[fact] === "owner") return leave("the owner set this fact");
    // Nor an OSM fact: it is fixed in OSM, which the data follows.
    if (place.fact_sources[fact] === "osm") return leave("this fact came from OSM, so a person decides");
    if (c.taken_down && current !== undefined) return leave("the place has this fact again");
    if (!c.taken_down && (current === undefined || JSON.stringify(current) !== JSON.stringify(c.value))) return leave("the fact has changed since the doubt");
    return null;
  }
  if (c.case === "contact_withdrawn") {
    const fact = c.fact as ContactFactName;
    if (place.fact_sources[fact] === "owner") return leave("the owner set this contact");
    if ((place.facts as Record<string, unknown>)[fact] !== undefined) return leave("the place has this contact again");
    const problem = contactProblem(fact, c.value);
    if (problem !== null) return leave(`the contact fails the link rules (${problem})`);
    // A takedown for spam is only undone by a person, so a reviewer can't put spam back.
    if (c.reasons?.includes("spam")) return leave("it was reported as spam, so only a person restores it");
    return null;
  }
  if (c.case === "contact_check") {
    // Owners keep control of their listings: a person decides.
    if (place.owner_verified === true) return leave("the place has a verified owner");
    if (place.fact_sources[c.fact!] === "owner") return leave("the owner set this contact");
    return null;
  }
  if (place.owner_verified === true) return leave("the place has a verified owner");
  if (place.standing === undefined) return leave("travellers did not add this place");
  if (place.moderator !== undefined) return leave("a person has already decided on this place");
  if (c.case === "hidden" && c.blocked === true) return leave("its contributor is blocked, and only a person decides on a block");
  if (c.case === "duplicate" && place.standing !== "held") return leave("the place is no longer held");
  if (c.case === "hidden" && place.standing !== "hidden") return leave("the place is no longer hidden");
  if (c.case === "first_place" && place.standing === "hidden") return leave("the place is already hidden");
  return null;
}

/**
 * The place record after a reviewer's decision, at `at` (a UTC time), or null
 * when the decision changes nothing in the data. `approve` sets a held place's
 * standing to `shown`, and restores a hidden one with a `restore` decision;
 * on a published first place it changes nothing. `take_down` hides the place
 * with a `hide` decision, so reports can't bring it back. `restore` sets the
 * withdrawn contact, or a fact doubts took down, back to the value the place
 * published. `revert` puts back the name, kind or location a `place_change`
 * replaced, and `approve` on one changes nothing, as the change is on the
 * place already. `keep_down` and `dismiss` change nothing, and neither does
 * `merge` here: it writes two records, with `mergePlaces`. On a
 * `contact_check` case, `confirm` keeps the reported contact the review PR
 * set, and `dismiss` puts back the value the place had before, or takes the
 * contact off when it had none.
 */
export function applyDecision(place: Place, c: HeldCase, decision: ReviewDecision, at: string): Place | null {
  if (!allowedDecisions(c).includes(decision) || decision === "leave" || decision === "keep_down" || decision === "merge") return null;
  if (decision === "dismiss" && c.case !== "contact_check") return null;
  // A Commons photo goes on the do-not-match list (`withDoNotMatch`), not into the place record.
  if (c.case === "commons_mismatch") return null;
  // An approved name, kind or location change is on the place already.
  if (c.case === "place_change" && decision === "approve") return null;
  // A confirmed contact stays as the review PR has it.
  if (c.case === "contact_check" && decision === "confirm") return null;
  const next = structuredClone(place);
  if (decision === "revert") {
    revertChange(next, c);
  } else if (c.case === "contact_check") {
    // Dismissed: the place's earlier value, or none.
    if (c.value !== undefined) {
      (next.facts as Record<string, FactValue>)[c.fact!] = c.value;
      setSource(next, c.fact!, "feedback", at);
    } else {
      delete (next.facts as Record<string, FactValue | undefined>)[c.fact!];
      dropSource(next, c.fact!);
    }
  } else if (decision === "restore") {
    (next.facts as Record<string, FactValue>)[c.fact!] = c.value as FactValue;
    setSource(next, c.fact!, "feedback", at);
  } else if (decision === "take_down") {
    next.standing = "hidden";
    next.moderator = { action: "hide", at };
  } else if (c.case === "first_place") {
    return null;
  } else {
    next.standing = "shown";
    if (c.case === "hidden") next.moderator = { action: "restore", at };
  }
  next.updated = at;
  return next;
}

/** Puts back the value a `place_change` case replaced, with its source and date as they were. */
function revertChange(place: Place, c: HeldCase): void {
  const key = c.change!;
  if (key === "name") place.name = c.from as string | null;
  else if (key === "kind") {
    place.kind = c.from as Place["kind"];
    place.group = c.from_group as Place["group"];
  } else place.location = { ...(c.from as { lat: number; lon: number }) };
  if (c.from_source === undefined) delete place.fact_sources[key];
  else place.fact_sources[key] = c.from_source;
  const dates = { ...place.fact_dates };
  if (c.from_date === undefined) delete dates[key];
  else dates[key] = c.from_date;
  if (Object.keys(dates).length > 0) place.fact_dates = dates;
  else delete place.fact_dates;
}

/** One key for a pair of places, whichever comes first, as `moderation/distinct_places.json` lists them. */
export const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** Sources whose facts move to the kept record in a merge, as the data repository's `pipeline.merge` moves them. */
const MOVABLE: readonly string[] = ["feedback", "contributed", "community_report", "overture"];

/**
 * Why a new place may not be merged into `other`, the place it may
 * duplicate, or null when it may: never into a place with a verified owner,
 * a tombstone or a place of another group, and never a pair on
 * `moderation/distinct_places.json` (keys from `pairKey`).
 */
export function mergeProblem(place: Place, other: Place | undefined, distinct: ReadonlySet<string> = new Set()): string | null {
  if (!other) return "the place it duplicates is not on the review branch";
  if (other.status === "merged") return "the place it duplicates was merged into another";
  if (other.owner_verified === true) return "the place it duplicates has a verified owner";
  if (other.group !== place.group) return "the two places are in different groups";
  if (distinct.has(pairKey(place.id, other.id))) return "moderation/distinct_places.json lists the two as separate places";
  return null;
}

/** Without road data, a reviewer merges only places closer than this, with the same name. */
export const MERGE_WITHOUT_ROADS_M = 25;

/**
 * Why a reviewer may not merge a new place into `other`, or null when it
 * may: `mergeProblem`, and then the opposite-side rule. With `roads`, a pair
 * whose straight line crosses a major road stays apart. Without road data,
 * only the same name once tidied, less than MERGE_WITHOUT_ROADS_M apart, is
 * merged.
 */
export function reviewerMergeProblem(place: Place, other: Place | undefined, distinct: ReadonlySet<string> = new Set(), roads?: MajorRoads): string | null {
  const problem = mergeProblem(place, other, distinct);
  if (problem !== null || !other) return problem;
  if (roads) {
    const road = roads.between(place.location, other.location);
    return road ? `a major road runs between them (${road.name ?? road.ref ?? road.highway})` : null;
  }
  const sameName = place.name !== null && other.name !== null && tidyName(place.name).toLowerCase() === tidyName(other.name).toLowerCase();
  if (!sameName) return "without road data, only places with the same name are merged";
  if (distanceM(place.location, other.location) >= MERGE_WITHOUT_ROADS_M) return `without road data, only places less than ${MERGE_WITHOUT_ROADS_M} m apart are merged`;
  return null;
}

/**
 * `dropped` merged into `kept` at `at`, as the data repository's
 * `pipeline.merge` does it: the facts `dropped` has from feedback,
 * contributions, community reports or Overture Maps that `kept` lacks move
 * with their dates (and any of them but Overture replaces an Overture value
 * on `kept`), `kept` takes the newer `last_confirmed`, and `dropped` becomes a
 * tombstone, `status: "merged"` with `merged_into`, otherwise unchanged.
 * Releases list tombstones in `merged.ndjson.gz`, so an app that stored the
 * new place's id can follow it. A person reverses a merge by setting the
 * tombstone's `status` back and removing `merged_into`, and lists the pair in
 * `moderation/distinct_places.json` so it is not merged again.
 */
export function mergePlaces(kept: Place, dropped: Place, at: string): { kept: Place; tombstone: Place } {
  const next = structuredClone(kept);
  for (const [key, source] of Object.entries(dropped.fact_sources).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isFactName(key) || !MOVABLE.includes(source!)) continue;
    // A value from any movable source but Overture also replaces an Overture value (a gap fill) on the kept place.
    if (key in next.facts && !(next.fact_sources[key] === "overture" && source !== "overture")) continue;
    const value = (dropped.facts as Record<string, FactValue | undefined>)[key];
    if (value === undefined) continue;
    (next.facts as Record<string, FactValue>)[key] = value;
    next.fact_sources[key] = source;
    const date = dropped.fact_dates?.[key];
    if (date !== undefined) next.fact_dates = { ...next.fact_dates, [key]: date };
  }
  const confirmed = [kept.last_confirmed ?? "", dropped.last_confirmed ?? ""].sort().at(-1)!;
  if (confirmed) next.last_confirmed = confirmed;
  next.updated = at;
  return { kept: next, tombstone: { ...structuredClone(dropped), status: "merged", merged_into: kept.id } };
}

/**
 * One entry of `moderation/commons-do-not-match.json` in the data
 * repository: a Commons file that is not of a place, so `pipeline.commons`
 * never matches it to the place again and releases leave it out. `added` is
 * the day, `YYYY-MM-DD`. `source` is `reports` when two travellers' reports
 * put it there, or `reviewer` when a reviewer confirmed one report. A person
 * undoes it by deleting the entry.
 */
export interface DoNotMatchEntry {
  place: string;
  file: string;
  added: string;
  source: "reports" | "reviewer";
}

/**
 * `moderation/commons-do-not-match.json` as it should be with `entries`
 * added: `{"pairs": [...]}`, sorted by place and file by code point, keys in sorted order
 * as Python's json.dumps(sort_keys=True) writes them, two spaces, a trailing
 * newline. A pair already there keeps its entry, and a pair whose file is
 * not a Commons file name (`isCommonsFileName`) is left out. `text` is the
 * file as it is, or undefined when there is none.
 */
export function withDoNotMatch(text: string | undefined, entries: readonly DoNotMatchEntry[]): string {
  const current = text === undefined ? [] : ((JSON.parse(text) as { pairs?: DoNotMatchEntry[] }).pairs ?? []);
  const key = (e: Pick<DoNotMatchEntry, "place" | "file">) => `${e.place}\u0000${e.file}`;
  const byKey = new Map(current.map((e) => [key(e), e]));
  // Only a file with the shape of a Commons file name is ever written, whoever adds it.
  for (const e of entries) if (isCommonsFileName(e.file) && !byKey.has(key(e))) byKey.set(key(e), e);
  const pairs = [...byKey.values()]
    // By code point, as Python's sorted() orders the pairs the validator checks.
    .sort((a, b) => byCodePoint(a.place, b.place) || byCodePoint(a.file, b.file))
    .map((e) => ({ added: e.added, file: e.file, place: e.place, source: e.source }));
  return `${JSON.stringify({ pairs }, null, 2)}\n`;
}
