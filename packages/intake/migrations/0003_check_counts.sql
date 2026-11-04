-- Live changes per UTC day, for the intake's daily caps. `contributor` is the
-- counted key: a contributor id (`ctr_`), a hashed client network (`org_`) or
-- an App Attest key (`ak_`). A row counts the items that passed every check that day. Rows from earlier days
-- are only kept until the intake prunes them.

CREATE TABLE live_counts (
  contributor TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (contributor, day)
);

CREATE INDEX live_counts_day ON live_counts (day);
