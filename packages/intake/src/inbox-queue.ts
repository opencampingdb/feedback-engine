import type { Fetch, GitHubApp, GitHubAppConfig } from "./github.js";
import { chunks, type D1Like, type D1Statement } from "./recent.js";

/**
 * Batched inbox writes. With RECENT_LIST bound, the intake puts each stored
 * feedback item and owner submission into the `inbox_queue` table, in the
 * same D1 batch as the send-time decision's rows, and answers once that
 * batch commits. The scheduled job then writes what is queued to the inbox
 * once a minute, as one commit through the Git Data API, so the intake makes
 * three content-creating requests a minute however many items arrive,
 * instead of one commit per item.
 *
 * A flush reads the branch head, creates a tree with the files' text inline
 * on top of the head's tree, creates a commit, and moves the branch to it
 * without force, starting again from the new head when the branch has moved
 * on. Just before it moves the branch it records the commit on the rows, and
 * only once the branch holds the commit are the rows deleted. So a flush that
 * stopped part way is harmless to repeat: rows whose commit is on the branch
 * are deleted without writing them again, and files already in the inbox
 * with the same text give the head's own tree, which makes no commit.
 *
 * One flush runs at a time, under a lease in `runs` held for FLUSH_LEASE_MS,
 * and each GitHub call is given FLUSH_TIMEOUT_MS. The marks are read again
 * just before each tree, so a row another flush wrote meanwhile is never
 * written again after the apply has moved it out of `pending/`.
 */

/** Most items one flush writes. The rest wait for the next minute. */
export const MAX_FLUSH_ITEMS = 200;
/** Most bytes of file text one flush writes. A single larger item still goes on its own. */
export const MAX_FLUSH_BYTES = 2 * 1024 * 1024;
/** Times a flush starts again from a branch that moved on before it gives up until the next minute. */
export const FLUSH_ATTEMPTS = 3;

/** Queued items older than this mean the flush is failing: the scheduled job logs an error on every tick until they are written. */
export const STALE_QUEUE_MS = 15 * 60 * 1000;

/** D1 allows 100 bound values in one statement. */
const MAX_BOUND = 100;
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** One file for the inbox. */
export interface QueuedFile {
  /** The feedback id, `fb_` and a ulid. */
  id: string;
  /** Its path in the inbox: `pending/<yyyy-mm-dd>/<id>.json`. */
  path: string;
  content: string;
}

/**
 * The statement that queues `file`, accepted at `nowMs`, for the same batch as
 * the decision's rows. An id already queued keeps its first file, as the
 * inbox keeps one file per id.
 */
export function queueStatement(db: D1Like, file: QueuedFile, nowMs: number): D1Statement {
  return db.prepare("INSERT OR IGNORE INTO inbox_queue (id, path, content, queued) VALUES (?, ?, ?, ?)").bind(file.id, file.path, file.content, nowMs);
}

export type FlushResult =
  /** Nothing was queued. */
  | { outcome: "empty" }
  /** `items` went into the inbox in `commit`. */
  | { outcome: "committed"; commit: string; items: number }
  /** `items` were in the inbox already, from a flush that stopped before deleting them. No commit was made. */
  | { outcome: "settled"; items: number }
  /** The branch kept moving on. The items wait for the next minute. */
  | { outcome: "conflict" }
  /** Another flush holds the lease. */
  | { outcome: "busy" }
  /** The flush ran so long its lease was nearly over, so it stopped before moving the branch. */
  | { outcome: "expired" };

/** How long a flush holds its lease. Another flush may start once it has run out. */
export const FLUSH_LEASE_MS = 5 * 60 * 1000;
/** How long one GitHub call in a flush may take. */
export const FLUSH_TIMEOUT_MS = 15 * 1000;
/** The row in `runs` that holds the flush's lease. Only `last_start` is used: the time the lease was claimed, or null when free. */
export const FLUSH = "flush";

export interface FlushDeps {
  db: D1Like;
  /** Give it a fetch with a timeout (`timedFetch`), so a stalled call can't outlive the lease. */
  github: GitHubApp;
  /** The GitHub App, limited to the inbox. */
  inbox: GitHubAppConfig;
  branch: string;
  now: () => number;
  /** Called once the items are in the inbox, for the run triggers (`recordInboxWrite`). */
  onWritten?: () => Promise<void>;
}

/** `fetch`, with each call aborted and failed after `ms`. */
export function timedFetch(fetch: Fetch, ms = FLUSH_TIMEOUT_MS): Fetch {
  return async (input, init) => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`${input} took longer than ${ms} ms`));
      }, ms);
    });
    try {
      return await Promise.race([fetch(input, { ...init, signal: controller.signal }), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Claims the flush's lease at `nowMs` when it is free or has run out. Null when another flush holds it. */
async function claimLease(db: D1Like, nowMs: number): Promise<number | null> {
  const row = await db
    .prepare(
      "INSERT INTO runs (name, last_start) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET last_start = excluded.last_start WHERE runs.last_start IS NULL OR runs.last_start <= ? RETURNING name",
    )
    .bind(FLUSH, nowMs, nowMs - FLUSH_LEASE_MS)
    .first<string>("name");
  return row === null ? null : nowMs;
}

/** Gives the lease back, unless another flush has taken it since it ran out. */
async function releaseLease(db: D1Like, claimed: number): Promise<void> {
  await db.prepare("UPDATE runs SET last_start = NULL WHERE name = ? AND last_start = ?").bind(FLUSH, claimed).run();
}

interface Row extends QueuedFile {
  commit_sha: string | null;
}

/** The oldest queued rows, within MAX_FLUSH_ITEMS and MAX_FLUSH_BYTES. */
async function oldest(db: D1Like): Promise<Row[]> {
  const { results } = await db
    .prepare("SELECT id, path, content, commit_sha FROM inbox_queue ORDER BY queued, rowid LIMIT ?")
    .bind(MAX_FLUSH_ITEMS)
    .all<Row>();
  const out: Row[] = [];
  let bytes = 0;
  for (const row of results) {
    const size = new TextEncoder().encode(row.content).length;
    if (out.length > 0 && bytes + size > MAX_FLUSH_BYTES) break;
    out.push(row);
    bytes += size;
  }
  return out;
}

async function remove(db: D1Like, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(chunks(ids, MAX_BOUND).map((part) => db.prepare(`DELETE FROM inbox_queue WHERE id IN (${marks(part.length)})`).bind(...part)));
}

async function mark(db: D1Like, ids: readonly string[], commit: string | null): Promise<void> {
  if (ids.length === 0) return;
  await db.batch(
    chunks(ids, MAX_BOUND - 1).map((part) => db.prepare(`UPDATE inbox_queue SET commit_sha = ? WHERE id IN (${marks(part.length)})`).bind(commit, ...part)),
  );
}

/**
 * Marks `ids` with `commit`, leaving any row another flush has marked since
 * (with a commit not in `own`). False when it left one, or one is gone.
 */
async function markOwn(db: D1Like, ids: readonly string[], commit: string, own: ReadonlySet<string>): Promise<boolean> {
  const mine = [...own];
  let changed = 0;
  for (const part of chunks(ids, MAX_BOUND - 1 - mine.length)) {
    const result = await db
      .prepare(`UPDATE inbox_queue SET commit_sha = ? WHERE id IN (${marks(part.length)}) AND (commit_sha IS NULL${mine.length > 0 ? ` OR commit_sha IN (${marks(mine.length)})` : ""})`)
      .bind(commit, ...part, ...mine)
      .run();
    changed += (result as { meta?: { changes?: number } }).meta?.changes ?? 0;
  }
  return changed === ids.length;
}

/** The commit each of `ids` is marked with now, for those still queued. */
async function currentMarks(db: D1Like, ids: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const part of chunks(ids, MAX_BOUND)) {
    const { results } = await db.prepare(`SELECT id, commit_sha FROM inbox_queue WHERE id IN (${marks(part.length)})`).bind(...part).all<{ id: string; commit_sha: string | null }>();
    for (const row of results) out.set(row.id, row.commit_sha);
  }
  return out;
}

/**
 * Reads the rows' marks again and settles what another flush did: rows no
 * longer queued are dropped, rows marked with a commit this flush did not
 * make (`own`) are deleted when the branch holds that commit, and unmarked to
 * be written again when it doesn't. Returns the rows left to write and how
 * many were settled.
 */
async function settle(deps: FlushDeps, rows: readonly Row[], own: ReadonlySet<string>): Promise<{ rows: Row[]; settled: number }> {
  const { db, github, inbox, branch } = deps;
  const now = await currentMarks(db, rows.map((r) => r.id));
  let left = rows.filter((r) => now.has(r.id)).map((r) => ({ ...r, commit_sha: now.get(r.id) ?? null }));
  let settled = 0;
  for (const commit of new Set(left.flatMap((r) => (r.commit_sha === null || own.has(r.commit_sha) ? [] : [r.commit_sha])))) {
    const ids = left.filter((r) => r.commit_sha === commit).map((r) => r.id);
    if (await github.isOnBranch(inbox, commit, branch)) {
      await remove(db, ids);
      settled += ids.length;
      left = left.filter((r) => r.commit_sha !== commit);
    } else {
      await mark(db, ids, null);
      left = left.map((r) => (r.commit_sha === commit ? { ...r, commit_sha: null } : r));
    }
  }
  return { rows: left, settled };
}

/**
 * Writes the oldest queued items to the inbox as one commit, as described
 * above, under the flush's lease, so two ticks never flush at once. GitHub or
 * D1 failing throws, and the items wait for the next minute.
 */
export async function flushInbox(deps: FlushDeps): Promise<FlushResult> {
  const { db } = deps;
  const claimed = await claimLease(db, deps.now());
  if (claimed === null) return { outcome: "busy" };
  try {
    return await flushHeld(deps, claimed);
  } finally {
    await releaseLease(db, claimed).catch(() => undefined);
  }
}

async function flushHeld(deps: FlushDeps, claimed: number): Promise<FlushResult> {
  const { db, github, inbox, branch } = deps;
  const first = await oldest(db);
  if (first.length === 0) return { outcome: "empty" };

  // Rows a flush committed before it stopped: delete those the branch holds, and write the rest again.
  const own = new Set<string>();
  let { rows, settled } = await settle(deps, first, own);
  for (let attempt = 0; attempt < FLUSH_ATTEMPTS && rows.length > 0; attempt++) {
    const head = await github.branchHead(inbox, branch);
    const base = await github.commitTree(inbox, head);
    // Just before the tree: a row another flush has written since is not written again.
    const now = await settle(deps, rows, own);
    rows = now.rows;
    settled += now.settled;
    if (rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    const tree = await github.createTree(inbox, base, rows.map((r) => ({ path: r.path, content: r.content })));
    if (tree === base) {
      // Every file is in the inbox with this text already.
      await remove(db, ids);
      await deps.onWritten?.();
      return { outcome: "settled", items: settled + ids.length };
    }
    const commit = await github.createCommit(inbox, rows.length === 1 ? `Add ${rows[0]!.id}` : `Add ${rows.length} items`, tree, [head]);
    // Moving the branch after the lease ran out could race a newer flush.
    if (deps.now() - claimed > FLUSH_LEASE_MS - FLUSH_TIMEOUT_MS) return { outcome: "expired" };
    // A row another flush marked since the read is settled on the next attempt, never written over.
    if (!(await markOwn(db, ids, commit, own))) {
      own.add(commit);
      continue;
    }
    own.add(commit);
    if (!(await github.updateBranch(inbox, branch, commit))) continue;
    await remove(db, ids);
    await deps.onWritten?.();
    return { outcome: "committed", commit, items: ids.length };
  }
  if (rows.length === 0) {
    await deps.onWritten?.();
    return { outcome: "settled", items: settled };
  }
  return { outcome: "conflict" };
}

/** How far behind the queue is: how many items wait, and how long the oldest has waited (null when none). */
export interface QueueBacklog {
  queued: number;
  oldest_age_ms: number | null;
}

export async function queueBacklog(db: D1Like, nowMs: number): Promise<QueueBacklog> {
  const row = await db.prepare("SELECT count(*) AS queued, min(queued) AS oldest FROM inbox_queue").first<{ queued: number; oldest: number | null }>();
  const oldest = row?.oldest ?? null;
  return { queued: row?.queued ?? 0, oldest_age_ms: oldest === null ? null : Math.max(0, nowMs - oldest) };
}
