-- silent_drops: how many items the intake dropped silently each UTC day, by reason (src/silent.ts). A silent
-- drop answers the sender exactly as an accepted item is answered but stores nothing, so whoever sent it
-- cannot tell which check it failed. Only the day, the reason and the count are kept: never the item, a
-- device, a network or an app. The scheduled job deletes days older than 90.

CREATE TABLE silent_drops (
  day TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, reason)
) WITHOUT ROWID;
