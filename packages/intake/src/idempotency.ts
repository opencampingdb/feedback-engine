/**
 * Idempotency keys. The SDK sends a key that stays the same each time it
 * sends one item again: in the `Idempotency-Key` header of a single request,
 * or in `keys` beside `items` in a batch. The intake keeps each key, per app,
 * with what it answered, in the same D1 batch that stores the item. When the
 * same key comes again, for example because the first answer was lost on a
 * weak signal, the intake gives the first answer again and stores and counts
 * nothing. Two requests with one key at the same moment can't both be
 * stored: the second batch fails on the key and answers 503, and the SDK's
 * next try gets the first answer.
 */

import { IDEMPOTENCY_HEADER, isIdempotencyKey } from "@opencampingdb/feedback";
import type { D1Like, D1Statement } from "./recent.js";

export { IDEMPOTENCY_HEADER, isIdempotencyKey };
/**
 * How long a key is kept: a day more than the SDK keeps an unsent item
 * (`maxQueueAgeMs`, 30 days by default), so an item sent again after its
 * longest wait is still known.
 */
export const KEEP_KEYS_DAYS = 31;

/** A request's answer as it is kept and given again. */
export interface KeptAnswer {
  status: number;
  body: Record<string, unknown>;
}

/** The request's key: undefined without one, or "invalid" when it is not a key. */
export function requestKey(request: Request): string | undefined | "invalid" {
  const value = request.headers.get(IDEMPOTENCY_HEADER);
  if (value === null) return undefined;
  return isIdempotencyKey(value) ? value : "invalid";
}

/** The kept answers for the app's keys, by key. Missing keys are not in the map. */
export async function keptAnswers(db: D1Like, app: string, keys: readonly string[]): Promise<Map<string, KeptAnswer>> {
  const out = new Map<string, KeptAnswer>();
  // D1 takes at most 100 bound values a statement: one for the app, the rest keys.
  for (let i = 0; i < keys.length; i += 99) {
    const part = keys.slice(i, i + 99);
    const { results } = await db
      .prepare(`SELECT key, answer FROM request_keys WHERE app = ? AND key IN (${part.map(() => "?").join(", ")})`)
      .bind(app, ...part)
      .all<{ key: string; answer: string }>();
    for (const row of results) out.set(row.key, JSON.parse(row.answer) as KeptAnswer);
  }
  return out;
}

/**
 * Keeps the key with its answer. A plain INSERT: when the key is there
 * already, the batch it is in fails, so the item is not stored twice.
 */
export function keepAnswer(db: D1Like, app: string, key: string, answer: KeptAnswer, at: string): D1Statement {
  return db.prepare("INSERT INTO request_keys (app, key, answer, created) VALUES (?, ?, ?, ?)").bind(app, key, JSON.stringify(answer), at);
}

/** Deletes keys older than KEEP_KEYS_DAYS. */
export async function pruneRequestKeys(db: D1Like, nowMs: number): Promise<void> {
  const before = new Date(nowMs - KEEP_KEYS_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM request_keys WHERE created < ?").bind(before).run();
}
