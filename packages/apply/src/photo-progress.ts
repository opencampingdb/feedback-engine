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
  /** The time of this run, sent with every update (`run_at`). */
  runAt: string;
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
  const base = { id, place: item.place, ...(item.outcome?.run ? { decided_at: item.outcome.run } : {}), run_at: context.runAt };
  const refused = (by: "rules" | "reviewer", why: string | undefined): PhotoProgressUpdate => ({ ...base, state: "refused", by, ...(why ? { reason: why } : {}) });
  const onMain = photoOnMain(id, main, context, base, reason);
  if (onMain) return onMain;

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

/**
 * Where main has a photo: `refused` on the removed list (by the rules when
 * they refused it or the contributor asked, otherwise by the reviewer), and
 * for a line, `refused` by the reviewer when a person hid it or blocked the
 * contributor, `held` (`reported`) while hidden after reports, or
 * `in_data`. Undefined when main names it nowhere. `reason` is the
 * decision's, when the photo has one in the window.
 */
function photoOnMain(
  id: string,
  main: PhotoMain,
  context: PhotoProgressContext,
  base: Omit<PhotoProgressUpdate, "state">,
  reason: string | undefined,
): PhotoProgressUpdate | undefined {
  const refused = (by: "rules" | "reviewer", why: string | undefined): PhotoProgressUpdate => ({ ...base, state: "refused", by, ...(why ? { reason: why } : {}) });
  const removed = main.removed.get(id);
  if (removed === "erased") return refused("rules", PHOTO_REASONS.erased);
  if (removed === "refused") return refused("rules", reason);
  if (removed === "moderator") return refused("reviewer", PHOTO_REASONS.removed);

  const line = main.lines.get(id);
  if (line === undefined) return undefined;
  const at = { ...base, place: line.place };
  if (main.blocked.has(line.contributor)) return { ...at, state: "refused", by: "reviewer", reason: PHOTO_REASONS.blocked };
  if (line.hidden === "moderator") return { ...at, state: "refused", by: "reviewer", reason: PHOTO_REASONS.hidden };
  if (line.hidden === "reported") return { ...at, state: "held", held_reason: "reported", reason: PHOTO_REASONS.reported };
  return { ...at, state: "in_data", ...(reason ? { reason } : {}), in_data_at: context.inDataAt(photoPath(line.place)) };
}

/** Where main keeps the photos taken out of the records, which dates a removal. */
export const REMOVED_PHOTOS_FILE = "moderation/removed_photos.json";
/** Where main keeps the blocked contributors, which dates a block. */
export const BLOCKED_FILE = "moderation/blocked_contributors.json";

/**
 * A photo report's or erasure's progress, by its feedback id, from its
 * decision and main. The rules hold a report for a person and accept an
 * erasure. A report is `in_data` once main no longer shows the photo
 * (hidden, removed, or its contributor blocked), and `refused` by the
 * reviewer when a person merged or closed the review PR and kept it. An
 * erasure is `in_data` once main holds no photo line from the contributor,
 * and `refused` by the reviewer when its automatic PR closed without
 * merging. `in_data_at` is the commit time of the file that took the photo
 * out: its photo file, the removed list or the block list.
 */
export function photoFeedbackProgressOf(item: DecidedItem, main: PhotoMain, context: PhotoProgressContext): PhotoProgressUpdate | undefined {
  const result = item.outcome?.result;
  if (result === undefined || (item.type !== "photo_report" && item.type !== "photo_erasure")) return undefined;
  const reason = item.outcome?.reason;
  const base = {
    id: item.id,
    ...(typeof item.place === "string" ? { place: item.place } : {}),
    ...(reason ? { reason } : {}),
    ...(item.outcome?.run ? { decided_at: item.outcome.run } : {}),
    run_at: context.runAt,
  };
  if (result === "refused") return { ...base, state: "refused", by: "rules" };
  if (result === "waiting") return { ...base, state: "waiting" };
  const inData = (file: string): PhotoProgressUpdate => ({ ...base, state: "in_data", in_data_at: context.inDataAt(file) });

  if (item.type === "photo_report") {
    const photo = item.photo_report.photo;
    const line = main.lines.get(photo);
    if (main.removed.has(photo)) return inData(REMOVED_PHOTOS_FILE);
    if (line?.hidden !== undefined) return inData(photoPath(line.place));
    if (line !== undefined && main.blocked.has(line.contributor)) return inData(BLOCKED_FILE);
    if (context.declined.review.has(item.id)) return { ...base, state: "refused", by: "reviewer", reason: REVIEWER_DECLINED };
    return { ...base, state: result === "applied" ? "accepted" : "held" };
  }
  const contributor = item.contributor;
  const left = [...main.lines.values()].some((line) => line.contributor === contributor);
  if (!left) return inData(REMOVED_PHOTOS_FILE);
  if (context.declined.auto.has(item.id)) return { ...base, state: "refused", by: "reviewer", reason: AUTO_PR_CLOSED };
  return { ...base, state: result === "applied" ? "accepted" : "held" };
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
  const isPhotoItem = (item: StoredFeedback) => item.type === "photo" || item.type === "photo_report" || item.type === "photo_erasure";
  const history = [...(await readHistory(options.inbox, sinceDay)), ...(await readHistory(options.inbox, sinceDay, "refused"))].filter(isPhotoItem) as DecidedItem[];
  const record = await readSent<string>(options.inbox, PHOTO_SENT_FILE);
  const reconcile = (record.reconciled_at ?? "") < mondayOf(now);

  const repo = new DataRepo(options.main);
  const main: PhotoMain = {
    lines: new Map((await repo.allPhotos()).map((p) => [p.id, p])),
    removed: new Map((await repo.removedPhotos()).map((r) => [r.photo, r.reason])),
    blocked: await repo.blocked(),
  };
  const botLogins = options.botLogins ?? [];
  const auto = idsOnPrs(options.autoPrs ?? [], botLogins);
  const declined = turnedDown(idsOnPrs(options.reviewPrs ?? [], botLogins), auto);
  const autoMerged = new Set([...auto.merged].filter((id) => !auto.open.has(id)));

  // in_data_at names its file until the updates due are known, then each file is dated once by its last commit.
  const context: PhotoProgressContext = { declined, autoMerged, inDataAt: (file) => `${UNDATED}${file}`, runAt };

  const updates = new Map<string, PhotoProgressUpdate>();
  for (const item of history) {
    const update = item.type === "photo" ? photoProgressOf(item, main, context) : photoFeedbackProgressOf(item, main, context);
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

  // Photos decided before the window that main still names are followed only for changes: once they
  // leave the data, and when they come back to it. A photo with no record stayed in the data.
  const inWindow = new Set(updates.keys());
  for (const id of new Set([...main.lines.keys(), ...main.removed.keys()])) {
    if (inWindow.has(id)) continue;
    const update = photoOnMain(id, main, context, { id, run_at: runAt }, undefined);
    const last = record.items[id] ?? "in_data";
    if (update && (signature(update) !== "in_data" || last !== "in_data")) updates.set(id, update);
  }
  // The Monday run sends the window's photos again, and the older ones only when they change.
  const due = [...updates.values()].filter((u) => (reconcile && inWindow.has(u.id)) || (record.items[u.id] ?? (inWindow.has(u.id) ? undefined : "in_data")) !== signature(u));
  const undated = due.flatMap((u) => (u.in_data_at?.startsWith(UNDATED) ? [u.in_data_at.slice(UNDATED.length)] : []));
  const times = await lastCommitTimes(options.main, undated, runAt);
  for (const u of due) if (u.in_data_at?.startsWith(UNDATED)) u.in_data_at = times.get(u.in_data_at.slice(UNDATED.length)) ?? runAt;

  // The record keeps the window's items, and the older photos not in the data.
  return sendChanged({
    inbox: options.inbox,
    file: PHOTO_SENT_FILE,
    record,
    reconcile,
    runAt,
    updates: due,
    value: signature,
    keep: (id) => updates.has(id),
    send: (part) => options.store.photoProgress(part),
    what: "photo(s) to the photo intake",
  });
}

/** Marks an in_data_at not dated yet, followed by the file that will date it. */
const UNDATED = "\u0000";
