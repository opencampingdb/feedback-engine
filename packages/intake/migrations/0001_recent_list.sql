-- The recent list: new places, the evidence on them, and the block list the apply run sends.
-- Standing is never stored. The intake works it out from these rows each time the list is read.

CREATE TABLE new_places (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  kind TEXT,
  name TEXT,
  added TEXT NOT NULL,
  contributor TEXT NOT NULL,
  device TEXT NOT NULL,
  attest_key TEXT
);

-- The bounding-box query.
CREATE INDEX new_places_location ON new_places (lat, lon);

-- One row per feedback item, so the same item sent twice counts once.
CREATE TABLE evidence (
  feedback_id TEXT PRIMARY KEY,
  place_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('check', 'removal_report', 'withdraw')),
  data TEXT NOT NULL
);

CREATE INDEX evidence_place ON evidence (place_id);

CREATE TABLE blocked_contributors (
  contributor TEXT PRIMARY KEY
);
