import { MAX_PROGRESS_IDS, type Progress, type RefusedBy } from "@opencampingdb/feedback";
import type { ProgressUpdate } from "@opencampingdb/apply/progress-update";
import type { ItemState } from "./decide.js";
import { chunks, isoSeconds, type D1Like, type D1Statement } from "./recent.js";
import { ulidTime } from "./ulid.js";

/**
 * Where each contribution is (the `item_progress` table): written when an
 * item is queued, updated by the apply run, and served to apps by id. A row
 * holds only the state, the engine's reason, the send-time held reason, who
 * refused it, the place and times: never the traveller's words, a device or
 * a contributor.
 */

/** Days a row is kept after it last changed. */
export const KEEP_PROGRESS_DAYS = 90;
/** Most items one `POST /v1/feedback/progress` may carry. */
export const MAX_PROGRESS_ITEMS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The row an accepted feedback item gets when it is queued, for the same
 * batch: `live` when the send-time decision put it live, otherwise
 * `received`, with the held reason when that decision held it.
 */
export function receivedStatement(db: D1Like, item: { id: string; received: string; place: string | null }, decision: ItemState | undefined): D1Statement {
  return db
    .prepare(
      "INSERT OR IGNORE INTO item_progress (feedback_id, state, held_reason, place, received, updated) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(
      item.id,
      decision?.state === "live" ? "live" : "received",
      decision?.state === "held" ? decision.held_reason : null,
      item.place,
      item.received,
      item.received,
    );
}

/**
 * Records what the apply run says about each item, never moving a row back:
 * a row `in_data` keeps everything, and a row `refused` changes only to
 * `in_data` (a change a reviewer turned down that reached the data after
 * all). `in_data_at` is kept once set, and no time is later than `now`. An
 * id the intake has no row for (an item sent before rows were kept) gets
 * one, received at the time in its id. A row changes, and its `updated`
 * moves, only when its state, reason, refusal or place changes, so the
 * same items can be sent on every run. Returns the rows written.
 */
export async function recordProgress(db: D1Like, items: readonly ProgressUpdate[], now: number): Promise<number> {
  const at = isoSeconds(now);
  const capped = (time: string | undefined) => (time === undefined ? null : Date.parse(time) > now ? at : time);
  const statements = items.map((item) =>
    db
      .prepare(
        `INSERT INTO item_progress (feedback_id, state, reason, refused_by, place, received, decided_at, in_data_at, updated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (feedback_id) DO UPDATE SET
           state = excluded.state,
           reason = excluded.reason,
           refused_by = excluded.refused_by,
           place = COALESCE(excluded.place, item_progress.place),
           decided_at = CASE WHEN item_progress.state = excluded.state THEN COALESCE(item_progress.decided_at, excluded.decided_at) ELSE excluded.decided_at END,
           in_data_at = COALESCE(item_progress.in_data_at, excluded.in_data_at),
           updated = excluded.updated
         WHERE item_progress.state <> 'in_data'
           AND (item_progress.state <> 'refused' OR excluded.state = 'in_data')
           AND (item_progress.state IS NOT excluded.state
             OR item_progress.reason IS NOT excluded.reason
             OR item_progress.refused_by IS NOT excluded.refused_by
             OR (excluded.place IS NOT NULL AND item_progress.place IS NOT excluded.place))`,
      )
      .bind(
        item.id,
        item.state,
        item.reason ?? null,
        item.state === "refused" ? (item.by ?? null) : null,
        item.place ?? null,
        isoSeconds(ulidTime(item.id.slice(3))),
        capped(item.decided_at),
        item.state === "in_data" ? capped(item.in_data_at) : null,
        at,
      ),
  );
  const results = await db.batch(statements);
  return results.reduce<number>((sum, result) => sum + ((result as { meta?: { changes?: number } } | null)?.meta?.changes ?? 0), 0);
}

interface ProgressRow {
  feedback_id: string;
  state: Exclude<Progress["state"], "unknown">;
  reason: string | null;
  held_reason: string | null;
  refused_by: RefusedBy | null;
  place: string | null;
  received: string;
  decided_at: string | null;
  in_data_at: string | null;
}

/** Each id's progress, in the order asked, `unknown` for an id with no row kept. */
export async function readProgress(db: D1Like, ids: readonly string[], now: number): Promise<Progress[]> {
  const kept = isoSeconds(now - KEEP_PROGRESS_DAYS * DAY_MS);
  const unique = [...new Set(ids)];
  const rows = new Map<string, ProgressRow>();
  for (const part of chunks(unique, MAX_PROGRESS_IDS - 1)) {
    const { results } = await db
      .prepare(
        `SELECT feedback_id, state, reason, held_reason, refused_by, place, received, decided_at, in_data_at FROM item_progress
         WHERE updated >= ? AND feedback_id IN (${part.map(() => "?").join(", ")})`,
      )
      .bind(kept, ...part)
      .all<ProgressRow>();
    for (const row of results) rows.set(row.feedback_id, row);
  }
  return ids.map((id): Progress => {
    const row = rows.get(id);
    if (!row) return { id, state: "unknown" };
    return {
      id,
      state: row.state,
      ...(row.reason !== null ? { reason: row.reason } : {}),
      ...(row.held_reason !== null ? { held_reason: row.held_reason as NonNullable<Progress["held_reason"]> } : {}),
      ...(row.state === "refused" && row.refused_by !== null ? { by: row.refused_by } : {}),
      ...(row.place !== null ? { place: row.place } : {}),
      received: row.received,
      ...(row.decided_at !== null ? { decided_at: row.decided_at } : {}),
      ...(row.in_data_at !== null ? { in_data_at: row.in_data_at } : {}),
    };
  });
}

/** Deletes rows that have not changed for 90 days. For the scheduled job. */
export async function pruneProgress(db: D1Like, now: number): Promise<void> {
  await db.prepare("DELETE FROM item_progress WHERE updated < ?").bind(isoSeconds(now - KEEP_PROGRESS_DAYS * DAY_MS)).run();
}
