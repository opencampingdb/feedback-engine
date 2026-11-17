-- Frozen places (src/decide.ts): conflicting values for one fact from three or more sources within 24 hours
-- freeze the place, so no fact on it changes until a reviewer decides.
--
-- One row a place. fact is the disputed fact and frozen_at when the freeze started. The intake writes a row
-- when it finds a dispute at send time, and the apply run sends the freezes it keeps in the inbox, with
-- lifted_at once the reviewer's value for the fact is in the data. A row with lifted_at NULL holds every fact
-- report, doubt, clear and contact report about the place as `disputed`. The scheduled job deletes a row 90
-- days after the freeze, when the inbox no longer keeps it.

CREATE TABLE frozen_places (
  place TEXT PRIMARY KEY,
  fact TEXT NOT NULL,
  frozen_at TEXT NOT NULL,
  lifted_at TEXT
) WITHOUT ROWID;

CREATE INDEX frozen_places_frozen ON frozen_places (frozen_at);
