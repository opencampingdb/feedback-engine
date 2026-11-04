-- When the intake last wrote to the inbox and last started the inbox's apply
-- workflow, so the scheduled job can start a run once the inbox has gone quiet.
-- Times are milliseconds since the epoch. One row per workflow, named by `name`.

CREATE TABLE runs (
  name TEXT PRIMARY KEY,
  last_write INTEGER,
  last_start INTEGER
);
