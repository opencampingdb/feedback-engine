-- latest_release: the newest data release, as the data repository's release workflow announces it with
-- POST /v1/release after it loads the place index, served with the recent list. One row. data_version is the
-- release's <commit time>-<short sha>, published when the intake was told, layout_version the release's
-- file layout when it sends one. An older data_version never replaces a newer one.

CREATE TABLE latest_release (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  data_version TEXT NOT NULL,
  published TEXT NOT NULL,
  layout_version INTEGER
);
