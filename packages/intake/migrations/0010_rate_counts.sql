-- rate_counts: the intake's daily counters (src/ratelimit.ts), per hashed device, client network, app,
-- contributor, attested key, new places, place edit, photo pass and key registration. key is the counter's
-- name with its UTC day in it, such as d:2026-11-07:<hashed device>, and day that day, for the prune.
-- Each accepted request adds one to each of its counters in the same batch that stores it. The scheduled
-- job deletes rows from before yesterday (UTC).

CREATE TABLE rate_counts (
  key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  count INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX rate_counts_day ON rate_counts (day);
