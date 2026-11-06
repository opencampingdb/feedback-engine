-- item_progress: where each contribution is, served by GET /v1/feedback/progress (src/progress.ts).
--
-- The intake writes a row in the same batch that queues an accepted feedback item: state received, or live
-- when the send-time decision put it live, with held_reason when that decision held it. The apply run sends
-- every item's later state with POST /v1/feedback/progress: waiting, accepted, held, refused or in_data.
-- in_data is final, and refused is final unless the change later reaches the data. refused_by says who
-- refused it (rules or reviewer). in_data_at is the first time the apply saw the change in the data, and is
-- kept once set. Never the traveller's words, a device or a contributor. updated is when the row last
-- changed; the scheduled job deletes rows 90 days after that.

CREATE TABLE item_progress (
  feedback_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('received', 'live', 'waiting', 'accepted', 'held', 'refused', 'in_data')),
  reason TEXT,
  held_reason TEXT,
  refused_by TEXT CHECK (refused_by IN ('rules', 'reviewer')),
  place TEXT,
  received TEXT NOT NULL,
  decided_at TEXT,
  in_data_at TEXT,
  updated TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX item_progress_updated ON item_progress (updated);
