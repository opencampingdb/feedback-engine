import type { D1Like } from "./recent.js";

/**
 * Starting the inbox's apply workflow soon after feedback arrives. Each inbox
 * write is recorded, and the scheduled job, once a minute, starts the apply
 * when the inbox has had no new write for QUIET_MS, or when the oldest write
 * since the last start is MAX_WAIT_MS old, so a steady stream of writes still
 * gets a run. Either way at most once every CAP_MS. The apply's own hourly
 * schedule stays as a back-up.
 */

/** How long the inbox must go without a new write before a run starts. */
export const QUIET_MS = 2 * 60 * 1000;
/** The shortest time between two runs the intake starts. */
export const CAP_MS = 10 * 60 * 1000;
/** The longest a write waits for a run while new writes keep the inbox from going quiet. */
export const MAX_WAIT_MS = 10 * 60 * 1000;
/** The row in `runs` for the apply workflow. */
export const APPLY = "apply";

/**
 * Records an inbox write at `nowMs`. A later write never moves the last write
 * back, and the first waiting write keeps its time until a run starts.
 */
export async function recordInboxWrite(db: D1Like, nowMs: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO runs (name, last_write, first_write) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET last_write = max(coalesce(runs.last_write, 0), excluded.last_write), first_write = min(coalesce(runs.first_write, excluded.first_write), excluded.first_write)",
    )
    .bind(APPLY, nowMs, nowMs)
    .run();
}

export type RunOutcome =
  /** No inbox write since the last run started. */
  | "idle"
  /** A write came in less than QUIET_MS ago, and none has waited MAX_WAIT_MS. */
  | "waiting_quiet"
  /** The last run started less than CAP_MS ago. */
  | "waiting_cap"
  | "started"
  /** Starting the run failed. The state is as before, so the next tick tries again. */
  | "failed";

interface RunRow {
  last_write: number | null;
  first_write: number | null;
  last_start: number | null;
}

/**
 * Starts the apply with `start` when it is due. The start time is claimed
 * before `start` runs, so two ticks at once start one run, and put back when
 * `start` fails. `start` failing is never thrown: it is passed to `onError`.
 */
export async function startApplyIfDue(
  db: D1Like,
  nowMs: number,
  start: () => Promise<void>,
  onError: (error: unknown) => void = () => undefined,
): Promise<RunOutcome> {
  const row = await db.prepare("SELECT last_write, first_write, last_start FROM runs WHERE name = ?").bind(APPLY).first<RunRow>();
  if (!row || row.last_write === null) return "idle";
  const lastStart = row.last_start;
  if (lastStart !== null && row.last_write < lastStart) return "idle";
  // A write at the very moment of the last start has no first_write of its own.
  const firstWrite = row.first_write ?? row.last_write;
  if (nowMs - row.last_write < QUIET_MS && nowMs - firstWrite < MAX_WAIT_MS) return "waiting_quiet";
  if (lastStart !== null && nowMs - lastStart < CAP_MS) return "waiting_cap";

  const claimed = (await db
    .prepare("UPDATE runs SET last_start = ?, first_write = NULL WHERE name = ? AND last_start IS ?")
    .bind(nowMs, APPLY, lastStart)
    .run()) as { meta?: { changes?: number } };
  if (claimed.meta?.changes === 0) return "idle";

  try {
    await start();
    return "started";
  } catch (error) {
    // Writes that came in meanwhile keep the earlier first_write.
    await db
      .prepare("UPDATE runs SET last_start = ?, first_write = min(coalesce(first_write, ?), ?) WHERE name = ? AND last_start = ?")
      .bind(lastStart, firstWrite, firstWrite, APPLY, nowMs)
      .run()
      .catch(() => undefined);
    onError(error);
    return "failed";
  }
}

/** The shortest time between two runs of the AI reviewer. */
export const REVIEW_EVERY_MS = 10 * 60 * 1000;
/** The row in `runs` for the AI reviewer. Only `last_start` is used. */
export const REVIEW = "review";

/**
 * Claims a run of the AI reviewer at `nowMs`, when the last one started at
 * least REVIEW_EVERY_MS ago. False when it is not due, so two ticks at once
 * start one run.
 */
export async function claimReviewRun(db: D1Like, nowMs: number): Promise<boolean> {
  const row = await db
    .prepare(
      "INSERT INTO runs (name, last_start) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET last_start = excluded.last_start WHERE runs.last_start IS NULL OR runs.last_start <= ? RETURNING name",
    )
    .bind(REVIEW, nowMs, nowMs - REVIEW_EVERY_MS)
    .first<string>("name");
  return row !== null;
}
