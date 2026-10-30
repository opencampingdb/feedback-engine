/** The part of a Workers KV namespace the rate limiter uses. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export const DEVICE_DAILY_LIMIT = 20;
/** Owner claims, listings and updates, per hashed device per day (SPEC "Owners"). */
export const OWNER_DAILY_LIMIT = 5;
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
 * Daily counters per hashed device and per app, kept in KV. KV is eventually
 * consistent, so a burst from one device can slip a few over the limit. That
 * is acceptable here: the limit stops floods, and the apply rules count
 * distinct devices, not submissions.
 */
export async function checkAndCount(
  kv: KVLike,
  day: string,
  deviceHash: string,
  app: string,
  appDailyLimit: number,
  nowMs: number,
  kind: "feedback" | "owner" = "feedback",
): Promise<RateLimitResult> {
  // Owner submissions have their own, smaller device counter.
  const deviceKey = kind === "owner" ? `o:${day}:${deviceHash}` : `d:${day}:${deviceHash}`;
  const deviceLimit = kind === "owner" ? OWNER_DAILY_LIMIT : DEVICE_DAILY_LIMIT;
  const appKey = `a:${day}:${app}`;
  const [deviceCount, appCount] = await Promise.all([kv.get(deviceKey), kv.get(appKey)]);
  const d = Number(deviceCount ?? 0);
  const a = Number(appCount ?? 0);
  const retryAfter = secondsToMidnightUtc(nowMs);
  if (d >= deviceLimit || a >= appDailyLimit) return { allowed: false, retryAfter };
  await Promise.all([
    kv.put(deviceKey, String(d + 1), { expirationTtl: TTL_SECONDS }),
    kv.put(appKey, String(a + 1), { expirationTtl: TTL_SECONDS }),
  ]);
  return { allowed: true, retryAfter };
}
