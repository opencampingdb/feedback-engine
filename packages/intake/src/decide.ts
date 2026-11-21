import {
  CHECK_HOLDS,
  decideClear,
  sameValue,
  decideContactReport,
  decideDoubt,
  decideFact,
  findDispute,
  gapFillFact,
  newPlaceFields,
  newPlaceListing,
  REVIEWED_FACTS,
  sourceOf,
  WINDOW_DAYS,
  type HeldReason as RulesHeldReason,
  type ItemDecision,
  type OpenDoubt,
  type PlaceState,
  type RefusedReason,
  type ReportItem,
  type Setter,
} from "@opencampingdb/apply/decide";
import { websiteCheck, websiteCheckApplies, type Fetch as CheckFetch } from "@opencampingdb/apply/contact-checks";
import {
  isContactFact,
  newPlaceId,
  tidyName,
  type ContactFactName,
  type FactName,
  type FactValue,
  type FeedbackSubmission,
  type RecentChange,
  type ReportBody,
  type UnconfirmedValue,
  type StoredFeedback,
  type HeldReason as PublishedHeldReason,
} from "@opencampingdb/feedback";
import type { CheckContributor, Checks, HeldReason as ChecksHeldReason, LiveSlot } from "./checks.js";
import { implausibleLocation, type PlaceGeometry } from "@opencampingdb/apply/plausible";
import { getIndexedPlace, type Cell } from "./place-index.js";
import { chunks, isoSeconds, placeStatement, prunePlaceStatements, type Bbox, type D1Like, type D1Statement, type StoredPlace } from "./recent.js";

/**
 * The intake deciding an item at send time, with the apply's own rules
 * (`@opencampingdb/apply/decide`) and then the checks (checks.ts), so the app
 * learns at once whether its change is live or held. The inbox write is the
 * same either way, and the apply still writes the data.
 *
 * Decided here: `fact`, `contact` and `doubt` reports about a released place,
 * and `new_place` reports. A `commons_mismatch` report is always held. A fact report, contact takedown or doubt takedown
 * that goes live is a recent change, served with the recent list by map area
 * until 7 days after the apply has put it into the data. A doubt takedown also
 * opens a case in `doubt_cases` with the value the fact had, as does a
 * takedown by the apply (`openDoubtCases`), so a later report of that value is
 * decided as a confirmation, and the restore or replacement that goes live
 * closes it. A live new place goes on the recent list
 * with its description, fee and contacts. Everything else the apply decides,
 * as before, and its answer has no `state`.
 *
 * Each item is decided against the place in the place index with the recent
 * changes on it laid over, and against the fact, contact and doubt reports the
 * intake decided for the same place and fact in the last 90 days, live or held. The
 * checks run last, only for an item the rules would put live, because an item
 * that passes them takes one of its contributor's daily live changes.
 */

/** Days a recent change is kept after the apply has put it into the data. */
export const KEEP_IN_DATA_DAYS = 7;
/**
 * Days a recent change is kept after it was accepted while the apply has not
 * put it into the data, so a change whose item never reached the data (an
 * inbox that stopped taking writes, say) does not stay on the list for ever.
 */
export const KEEP_NOT_IN_DATA_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why the intake held an item. The rules' and the checks' reasons, and:
 * `unknown_place`, the place is not in the place index (a place the release
 * doesn't have yet, or a new place); `blocked`, the contributor is on the
 * block list; `no_value` and `invalid_value`, the rules would refuse it (a
 * contact report or doubt about a fact the place does not have, as the index
 * has it). `commons_report`: a report that a Commons photo is not of the
 * place, which the apply decides. `source_link`: a fact report without
 * attestation that carries a source link, waiting for the apply run to read
 * the page. `implausible_location`: a new place in the sea or a lake, on a
 * major road's carriageway or inside a building footprint, which the AI
 * reviewer checks. `waiting_value`: a doubt about a fact while another
 * source's report of a new value for it waits for a second source, which
 * counts against that report and never takes the place's value down.
 * `new_place_cap`: a new place past its contributor's first
 * NEW_PLACE_DAILY_LIMIT new places of the UTC day, which the AI reviewer
 * checks. The apply decides each of these again when it runs.
 */
export type HeldReason =
  | RulesHeldReason
  | ChecksHeldReason
  | RefusedReason
  | "unknown_place"
  | "blocked"
  | "commons_report"
  | "source_link"
  | "implausible_location"
  | "waiting_value"
  | "new_place_cap";
// Every reason the intake answers is in the SDK's published list: this fails to compile otherwise.
const PUBLISHED: readonly PublishedHeldReason[] = [] as HeldReason[];
void PUBLISHED;

/** What the answer to an accepted item adds. */
export type ItemState = { state: "live" } | { state: "held"; held_reason: HeldReason };

/**
 * What the items decided earlier in the same batch will write when the batch
 * is stored, so each later item is decided as if those were stored already,
 * as it would be had each item been sent alone (`decideAtSendTime`).
 */
export interface DecidedInRequest {
  /** Recent changes, in the order they were decided. */
  changes: { place: string; fact: string; value: string | null; accepted: string }[];
  /** Report evidence, in the order it was decided. */
  evidence: EvidenceRow[];
  /** Doubt cases by place and fact: opened with the value the place had, or closed (null). */
  cases: Map<string, { value: string; taken_down_at: string } | null>;
  /** Accepted items by contributor. */
  accepted: Map<string, number>;
  /** Places frozen by an item in the batch, with the disputed fact and when. */
  frozen: Map<string, { fact: string; frozen_at: string }>;
}

/** Nothing decided yet: for a single item, or the start of a batch. */
export function noneDecided(): DecidedInRequest {
  return { changes: [], evidence: [], cases: new Map(), accepted: new Map(), frozen: new Map() };
}

const caseKey = (place: string, fact: string) => `${place}\u0000${fact}`;

/** What the intake decided, and the writes that record it once the item is in the inbox. */
export interface SendTimeDecision {
  answer: ItemState;
  writes: (db: D1Like) => D1Statement[];
  /** Adds what `writes` will store to what was decided in the request, once the item is accepted into the batch. */
  addToDecided?: (decided: DecidedInRequest) => void;
  /** The live change the checks took from the daily caps, to give back with `releaseLive` when the item is not recorded. */
  slot?: LiveSlot;
  /** On an item the rules held: its links passed the link rules and URLhaus. The inbox stores it with the decision. */
  linksPassed?: true;
}

/** The answer when the decision could not be made or recorded. */
export const UNAVAILABLE: ItemState = { state: "held", held_reason: "check_unavailable" };

/** A recent change as `GET /v1/places/recent` serves it: the SDK's type, so apps read what the intake writes. */
export type { RecentChange };

/** Whether the intake decides `item` at send time. */
export function decidedHere(item: StoredFeedback): item is ReportItem {
  if (item.type !== "report") return false;
  const kind = item.report.kind;
  if (kind === "new_place") return true;
  if (kind === "commons_mismatch") return typeof item.place === "string";
  return (kind === "fact" || kind === "contact" || kind === "doubt" || kind === "clear") && typeof item.place === "string" && typeof item.report.fact === "string";
}


/** A contributor's track record, whether they are on the block list, and whether the apply trusts them (trust from a track record). */
export async function contributorRecord(
  db: D1Like,
  contributor: string,
  decided: DecidedInRequest = noneDecided(),
): Promise<CheckContributor & { blocked: boolean; trusted: boolean }> {
  const row = await db
    .prepare(
      `SELECT COALESCE((SELECT accepted FROM contributor_records WHERE contributor = ?1), 0) AS accepted,
         COALESCE((SELECT taken_down FROM contributor_records WHERE contributor = ?1), 0) AS taken_down,
         EXISTS (SELECT 1 FROM blocked_contributors WHERE contributor = ?1) AS blocked,
         EXISTS (SELECT 1 FROM trusted_contributors WHERE contributor = ?1) AS trusted`,
    )
    .bind(contributor)
    .first<{ accepted: number; taken_down: number; blocked: number; trusted: number }>();
  const accepted = (row?.accepted ?? 0) + (decided.accepted.get(contributor) ?? 0);
  return { id: contributor, accepted, taken_down: row?.taken_down ?? 0, blocked: row?.blocked === 1, trusted: row?.trusted === 1 };
}

/** Counts one more accepted item for a contributor. */
function acceptedStatement(db: D1Like, contributor: string): D1Statement {
  return db
    .prepare("INSERT INTO contributor_records (contributor, accepted) VALUES (?, 1) ON CONFLICT (contributor) DO UPDATE SET accepted = accepted + 1")
    .bind(contributor);
}

/**
 * A released place as it is now: its facts in the place index, with the
 * recent changes on it laid over in the order they were accepted. Changes
 * from a blocked contributor are left out, as apps leave them out, and so is
 * a change the data already held when the release last loaded the place's
 * cell: the index has it, or whatever has replaced it since.
 */
export async function placeNow(db: D1Like, id: string, decided: DecidedInRequest = noneDecided()): Promise<(PlaceState & { cell: Cell }) | undefined> {
  const indexed = await getIndexedPlace(db, id);
  if (indexed === undefined) return undefined;
  const [cellLon, cellLat] = indexed.cell;
  const { results } = await db
    .prepare(
      `SELECT fact, value, accepted FROM recent_changes c
       WHERE c.place = ?
         AND NOT EXISTS (SELECT 1 FROM blocked_contributors b WHERE b.contributor = c.contributor)
         AND NOT (c.in_data_at IS NOT NULL AND EXISTS (
           SELECT 1 FROM place_index_cells i WHERE i.cell_lon = ? AND i.cell_lat = ? AND i.loaded_at > c.in_data_at
         ))
       ORDER BY accepted, feedback_id`,
    )
    .bind(id, cellLon, cellLat)
    .all<{ fact: string; value: string | null; accepted: string }>();
  const facts: Record<string, unknown> = { ...indexed.facts };
  const sources: Record<string, string> = { ...indexed.fact_sources };
  const dates: Record<string, string> = { ...indexed.fact_dates };
  for (const change of [...results, ...decided.changes.filter((c) => c.place === id)]) {
    if (change.value === null) delete facts[change.fact];
    else facts[change.fact] = JSON.parse(change.value) as unknown;
    sources[change.fact] = "feedback";
    dates[change.fact] = change.accepted;
  }
  return { facts, fact_sources: sources, fact_dates: dates, cell: indexed.cell } as unknown as PlaceState & { cell: Cell };
}

interface EvidenceRow {
  /** How the intake decided the report. Absent on rows read for the rules, which do not need it. */
  state?: "live" | "held";
  feedback_id: string;
  place: string;
  fact: string;
  kind: "fact" | "contact" | "doubt";
  value: string | null;
  reason: string | null;
  received: string;
  device: string;
  origin: string | null;
  attested: string | null;
}

/** The fact, contact and doubt reports the intake decided about a place and fact in the 90 days up to `at`, as the rules read them. */
export async function earlierReports(
  db: D1Like,
  place: string,
  fact: string,
  at: number,
  decided: DecidedInRequest = noneDecided(),
): Promise<StoredFeedback[]> {
  const { results: stored } = await db
    .prepare("SELECT * FROM report_evidence WHERE place = ? AND fact = ? AND received >= ? ORDER BY received, feedback_id")
    .bind(place, fact, isoSeconds(at - WINDOW_DAYS * DAY_MS))
    .all<EvidenceRow>();
  const results = [...stored, ...decided.evidence.filter((row) => row.place === place && row.fact === fact)];
  return results.map(
    (row) =>
      ({
        id: row.feedback_id,
        received: row.received,
        type: "report",
        place: row.place,
        device: row.device,
        ...(row.origin === null ? {} : { origin: row.origin }),
        ...(row.attested === null ? {} : { attested: row.attested }),
        report:
          row.kind === "fact"
            ? { kind: "fact", fact: row.fact, value: row.value === null ? undefined : (JSON.parse(row.value) as unknown) }
            : row.kind === "contact"
              ? { kind: "contact", fact: row.fact, reason: row.reason }
              : { kind: "doubt", fact: row.fact },
      }) as unknown as StoredFeedback,
  );
}

/** The report evidence row an item's decision stores. */
function evidenceRow(item: ReportItem, state: "live" | "held"): EvidenceRow {
  const { kind, fact, value, reason } = item.report;
  return {
    state,
    feedback_id: item.id,
    place: item.place as string,
    fact: fact as string,
    kind: kind as EvidenceRow["kind"],
    value: kind === "fact" && value !== undefined ? JSON.stringify(value) : null,
    reason: kind === "contact" ? (reason ?? null) : null,
    received: item.received,
    device: item.device,
    origin: item.origin ?? null,
    attested: item.attested ?? null,
  };
}

function evidenceStatement(db: D1Like, item: ReportItem, state: "live" | "held"): D1Statement {
  const { kind, fact, value, reason } = item.report;
  return db
    .prepare(
      "INSERT OR IGNORE INTO report_evidence (feedback_id, place, fact, kind, value, reason, received, device, origin, attested, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      item.id,
      item.place,
      fact,
      kind,
      kind === "fact" && value !== undefined ? JSON.stringify(value) : null,
      kind === "contact" ? (reason ?? null) : null,
      item.received,
      item.device,
      item.origin ?? null,
      item.attested ?? null,
      state,
    );
}

/**
 * The fact report that set a fact's current value, as the intake knows it:
 * the latest one it put live for the place and fact in the last 90 days, when
 * it carried `current`. The intake keeps no attested key or contributor proof
 * with its evidence, so only the device can match; a clear it cannot tie to
 * its sender is held, and the apply, which can, decides it again.
 */
export async function setterAt(db: D1Like, place: string, fact: string, current: unknown, decided: DecidedInRequest = noneDecided()): Promise<Setter | undefined> {
  if (current === undefined) return undefined;
  const batched = decided.evidence.filter((row) => row.place === place && row.fact === fact && row.kind === "fact" && row.state === "live").at(-1);
  const row =
    batched ??
    (await db
      .prepare("SELECT value, received, device FROM report_evidence WHERE place = ? AND fact = ? AND kind = 'fact' AND state = 'live' ORDER BY received DESC, feedback_id DESC LIMIT 1")
      .bind(place, fact)
      .first<{ value: string | null; received: string; device: string }>()) ??
    undefined;
  if (row === undefined || row.value === null || !sameValue(JSON.parse(row.value) as unknown, current)) return undefined;
  return { device: row.device, received: row.received };
}

/** The open case for a fact doubts took down on a place, as `decideFact` reads it, or undefined when there is none. */
export async function openDoubt(db: D1Like, place: string, fact: string, decided: DecidedInRequest = noneDecided()): Promise<OpenDoubt | undefined> {
  const batched = decided.cases.get(caseKey(place, fact));
  if (batched !== undefined) return batched === null ? undefined : { value: JSON.parse(batched.value) as OpenDoubt["value"], at: batched.taken_down_at };
  const row = await db
    .prepare("SELECT value, taken_down_at FROM doubt_cases WHERE place = ? AND fact = ? AND closed_by IS NULL")
    .bind(place, fact)
    .first<{ value: string; taken_down_at: string }>();
  return row === null ? undefined : { value: JSON.parse(row.value) as OpenDoubt["value"], at: row.taken_down_at };
}

/** A fact the apply took down after doubts, as it sends it to `openDoubtCases`. */
export interface DoubtCase {
  place: string;
  fact: string;
  /** The value the place had. */
  value: FactValue;
  /** When the doubt that took it down was received. */
  taken_down_at: string;
  /** That doubt. */
  feedback_id: string;
}

/**
 * Opens a case for each fact the apply took down after doubts, as the intake
 * does for its own takedowns, so a later report of the value is decided as a
 * confirmation once the release no longer has the fact. A case replaces the
 * one held for its place and fact only when its takedown is later, and that
 * one was not closed after it, so the apply can send the same cases on every
 * run. Returns the cases opened.
 */
export async function openDoubtCases(db: D1Like, cases: readonly DoubtCase[]): Promise<number> {
  if (cases.length === 0) return 0;
  const results = await db.batch(
    cases.map((c) =>
      db
        .prepare(
          `INSERT INTO doubt_cases (place, fact, value, taken_down_at, feedback_id, closed_by, closed_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT (place, fact) DO UPDATE SET value = excluded.value, taken_down_at = excluded.taken_down_at, feedback_id = excluded.feedback_id, closed_by = NULL, closed_at = NULL
           WHERE excluded.taken_down_at > doubt_cases.taken_down_at AND (doubt_cases.closed_at IS NULL OR doubt_cases.closed_at <= excluded.taken_down_at)`,
        )
        .bind(c.place, c.fact, JSON.stringify(c.value), c.taken_down_at, c.feedback_id),
    ),
  );
  return results.reduce<number>((sum, result) => sum + changesOf(result), 0);
}

/**
 * The writes for a live decision's case: a takedown opens the case for the
 * place and fact (replacing a closed one), with the value the place had and
 * the takedown's time, and a restore or replacement closes it.
 */
/** What `caseStatements` writes, added to the batch's decisions so far. */
function decidedCase(decided: DecidedInRequest, item: ReportItem, decision: Extract<ItemDecision, { verdict: "live" }>): void {
  if (decision.doubtTakedown !== undefined) {
    const value = { value: JSON.stringify(decision.doubtTakedown.value), taken_down_at: item.received };
    decided.cases.set(caseKey(item.place as string, decision.doubtTakedown.fact), value);
  } else if (decision.settles !== undefined) {
    const key = caseKey(item.place as string, item.report.fact as string);
    // Closing changes only an open case, as the UPDATE does. Whether one is open in D1 is not known here, and a closed one reads as none.
    decided.cases.set(key, null);
  }
}

function caseStatements(db: D1Like, item: ReportItem, decision: Extract<ItemDecision, { verdict: "live" }>): D1Statement[] {
  if (decision.doubtTakedown !== undefined) {
    return [
      db
        .prepare(
          `INSERT INTO doubt_cases (place, fact, value, taken_down_at, feedback_id, closed_by, closed_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)
           ON CONFLICT (place, fact) DO UPDATE SET value = excluded.value, taken_down_at = excluded.taken_down_at, feedback_id = excluded.feedback_id, closed_by = NULL, closed_at = NULL`,
        )
        .bind(item.place, decision.doubtTakedown.fact, JSON.stringify(decision.doubtTakedown.value), item.received, item.id),
    ];
  }
  if (decision.settles !== undefined) {
    return [
      db
        .prepare("UPDATE doubt_cases SET closed_by = ?, closed_at = ? WHERE place = ? AND fact = ? AND closed_by IS NULL")
        .bind(item.id, item.received, item.place, item.report.fact),
    ];
  }
  return [];
}

export interface DecideInput {
  db: D1Like;
  checks: Checks;
  /** The item as the inbox stores it. */
  item: ReportItem;
  /** The item as the app sent it, for the checks. */
  submission: FeedbackSubmission;
  /** The hashed contributor id, or the hashed install standing in for one. */
  contributor: string;
  /** What items earlier in the same batch decided. None for an item sent alone. */
  decided?: DecidedInRequest;
  /**
   * The website check on an attested contact (contact-checks.ts): the fetch
   * it reads the place's website with and how long it may take. Left out, no
   * attested contact goes live at send time: each waits for the apply run.
   */
  website?: { fetch: CheckFetch; timeoutMs: number };
  /**
   * The geometry around a new place's location, for the plausibility check
   * (place-geometry.ts): undefined when there is none, so the check passes.
   * Throws when it cannot be read, and the place is held as
   * `check_unavailable`. Left out, new places are not checked.
   */
  placeGeometry?: (p: { lat: number; lon: number }) => Promise<PlaceGeometry | undefined>;
  /**
   * On a new place: its contributor (or install, without one) has added
   * NEW_PLACE_DAILY_LIMIT new places already this UTC day, so it is held as
   * `new_place_cap` instead of listed.
   */
  pastNewPlaceCap?: boolean;
}

const held = (reason: HeldReason, writes: SendTimeDecision["writes"] = () => [], addToDecided?: SendTimeDecision["addToDecided"]): SendTimeDecision => ({
  answer: { state: "held", held_reason: reason },
  writes,
  ...(addToDecided ? { addToDecided } : {}),
});
const live = (writes: SendTimeDecision["writes"], addToDecided: (decided: DecidedInRequest) => void, slot?: LiveSlot): SendTimeDecision => ({
  answer: { state: "live" },
  writes,
  addToDecided,
  ...(slot ? { slot } : {}),
});
/** A held item's evidence: written, and known to the items after it in the batch. */
const heldWithEvidence = (reason: HeldReason, item: ReportItem): SendTimeDecision =>
  held(reason, (d) => [evidenceStatement(d, item, "held")], (p) => void p.evidence.push(evidenceRow(item, "held")));

/**
 * A held item's evidence, and when it is a fact report without attestation
 * waiting for a second source (`not_attested` or `source_link`) that would
 * change a fixed-value fact (`gapFillFact`), an unconfirmed value on the
 * recent list too.
 */
function heldWaiting(reason: HeldReason, item: ReportItem, place: PlaceState & { cell: Cell }, contributor: string): SendTimeDecision {
  const { kind, fact, value } = item.report;
  const waits = reason === "not_attested" || reason === "source_link";
  const changes = value !== undefined && !sameValue((place.facts as Record<string, unknown>)[fact as string], value);
  if (!waits || kind !== "fact" || item.attested !== undefined || !changes || !gapFillFact(fact as FactName)) return heldWithEvidence(reason, item);
  const [cellLon, cellLat] = place.cell;
  return held(
    reason,
    (d) => [
      evidenceStatement(d, item, "held"),
      d
        .prepare(
          "INSERT OR IGNORE INTO unconfirmed_values (feedback_id, place, fact, value, received, source, contributor, cell_lon, cell_lat) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(item.id, item.place, fact, JSON.stringify(value), item.received, sourceOf(item), contributor, cellLon, cellLat),
    ],
    (p) => void p.evidence.push(evidenceRow(item, "held")),
  );
}

/**
 * Whether a doubt answers No to an unconfirmed value: a report of the fact
 * from another source, received before the doubt and within the rules' 90
 * days, that waits for a second source and is on the recent list.
 */
async function waitingValueFor(db: D1Like, item: ReportItem): Promise<boolean> {
  const at = Date.parse(item.received);
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM unconfirmed_values u
       WHERE u.place = ? AND u.fact = ? AND u.source != ? AND u.received <= ? AND u.received >= ?
         AND NOT EXISTS (SELECT 1 FROM blocked_contributors b WHERE b.contributor = u.contributor)
       LIMIT 1`,
    )
    .bind(item.place, item.report.fact, sourceOf(item), item.received, isoSeconds(at - WINDOW_DAYS * DAY_MS))
    .first<{ found: number }>();
  return row !== null && row !== undefined;
}

/** Takes the unconfirmed values a live change has settled off the list: those of the value the fact now has. */
function settledUnconfirmed(db: D1Like, changes: readonly { place: string; fact: string; value: unknown }[]): D1Statement[] {
  return changes
    .filter((change) => change.value !== null)
    .map((change) =>
      db.prepare("DELETE FROM unconfirmed_values WHERE place = ? AND fact = ? AND value = ?").bind(change.place, change.fact, JSON.stringify(change.value)),
    );
}

const countAccepted = (decided: DecidedInRequest, contributor: string) => decided.accepted.set(contributor, (decided.accepted.get(contributor) ?? 0) + 1);

/**
 * Decides one item that `decidedHere` says the intake decides. Reads D1 and
 * runs the checks, and writes nothing. When the rules hold an item that would
 * set a link, the checks never run, so its links still get the link rules and
 * URLhaus: a link that fails is held as `link_check`, and links that pass are
 * marked `linksPassed`, without which the apply sends the item to a person.
 * Its text still gets the repeated text check, so it counts for later items,
 * and a repeat, or a check that could not run, is held for that instead.
 */
export async function decideAtSendTime(input: DecideInput): Promise<SendTimeDecision> {
  const decision = await decideByRulesAndChecks(input);
  const { answer } = decision;
  if (answer.state !== "held" || (CHECK_HOLDS as readonly string[]).includes(answer.held_reason) || answer.held_reason === "blocked") return decision;
  // The rules held it, so the checks never ran: its text still counts, and a repeat goes to a person.
  const repeated = await input.checks.repeated();
  if (repeated === "repeated_text" || repeated === "check_unavailable") return { ...decision, answer: { state: "held", held_reason: repeated } };
  const links = await input.checks.links(input.submission);
  if (links === "none" || links === "check_unavailable") return decision;
  if (links === "passed") return { ...decision, linksPassed: true };
  return { ...decision, answer: { state: "held", held_reason: links } };
}

async function decideByRulesAndChecks(input: DecideInput): Promise<SendTimeDecision> {
  const { db, checks, item, submission, contributor, decided = noneDecided() } = input;
  const record = await contributorRecord(db, contributor, decided);
  if (record.blocked) return held("blocked");
  if (item.report.kind === "new_place") return decideNewPlace(input, record);
  // The app hides the photo for this traveller. Everyone else waits for the apply: two sources, or a reviewer.
  if (item.report.kind === "commons_mismatch") return held("commons_report");

  const placeId = item.place as string;
  const place = await placeNow(db, placeId, decided);
  if (place === undefined) return held("unknown_place");
  // A frozen place takes no fact change until the reviewer's value is in the data.
  const freeze = await freezeOf(db, placeId, decided);
  if (freeze !== undefined && freeze.lifted_at === null) return item.report.kind === "clear" ? held("disputed") : heldWithEvidence("disputed", item);
  if (item.report.kind === "clear") return decideClearHere(input, place, record);
  const earlier = await earlierReports(db, placeId, item.report.fact as string, Date.parse(item.received), decided);
  const kind = item.report.kind;
  if (kind === "fact") {
    // Reports of a fact a reviewer settled no longer count towards a dispute.
    const settledAt = freeze !== undefined && freeze.fact === item.report.fact ? freeze.lifted_at : null;
    const counted = settledAt === null ? earlier : earlier.filter((r) => r.received > settledAt);
    if (findDispute([...counted, item], placeId) !== null) return frozeHere(item);
  }
  // A No to a value waiting for a second source counts against that report, which the apply weighs, never against the place's value.
  if (kind === "doubt" && (await waitingValueFor(db, item))) return held("waiting_value");
  const openCase = kind === "fact" ? await openDoubt(db, placeId, item.report.fact as string, decided) : undefined;
  const decision =
    kind === "fact"
      ? decideFact({ item, place, earlier, ...(openCase === undefined ? {} : { openCase }) })
      : kind === "doubt" ? decideDoubt({ item, place, earlier }) : decideContactReport({ item, place, earlier });
  if (decision.verdict === "refused") return held(decision.reason);
  // A report waiting for a second source that carries a source link waits for the apply run to read the page instead.
  const waiting = (reason: HeldReason) =>
    reason === "not_attested" && kind === "fact" && item.report.source !== undefined && !REVIEWED_FACTS.has(item.report.fact as FactName) ? "source_link" : reason;
  if (decision.verdict === "held") return heldWaiting(waiting(decision.reason), item, place, contributor);
  // An item without attestation is never live from the intake. The apply decides it: a gap fill, or the two-device rule.
  if (item.attested === undefined) return heldWaiting(waiting("not_attested"), item, place, contributor);
  // The place already has the value: nothing to show, and nothing for the checks.
  if (decision.changes.length === 0) return live((d) => [evidenceStatement(d, item, "live")], (p) => void p.evidence.push(evidenceRow(item, "live")));
  // An attested contact goes live now only when the place's own website shows it, within the time
  // allowed. Otherwise it waits for the apply run, which runs every contact check.
  const fact = item.report.fact as string;
  if (kind === "fact" && isContactFact(fact)) {
    const website = input.website;
    const shown =
      website !== undefined && websiteCheckApplies(fact)
        ? (await websiteCheck(website.fetch, (place.facts as Record<string, unknown>).website, fact, item.report.value as FactValue, website.timeoutMs)).passed
        : false;
    if (!shown) return heldWithEvidence("contact_check", item);
  }

  const checked = await checks.check(submission, { ...record, origin: item.origin, attest_key: item.attest_key });
  if ("held" in checked) return heldWithEvidence(checked.held, item);
  const [cellLon, cellLat] = place.cell;
  return live((d) => [
    evidenceStatement(d, item, "live"),
    ...caseStatements(d, item, decision),
    ...settledUnconfirmed(d, decision.changes),
    ...decision.changes.map((change) =>
      d
        .prepare(
          "INSERT OR IGNORE INTO recent_changes (feedback_id, place, fact, value, accepted, in_data_at, cell_lon, cell_lat, contributor) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        )
        .bind(item.id, change.place, change.fact, change.value === null ? null : JSON.stringify(change.value), item.received, cellLon, cellLat, contributor),
    ),
    acceptedStatement(d, contributor),
  ], (p) => {
    p.evidence.push(evidenceRow(item, "live"));
    decidedCase(p, item, decision);
    for (const change of decision.changes) {
      p.changes.push({ place: change.place, fact: change.fact, value: change.value === null ? null : JSON.stringify(change.value), accepted: item.received });
    }
    countAccepted(p, contributor);
  }, checked.slot);
}

/** A place's freeze: the latest one, lifted or not, or undefined when it has none. */
export async function freezeOf(db: D1Like, place: string, decided: DecidedInRequest = noneDecided()): Promise<{ fact: string; frozen_at: string; lifted_at: string | null } | undefined> {
  const batched = decided.frozen.get(place);
  if (batched !== undefined) return { ...batched, lifted_at: null };
  const row = await db.prepare("SELECT fact, frozen_at, lifted_at FROM frozen_places WHERE place = ?").bind(place).first<{ fact: string; frozen_at: string; lifted_at: string | null }>();
  return row ?? undefined;
}

/**
 * The upsert for a freeze. A freeze replaces the place's row when it started
 * no earlier, or when it lifted at or after the row's freeze started, so the
 * apply's freeze, which may start at an earlier report than the intake saw
 * last, still lifts the row the intake wrote for the same dispute.
 */
const FREEZE_UPSERT = `INSERT INTO frozen_places (place, fact, frozen_at, lifted_at) VALUES (?, ?, ?, ?)
  ON CONFLICT (place) DO UPDATE SET fact = excluded.fact, frozen_at = excluded.frozen_at, lifted_at = excluded.lifted_at
  WHERE excluded.frozen_at >= frozen_places.frozen_at OR (excluded.lifted_at IS NOT NULL AND excluded.lifted_at >= frozen_places.frozen_at)`;

/** A fact report that completes a dispute (`findDispute`): held as `disputed`, and the place frozen from its time. */
function frozeHere(item: ReportItem): SendTimeDecision {
  const fact = item.report.fact as string;
  return held(
    "disputed",
    (d) => [evidenceStatement(d, item, "held"), d.prepare(FREEZE_UPSERT).bind(item.place, fact, item.received, null)],
    (p) => {
      p.evidence.push(evidenceRow(item, "held"));
      p.frozen.set(item.place as string, { fact, frozen_at: item.received });
    },
  );
}

/** A freeze the apply keeps in the inbox, as it sends it to `recordFreezes`. */
export interface Freeze {
  place: string;
  fact: string;
  frozen_at: string;
  lifted_at?: string;
}

/** Records the apply's freezes, and lifts the ones it says have lifted. Sending them again changes nothing. Returns the rows written. */
export async function recordFreezes(db: D1Like, freezes: readonly Freeze[]): Promise<number> {
  if (freezes.length === 0) return 0;
  const results = await db.batch(freezes.map((f) => db.prepare(FREEZE_UPSERT).bind(f.place, f.fact, f.frozen_at, f.lifted_at ?? null)));
  return results.reduce<number>((sum, result) => sum + changesOf(result), 0);
}

/** How long a freeze the intake found at send time stands before the apply's full list can lift it. */
export const FREEZE_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Lifts, at `now`, each freeze the intake holds that is not among `held`
 * (by place and fact) and started FREEZE_GRACE_MS ago or more. `held` is the
 * apply's full list: the intake's own freeze outlives the apply's view only
 * for the day the apply may take to see the same reports. Returns how many
 * it lifted.
 */
export async function liftUnheld(db: D1Like, held: readonly Freeze[], now: number): Promise<number> {
  const { results } = await db
    .prepare("SELECT place, fact FROM frozen_places WHERE lifted_at IS NULL AND frozen_at <= ?")
    .bind(isoSeconds(now - FREEZE_GRACE_MS))
    .all<{ place: string; fact: string }>();
  const keep = new Set(held.map((f) => `${f.place} ${f.fact}`));
  const lift = results.filter((r) => !keep.has(`${r.place} ${r.fact}`));
  if (lift.length === 0) return 0;
  await db.batch(lift.map((r) => db.prepare("UPDATE frozen_places SET lifted_at = ? WHERE place = ? AND lifted_at IS NULL").bind(isoSeconds(now), r.place)));
  return lift.length;
}

/**
 * A clear. It is live, with the fact (and any fact that goes with it) off the
 * place on the recent list, when the rules put it live and the checks pass.
 * A clear stores no report evidence: no rule weighs one.
 */
async function decideClearHere({ db, checks, item, submission, contributor, decided = noneDecided() }: DecideInput, place: PlaceState & { cell: Cell }, record: CheckContributor): Promise<SendTimeDecision> {
  const fact = item.report.fact as string;
  const setter = await setterAt(db, item.place as string, fact, (place.facts as Record<string, unknown>)[fact], decided);
  const decision = decideClear({ item, place, setter });
  if (decision.verdict !== "live") return held(decision.reason);
  if (decision.changes.length === 0) return live(() => [], () => {});
  const checked = await checks.check(submission, { ...record, origin: item.origin, attest_key: item.attest_key });
  if ("held" in checked) return held(checked.held);
  const [cellLon, cellLat] = place.cell;
  return live((d) => [
    ...decision.changes.map((change) =>
      d
        .prepare(
          "INSERT OR IGNORE INTO recent_changes (feedback_id, place, fact, value, accepted, in_data_at, cell_lon, cell_lat, contributor) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        )
        .bind(item.id, change.place, change.fact, null, item.received, cellLon, cellLat, contributor),
    ),
    acceptedStatement(d, contributor),
  ], (p) => {
    for (const change of decision.changes) p.changes.push({ place: change.place, fact: change.fact, value: null, accepted: item.received });
    countAccepted(p, contributor);
  }, checked.slot);
}

/**
 * A new place. It is listed, with the description, fee and contacts it is
 * published with, when the apply would publish it (attested, with a
 * contributor, a note that passes the text checks) and the checks pass on
 * what would be published. Contacts that fail `contactProblem` and a
 * description that fails the text checks are left for a person, as the apply
 * leaves them, and the place is listed without them. A place past its
 * contributor's new places for the day (`pastNewPlaceCap`) is held as
 * `new_place_cap` where it would otherwise go to the checks.
 */
async function decideNewPlace({ checks, item, submission, placeGeometry, pastNewPlaceCap }: DecideInput, record: CheckContributor & { trusted: boolean }): Promise<SendTimeDecision> {
  // A trusted contributor's place is listed without attestation, but only when it was sent signed in and not through a human check.
  const trusted = record.trusted && item.signed_in === true && item.human_checked === undefined;
  const listing = newPlaceListing(item, trusted);
  if (listing !== null) return held(listing.reason);
  if (item.location === undefined || item.contributor === undefined || submission.type !== "report") return held("invalid_value");
  // In the water, on a major road or inside a building: the AI reviewer checks it. Remoteness never holds a place.
  if (placeGeometry) {
    let geometry: PlaceGeometry | undefined;
    try {
      geometry = await placeGeometry(item.location);
    } catch (error) {
      console.warn(`the place geometry could not be read, so ${item.id} waits for the apply: ${String(error)}`);
      return held("check_unavailable");
    }
    if (implausibleLocation(item.location, item.report.place_kind, geometry) !== null) return held("implausible_location");
  }
  // Past the day's new places: stored for the AI reviewer, without taking a live change.
  if (pastNewPlaceCap) return held("new_place_cap");
  const fields = newPlaceFields(item);
  const contacts = Object.fromEntries(
    Object.entries(fields.contacts).filter(([fact]) => !fields.failing.includes(fact as ContactFactName)),
  ) as Partial<Record<ContactFactName, FactValue>>;

  // The checks read what would be published.
  const { contacts: _contacts, address: _address, description: _description, ...rest } = submission.report;
  const { address, ...links } = contacts;
  const published = {
    ...submission,
    report: {
      ...rest,
      ...(Object.keys(links).length > 0 ? { contacts: links } : {}),
      ...(address !== undefined ? { address } : {}),
      ...(fields.description !== undefined ? { description: fields.description } : {}),
    } as ReportBody,
  } as FeedbackSubmission;
  const checked = await checks.check(published, { ...record, origin: item.origin, attest_key: item.attest_key });
  if ("held" in checked) return held(checked.held);

  const { place_kind, name } = item.report;
  const place: StoredPlace = {
    id: newPlaceId(item.id),
    location: item.location,
    kind: place_kind ?? null,
    name: name === undefined ? null : tidyName(name),
    added: item.received,
    contributor: item.contributor,
    device: item.device,
    ...(item.attest_key !== undefined ? { attest_key: item.attest_key } : {}),
    ...(item.origin !== undefined ? { origin: item.origin } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.fee !== undefined ? { fee: fields.fee } : {}),
    ...(Object.keys(contacts).length > 0 ? { contacts } : {}),
  };
  return live((d) => [placeStatement(d, place), acceptedStatement(d, record.id)], (p) => countAccepted(p, record.id), checked.slot);
}

interface ChangeRow {
  place: string;
  fact: string;
  value: string | null;
  accepted: string;
  in_data_at: string | null;
}

/**
 * The recent changes apps lay over their release: for each place and fact,
 * the latest change, leaving out changes from a blocked contributor and those
 * the data has held for more than 7 days. With `bbox` (already snapped to
 * whole degrees), only places in the map cells it covers, as in the place
 * index. In place and fact order.
 */
export async function listChanges(db: D1Like, now: number, bbox?: Bbox): Promise<RecentChange[]> {
  const kept = isoSeconds(now - KEEP_IN_DATA_DAYS * DAY_MS);
  const last = (low: number, high: number) => Math.max(Math.floor(low), Math.ceil(high) - 1);
  const area = bbox ? "AND cell_lon BETWEEN ? AND ? AND cell_lat BETWEEN ? AND ?" : "";
  // One pass over the visible changes, through the (place, fact) index, or the cell index within a box,
  // numbering each place and fact's changes newest first. A NOT EXISTS self-join would search the index
  // again for every row. Window functions are in SQLite's own engine, which D1 runs.
  const query = db.prepare(
    `SELECT place, fact, value, accepted, in_data_at FROM (
       SELECT place, fact, value, accepted, in_data_at,
         ROW_NUMBER() OVER (PARTITION BY place, fact ORDER BY accepted DESC, feedback_id DESC) AS newest
       FROM recent_changes c
       WHERE (c.in_data_at IS NULL OR c.in_data_at >= ?)
         AND NOT EXISTS (SELECT 1 FROM blocked_contributors b WHERE b.contributor = c.contributor)
         ${area}
     )
     WHERE newest = 1
     ORDER BY place, fact`,
  );
  const bound = bbox
    ? query.bind(kept, Math.floor(bbox[0]), last(bbox[0], bbox[2]), Math.floor(bbox[1]), last(bbox[1], bbox[3]))
    : query.bind(kept);
  const { results } = await bound.all<ChangeRow>();
  return results.map((row) => ({
    place: row.place,
    fact: row.fact,
    value: row.value === null ? null : (JSON.parse(row.value) as FactValue),
    accepted: row.accepted,
    in_data_at: row.in_data_at,
  }));
}

interface UnconfirmedRow {
  place: string;
  fact: string;
  value: string;
  received: string;
  sources: number;
  facts: string | null;
}

/**
 * The unconfirmed values apps can ask travellers to confirm: for each place,
 * fact and value, when the intake received the earliest held report of it in
 * the rules' 90 days, and how many independent sources sent one. Reports from
 * a blocked contributor are left out, and so is a value the place already has
 * in the place index. With `bbox` (already snapped to whole degrees), only
 * places in the map cells it covers. In place, fact and value order.
 */
export async function listUnconfirmed(db: D1Like, now: number, bbox?: Bbox): Promise<UnconfirmedValue[]> {
  const last = (low: number, high: number) => Math.max(Math.floor(low), Math.ceil(high) - 1);
  const area = bbox ? "AND u.cell_lon BETWEEN ? AND ? AND u.cell_lat BETWEEN ? AND ?" : "";
  const query = db.prepare(
    `SELECT u.place, u.fact, u.value, MIN(u.received) AS received, COUNT(DISTINCT u.source) AS sources, i.facts
     FROM unconfirmed_values u LEFT JOIN place_index i ON i.id = u.place
     WHERE u.received >= ?
       AND NOT EXISTS (SELECT 1 FROM blocked_contributors b WHERE b.contributor = u.contributor)
       ${area}
     GROUP BY u.place, u.fact, u.value
     ORDER BY u.place, u.fact, u.value`,
  );
  const since = isoSeconds(now - WINDOW_DAYS * DAY_MS);
  const bound = bbox ? query.bind(since, Math.floor(bbox[0]), last(bbox[0], bbox[2]), Math.floor(bbox[1]), last(bbox[1], bbox[3])) : query.bind(since);
  const { results } = await bound.all<UnconfirmedRow>();
  return results.flatMap((row) => {
    const value = JSON.parse(row.value) as FactValue;
    const current = row.facts === null ? undefined : (JSON.parse(row.facts) as Record<string, unknown>)[row.fact];
    if (sameValue(current, value)) return [];
    return [{ place: row.place, fact: row.fact, value, received: row.received, sources: row.sources }];
  });
}

/** D1 allows 100 bound values in one statement. */
const MAX_BOUND = 100;
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
const changesOf = (result: unknown) => (result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0;

/**
 * Records that the apply has put the recent changes from these feedback items
 * into the data, from `at`. A change already marked keeps its first time, so
 * the apply can send the same ids on every run. Ids with no recent change are
 * skipped. Returns the recent changes marked.
 */
export async function markInData(db: D1Like, ids: readonly string[], at: string): Promise<number> {
  const parts = chunks([...new Set(ids)], MAX_BOUND - 1);
  const results = await db.batch([
    ...parts.map((part) =>
      db.prepare(`UPDATE recent_changes SET in_data_at = ? WHERE in_data_at IS NULL AND feedback_id IN (${marks(part.length)})`).bind(at, ...part),
    ),
    // A held report the apply put into the data is no longer unconfirmed.
    ...parts.map((part) => db.prepare(`DELETE FROM unconfirmed_values WHERE feedback_id IN (${marks(part.length)})`).bind(...part)),
  ]);
  return results.slice(0, parts.length).reduce<number>((sum, result) => sum + changesOf(result), 0);
}

/**
 * The apply decided these feedback items other than applying them, though the
 * intake may have put them live. Their recent changes leave the list at once
 * and their report evidence counts as held. Only the ones among `takenDown`
 * (items the apply refused) count against their contributor's track record:
 * an item that went to a person, for a disagreement or an owner's value, says
 * nothing bad about who sent it. All in one transaction, and counted from the
 * changes deleted, so sending the same ids again changes nothing. Returns the
 * recent changes deleted.
 */
export async function overrule(db: D1Like, ids: readonly string[], takenDown: readonly string[] = []): Promise<number> {
  const unique = [...new Set(ids)];
  const counted = [...new Set(takenDown)].filter((id) => unique.includes(id));
  const records = chunks(counted, MAX_BOUND).map((part) =>
    db
      .prepare(
        `INSERT INTO contributor_records (contributor, taken_down)
         SELECT contributor, COUNT(DISTINCT feedback_id) FROM recent_changes WHERE feedback_id IN (${marks(part.length)}) GROUP BY contributor
         ON CONFLICT (contributor) DO UPDATE SET taken_down = taken_down + excluded.taken_down`,
      )
      .bind(...part),
  );
  const removals = chunks(unique, MAX_BOUND).flatMap((part) => [
    db.prepare(`UPDATE report_evidence SET state = 'held' WHERE state = 'live' AND feedback_id IN (${marks(part.length)})`).bind(...part),
    db.prepare(`DELETE FROM recent_changes WHERE feedback_id IN (${marks(part.length)})`).bind(...part),
  ]);
  // A refused report is no longer unconfirmed. One the apply sent to a person still waits, and stays listed.
  const unlisted = chunks(counted, MAX_BOUND).map((part) => db.prepare(`DELETE FROM unconfirmed_values WHERE feedback_id IN (${marks(part.length)})`).bind(...part));
  // The track records are counted before the changes they count are deleted.
  const results = await db.batch([...records, ...removals, ...unlisted]);
  return results
    .slice(records.length, records.length + removals.length)
    .filter((_, i) => i % 2 === 1)
    .reduce<number>((sum, result) => sum + changesOf(result), 0);
}

/**
 * Deletes recent changes the data has held for more than 7 days, those
 * accepted more than 7 days ago that the data still does not hold, new places
 * the apply run was done with more than 7 days ago with their evidence, and
 * report evidence, doubt cases and freezes older than the rules' 90 days. For the
 * scheduled job.
 */
export async function pruneDecisions(db: D1Like, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM recent_changes WHERE in_data_at IS NOT NULL AND in_data_at < ?").bind(isoSeconds(now - KEEP_IN_DATA_DAYS * DAY_MS)),
    db.prepare("DELETE FROM recent_changes WHERE in_data_at IS NULL AND accepted < ?").bind(isoSeconds(now - KEEP_NOT_IN_DATA_DAYS * DAY_MS)),
    db.prepare("DELETE FROM report_evidence WHERE received < ?").bind(isoSeconds(now - WINDOW_DAYS * DAY_MS)),
    db.prepare("DELETE FROM unconfirmed_values WHERE received < ?").bind(isoSeconds(now - WINDOW_DAYS * DAY_MS)),
    db.prepare("DELETE FROM doubt_cases WHERE taken_down_at < ?").bind(isoSeconds(now - WINDOW_DAYS * DAY_MS)),
    db.prepare("DELETE FROM frozen_places WHERE frozen_at < ?").bind(isoSeconds(now - WINDOW_DAYS * DAY_MS)),
    ...prunePlaceStatements(db, now),
  ]);
}
