-- ai_spend: what the AI reviewer's second model (src/second-review.ts) cost in each calendar month (UTC),
-- `YYYY-MM`, metered from the token usage each answer reports. `nano_usd` is billionths of a US dollar.
-- A month with no row has spent nothing, so a new month starts under the cap.

CREATE TABLE ai_spend (
  month TEXT PRIMARY KEY,
  nano_usd INTEGER NOT NULL
) WITHOUT ROWID;
