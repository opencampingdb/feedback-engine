-- trusted_contributors: signed-in contributors the apply run trusts from their track record (five of their
-- edits confirmed by other sources, and no upheld doubt about any of them since). The apply sends the whole
-- list after each run (POST /v1/places/recent/trust), which replaces this table. A trusted contributor's new
-- place is listed at once, without attestation. Only hashed contributor ids are kept.

CREATE TABLE trusted_contributors (
  contributor TEXT PRIMARY KEY
);
