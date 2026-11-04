-- Live changes per contributor per UTC day, for the intake's daily cap. A row
-- counts the items that passed every check that day. Rows from earlier days
-- are only kept until the intake prunes them.

CREATE TABLE live_counts (
  contributor TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (contributor, day)
);

CREATE INDEX live_counts_day ON live_counts (day);
