import {
  decideContactReport,
  decideFact,
  newPlaceFields,
  newPlaceListing,
  WINDOW_DAYS,
  type HeldReason as RulesHeldReason,
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
  type ReportBody,
  type StoredFeedback,
} from "@opencampingdb/feedback";
import type { CheckContributor, Checks, HeldReason as ChecksHeldReason } from "./checks.js";
import { getIndexedPlace, type Cell } from "./place-index.js";
import { placeStatement, type Bbox, type D1Like, type D1Statement, type StoredPlace } from "./recent.js";

/**
 * The intake deciding an item at send time, with the apply's own rules
 * (`@opencampingdb/apply/decide`) and then the checks (checks.ts), so the app
 * learns at once whether its change is live or held. The inbox write is the
 * same either way, and the apply still writes the data.
 *
 * Decided here: `fact` and `contact` reports about a released place, and
 * `new_place` reports. A fact report or contact takedown that goes live is a
 * recent change, served with the recent list by map area until 7 days after
 * the apply has put it into the data. A live new place goes on the recent list
 * with its description, fee and contacts. Everything else the apply decides,
 * as before, and its answer has no `state`.
 *
 * Each item is decided against the place in the place index with the recent
 * changes on it laid over, and against the fact and contact reports the intake
 * decided for the same place and fact in the last 90 days, live or held. The
 * checks run last, only for an item the rules would put live, because an item
 * that passes them takes one of its contributor's daily live changes.
 */

/** Days a recent change is kept after the apply has put it into the data. */
export const KEEP_IN_DATA_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why the intake held an item. The rules' and the checks' reasons, and:
 * `unknown_place`, the place is not in the place index (a place the release
 * doesn't have yet, or a new place); `blocked`, the contributor is on the
 * block list; `no_value` and `invalid_value`, the rules would refuse it (a
 * contact report about a contact the place does not have, as the index has
 * it). The apply decides each of these again when it runs.
 */
export type HeldReason = RulesHeldReason | ChecksHeldReason | RefusedReason | "unknown_place" | "blocked";

/** What the answer to an accepted item adds. */
export type ItemState = { state: "live" } | { state: "held"; held_reason: HeldReason };

/** What the intake decided, and the writes that record it once the item is in the inbox. */
export interface SendTimeDecision {
  answer: ItemState;
  writes: (db: D1Like) => D1Statement[];
}

/** The answer when the decision could not be made or recorded. */
export const UNAVAILABLE: ItemState = { state: "held", held_reason: "check_unavailable" };

/** A recent change as `GET /v1/places/recent` serves it. */
export interface RecentChange {
  place: string;
  fact: string;
  /** The fact's new value, or null when the change takes it down. */
  value: FactValue | null;
  /** When the intake accepted it. */
  accepted: string;
  /** When the apply put it into the data, or null until it has. */
  in_data_at: string | null;
}

/** Whether the intake decides `item` at send time. */
export function decidedHere(item: StoredFeedback): item is ReportItem {
  if (item.type !== "report") return false;
  const kind = item.report.kind;
  if (kind === "new_place") return true;
  return (kind === "fact" || kind === "contact") && typeof item.place === "string" && typeof item.report.fact === "string";
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

/** A released place as it is now: its facts in the place index, with the recent changes on it laid over in the order they were accepted. */
export async function placeNow(db: D1Like, id: string): Promise<(PlaceState & { cell: Cell }) | undefined> {
  const indexed = await getIndexedPlace(db, id);
  if (indexed === undefined) return undefined;
  const { results } = await db
    .prepare("SELECT fact, value, accepted FROM recent_changes WHERE place = ? ORDER BY accepted, feedback_id")
    .bind(id)
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
  kind: "fact" | "contact";
  value: string | null;
  reason: string | null;
  received: string;
  device: string;
  origin: string | null;
  attested: string | null;
}

/** The fact and contact reports the intake decided about a place and fact in the 90 days up to `at`, as the rules read them. */
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
            : { kind: "contact", fact: row.fact, reason: row.reason },
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
const live = (writes: SendTimeDecision["writes"]): SendTimeDecision => ({ answer: { state: "live" }, writes });

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
  const decision = item.report.kind === "fact" ? decideFact({ item, place, earlier }) : decideContactReport({ item, place, earlier });
  if (decision.verdict === "refused") return held(decision.reason);
  if (decision.verdict === "held") return held(decision.reason, (d) => [evidenceStatement(d, item, "held")]);
  // An item without attestation is never live from the intake. The apply's two-device rule still runs.
  if (item.attested === undefined) return held("not_attested", (d) => [evidenceStatement(d, item, "held")]);
  // The place already has the value: nothing to show, and nothing for the checks.
  if (decision.changes.length === 0) return live((d) => [evidenceStatement(d, item, "live")]);

  const checked = await checks.check(submission, record);
  if ("held" in checked) return held(checked.held, (d) => [evidenceStatement(d, item, "held")]);
  const [cellLon, cellLat] = place.cell;
  return live((d) => [
    evidenceStatement(d, item, "live"),
    ...decision.changes.map((change) =>
      d
        .prepare(
          "INSERT OR IGNORE INTO recent_changes (feedback_id, place, fact, value, accepted, in_data_at, cell_lon, cell_lat, contributor) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
        )
        .bind(item.id, change.place, change.fact, change.value === null ? null : JSON.stringify(change.value), item.received, cellLon, cellLat, contributor),
    ),
    acceptedStatement(d, contributor),
  ]);
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
  const checked = await checks.check(published, record);
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
  return live((d) => [placeStatement(d, place), acceptedStatement(d, record.id)]);
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

/** Deletes recent changes the data has held for more than 7 days, and report evidence older than the rules' 90 days. For the scheduled job. */
export async function pruneDecisions(db: D1Like, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM recent_changes WHERE in_data_at IS NOT NULL AND in_data_at < ?").bind(isoSeconds(now - KEEP_IN_DATA_DAYS * DAY_MS)),
    db.prepare("DELETE FROM report_evidence WHERE received < ?").bind(isoSeconds(now - WINDOW_DAYS * DAY_MS)),
  ]);
}
