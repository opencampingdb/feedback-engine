import type { KVLike } from "./ratelimit.js";
import type { D1Like } from "./recent.js";

/**
 * Silent drops: items the intake answers exactly as it answers an accepted
 * item, with an id and a progress row, but never stores, counts as a source
 * or counts against a limit. Whoever sent one cannot tell it was dropped, or
 * which check it failed. Only a count per UTC day and reason is kept.
 */

/**
 * Why an item was dropped silently: its human check was missing, or did not
 * pass; or it came from a network on the blocklist (reputation.ts) without
 * attestation.
 */
export type SilentReason = "human_check_required" | "human_check_failed" | "network_reputation";

/** Days a day's counts are kept. */
export const KEEP_SILENT_DROP_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The KV key of a day's count for a reason, on an intake without D1. */
export const silentDropKey = (day: string, reason: SilentReason) => `silent:${day}:${reason}`;

/**
 * Adds each reason's drops to `day`'s counts: rows in `silent_drops` with
 * D1, otherwise KV keys that expire after KEEP_SILENT_DROP_DAYS. KV reads
 * and then writes, so drops that arrive together can be counted short.
 */
export async function countSilentDrops(store: { d1: D1Like } | { kv: KVLike }, day: string, reasons: readonly SilentReason[]): Promise<void> {
  const counts = new Map<SilentReason, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  if (counts.size === 0) return;
  if ("d1" in store) {
    const db = store.d1;
    await db.batch(
      [...counts].map(([reason, n]) =>
        db
          .prepare("INSERT INTO silent_drops (day, reason, count) VALUES (?, ?, ?) ON CONFLICT (day, reason) DO UPDATE SET count = count + excluded.count")
          .bind(day, reason, n),
      ),
    );
    return;
  }
  for (const [reason, n] of counts) {
    const key = silentDropKey(day, reason);
    const now = Number((await store.kv.get(key)) ?? "0");
    await store.kv.put(key, String((Number.isFinite(now) ? now : 0) + n), { expirationTtl: KEEP_SILENT_DROP_DAYS * 24 * 60 * 60 });
  }
}

/** Deletes counts for days older than KEEP_SILENT_DROP_DAYS. For the scheduled job. */
export async function pruneSilentDrops(db: D1Like, nowMs: number): Promise<void> {
  const before = new Date(nowMs - KEEP_SILENT_DROP_DAYS * DAY_MS).toISOString().slice(0, 10);
  await db.prepare("DELETE FROM silent_drops WHERE day < ?").bind(before).run();
}
