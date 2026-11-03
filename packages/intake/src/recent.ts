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

/** A new place as the store keeps it: the listed part, and what its standing is worked out from. */
export interface StoredPlace extends RecentPlace {
  /** The adder's hashed device. */
  device: string;
  /** The adder's hashed App Attest key, when the report was attested with one. */
  attest_key?: string;
  checks: NewPlaceCheck[];
  reports: NewPlaceReport[];
  withdrawn_at: string | null;
}

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

const key = (id: string) => `np:${id}`;
/** Outside the `np:` prefix, so listing places never reads it. */
const BLOCKED_KEY = "blocked:contributors";

const listed = (place: StoredPlace): RecentPlace => ({
  id: place.id,
  location: place.location,
  kind: place.kind,
  name: place.name ?? null,
  standing: place.standing,
  added: place.added,
  contributor: place.contributor,
});

/** The contributors the apply run last sent as blocked. Empty until it has sent a list. */
export async function getBlocked(kv: ListableKV): Promise<Set<string>> {
  const text = await kv.get(BLOCKED_KEY);
  return new Set(text === null ? [] : (JSON.parse(text) as string[]));
}

/**
 * Replaces the block list, then works out again the standing of every stored
 * place whose contributor was blocked or unblocked by the change.
 */
export async function setBlocked(kv: ListableKV, contributors: readonly string[], now: string): Promise<void> {
  const before = await getBlocked(kv);
  const after = new Set(contributors);
  await kv.put(BLOCKED_KEY, JSON.stringify([...after]));
  const changed = (c: string) => before.has(c) !== after.has(c);
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "np:", ...(cursor ? { cursor } : {}) });
    for (const { name, metadata } of page.keys) {
      const contributor = (metadata as RecentPlace | undefined)?.contributor;
      if (contributor === undefined || !changed(contributor)) continue;
      const place = await getPlace(kv, name.slice(3));
      if (place) await savePlace(kv, place, now, after);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

/**
 * Works the standing out again and writes the place. The listed part goes in
 * the key's metadata too, so the list is read without a get for each place.
 * The block list is read from the store unless it is given.
 */
export async function savePlace(kv: ListableKV, place: StoredPlace, now: string, blocked?: ReadonlySet<string>): Promise<void> {
  const blockedNow = blocked ?? (await getBlocked(kv));
  const standing = newPlaceStanding({
    added: place.added,
    // The intake has no place history: the apply run settles first places.
    contributor: { device: place.device, blocked: blockedNow.has(place.contributor), firstPlace: false },
    checks: place.checks,
    reports: place.reports,
    withdrawnAt: place.withdrawn_at,
    duplicateOf: null,
    moderator: null,
    now,
  });
  const next = { ...place, standing };
  await kv.put(key(place.id), JSON.stringify(next), { metadata: listed(next) });
}

export async function getPlace(kv: ListableKV, id: string): Promise<StoredPlace | undefined> {
  const text = await kv.get(key(id));
  return text === null ? undefined : (JSON.parse(text) as StoredPlace);
}

export async function removePlaces(kv: ListableKV, ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => kv.delete(key(id))));
}

/** West, south, east, north. */
export type Bbox = [number, number, number, number];

/** Every `shown` or `confirmed` place in the store, within `bbox` when given. */
export async function listPlaces(kv: ListableKV, bbox?: Bbox): Promise<RecentPlace[]> {
  const out: RecentPlace[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: "np:", ...(cursor ? { cursor } : {}) });
    for (const { metadata } of page.keys) {
      const place = metadata as RecentPlace | undefined;
      if (!place || (place.standing !== "shown" && place.standing !== "confirmed")) continue;
      if (bbox) {
        const [west, south, east, north] = bbox;
        const { lat, lon } = place.location;
        if (lat < south || lat > north || lon < west || lon > east) continue;
      }
      // Places stored before names were kept have none.
      out.push({ ...place, name: place.name ?? null });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
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
