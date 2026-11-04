-- The place index: every released place's facts and who set each one, loaded from each data release,
-- so the intake can decide an item at send time. The release sends only the map cells that changed,
-- and place_index_cells keeps the hash of each cell as the intake holds it, and when the release loaded it
-- (an ISO 8601 UTC time), so a recent change the data already held at that load is not laid over it again.

CREATE TABLE place_index (
  id TEXT PRIMARY KEY,
  -- The whole-degree map cell: the floor of the longitude and of the latitude.
  cell_lon INTEGER NOT NULL,
  cell_lat INTEGER NOT NULL,
  -- JSON objects, as in the place record. fact_dates is {} when the record has none.
  facts TEXT NOT NULL,
  fact_sources TEXT NOT NULL,
  fact_dates TEXT NOT NULL
) WITHOUT ROWID;

-- Replacing a cell, and the bounding-box query.
CREATE INDEX place_index_cell ON place_index (cell_lon, cell_lat);

CREATE TABLE place_index_cells (
  cell_lon INTEGER NOT NULL,
  cell_lat INTEGER NOT NULL,
  hash TEXT NOT NULL,
  loaded_at TEXT NOT NULL,
  PRIMARY KEY (cell_lon, cell_lat)
) WITHOUT ROWID;
