-- Doubts (src/decide.ts): a traveller says a fact on a place is wrong without giving the right value.
--
-- report_evidence takes doubts as a third kind, so later doubts and confirmations about the same place and
-- fact are decided against them. A doubt row has no value and no reason. SQLite cannot change a CHECK, so
-- the table is made again with the rows it held.

CREATE TABLE report_evidence_next (
  feedback_id TEXT PRIMARY KEY,
  place TEXT NOT NULL,
  fact TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'contact', 'doubt')),
  value TEXT,
  reason TEXT,
  received TEXT NOT NULL,
  device TEXT NOT NULL,
  origin TEXT,
  attested TEXT,
  state TEXT NOT NULL CHECK (state IN ('live', 'held'))
) WITHOUT ROWID;

INSERT INTO report_evidence_next (feedback_id, place, fact, kind, value, reason, received, device, origin, attested, state)
  SELECT feedback_id, place, fact, kind, value, reason, received, device, origin, attested, state FROM report_evidence;
DROP TABLE report_evidence;
ALTER TABLE report_evidence_next RENAME TO report_evidence;

CREATE INDEX report_evidence_place ON report_evidence (place, fact, received);
CREATE INDEX report_evidence_received ON report_evidence (received);

-- doubt_cases: a fact doubts took down at send time, one row for each place and fact. value is the value
-- the place had, as JSON, taken_down_at when the doubt that took it down was received, and feedback_id that
-- doubt. A later fact report of the value restores the fact once two new sources confirm it, and a report of
-- another value replaces it: either closes the case, with the closing item in closed_by and the time in
-- closed_at. A case only counts while the place lacks the fact, so one whose takedown the apply overruled does
-- nothing. The scheduled job deletes a case 90 days after the takedown, when the doubts behind it no longer
-- count.

CREATE TABLE doubt_cases (
  place TEXT NOT NULL,
  fact TEXT NOT NULL,
  value TEXT NOT NULL,
  taken_down_at TEXT NOT NULL,
  feedback_id TEXT NOT NULL,
  closed_by TEXT,
  closed_at TEXT,
  PRIMARY KEY (place, fact)
) WITHOUT ROWID;

CREATE INDEX doubt_cases_taken_down ON doubt_cases (taken_down_at);
