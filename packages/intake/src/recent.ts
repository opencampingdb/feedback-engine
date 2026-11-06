import {
  newPlaceStanding,
  type ContactFactName,
  type FactValue,
  type FeeValue,
  type NewPlaceCheck,
  type NewPlaceReport,
  type RecentPlace,
} from "@opencampingdb/feedback";

/** A prepared D1 statement: the part of the Workers D1 API the recent list uses. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
}

/** The part of a D1 database binding the recent list uses. A batch runs as one transaction. */
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

/** What the recent list serves for a place: the SDK's type, so apps read what the intake writes. */
export type { RecentPlace };

/** A new place as the recent list keeps it. Written once, when the place is added. */
export interface StoredPlace extends Omit<RecentPlace, "standing" | "in_data_at"> {
  /** The adder's hashed device. */
  device: string;
  /** The adder's hashed App Attest key, when the report was attested with one. */
  attest_key?: string;
}

/** A check, removal report or withdraw on a new place. */
export type Evidence =
  | { kind: "check"; check: NewPlaceCheck }
  | { kind: "removal_report"; report: NewPlaceReport }
  | { kind: "withdraw"; at: string };

/** How long the adder may withdraw a new place outright. */
export const WITHDRAW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** New places per contributor (or device, without one) per day. */
export const NEW_PLACE_DAILY_LIMIT = 10;
/** Seconds the recent list is cached at the edge. */
export const RECENT_CACHE_SECONDS = 30;
/** Most ids one removal call may name. */
export const MAX_REMOVE_IDS = 500;
/** Most contributors the block list may hold. */
export const MAX_BLOCKED_CONTRIBUTORS = 5000;
/** Days a new place stays on the recent list after the apply run is done with it. */
export const KEEP_PLACE_IN_DATA_DAYS = 7;
/** D1 allows 100 bound values in one statement. */
const MAX_BOUND = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const isoSeconds = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

/** `items` in runs of at most `size`. */
export const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Writes a new place. A place already there is left as it is, so writing the
 * same place twice keeps one.
 */
export function insertPlace(db: D1Like, place: StoredPlace): Promise<unknown> {
  return placeStatement(db, place).run();
}

/** The statement `insertPlace` runs, for writing many places in one batch. */
export function placeStatement(db: D1Like, place: StoredPlace): D1Statement {
  return db
    .prepare(
      "INSERT OR IGNORE INTO new_places (id, lat, lon, kind, name, added, contributor, device, attest_key, description, fee, contacts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      place.id,
      place.location.lat,
      place.location.lon,
      place.kind,
      place.name,
      place.added,
      place.contributor,
      place.device,
      place.attest_key ?? null,
      place.description ?? null,
      place.fee === undefined ? null : JSON.stringify(place.fee),
      place.contacts === undefined ? null : JSON.stringify(place.contacts),
    );
}

/**
 * Writes one check, removal report or withdraw on a place, as a row of its own
 * named by the feedback item's id. Nothing is read first, so evidence arriving
 * at the same moment all counts, and the same feedback item written twice
 * counts once.
 */
export function insertEvidence(db: D1Like, place: string, feedbackId: string, evidence: Evidence): Promise<unknown> {
  return evidenceStatement(db, place, feedbackId, evidence).run();
}

/** The statement `insertEvidence` runs, for writing many pieces of evidence in one batch. */
export function evidenceStatement(db: D1Like, place: string, feedbackId: string, evidence: Evidence): D1Statement {
  const data = evidence.kind === "check" ? evidence.check : evidence.kind === "removal_report" ? evidence.report : { at: evidence.at };
  return db
    .prepare("INSERT OR IGNORE INTO evidence (feedback_id, place_id, kind, data) VALUES (?, ?, ?, ?)")
    .bind(feedbackId, place, evidence.kind, JSON.stringify(data));
}

/** Replaces the block list in one transaction. Standings are worked out with it each time the list is read. */
export async function setBlockList(db: D1Like, contributors: readonly string[]): Promise<void> {
  await db.batch([db.prepare("DELETE FROM blocked_contributors"), ...blockStatements(db, contributors)]);
}

/** Statements adding contributors to the block list. One already on it is left as it is. */
export function blockStatements(db: D1Like, contributors: readonly string[]): D1Statement[] {
  return chunks([...new Set(contributors)], MAX_BOUND).map((part) =>
    db.prepare(`INSERT OR IGNORE INTO blocked_contributors (contributor) VALUES ${part.map(() => "(?)").join(", ")}`).bind(...part),
  );
}

interface PlaceRow {
  id: string;
  lat: number;
  lon: number;
  kind: string | null;
  name: string | null;
  added: string;
  contributor: string;
  device: string;
  attest_key: string | null;
  description: string | null;
  fee: string | null;
  contacts: string | null;
  in_data_at: string | null;
}

const fromRow = (row: PlaceRow): StoredPlace => ({
  id: row.id,
  location: { lat: row.lat, lon: row.lon },
  kind: row.kind,
  name: row.name,
  added: row.added,
  contributor: row.contributor,
  device: row.device,
  ...(row.attest_key === null ? {} : { attest_key: row.attest_key }),
  ...(row.description === null ? {} : { description: row.description }),
  ...(row.fee === null ? {} : { fee: JSON.parse(row.fee) as FeeValue }),
  ...(row.contacts === null ? {} : { contacts: JSON.parse(row.contacts) as Partial<Record<ContactFactName, FactValue>> }),
});

export async function getPlace(db: D1Like, id: string): Promise<StoredPlace | undefined> {
  const row = await db.prepare("SELECT * FROM new_places WHERE id = ?").bind(id).first<PlaceRow>();
  return row === null ? undefined : fromRow(row);
}

/**
 * Removes places and the evidence on them in one transaction, along with any
 * evidence whose place has already gone (written while its place was being removed).
 */
export async function removePlaces(db: D1Like, ids: readonly string[]): Promise<void> {
  await db.batch([
    ...chunks(ids, MAX_BOUND).flatMap((part) => [
      db.prepare(`DELETE FROM new_places WHERE id IN (${marks(part.length)})`).bind(...part),
      db.prepare(`DELETE FROM evidence WHERE place_id IN (${marks(part.length)})`).bind(...part),
    ]),
    db.prepare("DELETE FROM evidence WHERE place_id NOT IN (SELECT id FROM new_places)"),
  ]);
}

/**
 * Records that the apply run is done with these places, as of `at`: the data
 * holds them, or their adder withdrew them. They stay on the recent list, with
 * their evidence still counting, for 7 days from then, so a hide or withdraw
 * after that still reaches apps. A place already marked keeps its first time,
 * so the apply can send the same ids on every run. Returns the places marked.
 */
export async function markPlacesInData(db: D1Like, ids: readonly string[], at: string): Promise<number> {
  const results = await db.batch(
    chunks([...new Set(ids)], MAX_BOUND - 1).map((part) =>
      db.prepare(`UPDATE new_places SET in_data_at = ? WHERE in_data_at IS NULL AND id IN (${marks(part.length)})`).bind(at, ...part),
    ),
  );
  return results.reduce<number>((sum, result) => sum + ((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0), 0);
}

/**
 * The statements that delete new places the apply run was done with more than
 * 7 days before `now`, with their evidence, and any evidence whose place has
 * already gone. The evidence goes first, while its place can still be found.
 * For the scheduled job's prune.
 */
export function prunePlaceStatements(db: D1Like, now: number): D1Statement[] {
  const before = isoSeconds(now - KEEP_PLACE_IN_DATA_DAYS * DAY_MS);
  return [
    db.prepare("DELETE FROM evidence WHERE place_id IN (SELECT id FROM new_places WHERE in_data_at IS NOT NULL AND in_data_at < ?)").bind(before),
    db.prepare("DELETE FROM new_places WHERE in_data_at IS NOT NULL AND in_data_at < ?").bind(before),
    db.prepare("DELETE FROM evidence WHERE place_id NOT IN (SELECT id FROM new_places)"),
  ];
}

/** West, south, east, north. */
export type Bbox = [number, number, number, number];

type ListedRow = PlaceRow & { blocked: number; evidence_kind: Evidence["kind"] | null; evidence_data: string | null };

/**
 * The new places on the recent list in id order, within `bbox` when given,
 * read in one query with their evidence: those the apply run is not done with
 * yet while they are `shown` or `confirmed`, and those it was done with in the
 * last 7 days whatever their standing, with `in_data_at`, so a hide or
 * withdraw after the data has a place still reaches apps. Each standing is
 * worked out at `now` from the evidence and the block list, so nothing is
 * written back.
 */
export async function listPlaces(db: D1Like, now: string, bbox?: Bbox): Promise<RecentPlace[]> {
  const query = db.prepare(
    `SELECT p.*, EXISTS (SELECT 1 FROM blocked_contributors b WHERE b.contributor = p.contributor) AS blocked,
       e.kind AS evidence_kind, e.data AS evidence_data
     FROM new_places p LEFT JOIN evidence e ON e.place_id = p.id
     ${bbox ? "WHERE p.lat BETWEEN ? AND ? AND p.lon BETWEEN ? AND ?" : ""}
     ORDER BY p.id`,
  );
  const { results } = await (bbox ? query.bind(bbox[1], bbox[3], bbox[0], bbox[2]) : query).all<ListedRow>();

  // Kept until the scheduled job prunes it, but not listed past its 7 days should a prune be late.
  const kept = isoSeconds(Date.parse(now) - KEEP_PLACE_IN_DATA_DAYS * DAY_MS);
  type Entry = { place: StoredPlace; inDataAt: string | null; blocked: boolean; checks: NewPlaceCheck[]; reports: NewPlaceReport[]; withdrawn: string[] };
  const places = new Map<string, Entry>();
  for (const row of results) {
    if (row.in_data_at !== null && row.in_data_at < kept) continue;
    let entry = places.get(row.id);
    if (!entry) places.set(row.id, (entry = { place: fromRow(row), inDataAt: row.in_data_at, blocked: row.blocked === 1, checks: [], reports: [], withdrawn: [] }));
    if (row.evidence_kind === null || row.evidence_data === null) continue;
    const data: unknown = JSON.parse(row.evidence_data);
    if (row.evidence_kind === "check") entry.checks.push(data as NewPlaceCheck);
    else if (row.evidence_kind === "removal_report") entry.reports.push(data as NewPlaceReport);
    else entry.withdrawn.push((data as { at: string }).at);
  }

  const out: RecentPlace[] = [];
  for (const { place, inDataAt, blocked, checks, reports, withdrawn } of places.values()) {
    const standing = newPlaceStanding({
      added: place.added,
      // The intake has no place history: the apply run settles first places.
      contributor: { device: place.device, blocked, firstPlace: false },
      checks,
      reports,
      withdrawnAt: withdrawn.sort()[0] ?? null,
      duplicateOf: null,
      moderator: null,
      now,
    });
    if (inDataAt === null && standing !== "shown" && standing !== "confirmed") continue;
    const { id, location, kind, name, added, contributor, description, fee, contacts } = place;
    out.push({
      id,
      location,
      kind,
      name,
      standing,
      added,
      contributor,
      ...(description !== undefined ? { description } : {}),
      ...(fee !== undefined ? { fee } : {}),
      ...(contacts !== undefined ? { contacts } : {}),
      ...(inDataAt !== null ? { in_data_at: inDataAt } : {}),
    });
  }
  return out;
}

/**
 * The box grown out to whole degrees. The recent list is cached by its box, so
 * every map view inside the same degrees shares one cached answer.
 */
export function snapBbox([west, south, east, north]: Bbox): Bbox {
  // `+ 0` turns -0 into 0, so the cache key reads the same either way.
  return [Math.floor(west) + 0, Math.floor(south) + 0, Math.ceil(east) + 0, Math.ceil(north) + 0];
}

/** Reads `west,south,east,north` in degrees. Undefined when the text is not a box. */
export function parseBbox(text: string): Bbox | undefined {
  const parts = text.split(",").map((p) => (p.trim() === "" ? NaN : Number(p)));
  if (parts.length !== 4 || !parts.every(Number.isFinite)) return undefined;
  const [west, south, east, north] = parts as Bbox;
  if (south < -90 || north > 90 || south > north || west < -180 || east > 180 || west > east) return undefined;
  return [west, south, east, north];
}
