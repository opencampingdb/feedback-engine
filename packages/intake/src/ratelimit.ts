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
 * Reports about one place from one device in one day. The first counts
 * against the daily limits like any item; the rest of the edit (a traveller
 * filling in many facts) don't, up to this many.
 */
export const PLACE_EDIT_DAILY_LIMIT = 100;
const TTL_SECONDS = 2 * 24 * 60 * 60;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the counters reset at midnight UTC. */
  retryAfter: number;
}

export function secondsToMidnightUtc(nowMs: number): number {
  const d = new Date(nowMs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - nowMs) / 1000));
}

/**
 * Daily counters per hashed device, per hashed client network, per app and
 * per any `extra` id (a contributor, an attested key),
 * kept in KV. KV is eventually consistent, so a burst from one device can slip
 * a few over the limit. That is acceptable here: the limit stops floods, and
 * the apply rules count distinct networks, not submissions or device ids.
 */
export async function checkAndCount(
  kv: KVLike,
  day: string,
  deviceHash: string,
  app: string,
  appDailyLimit: number,
  nowMs: number,
  kind: "feedback" | "owner" = "feedback",
  originHash?: string,
  /** More counters, such as one per contributor: KV key prefix, hashed id and limit. */
  extra: readonly { prefix: string; id: string; limit: number }[] = [],
): Promise<RateLimitResult> {
  // Owner submissions have their own, smaller device counter.
  const deviceKey = kind === "owner" ? `o:${day}:${deviceHash}` : `d:${day}:${deviceHash}`;
  const deviceLimit = kind === "owner" ? OWNER_DAILY_LIMIT : DEVICE_DAILY_LIMIT;
  // Owner submissions have their own app counter, so other feedback cannot use up the owners' share.
  const appKey = kind === "owner" ? `ao:${day}:${app}` : `a:${day}:${app}`;
  // The network counter applies only when the intake saw a client address.
  const originKey = originHash === undefined ? undefined : kind === "owner" ? `no:${day}:${originHash}` : `n:${day}:${originHash}`;
  const originLimit = kind === "owner" ? OWNER_ORIGIN_DAILY_LIMIT : ORIGIN_DAILY_LIMIT;
  const extraKeys = extra.map((e) => ({ key: `${e.prefix}:${day}:${e.id}`, limit: e.limit }));
  const [deviceCount, appCount, originCount, ...extraCounts] = await Promise.all([
    kv.get(deviceKey),
    kv.get(appKey),
    originKey === undefined ? null : kv.get(originKey),
    ...extraKeys.map((e) => kv.get(e.key)),
  ]);
  const d = Number(deviceCount ?? 0);
  const a = Number(appCount ?? 0);
  const o = Number(originCount ?? 0);
  const x = extraCounts.map((c) => Number(c ?? 0));
  const retryAfter = secondsToMidnightUtc(nowMs);
  if (d >= deviceLimit || a >= appDailyLimit || o >= originLimit || x.some((c, i) => c >= extraKeys[i]!.limit)) {
    return { allowed: false, retryAfter };
  }
  await Promise.all([
    kv.put(deviceKey, String(d + 1), { expirationTtl: TTL_SECONDS }),
    kv.put(appKey, String(a + 1), { expirationTtl: TTL_SECONDS }),
    ...(originKey === undefined ? [] : [kv.put(originKey, String(o + 1), { expirationTtl: TTL_SECONDS })]),
    ...extraKeys.map((e, i) => kv.put(e.key, String(x[i]! + 1), { expirationTtl: TTL_SECONDS })),
  ]);
  return { allowed: true, retryAfter };
}

/**
 * Where a report about `place` from this device stands today: `first` when the
 * device has not reported on the place today, so the item counts against the
 * daily limits as usual; `more` when it has, so the item is part of the same
 * edit and doesn't count again; `full` past PLACE_EDIT_DAILY_LIMIT.
 */
export async function placeEditState(kv: KVLike, day: string, deviceHash: string, place: string): Promise<"first" | "more" | "full"> {
  const count = Number((await kv.get(placeEditKey(day, deviceHash, place))) ?? 0);
  if (count === 0) return "first";
  return count >= PLACE_EDIT_DAILY_LIMIT ? "full" : "more";
}

/** Counts one more report about `place` from this device today. */
export async function countPlaceEdit(kv: KVLike, day: string, deviceHash: string, place: string): Promise<void> {
  const key = placeEditKey(day, deviceHash, place);
  const count = Number((await kv.get(key)) ?? 0);
  await kv.put(key, String(count + 1), { expirationTtl: TTL_SECONDS });
}

const placeEditKey = (day: string, deviceHash: string, place: string) => `pe:${day}:${deviceHash}:${place}`;
