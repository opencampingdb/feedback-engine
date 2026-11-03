/**
 * Reads the recent list as Workers KV held it before it moved to D1, so the
 * copy into D1 can read it. Remove it with the RECENT_PLACES namespace.
 */
import type { NewPlaceCheck, NewPlaceReport } from "@opencampingdb/feedback";
import type { StoredPlace } from "./recent.js";

/** The part of a Workers KV namespace the copy reads: values, and listing with metadata. */
export interface ListableKV {
  get(key: string): Promise<string | null>;
  list(options: { prefix?: string; cursor?: string }): Promise<{
    keys: { name: string; metadata?: unknown }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export const PREFIX = "np:";
/** The key of a place, `np:<id>`. Its value is the whole place as JSON. */
export const kvKey = (id: string) => `${PREFIX}${id}`;
/** Outside the `np:` prefix, so listing places never reads it. */
export const BLOCKED_KEY = "blocked:contributors";

/**
 * The metadata of an evidence key: a check, a removal report, or the time of
 * a withdraw (named `day`, though it holds the full time).
 */
export type KvEvidenceMetadata = NewPlaceCheck | NewPlaceReport | { day: string };

/**
 * A key under `np:`: a place (`np:<id>`) or evidence on it
 * (`np:<id>:<c|r|w>:<feedback id>`, for a check, removal report or withdraw).
 */
export function readKey(name: string): { place: string; evidence?: "c" | "r" | "w"; feedbackId?: string } {
  const [place = "", evidence, ...rest] = name.slice(PREFIX.length).split(":");
  const feedbackId = rest.join(":");
  if ((evidence === "c" || evidence === "r" || evidence === "w") && feedbackId !== "") return { place, evidence, feedbackId };
  return { place };
}

/** The contributors the apply run last sent as blocked. Empty until it has sent a list. */
export async function getKvBlocked(kv: ListableKV): Promise<Set<string>> {
  const text = await kv.get(BLOCKED_KEY);
  return new Set(text === null ? [] : (JSON.parse(text) as string[]));
}

/** The whole place, from its value: the registered key and a long name are only there, not in the metadata. */
export async function getKvPlace(kv: ListableKV, id: string): Promise<StoredPlace | undefined> {
  const text = await kv.get(kvKey(id));
  return text === null ? undefined : (JSON.parse(text) as StoredPlace);
}

/** The keys under `np:`, a page (one KV list operation) at a time. */
export async function* kvPages(kv: ListableKV): AsyncGenerator<{ name: string; metadata?: unknown }[]> {
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: PREFIX, ...(cursor ? { cursor } : {}) });
    yield page.keys;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}
