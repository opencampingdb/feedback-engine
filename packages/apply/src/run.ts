import { resolve } from "node:path";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { DataRepo, moveDecided, readHistory, readPending } from "./io.js";
import { autoPrBody, reviewPrBody } from "./prbody.js";
import { applyEdit, applyRules, WINDOW_DAYS, type Decision } from "./rules.js";
import type { Place, Review } from "./types.js";

export interface RunOptions {
  inbox: string;
  /**
   * Checkout of `data` for automatic changes: the `feedback/auto` branch when
   * its PR is open, otherwise `main`. The rules read the current data here.
   */
  data: string;
  /**
   * Checkout of `data` for changes a person decides on: the `feedback/review`
   * branch when its PR is open, otherwise `main`. Defaults to `data`, which
   * puts both kinds of change in one tree (handy when running by hand).
   */
  reviewData?: string;
  /** Time of the run. Defaults to now. */
  now?: Date;
}

export interface RunSummary {
  run_at: string;
  /** Files changed in the automatic checkout. */
  auto_changed: boolean;
  /** Files changed in the review checkout, or reports for a person to read. */
  review_changed: boolean;
  inbox_changed: boolean;
  counts: Record<Decision["outcome"], number>;
  auto_files: string[];
  review_files: string[];
  /** Empty when `auto_changed` is false. */
  auto_pr_body: string;
  /** Empty when `review_changed` is false. */
  review_pr_body: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One apply run. Writes automatic changes to `data`, review edits to
 * `reviewData` and moves decided inbox files. Running it again with no new
 * inbox files writes nothing: decided items have left `pending/`, waiting
 * items decide the same way, and every write is skipped when the file already
 * holds that content.
 */
export async function run(options: RunOptions): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const runAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  // One extra day so an item received just after midnight UTC 90 days ago is still found.
  const sinceDay = new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);

  const pendingFiles = await readPending(options.inbox);
  const pending = pendingFiles.map((f) => f.item);
  const history = await readHistory(options.inbox, sinceDay);
  const auto = new DataRepo(options.data);
  const sameTree = !options.reviewData || resolve(options.reviewData) === resolve(options.data);
  const review = sameTree ? auto : new DataRepo(options.reviewData!);

  const ids = pending.map((p) => p.place).filter((p): p is string => typeof p === "string");
  const places = await auto.places(ids);
  const reviewIds = new Set(
    pending.filter((p): p is Extract<StoredFeedback, { type: "review" }> => p.type === "review").map((p) => p.place),
  );
  const reviews = new Map<string, Review[]>();
  for (const id of reviewIds) if (places.has(id)) reviews.set(id, await auto.reviews(id));

  const result = applyRules({ now: runAt, pending, history, places, reviews: (id) => reviews.get(id) ?? [] });

  const autoFiles = await auto.writePlaces(result.places.values());
  for (const [placeId, added] of result.reviews) autoFiles.push(await auto.addReviews(placeId, added));

  // Review edits, applied on top of whatever the review checkout already holds.
  const reviewFiles: string[] = [];
  const effective = new Set<string>();
  for (const edit of result.edits) {
    if (edit.kind === "note") {
      effective.add(edit.feedback);
      continue;
    }
    const placeId = edit.kind === "new_place" ? edit.record.id : edit.place;
    const current = (await review.places([placeId])).get(placeId);
    const next: Place | undefined = applyEdit(current, edit, runAt);
    if (!next) continue;
    reviewFiles.push(...(await review.writePlaces([next])));
    effective.add(edit.feedback);
  }

  const moved = await moveDecided(options.inbox, pendingFiles, result.decisions, runAt);

  const counts = { applied: 0, refused: 0, needs_review: 0, waiting: 0 };
  for (const d of result.decisions) counts[d.outcome] += 1;
  const allPlaces = new Map([...places, ...result.places]);
  const autoChanges = result.changes.filter((c) => c.automatic);
  const reviewChanges = result.changes.filter((c) => !c.automatic && c.feedback.some((f) => effective.has(f)));
  const autoChanged = autoFiles.length > 0;
  const reviewChanged = reviewFiles.length > 0 || reviewChanges.length > 0;

  return {
    run_at: runAt,
    auto_changed: autoChanged,
    review_changed: reviewChanged,
    inbox_changed: moved > 0,
    counts,
    auto_files: autoFiles,
    review_files: reviewFiles,
    auto_pr_body: autoChanged ? autoPrBody(runAt, autoChanges, result.decisions, allPlaces) : "",
    review_pr_body: reviewChanged ? reviewPrBody(runAt, reviewChanges, allPlaces) : "",
  };
}
