-- What the intake decides at send time (src/decide.ts).
--
-- recent_changes: accepted changes to released places that apps show over their release, served by
-- GET /v1/places/recent by map area. value is the fact's value as JSON, or NULL when the change takes
-- the fact down. in_data_at is set when the apply has written the change into the data, and the row is
-- deleted 7 days after that. The map cell is the place's cell in the place index when it was accepted.

CREATE TABLE recent_changes (
  feedback_id TEXT NOT NULL,
  place TEXT NOT NULL,
  fact TEXT NOT NULL,
  value TEXT,
  accepted TEXT NOT NULL,
  in_data_at TEXT,
  cell_lon INTEGER NOT NULL,
  cell_lat INTEGER NOT NULL,
  contributor TEXT NOT NULL,
  PRIMARY KEY (feedback_id, fact)
) WITHOUT ROWID;

CREATE INDEX recent_changes_cell ON recent_changes (cell_lon, cell_lat);
CREATE INDEX recent_changes_place ON recent_changes (place, fact);

-- report_evidence: the fact and contact reports the intake decided, live or held, with just what the
-- shared rules read of them, so later reports about the same place and fact are decided against them.
-- Kept for the rules' 90 days. value is the reported value as JSON (fact reports), reason the contact
-- report's reason (contact reports).

CREATE TABLE report_evidence (
  feedback_id TEXT PRIMARY KEY,
  place TEXT NOT NULL,
  fact TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'contact')),
  value TEXT,
  reason TEXT,
  received TEXT NOT NULL,
  device TEXT NOT NULL,
  origin TEXT,
  attested TEXT,
  state TEXT NOT NULL CHECK (state IN ('live', 'held'))
) WITHOUT ROWID;

CREATE INDEX report_evidence_place ON report_evidence (place, fact, received);
CREATE INDEX report_evidence_received ON report_evidence (received);

-- contributor_records: each contributor's track record for the checks. accepted counts items that went
-- live, taken_down the ones a reviewer or the apply later took down. contributor is the hashed
-- contributor id, or the hashed install standing in for one.

CREATE TABLE contributor_records (
  contributor TEXT PRIMARY KEY,
  accepted INTEGER NOT NULL DEFAULT 0,
  taken_down INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- A new place's own fields, as they are published with it: the tidied description, the fee as JSON,
-- and the contacts and address that passed the checks as a JSON object. NULL when the report had none.
ALTER TABLE new_places ADD COLUMN description TEXT;
ALTER TABLE new_places ADD COLUMN fee TEXT;
ALTER TABLE new_places ADD COLUMN contacts TEXT;
