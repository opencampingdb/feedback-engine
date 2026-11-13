-- review_failures: how many runs of the AI reviewer (src/reviewer.ts) the model call failed for each held
-- case, by the case's review-decision key. A case that reaches MAX_MODEL_FAILURES is left to a person and the
-- run goes on to the next case. A row goes when the case's decision is recorded, or 14 days after its last
-- failure. `failed` is milliseconds since the epoch.

CREATE TABLE review_failures (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  failed INTEGER NOT NULL
) WITHOUT ROWID;
