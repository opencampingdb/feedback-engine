/**
 * The recent list as Workers KV held it before it moved to D1, kept so the
 * copy into D1 can read it. Remove it with the RECENT_PLACES namespace.
 */
import type { NewPlaceCheck, NewPlaceReport } from "@opencampingdb/feedback";
import type { StoredPlace } from "./recent.js";

/** The part of a Workers KV namespace the old recent list used: values with metadata, and listing. */
export interface ListableKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/** A check, removal report or withdraw on a stored place, each kept under its own key. */
export type Evidence =
  | { type: "check"; check: NewPlaceCheck }
  | { type: "report"; report: NewPlaceReport }
  | { type: "withdraw"; at: string };

export const PREFIX = "np:";
export const key = (id: string) => `${PREFIX}${id}`;
const EVIDENCE_KEY = { check: "c", report: "r", withdraw: "w" } as const;
/** Outside the `np:` prefix, so listing places never reads it. */
export const BLOCKED_KEY = "blocked:contributors";

/**
 * The listed part of a place, kept in its key's metadata so the list needs no
 * get for each place. A name too long for the metadata stays in the value
 * alone, and `long_name` says to read it from there.
 */
export type PlaceMetadata = Omit<StoredPlace, "id" | "attest_key"> & { long_name?: true };
/** Workers KV refuses metadata longer than this, as JSON in UTF-8. */
const MAX_METADATA_BYTES = 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
export type EvidenceMetadata = NewPlaceCheck | NewPlaceReport | { day: string };

/** A key under `np:`: a place (`np:<id>`) or evidence on it (`np:<id>:<c|r|w>:<feedback id>`). */
export function readKey(name: string): { place: string; evidence?: "c" | "r" | "w" } {
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
  const { id: _, attest_key: __, ...listed } = place;
  // The rest of the place is short and bounded; a name of 300 characters can be 1200 bytes.
  const metadata: PlaceMetadata = bytes(listed) <= MAX_METADATA_BYTES ? listed : { ...listed, name: null, long_name: true };
  await kv.put(key(place.id), JSON.stringify(place), { metadata });
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
export async function* pages(kv: ListableKV): AsyncGenerator<{ name: string; metadata?: unknown }[]> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}) });
    yield page.keys;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
