-- Stored items waiting for the scheduled job to write them to the inbox, many to one commit
-- (src/inbox-queue.ts). path is the item's file in the inbox (pending/<day>/<id>.json) and content its
-- text. queued is when it was accepted, in milliseconds since the epoch. commit_sha is the commit a flush
-- made with it, set just before the flush moves the branch, so a flush that stopped before deleting the
-- row can tell whether the item already reached the inbox. Rows are deleted once the commit is on the branch.

CREATE TABLE inbox_queue (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  queued INTEGER NOT NULL,
  commit_sha TEXT
);
