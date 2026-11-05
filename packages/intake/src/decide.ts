import {
  decideContactReport,
  decideDoubt,
  decideFact,
  newPlaceFields,
  newPlaceListing,
  WINDOW_DAYS,
  type HeldReason as RulesHeldReason,
  type ItemDecision,
  type OpenDoubt,
  type PlaceState,
  type RefusedReason,
  type ReportItem,
} from "@opencampingdb/apply/decide";
import {
  newPlaceId,
  tidyName,
  type ContactFactName,
  type FactValue,
  type FeedbackSubmission,
  type RecentChange,
  type ReportBody,
  type StoredFeedback,
} from "@opencampingdb/feedback";
import type { CheckContributor, Checks, HeldReason as ChecksHeldReason, LiveSlot } from "./checks.js";
import { getIndexedPlace, type Cell } from "./place-index.js";
import { chunks, placeStatement, prunePlaceStatements, type Bbox, type D1Like, type D1Statement, type StoredPlace } from "./recent.js";

/**
 * The intake deciding an item at send time, with the apply's own rules
 * (`@opencampingdb/apply/decide`) and then the checks (checks.ts), so the app
 * learns at once whether its change is live or held. The inbox write is the
 * same either way, and the apply still writes the data.
 *
 * Decided here: `fact`, `contact` and `doubt` reports about a released place,
 * and `new_place` reports. A fact report, contact takedown or doubt takedown
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
 * has it). The apply decides each of these again when it runs.
 */
export type HeldReason = RulesHeldReason | ChecksHeldReason | RefusedReason | "unknown_place" | "blocked";

/** What the answer to an accepted item adds. */
export type ItemState = { state: "live" } | { state: "held"; held_reason: HeldReason };

/** What the intake decided, and the writes that record it once the item is in the inbox. */
export interface SendTimeDecision {
  answer: ItemState;
  writes: (db: D1Like) => D1Statement[];
  /** The live change the checks took from the daily caps, to give back with `releaseLive` when the item is not recorded. */
  slot?: LiveSlot;
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
  return (kind === "fact" || kind === "contact" || kind === "doubt") && typeof item.place === "string" && typeof item.report.fact === "string";
}

const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A contributor's track record, and whether they are on the block list. */
export async function contributorRecord(db: D1Like, contributor: string): Promise<CheckContributor & { blocked: boolean }> {
  const row = await db
    .prepare(
      `SELECT COALESCE((SELECT accepted FROM contributor_records WHERE contributor = ?1), 0) AS accepted,
         COALESCE((SELECT taken_down FROM contributor_records WHERE contributor = ?1), 0) AS taken_down,
         EXISTS (SELECT 1 FROM blocked_contributors WHERE contributor = ?1) AS blocked`,
    )
    .bind(contributor)
    .first<{ accepted: number; taken_down: number; blocked: number }>();
  return { id: contributor, accepted: row?.accepted ?? 0, taken_down: row?.taken_down ?? 0, blocked: row?.blocked === 1 };
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
export async function placeNow(db: D1Like, id: string): Promise<(PlaceState & { cell: Cell }) | undefined> {
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
  for (const change of results) {
    if (change.value === null) delete facts[change.fact];
    else facts[change.fact] = JSON.parse(change.value) as unknown;
    sources[change.fact] = "feedback";
    dates[change.fact] = change.accepted;
  }
  return { facts, fact_sources: sources, fact_dates: dates, cell: indexed.cell } as unknown as PlaceState & { cell: Cell };
}

interface EvidenceRow {
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
export async function earlierReports(db: D1Like, place: string, fact: string, at: number): Promise<StoredFeedback[]> {
  const { results } = await db
    .prepare("SELECT * FROM report_evidence WHERE place = ? AND fact = ? AND received >= ? ORDER BY received, feedback_id")
    .bind(place, fact, isoSeconds(at - WINDOW_DAYS * DAY_MS))
    .all<EvidenceRow>();
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

/** The open case for a fact doubts took down on a place, as `decideFact` reads it, or undefined when there is none. */
export async function openDoubt(db: D1Like, place: string, fact: string): Promise<OpenDoubt | undefined> {
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
}

const held = (reason: HeldReason, writes: SendTimeDecision["writes"] = () => []): SendTimeDecision => ({
  answer: { state: "held", held_reason: reason },
  writes,
});
const live = (writes: SendTimeDecision["writes"], slot?: LiveSlot): SendTimeDecision => ({ answer: { state: "live" }, writes, ...(slot ? { slot } : {}) });

/** Decides one item that `decidedHere` says the intake decides. Reads D1 and runs the checks, and writes nothing. */
export async function decideAtSendTime(input: DecideInput): Promise<SendTimeDecision> {
  const { db, checks, item, submission, contributor } = input;
  const record = await contributorRecord(db, contributor);
  if (record.blocked) return held("blocked");
  if (item.report.kind === "new_place") return decideNewPlace(input, record);

  const placeId = item.place as string;
  const place = await placeNow(db, placeId);
  if (place === undefined) return held("unknown_place");
  const earlier = await earlierReports(db, placeId, item.report.fact as string, Date.parse(item.received));
  const kind = item.report.kind;
  const openCase = kind === "fact" ? await openDoubt(db, placeId, item.report.fact as string) : undefined;
  const decision =
    kind === "fact"
      ? decideFact({ item, place, earlier, ...(openCase === undefined ? {} : { openCase }) })
      : kind === "doubt" ? decideDoubt({ item, place, earlier }) : decideContactReport({ item, place, earlier });
  if (decision.verdict === "refused") return held(decision.reason);
  if (decision.verdict === "held") return held(decision.reason, (d) => [evidenceStatement(d, item, "held")]);
  // An item without attestation is never live from the intake. The apply's two-device rule still runs.
  if (item.attested === undefined) return held("not_attested", (d) => [evidenceStatement(d, item, "held")]);
  // The place already has the value: nothing to show, and nothing for the checks.
  if (decision.changes.length === 0) return live((d) => [evidenceStatement(d, item, "live")]);

  const checked = await checks.check(submission, { ...record, origin: item.origin, attest_key: item.attest_key });
  if ("held" in checked) return held(checked.held, (d) => [evidenceStatement(d, item, "held")]);
  const [cellLon, cellLat] = place.cell;
  return live((d) => [
    evidenceStatement(d, item, "live"),
    ...caseStatements(d, item, decision),
    ...decision.changes.map((change) =>
      d
        .prepare(
          "INSERT OR IGNORE INTO recent_changes (feedback_id, place, fact, value, accepted, in_data_at, cell_lon, cell_lat, contributor) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        )
        .bind(item.id, change.place, change.fact, change.value === null ? null : JSON.stringify(change.value), item.received, cellLon, cellLat, contributor),
    ),
    acceptedStatement(d, contributor),
  ], checked.slot);
}

/**
 * A new place. It is listed, with the description, fee and contacts it is
 * published with, when the apply would publish it (attested, with a
 * contributor, a note that passes the text checks) and the checks pass on
 * what would be published. Contacts that fail `contactProblem` and a
 * description that fails the text checks are left for a person, as the apply
 * leaves them, and the place is listed without them.
 */
async function decideNewPlace({ checks, item, submission }: DecideInput, record: CheckContributor): Promise<SendTimeDecision> {
  const listing = newPlaceListing(item);
  if (listing !== null) return held(listing.reason);
  if (item.location === undefined || item.contributor === undefined || submission.type !== "report") return held("invalid_value");
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
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.fee !== undefined ? { fee: fields.fee } : {}),
    ...(Object.keys(contacts).length > 0 ? { contacts } : {}),
  };
  return live((d) => [placeStatement(d, place), acceptedStatement(d, record.id)], checked.slot);
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
  const query = db.prepare(
    `WITH visible AS (
       SELECT * FROM recent_changes c
       WHERE (c.in_data_at IS NULL OR c.in_data_at >= ?)
         AND NOT EXISTS (SELECT 1 FROM blocked_contributors b WHERE b.contributor = c.contributor)
         ${area}
     )
     SELECT place, fact, value, accepted, in_data_at FROM visible c
     WHERE NOT EXISTS (
       SELECT 1 FROM visible d
       WHERE d.place = c.place AND d.fact = c.fact AND (d.accepted > c.accepted OR (d.accepted = c.accepted AND d.feedback_id > c.feedback_id))
     )
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

/** A feedback id, as the intake makes them. */
export const isFeedbackId = (value: unknown): value is string => typeof value === "string" && /^fb_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);

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
  const results = await db.batch(
    chunks([...new Set(ids)], MAX_BOUND - 1).map((part) =>
      db.prepare(`UPDATE recent_changes SET in_data_at = ? WHERE in_data_at IS NULL AND feedback_id IN (${marks(part.length)})`).bind(at, ...part),
    ),
  );
  return results.reduce<number>((sum, result) => sum + changesOf(result), 0);
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
  // The track records are counted before the changes they count are deleted.
  const results = await db.batch([...records, ...removals]);
  return results.slice(records.length).filter((_, i) => i % 2 === 1).reduce<number>((sum, result) => sum + changesOf(result), 0);
}

/**
 * Deletes recent changes the data has held for more than 7 days, those
 * accepted more than 7 days ago that the data still does not hold, new places
 * the apply run was done with more than 7 days ago with their evidence, and
 * report evidence and doubt cases older than the rules' 90 days. For the
 * scheduled job.
 */
export async function pruneDecisions(db: D1Like, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM recent_changes WHERE in_data_at IS NOT NULL AND in_data_at < ?").bind(isoSeconds(now - KEEP_IN_DATA_DAYS * DAY_MS)),
    db.prepare("DELETE FROM recent_changes WHERE in_data_at IS NULL AND accepted < ?").bind(isoSeconds(now - KEEP_NOT_IN_DATA_DAYS * DAY_MS)),
    db.prepare("DELETE FROM report_evidence WHERE received < ?").bind(isoSeconds(now - WINDOW_DAYS * DAY_MS)),
    db.prepare("DELETE FROM doubt_cases WHERE taken_down_at < ?").bind(isoSeconds(now - WINDOW_DAYS * DAY_MS)),
    ...prunePlaceStatements(db, now),
  ]);
}
