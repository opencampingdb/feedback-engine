import { chunks, type D1Like, type D1Statement } from "./recent.js";

/** The part of a Workers KV namespace the rate limiter uses. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Feedback per hashed device per day. Each fact is one item, so a careful edit
 * of one place can send 20 or more: the limit stops floods, not editors.
 */
export const DEVICE_DAILY_LIMIT = 200;
/** Owner claims, listings and updates, per hashed device per day (SPEC "Owners"). */
export const OWNER_DAILY_LIMIT = 5;
/** Submissions per hashed client network per day, and owner submissions per network. */
export const ORIGIN_DAILY_LIMIT = 500;
export const OWNER_ORIGIN_DAILY_LIMIT = 10;
/** Feedback per contributor per day, unless the app key sets `contributor_daily_limit`. */
export const CONTRIBUTOR_DAILY_LIMIT = 200;
/** Photo uploads per contributor per day. */
export const PHOTO_CONTRIBUTOR_DAILY_LIMIT = 10;
/** Feedback per attested App Attest key per day. */
export const ATTEST_KEY_DAILY_LIMIT = 200;
/**
 * Reports about one known place from one device in one day. The first counts
 * against every daily limit like any item; the rest of the edit (a traveller
 * filling in many facts) don't count against the device's or the
 * contributor's day, up to this many. They still count against the app's,
 * the network's and the attested key's.
 */
export const PLACE_EDIT_DAILY_LIMIT = 100;
/** The counters the rest of an edit leaves alone: the device's and the contributor's. */
const EDIT_RELIEVED = ["d:", "c:"];
/** How long a counter lives in KV, on an intake without D1. */
const TTL_SECONDS = 2 * 24 * 60 * 60;

export function secondsToMidnightUtc(nowMs: number): number {
  const d = new Date(nowMs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - nowMs) / 1000));
}

/** One daily counter: its key, with the UTC day in it, and its limit. */
export interface Counter {
  key: string;
  limit: number;
}

/**
 * Where the daily counters are kept. With the intake's D1 database
 * (RECENT_LIST) they are rows in `rate_counts`: D1 is strongly consistent and
 * has no per-key write limit, while Workers KV allows one write a second to a
 * key, which the app's counter would reach at one item a second. An intake
 * without D1 keeps them in KV, as it writes each item to the inbox at once
 * anyway. That fallback keeps KV's limit: every item writes the app's
 * counter, so such an intake takes about one item a second across all its
 * apps' users. D1 is needed at scale.
 */
export type CountStore = { d1: D1Like } | { kv: KVLike };

/** D1 allows 100 bound values in one statement. */
const MAX_BOUND = 100;
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Today's count for each of `keys`, in order, 0 for one not counted yet. One query for up to 100 keys on D1. */
export async function readCounts(store: CountStore, keys: readonly string[]): Promise<number[]> {
  if ("kv" in store) return Promise.all(keys.map(async (key) => Number((await store.kv.get(key)) ?? 0)));
  const found = new Map<string, number>();
  for (const part of chunks([...new Set(keys)], MAX_BOUND)) {
    const { results } = await store.d1.prepare(`SELECT key, count FROM rate_counts WHERE key IN (${marks(part.length)})`).bind(...part).all<{ key: string; count: number }>();
    for (const row of results) found.set(row.key, row.count);
  }
  return keys.map((key) => found.get(key) ?? 0);
}

/**
 * Adds one to each of `keys` for `day`. On D1 these are statements for the
 * caller's batch, the one that stores the item, so a count lands only with
 * what it counts and costs no round trip of its own. On KV the counts are
 * written now, from `current` (what `readCounts` gave), and none are returned.
 */
export async function countStatements(store: CountStore, day: string, keys: readonly string[], current: readonly number[]): Promise<D1Statement[]> {
  if ("kv" in store) {
    await Promise.all(keys.map((key, i) => store.kv.put(key, String((current[i] ?? 0) + 1), { expirationTtl: TTL_SECONDS })));
    return [];
  }
  return keys.map((key) =>
    store.d1.prepare("INSERT INTO rate_counts (key, day, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET count = count + 1").bind(key, day),
  );
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the counters reset at midnight UTC. */
  retryAfter: number;
  /** The counts to add, for the batch that stores the item (see `countStatements`). Empty when refused. */
  writes: D1Statement[];
}

/**
 * Checks `counters` and, when every one is under its limit, counts one more
 * on each. The check and the count are separate steps, so requests that
 * arrive together can pass a limit by a few, as they could on KV. That is
 * acceptable: the limits stop floods, and the apply rules count distinct
 * networks, not submissions or device ids. Refusing inside a transaction
 * would make every request wait on the others for no real gain.
 */
export async function checkCounters(store: CountStore, day: string, counters: readonly Counter[], nowMs: number): Promise<RateLimitResult> {
  return countSession(store, day, nowMs).check(counters);
}

/**
 * Daily counters for the items of one request, checked and counted in turn,
 * so the second item of a batch sees the first one's counts as it would if
 * the first had been sent alone and stored. Each counter is read once, the
 * first time an item needs it, in one query for every counter that item
 * needs that the session has not read yet.
 */
export interface CountSession {
  /** Today's counts for `keys`, from what the session has read and counted. */
  counts(keys: readonly string[]): Promise<number[]>;
  /** Checks and counts one item, as `checkAndCount` does. */
  check(counters: readonly Counter[], edit?: { deviceHash: string; place: string }): Promise<RateLimitResult>;
}

export function countSession(store: CountStore, day: string, nowMs: number): CountSession {
  const known = new Map<string, number>();
  const retryAfter = secondsToMidnightUtc(nowMs);
  async function counts(keys: readonly string[]): Promise<number[]> {
    const missing = [...new Set(keys.filter((key) => !known.has(key)))];
    if (missing.length > 0) {
      const read = await readCounts(store, missing);
      missing.forEach((key, i) => known.set(key, read[i] ?? 0));
    }
    return keys.map((key) => known.get(key) ?? 0);
  }
  async function count(keys: readonly string[], current: readonly number[]): Promise<D1Statement[]> {
    const writes = await countStatements(store, day, keys, current);
    keys.forEach((key, i) => known.set(key, (current[i] ?? 0) + 1));
    return writes;
  }
  return {
    counts,
    async check(counters, edit) {
      const keys = counters.map((c) => c.key);
      if (!edit) {
        const current = await counts(keys);
        if (current.some((n, i) => n >= counters[i]!.limit)) return { allowed: false, retryAfter, writes: [] };
        return { allowed: true, retryAfter, writes: await count(keys, current) };
      }
      const editKey = `pe:${day}:${edit.deviceHash}:${edit.place}`;
      const [edited = 0, ...current] = await counts([editKey, ...keys]);
      if (edited >= PLACE_EDIT_DAILY_LIMIT) return { allowed: false, retryAfter, writes: [] };
      // The rest of an edit is free of the traveller's own device and contributor counters only.
      // The app, network and attested-key counters bound every item.
      const binding = counters.map((c, i) => ({ c, n: current[i]! })).filter(({ c }) => edited === 0 || !EDIT_RELIEVED.some((p) => c.key.startsWith(p)));
      if (binding.some(({ c, n }) => n >= c.limit)) return { allowed: false, retryAfter, writes: [] };
      return { allowed: true, retryAfter, writes: await count([editKey, ...binding.map(({ c }) => c.key)], [edited, ...binding.map(({ n }) => n)]) };
    },
  };
}

/**
 * The counters for one item: per hashed device, per app, per hashed client
 * network when the intake saw an address, and per `extra` id (a contributor,
 * an attested key, a contributor's new places).
 */
export function itemCounters(
  day: string,
  deviceHash: string,
  app: string,
  appDailyLimit: number,
  kind: "feedback" | "owner" = "feedback",
  originHash?: string,
  /** More counters, such as one per contributor: key prefix, hashed id and limit. */
  extra: readonly { prefix: string; id: string; limit: number }[] = [],
): Counter[] {
  // Owner submissions have their own, smaller device counter, and their own app counter, so other
  // feedback cannot use up the owners' share.
  const out: Counter[] = [
    kind === "owner" ? { key: `o:${day}:${deviceHash}`, limit: OWNER_DAILY_LIMIT } : { key: `d:${day}:${deviceHash}`, limit: DEVICE_DAILY_LIMIT },
    { key: kind === "owner" ? `ao:${day}:${app}` : `a:${day}:${app}`, limit: appDailyLimit },
  ];
  if (originHash !== undefined) {
    out.push(kind === "owner" ? { key: `no:${day}:${originHash}`, limit: OWNER_ORIGIN_DAILY_LIMIT } : { key: `n:${day}:${originHash}`, limit: ORIGIN_DAILY_LIMIT });
  }
  for (const e of extra) out.push({ key: `${e.prefix}:${day}:${e.id}`, limit: e.limit });
  return out;
}

/**
 * Checks and counts one item against `counters`. With `editedPlace`, the item
 * is a report about that known place: the device's first report about it
 * today counts against the counters as usual, the rest of the same edit (a
 * traveller filling in many facts) don't count against the device's and the
 * contributor's counters, and past PLACE_EDIT_DAILY_LIMIT reports about the
 * place it is refused. One read for every counter.
 */
export async function checkAndCount(
  store: CountStore,
  day: string,
  counters: readonly Counter[],
  nowMs: number,
  edit?: { deviceHash: string; place: string },
): Promise<RateLimitResult> {
  return countSession(store, day, nowMs).check(counters, edit);
}

/** Deletes the D1 counters from before yesterday (UTC). Counters in KV expire on their own. */
export async function pruneRateCounts(db: D1Like, nowMs: number): Promise<void> {
  const yesterday = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await db.prepare("DELETE FROM rate_counts WHERE day < ?").bind(yesterday).run();
}
