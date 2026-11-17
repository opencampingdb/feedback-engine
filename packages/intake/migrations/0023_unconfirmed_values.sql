-- Unconfirmed values (src/decide.ts): fact reports without attestation that the intake held waiting for a
-- second source, and that would change the place's value. GET /v1/places/recent serves them as `unconfirmed_values`,
-- by place, fact and value, so apps can ask travellers to confirm them.
--
-- One row a held report. value is the reported value as JSON. source is the report's hashed client network,
-- or its hashed device without one, and is only counted, never listed. contributor is the hashed contributor
-- id, so a blocked contributor's reports are left out. The map cell is the place's cell in the place index when
-- the report was held. A row is deleted when the value goes live, when the apply puts the report into the
-- data or refuses it, and 90 days after it was received, when the rules no longer count it.

CREATE TABLE unconfirmed_values (
  feedback_id TEXT PRIMARY KEY,
  place TEXT NOT NULL,
  fact TEXT NOT NULL,
  value TEXT NOT NULL,
  received TEXT NOT NULL,
  source TEXT NOT NULL,
  contributor TEXT NOT NULL,
  cell_lon INTEGER NOT NULL,
  cell_lat INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX unconfirmed_values_cell ON unconfirmed_values (cell_lon, cell_lat);
CREATE INDEX unconfirmed_values_place ON unconfirmed_values (place, fact);
CREATE INDEX unconfirmed_values_received ON unconfirmed_values (received);
