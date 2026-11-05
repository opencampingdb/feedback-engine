import { contactProblem, isContactFact, isDoubtFact, isFactName, isValidFactValue, type ContactFactName, type FactName, type FactValue } from "@opencampingdb/feedback";
import type { Settles } from "./decide.js";
import { dumpPlace, placePath } from "./serialise.js";
import { setSource } from "./sources.js";
import type { Place } from "./types.js";

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

export { dumpPlace, placePath };
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
 * says who may use it (such as "Truck Parking Bay") but whose OSM tags do
 * not, from `moderation/heavy-vehicle-candidates.csv` in the data
 * repository; `fact` is `vehicle_access`, `value` the value the name
 * suggests, and `feedback` is empty. Contact values a traveller sent, notes
 * and device ids are never in it.
 */
export interface HeldCase {
  case: "duplicate" | "hidden" | "contacts" | "description" | "first_place" | "contact_withdrawn" | "fact_doubted" | "vehicle_access_candidate";
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
  /** On `description`: the text check it failed. */
  problem?: string;
  /** On `contact_withdrawn`: the contact taken off the place. On `fact_doubted`: the fact doubted. On `vehicle_access_candidate`: `vehicle_access`. */
  fact?: FactName;
  /** On `contact_withdrawn` and `fact_doubted`: the value the place published. On `vehicle_access_candidate`: the value its name suggests. */
  value?: FactValue;
  /** On `fact_doubted`: the doubts took the fact off the place. */
  taken_down?: boolean;
  /** On `fact_doubted`: independent sources among the doubts. */
  sources?: number;
  /** On `fact_doubted`: the doubts counted. */
  doubts?: string[];
  /** On `fact_doubted`: the confirmations of the value counted against them. */
  confirmations?: string[];
  contributor?: string;
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
];

/** Cases that come from the data rather than from feedback, so they name no feedback ids. */
const FROM_DATA: readonly HeldCase["case"][] = ["vehicle_access_candidate"];

const PLACE_ID = /^ocdb_[0-9A-HJKMNP-TV-Z]{26}$/;
const HELD_LINE = /^- held-case (\{.*\})\s*$/;
const CLOSED_LINE = /^- closed-case (\{.*\})\s*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Whether `v` has the shape the apply writes for a held case. */
export function isHeldCase(v: unknown): v is HeldCase {
  if (!isObject(v)) return false;
  if (!HELD_CASES.includes(v.case as HeldCase["case"])) return false;
  if (typeof v.place !== "string" || !PLACE_ID.test(v.place)) return false;
  if (!isObject(v.location) || typeof v.location.lat !== "number" || typeof v.location.lon !== "number") return false;
  if (typeof v.kind !== "string" || !isStrings(v.feedback)) return false;
  if (v.feedback.length === 0 && !FROM_DATA.includes(v.case as HeldCase["case"])) return false;
  if (v.duplicate_of !== undefined && (typeof v.duplicate_of !== "string" || !PLACE_ID.test(v.duplicate_of))) return false;
  if (v.case === "vehicle_access_candidate") {
    if (v.fact !== "vehicle_access" || !isValidFactValue("vehicle_access", v.value)) return false;
  } else if (v.case === "fact_doubted") {
    if (!isDoubtFact(v.fact) || v.value === undefined || typeof v.taken_down !== "boolean") return false;
    if (typeof v.sources !== "number" || !isStrings(v.doubts) || !isStrings(v.confirmations)) return false;
  } else if (v.fact !== undefined && (typeof v.fact !== "string" || !isContactFact(v.fact))) return false;
  if (v.case === "contact_withdrawn" && (v.fact === undefined || v.value === undefined)) return false;
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
  return [c.case, c.place, c.fact ?? "", [...c.feedback].sort().join(",")].join(" ");
}

export type ReviewDecision = "approve" | "restore" | "take_down" | "keep_down" | "dismiss" | "leave" | "confirm" | "merge";

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
      return ["confirm", "leave"];
    default:
      return ["leave"];
  }
}

/** `leave`, and why, when the rules settle a case; null when a reviewer has to look at it. */
export function settleByRules(c: HeldCase, place: Place | undefined): { decision: "leave"; reason: string } | null {
  const leave = (reason: string) => ({ decision: "leave" as const, reason });
  if (!place) return leave("the place record is not on the review branch");
  if (place.status === "merged") return leave("the place was merged into another");
  if (c.case === "contacts" || c.case === "description") return leave("what was left off the place is in the inbox, so a person decides");
  if (c.case === "vehicle_access_candidate") {
    if (place.status !== "open") return leave("the place is not open");
    if (place.facts.vehicle_access !== undefined) return leave("the place has vehicle_access already");
    if (place.owner_verified === true) return leave("the place has a verified owner");
    return null;
  }
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
 * published. `confirm` sets the fact a `vehicle_access_candidate` names, as
 * from feedback. `keep_down` and `dismiss` change nothing, and neither does
 * `merge` here: it writes two records, with `mergePlaces`.
 */
export function applyDecision(place: Place, c: HeldCase, decision: ReviewDecision, at: string): Place | null {
  if (!allowedDecisions(c).includes(decision) || decision === "leave" || decision === "keep_down" || decision === "dismiss" || decision === "merge") return null;
  const next = structuredClone(place);
  if (decision === "restore" || (decision === "confirm" && c.case === "vehicle_access_candidate")) {
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

/**
 * The `vehicle_access_candidate` cases for the places in `candidates` (ids
 * from `moderation/heavy-vehicle-candidates.csv`), in that order: each open
 * place without `vehicle_access` that is not in `listed`, the places a run
 * listed before. The value is `heavy_vehicles_only`, the only one the
 * candidates file is for.
 */
export function vehicleAccessCases(candidates: readonly string[], places: ReadonlyMap<string, Place>, listed: ReadonlySet<string>): HeldCase[] {
  const out: HeldCase[] = [];
  for (const id of new Set(candidates)) {
    const place = places.get(id);
    if (!place || listed.has(id) || place.status !== "open" || place.facts.vehicle_access !== undefined) continue;
    out.push({
      case: "vehicle_access_candidate",
      place: id,
      location: { lat: place.location.lat, lon: place.location.lon },
      kind: place.kind,
      fact: "vehicle_access",
      value: "heavy_vehicles_only",
      feedback: [],
    });
  }
  return out;
}

/** One key for a pair of places, whichever comes first, as `moderation/distinct_places.json` lists them. */
export const pairKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);

/** Sources whose facts move to the kept record in a merge, as the data repository's `pipeline.merge` moves them. */
const MOVABLE: readonly string[] = ["feedback", "contributed", "community_report"];

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

/**
 * `dropped` merged into `kept` at `at`, as the data repository's
 * `pipeline.merge` does it: the facts `dropped` has from feedback,
 * contributions or community reports that `kept` lacks move with their
 * dates, `kept` takes the newer `last_confirmed`, and `dropped` becomes a
 * tombstone, `status: "merged"` with `merged_into`, otherwise unchanged.
 * Releases list tombstones in `merged.ndjson.gz`, so an app that stored the
 * new place's id can follow it. A person reverses a merge by setting the
 * tombstone's `status` back and removing `merged_into`, and lists the pair in
 * `moderation/distinct_places.json` so it is not merged again.
 */
export function mergePlaces(kept: Place, dropped: Place, at: string): { kept: Place; tombstone: Place } {
  const next = structuredClone(kept);
  for (const [key, source] of Object.entries(dropped.fact_sources).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isFactName(key) || !MOVABLE.includes(source!) || key in next.facts) continue;
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
