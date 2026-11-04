-- When the intake last wrote to the inbox, when the oldest write since the last
-- start came in, and when it last started the inbox's apply workflow, so the
-- scheduled job can start a run once the inbox has gone quiet, or once a write
-- has waited long enough. Times are milliseconds since the epoch. One row per
-- workflow, named by `name`. `first_write` is null when no write is waiting.

CREATE TABLE runs (
  name TEXT PRIMARY KEY,
  last_write INTEGER,
  first_write INTEGER,
  last_start INTEGER
);
