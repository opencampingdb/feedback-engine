-- item_progress.run_at: the time of the photo apply run that last wrote a photo's row.
--
-- A photo's row follows the photo records repository's main, so unlike feedback it can leave in_data
-- (hidden after reports, or removed). Two photo runs can overlap, and the older one, which read main
-- earlier, can finish last. POST /v1/photos/progress carries each run's time, and the intake refuses an
-- update from a run older than the row's run_at (src/progress.ts, recordPhotoProgress). A newer run moves
-- run_at on even when it changes nothing else, without moving updated. NULL on rows no run has written:
-- feedback rows, and a photo's row from upload time.

ALTER TABLE item_progress ADD COLUMN run_at TEXT;
