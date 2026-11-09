-- request_keys: the idempotency key each app's SDK sends with a request (src/idempotency.ts), with what
-- the intake answered. A request that comes again with the same key, for example after its answer was lost
-- on a weak signal, gets the same answer and stores nothing new. Written in the same batch that stores the
-- item, so an item is stored exactly when its key is. The scheduled job deletes keys older than 31 days.

CREATE TABLE request_keys (
  app TEXT NOT NULL,
  key TEXT NOT NULL,
  answer TEXT NOT NULL,
  created TEXT NOT NULL,
  PRIMARY KEY (app, key)
) WITHOUT ROWID;

CREATE INDEX request_keys_created ON request_keys (created);
