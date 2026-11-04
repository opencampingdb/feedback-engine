import type { GitHubApp, GitHubAppConfig } from "./github.js";
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
  | { outcome: "conflict" };

export interface FlushDeps {
  db: D1Like;
  github: GitHubApp;
  /** The GitHub App, limited to the inbox. */
  inbox: GitHubAppConfig;
  branch: string;
  /** Called once the items are in the inbox, for the run triggers (`recordInboxWrite`). */
  onWritten?: () => Promise<void>;
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
  await db.batch(
    chunks(ids, MAX_BOUND - 1).map((part) => db.prepare(`UPDATE inbox_queue SET commit_sha = ? WHERE id IN (${marks(part.length)})`).bind(commit, ...part)),
  );
}

/**
 * Writes the oldest queued items to the inbox as one commit, as described
 * above. GitHub or D1 failing throws, and the items wait for the next minute.
 */
export async function flushInbox(deps: FlushDeps): Promise<FlushResult> {
  const { db, github, inbox, branch } = deps;
  let rows = await oldest(db);
  if (rows.length === 0) return { outcome: "empty" };

  // Rows a flush committed before it stopped: delete those the branch holds, and write the rest again.
  let settled = 0;
  for (const commit of new Set(rows.flatMap((r) => (r.commit_sha === null ? [] : [r.commit_sha])))) {
    const ids = rows.filter((r) => r.commit_sha === commit).map((r) => r.id);
    if (await github.isOnBranch(inbox, commit, branch)) {
      await remove(db, ids);
      settled += ids.length;
      rows = rows.filter((r) => r.commit_sha !== commit);
    } else {
      await mark(db, ids, null);
    }
  }
  if (rows.length === 0) {
    await deps.onWritten?.();
    return { outcome: "settled", items: settled };
  }

  const ids = rows.map((r) => r.id);
  const files = rows.map((r) => ({ path: r.path, content: r.content }));
  const message = rows.length === 1 ? `Add ${rows[0]!.id}` : `Add ${rows.length} items`;
  for (let attempt = 0; attempt < FLUSH_ATTEMPTS; attempt++) {
    const head = await github.branchHead(inbox, branch);
    const base = await github.commitTree(inbox, head);
    const tree = await github.createTree(inbox, base, files);
    if (tree === base) {
      // Every file is in the inbox with this text already.
      await remove(db, ids);
      await deps.onWritten?.();
      return { outcome: "settled", items: settled + ids.length };
    }
    const commit = await github.createCommit(inbox, message, tree, [head]);
    await mark(db, ids, commit);
    if (!(await github.updateBranch(inbox, branch, commit))) continue;
    await remove(db, ids);
    await deps.onWritten?.();
    return { outcome: "committed", commit, items: ids.length };
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
