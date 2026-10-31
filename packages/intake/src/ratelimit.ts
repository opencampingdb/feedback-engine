/** The part of a Workers KV namespace the rate limiter uses. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export const DEVICE_DAILY_LIMIT = 20;
/** Owner claims, listings and updates, per hashed device per day (SPEC "Owners"). */
export const OWNER_DAILY_LIMIT = 5;
/** Submissions per hashed client network per day, and owner submissions per network. */
export const ORIGIN_DAILY_LIMIT = 100;
export const OWNER_ORIGIN_DAILY_LIMIT = 10;
const TTL_SECONDS = 2 * 24 * 60 * 60;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the counters reset at midnight UTC. */
  retryAfter: number;
}

function secondsToMidnightUtc(nowMs: number): number {
  const d = new Date(nowMs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((midnight - nowMs) / 1000));
}

/**
 * Daily counters per hashed device, per hashed client network and per app,
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
): Promise<RateLimitResult> {
  // Owner submissions have their own, smaller device counter.
  const deviceKey = kind === "owner" ? `o:${day}:${deviceHash}` : `d:${day}:${deviceHash}`;
  const deviceLimit = kind === "owner" ? OWNER_DAILY_LIMIT : DEVICE_DAILY_LIMIT;
  // Owner submissions have their own app counter, so other feedback cannot use up the owners' share.
  const appKey = kind === "owner" ? `ao:${day}:${app}` : `a:${day}:${app}`;
  // The network counter applies only when the intake saw a client address.
  const originKey = originHash === undefined ? undefined : kind === "owner" ? `no:${day}:${originHash}` : `n:${day}:${originHash}`;
  const originLimit = kind === "owner" ? OWNER_ORIGIN_DAILY_LIMIT : ORIGIN_DAILY_LIMIT;
  const [deviceCount, appCount, originCount] = await Promise.all([
    kv.get(deviceKey),
    kv.get(appKey),
    originKey === undefined ? null : kv.get(originKey),
  ]);
  const d = Number(deviceCount ?? 0);
  const a = Number(appCount ?? 0);
  const o = Number(originCount ?? 0);
  const retryAfter = secondsToMidnightUtc(nowMs);
  if (d >= deviceLimit || a >= appDailyLimit || o >= originLimit) return { allowed: false, retryAfter };
  await Promise.all([
    kv.put(deviceKey, String(d + 1), { expirationTtl: TTL_SECONDS }),
    kv.put(appKey, String(a + 1), { expirationTtl: TTL_SECONDS }),
    ...(originKey === undefined ? [] : [kv.put(originKey, String(o + 1), { expirationTtl: TTL_SECONDS })]),
  ]);
  return { allowed: true, retryAfter };
}
