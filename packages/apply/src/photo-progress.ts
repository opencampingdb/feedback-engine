import type { StoredFeedback } from "@opencampingdb/feedback";
import { DataRepo, readHistory } from "./io.js";
import type { ReviewPr } from "./owners.js";
import type { PhotoProgressUpdate } from "./progress-update.js";
import {
  AUTO_PR_CLOSED,
  idsOnPrs,
  lastCommitTimes,
  mondayOf,
  readSent,
  REVIEWER_DECLINED,
  sendChanged,
  turnedDown,
  type DecidedItem,
} from "./progress.js";
import { photoIdOf, WINDOW_DAYS } from "./rules.js";
import type { RunDecision } from "./run.js";
import { photoPath } from "./serialise.js";
import type { Photo, RemovedPhotos } from "./types.js";

export type { PhotoProgressUpdate } from "./progress-update.js";

/**
 * Where each photo is, sent to the app's photo intake after every photo run
 * so apps can ask about their own photos by `pho_` id
 * (`GET /v1/photos/progress`). Built from the photo inbox's decisions of the
 * last 90 days, the photo records on the records repository's `main` and
 * the PRs from `feedback/review` and `feedback/auto`.
 */

/** The photo intake's progress store. */
export interface PhotoProgressStore {
  /** Records each photo's progress. A photo's state is where it is now, so sending the same photos again is safe. */
  photoProgress(items: readonly PhotoProgressUpdate[]): Promise<void>;
}

/** Where the photo inbox keeps the progress last sent for each photo. */
export const PHOTO_SENT_FILE = "progress/photos-sent.json";

/** The reasons sent for a photo that left the records. */
export const PHOTO_REASONS = {
  reported: "hidden after reports, until a person decides",
  hidden: "hidden by a reviewer",
  blocked: "the contributor is blocked",
  removed: "removed by a reviewer",
  erased: "removed at the contributor's request",
  takenOut: "a person took it out of the photo records",
} as const;

/** What `photoProgressOf` reads of the records repository's main. */
export interface PhotoMain {
  /** Each photo line on main, by photo id. */
  lines: ReadonlyMap<string, Photo>;
  /** `moderation/removed_photos.json`, by photo id. */
  removed: ReadonlyMap<string, RemovedPhotos["photos"][number]["reason"]>;
  /** `moderation/blocked_contributors.json`. */
  blocked: ReadonlySet<string>;
}

export interface PhotoProgressContext {
  /** Feedback ids a person turned down on their PR (`turnedDown`). */
  declined: { review: ReadonlySet<string>; auto: ReadonlySet<string> };
  /** Feedback ids on a merged automatic PR. */
  autoMerged: ReadonlySet<string>;
  /** When main got the photo lines in `file`. */
  inDataAt: (file: string) => string;
}

/**
 * One photo's progress from its decision and main. A photo on the removed
 * list is `refused` (by the rules when they refused it or the contributor
 * asked, otherwise by the reviewer). A line on main is `in_data`, or `held`
 * (`reported`) while hidden after reports, or `refused` by the reviewer when
 * a person hid it or blocked the contributor. Without a line: `held` with
 * its reason while it waits on the review PR, `accepted` while it waits on
 * the automatic PR, `waiting`, or `refused` by the rules or by a person who
 * merged or closed its PR without it.
 */
export function photoProgressOf(item: DecidedItem, main: PhotoMain, context: PhotoProgressContext): PhotoProgressUpdate | undefined {
  const result = item.outcome?.result;
  if (result === undefined || typeof item.place !== "string") return undefined;
  const id = photoIdOf(item);
  const reason = item.outcome?.reason;
  const base = { id, place: item.place, ...(item.outcome?.run ? { decided_at: item.outcome.run } : {}) };
  const refused = (by: "rules" | "reviewer", why: string | undefined): PhotoProgressUpdate => ({ ...base, state: "refused", by, ...(why ? { reason: why } : {}) });

  const removed = main.removed.get(id);
  if (removed === "erased") return refused("rules", PHOTO_REASONS.erased);
  if (removed === "refused") return refused("rules", reason);
  if (removed === "moderator") return refused("reviewer", PHOTO_REASONS.removed);

  const line = main.lines.get(id);
  if (line !== undefined) {
    if (main.blocked.has(line.contributor)) return refused("reviewer", PHOTO_REASONS.blocked);
    if (line.hidden === "moderator") return refused("reviewer", PHOTO_REASONS.hidden);
    if (line.hidden === "reported") return { ...base, state: "held", held_reason: "reported", reason: PHOTO_REASONS.reported };
    return { ...base, state: "in_data", ...(reason ? { reason } : {}), in_data_at: context.inDataAt(photoPath(line.place)), place: line.place };
  }

  const withReason = reason ? { reason } : {};
  if (result === "refused") return refused("rules", reason);
  if (result === "waiting") return { ...base, state: "waiting", ...withReason };
  if (result === "needs_review" || result === "awaiting_approval") {
    if (context.declined.review.has(item.id)) return refused("reviewer", REVIEWER_DECLINED);
    const held = item.outcome?.held_reason;
    return { ...base, state: "held", ...(held ? { held_reason: held } : {}), ...withReason };
  }
  if (context.declined.auto.has(item.id)) return refused("reviewer", AUTO_PR_CLOSED);
  if (context.autoMerged.has(item.id)) return refused("reviewer", PHOTO_REASONS.takenOut);
  return { ...base, state: "accepted", ...withReason };
}

/** What the record keeps for a photo: its state, with the held reason or who refused it. */
const signature = (u: PhotoProgressUpdate) => [u.state, u.held_reason ?? u.by].filter(Boolean).join(":");

export interface SendPhotoProgressOptions {
  inbox: string;
  /** A checkout of the records repository's `main`, with its last 14 days of history, so each photo is dated by its commit. */
  main: string;
  store: PhotoProgressStore;
  /** The photos this run decided (`photo_decisions` in the run summary). Those it left in `pending/` (waiting) are sent from here. */
  decisions: readonly RunDecision[];
  /** Recent PRs from `feedback/review`, read before `main` was checked out. */
  reviewPrs?: readonly ReviewPr[];
  /** Recent PRs from `feedback/auto`, read before `main` was checked out. */
  autoPrs?: readonly ReviewPr[];
  botLogins?: readonly string[];
  /** Time of the run. Defaults to now. */
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sends the photo intake the progress of each photo decided in the last 90
 * days, from `applied/` and `refused/`, and of this run's waiting photos,
 * when it differs from what `progress/photos-sent.json` in the inbox says
 * was last sent. Every photo is worked out on each run, since a published
 * photo can still be hidden or removed, and the first run after 00:00 UTC
 * each Monday sends every one. Reads only the inbox and the checkout of
 * main: no GitHub call. Sent in calls of up to 500. A call that fails is
 * logged, the rest are still sent and its photos are sent again next run,
 * so the intake failing never fails the run. Returns how many photos were
 * sent, how many were in failed calls, and whether the record changed (for
 * the inbox commit).
 */
export async function sendPhotoProgress(options: SendPhotoProgressOptions): Promise<{ sent: number; failed: number; recorded: boolean }> {
  const now = options.now ?? new Date();
  const runAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const sinceDay = new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const isPhoto = (item: StoredFeedback) => item.type === "photo";
  const history = [...(await readHistory(options.inbox, sinceDay)), ...(await readHistory(options.inbox, sinceDay, "refused"))].filter(isPhoto) as DecidedItem[];
  const record = await readSent<string>(options.inbox, PHOTO_SENT_FILE);
  const reconcile = (record.reconciled_at ?? "") < mondayOf(now);

  const repo = new DataRepo(options.main);
  const main: PhotoMain = {
    lines: new Map(history.length > 0 ? (await repo.allPhotos()).map((p) => [p.id, p]) : []),
    removed: new Map((await repo.removedPhotos()).map((r) => [r.photo, r.reason])),
    blocked: await repo.blocked(),
  };
  const botLogins = options.botLogins ?? [];
  const auto = idsOnPrs(options.autoPrs ?? [], botLogins);
  const declined = turnedDown(idsOnPrs(options.reviewPrs ?? [], botLogins), auto);
  const autoMerged = new Set([...auto.merged].filter((id) => !auto.open.has(id)));

  // Each photo file on main, dated once by its last commit.
  const files = history.map((item) => main.lines.get(photoIdOf(item))).flatMap((line) => (line ? [photoPath(line.place)] : []));
  const times = await lastCommitTimes(options.main, files, runAt);
  const context: PhotoProgressContext = { declined, autoMerged, inDataAt: (file) => times.get(file) ?? runAt };

  const updates = new Map<string, PhotoProgressUpdate>();
  for (const item of history) {
    const update = photoProgressOf(item, main, context);
    if (update) updates.set(update.id, update);
  }
  for (const d of options.decisions) {
    const id = photoIdOf(d);
    if (updates.has(id) || d.place === null) continue;
    const outcome = { result: d.outcome, reason: d.reason, run: runAt, ...(d.held_reason ? { held_reason: d.held_reason } : {}) };
    const decided = { id: d.id, type: "photo", place: d.place, outcome } as unknown as DecidedItem;
    const update = photoProgressOf(decided, main, context);
    if (update) updates.set(id, update);
  }

  // The record keeps only photos still in the window.
  return sendChanged({
    inbox: options.inbox,
    file: PHOTO_SENT_FILE,
    record,
    reconcile,
    runAt,
    updates: updates.values(),
    value: signature,
    keep: (id) => updates.has(id),
    send: (part) => options.store.photoProgress(part),
    what: "photo(s) to the photo intake",
  });
}
