-- The free texts the repeated text check (src/repeated.ts) put in Vectorize, by vector id (the feedback id),
-- with the time they were sent in milliseconds. Vectorize has no expiry of its own, so the scheduled job
-- deletes the vectors older than 30 days by these ids, then their rows. No text is kept here.

CREATE TABLE text_vectors (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

CREATE INDEX text_vectors_at ON text_vectors (at);
