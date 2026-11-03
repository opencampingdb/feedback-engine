import { newPlaceStanding, type LatLon, type NewPlaceCheck, type NewPlaceReport, type NewPlaceStanding } from "@opencampingdb/feedback";

/** The part of a Workers KV namespace the recent places store uses: values with metadata, and listing. */
export interface ListableKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/** What the recent list serves for a place. Never the note or contacts. */
export interface RecentPlace {
  id: string;
  location: LatLon;
  kind: string | null;
  /** The name the traveller gave, or null when the report carried none. */
  name: string | null;
  standing: NewPlaceStanding;
  added: string;
  /** The hashed contributor id, so apps can hide what a hidden contributor added. */
  contributor: string;
}

/** A new place as the store keeps it. Written once, when the place is added. */
export interface StoredPlace extends Omit<RecentPlace, "standing"> {
  /** The adder's hashed device. */
  device: string;
  /** The adder's hashed App Attest key, when the report was attested with one. */
  attest_key?: string;
}

/** A check, removal report or withdraw on a stored place, each kept under its own key. */
export type Evidence =
  | { type: "check"; check: NewPlaceCheck }
  | { type: "report"; report: NewPlaceReport }
  | { type: "withdraw"; at: string };

/** How long the adder may withdraw a new place outright. */
export const WITHDRAW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** New places per contributor (or device, without one) per day. */
export const NEW_PLACE_DAILY_LIMIT = 3;
/** Seconds the recent list is cached at the edge. */
export const RECENT_CACHE_SECONDS = 30;
/** Most ids one removal call may name. */
export const MAX_REMOVE_IDS = 500;
/** Most contributors the block list may hold. */
export const MAX_BLOCKED_CONTRIBUTORS = 5000;
/** Workers KV reads, writes, deletes and lists one call may make. */
const KV_OPERATIONS_PER_CALL = 1000;
/** Evidence older than this whose place has left the store is swept up by a removal. */
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

const PREFIX = "np:";
const key = (id: string) => `${PREFIX}${id}`;
const EVIDENCE_KEY = { check: "c", report: "r", withdraw: "w" } as const;
/** Outside the `np:` prefix, so listing places never reads it. */
const BLOCKED_KEY = "blocked:contributors";

/** The listed part of a place, kept in its key's metadata so the list needs no get for each place. */
type PlaceMetadata = Omit<StoredPlace, "id" | "attest_key">;
type EvidenceMetadata = NewPlaceCheck | NewPlaceReport | { day: string };

/** A key under `np:`: a place (`np:<id>`) or evidence on it (`np:<id>:<c|r|w>:<feedback id>`). */
function readKey(name: string): { place: string; evidence?: "c" | "r" | "w" } {
  const [place = "", evidence] = name.slice(PREFIX.length).split(":");
  return evidence === "c" || evidence === "r" || evidence === "w" ? { place, evidence } : { place };
}

/** The contributors the apply run last sent as blocked. Empty until it has sent a list. */
export async function getBlocked(kv: ListableKV): Promise<Set<string>> {
  const text = await kv.get(BLOCKED_KEY);
  return new Set(text === null ? [] : (JSON.parse(text) as string[]));
}

/** Replaces the block list. Standings are worked out with it each time the list is read. */
export async function setBlocked(kv: ListableKV, contributors: readonly string[]): Promise<void> {
  await kv.put(BLOCKED_KEY, JSON.stringify([...new Set(contributors)]));
}

/** Writes a new place. It is never written again: evidence on it goes under keys of its own. */
export async function addPlace(kv: ListableKV, place: StoredPlace): Promise<void> {
  const { id: _, attest_key: __, ...metadata } = place;
  await kv.put(key(place.id), JSON.stringify(place), { metadata: metadata satisfies PlaceMetadata });
}

/**
 * Writes one check, report or withdraw on a place under a key of its own,
 * named by the feedback item's id. Nothing is read first, so two arriving at
 * the same moment are both kept.
 */
export async function addEvidence(kv: ListableKV, place: string, feedbackId: string, evidence: Evidence): Promise<void> {
  const metadata: EvidenceMetadata =
    evidence.type === "check" ? evidence.check : evidence.type === "report" ? evidence.report : { day: evidence.at };
  await kv.put(`${key(place)}:${EVIDENCE_KEY[evidence.type]}:${feedbackId}`, "", { metadata });
}

export async function getPlace(kv: ListableKV, id: string): Promise<StoredPlace | undefined> {
  const text = await kv.get(key(id));
  return text === null ? undefined : (JSON.parse(text) as StoredPlace);
}

/** The keys under `np:`, a page (one KV list operation) at a time. */
async function* pages(kv: ListableKV): AsyncGenerator<{ name: string; metadata?: unknown }[]> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}) });
    yield page.keys;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

/**
 * Removes places and the evidence on them. Place keys go first, so the list
 * drops them at once. Evidence is then deleted while the call has KV
 * operations to spare, along with evidence left behind by earlier removals.
 */
export async function removePlaces(kv: ListableKV, ids: readonly string[], now: string): Promise<void> {
  await Promise.all(ids.map((id) => kv.delete(key(id))));
  const removed = new Set(ids);
  let spare = KV_OPERATIONS_PER_CALL - ids.length - 1;
  const places = new Set<string>();
  const evidence: { name: string; place: string; day: string }[] = [];
  for await (const keys of pages(kv)) {
    spare -= 1;
    for (const { name, metadata } of keys) {
      const read = readKey(name);
      if (read.evidence === undefined) places.add(read.place);
      else evidence.push({ name, place: read.place, day: (metadata as { day?: string } | undefined)?.day ?? "" });
    }
  }
  // Older than a day, so a place written moments ago but not yet in the listing is never mistaken for gone.
  const orphan = (e: { place: string; day: string }) => !places.has(e.place) && Date.parse(now) - Date.parse(e.day) > ORPHAN_AGE_MS;
  const doomed = evidence.filter((e) => removed.has(e.place) || orphan(e)).slice(0, Math.max(0, spare - 10));
  await Promise.all(doomed.map((e) => kv.delete(e.name)));
}

/** West, south, east, north. */
export type Bbox = [number, number, number, number];

/**
 * Every `shown` or `confirmed` place in the store, within `bbox` when given.
 * Each standing is worked out at `now` from the place's evidence and the
 * block list, so nothing written to the store is ever read back and changed.
 */
export async function listPlaces(kv: ListableKV, now: string, bbox?: Bbox): Promise<RecentPlace[]> {
  const places = new Map<string, { metadata?: PlaceMetadata; checks: NewPlaceCheck[]; reports: NewPlaceReport[]; withdrawn: string[] }>();
  const entry = (id: string) => {
    let found = places.get(id);
    if (!found) places.set(id, (found = { checks: [], reports: [], withdrawn: [] }));
    return found;
  };
  for await (const keys of pages(kv)) {
    for (const { name, metadata } of keys) {
      if (metadata === undefined) continue;
      const read = readKey(name);
      const place = entry(read.place);
      if (read.evidence === undefined) place.metadata = metadata as PlaceMetadata;
      else if (read.evidence === "c") place.checks.push(metadata as NewPlaceCheck);
      else if (read.evidence === "r") place.reports.push(metadata as NewPlaceReport);
      else place.withdrawn.push((metadata as { day: string }).day);
    }
  }
  const blocked = await getBlocked(kv);
  const out: RecentPlace[] = [];
  for (const [id, { metadata, checks, reports, withdrawn }] of places) {
    // Evidence whose place has been removed.
    if (!metadata) continue;
    if (bbox) {
      const [west, south, east, north] = bbox;
      const { lat, lon } = metadata.location;
      if (lat < south || lat > north || lon < west || lon > east) continue;
    }
    const standing = newPlaceStanding({
      added: metadata.added,
      // The intake has no place history: the apply run settles first places.
      contributor: { device: metadata.device, blocked: blocked.has(metadata.contributor), firstPlace: false },
      checks,
      reports,
      withdrawnAt: withdrawn.sort()[0] ?? null,
      duplicateOf: null,
      moderator: null,
      now,
    });
    if (standing !== "shown" && standing !== "confirmed") continue;
    const { location, kind, name, added, contributor } = metadata;
    out.push({ id, location, kind, name: name ?? null, standing, added, contributor });
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
