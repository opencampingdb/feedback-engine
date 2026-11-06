import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isFeedbackId, type StoredFeedback } from "@opencampingdb/feedback";
import { DataRepo, readHistory } from "./io.js";
import type { ReviewPr } from "./owners.js";
import { placeOf, type ProgressUpdate } from "./progress-update.js";
import { inDataOnMain as changeReportOnMain } from "./recent.js";
import type { DoNotMatchEntry } from "./review.js";
import { feeIdOf, newPlaceIdOf, reviewIdOf, WINDOW_DAYS, WITHDRAWN, type Outcome } from "./rules.js";
import type { RunDecision } from "./run.js";
import { feePath, placePath, reviewPath } from "./serialise.js";
import type { Fee, Place, Review, SourceKey } from "./types.js";

export type { ProgressUpdate } from "./progress-update.js";

/**
 * Where each contribution is, sent to the intake after every run so apps can
 * ask about their own contributions (`GET /v1/feedback/progress`). Built from
 * the inbox's decisions of the last 90 days, the data's `main` branch and the
 * PRs from `feedback/review` and `feedback/auto`.
 */

/** The intake's progress store. */
export interface ProgressStore {
  /** Records each item's progress. The intake never moves an item back, so sending the same items again is safe. */
  progress(items: readonly ProgressUpdate[]): Promise<void>;
}

/** What `itemInDataOnMain` reads of the data's main branch. */
export interface MainData {
  places: ReadonlyMap<string, Place>;
  reviews: (placeId: string) => readonly Review[];
  fees: (placeId: string) => readonly Fee[];
  doNotMatch: readonly Pick<DoNotMatchEntry, "place" | "file">[];
}

/** An inbox item with the outcome the run that decided it kept on it, as `applied/` and `refused/` hold them. */
export type DecidedItem = StoredFeedback & { outcome?: { result?: Outcome; reason?: string; run?: string } };

/**
 * Whether main holds an item's change. When it does, `file` is the file in
 * the data repository the change is in, whose last commit dates it, and
 * `place` the place to name when it is not the item's own.
 */
export type OnMain = { inData: false } | { inData: true; file: string; place?: string };

/** The reason sent for a change a reviewer turned down. */
export const REVIEWER_DECLINED = "a reviewer merged or closed the review PR without this change";
/** The reason sent for an automatic change whose PR was closed without merging. */
export const AUTO_PR_CLOSED = "the automatic PR with this change was closed without merging";

/** Whether an item can change the data. Review reports, photo reports and erasures, photos and `other` reports never change a place. */
export function changesData(item: StoredFeedback): boolean {
  if (item.type === "review_report" || item.type === "photo_report" || item.type === "photo_erasure" || item.type === "photo") return false;
  return !(item.type === "report" && item.report.kind === "other");
}

/** The place key a report kind changes, for the kinds a run writes with `setSource`. */
const REPORT_KEYS: Partial<Record<string, SourceKey>> = {
  name: "name",
  description: "description",
  kind: "kind",
  wrong_location: "location",
  closed: "status",
  reopened: "status",
};

const DO_NOT_MATCH_FILE = "moderation/commons-do-not-match.json";

/**
 * Whether main holds the change an applied or reviewed item made, and the
 * file it is in. The apply stamps `fact_dates[key]` with the run's time
 * whenever it writes a change (by the rules or in a review draft), so a
 * change to key `k` is in the data when main's `fact_dates[k]` is that run's
 * time or later, whoever merged it, and still when a later change replaced
 * it. A person who took the change out of the review PR leaves no such date.
 * A place merged into another counts as in the data, as the data has moved on.
 */
export function itemInDataOnMain(item: DecidedItem, main: MainData): OnMain {
  const notInData = { inData: false } as const;
  const inDataIn = (file: string, place?: string): OnMain => ({ inData: true, file, ...(place !== undefined ? { place } : {}) });
  const run = item.outcome?.run;
  const datedByRun = (place: Place, key: SourceKey) => typeof run === "string" && (place.fact_dates?.[key] ?? "") >= run;

  if (item.type === "report" && item.report.kind === "new_place") {
    const id = newPlaceIdOf(item);
    const place = main.places.get(id);
    if (place === undefined) return notInData;
    return place.status === "merged" ? inDataIn(placePath(id), place.merged_into) : inDataIn(placePath(id));
  }
  if (typeof item.place !== "string") return notInData;
  const placeFile = placePath(item.place);
  const place = main.places.get(item.place);
  if (item.type === "withdraw" && item.outcome?.reason === WITHDRAWN.withdrawal) {
    // The run deletes a withdrawn new place's record.
    return place === undefined || place.status === "merged" ? inDataIn(placeFile) : notInData;
  }
  if (place === undefined) return notInData;
  if (place.status === "merged") return inDataIn(placeFile);
  const onPlace = (holdsChange: boolean) => (holdsChange ? inDataIn(placeFile) : notInData);

  switch (item.type) {
    case "report": {
      const kind = item.report.kind;
      if (kind === "fact" || kind === "contact" || kind === "doubt") return onPlace(changeReportOnMain(item as Parameters<typeof changeReportOnMain>[0], place));
      const key = REPORT_KEYS[kind];
      if (key !== undefined) return onPlace(datedByRun(place, key));
      if (kind === "remove") return onPlace(place.standing === "hidden");
      if (kind === "commons_mismatch") {
        return main.doNotMatch.some((p) => p.place === place.id && p.file === item.report.file) ? inDataIn(DO_NOT_MATCH_FILE) : notInData;
      }
      return notInData;
    }
    case "check":
      // A new place's standing is worked out from all its checks on every run, so a check on one counts once the place is on main.
      return onPlace((typeof run === "string" && (place.last_confirmed ?? "") >= run) || datedByRun(place, "status") || place.standing !== undefined);
    case "withdraw":
      // Withdrawn more than 24 hours after it was added: it counts as a removal report.
      return onPlace(place.standing === "hidden");
    case "fee": {
      const feeId = feeIdOf(item);
      // A later fee from the same contributor for the same site type replaces it.
      const holdsChange = main.fees(place.id).some((f) => f.id === feeId || (f.id > feeId && f.contributor === item.contributor && f.site === item.fee.site));
      return holdsChange ? inDataIn(feePath(place.id)) : notInData;
    }
    case "review": {
      const reviewId = reviewIdOf(item);
      // A later review from the same contributor replaces it.
      const holdsChange = main.reviews(place.id).some((r) => r.id === reviewId || (r.id > reviewId && r.contributor === item.contributor));
      return holdsChange ? inDataIn(reviewPath(place.id)) : notInData;
    }
    default:
      return notInData;
  }
}

/** The feedback ids named on PRs from one branch, by the PR's state. */
export interface PrMentions {
  open: ReadonlySet<string>;
  merged: ReadonlySet<string>;
  closed: ReadonlySet<string>;
}

/**
 * The feedback ids each PR names, in the body or in a comment by the bot,
 * by whether the PR is open, merged or closed without merging. Only PRs the
 * bot opened from the data repository itself count, as for owner approvals.
 */
export function idsOnPrs(prs: readonly ReviewPr[], botLogins: readonly string[]): PrMentions {
  const logins = new Set(botLogins.flatMap((l) => [l, `${l}[bot]`, `app/${l}`]));
  const out = { open: new Set<string>(), merged: new Set<string>(), closed: new Set<string>() };
  for (const pr of prs) {
    if (pr.isCrossRepository !== false || !pr.author || !logins.has(pr.author.login)) continue;
    const into = pr.state === "OPEN" ? out.open : pr.state === "MERGED" ? out.merged : out.closed;
    const texts = [pr.body, ...pr.comments.filter((c) => c.author && logins.has(c.author.login)).map((c) => c.body)];
    for (const text of texts) for (const word of text.split(/[^0-9A-Za-z_]+/)) if (isFeedbackId(word)) into.add(word);
  }
  return out;
}

/**
 * The items whose change a person turned down, when main lacks it: a held
 * item named on a merged or closed review PR, or an applied item named on a
 * closed automatic PR. An item named on an open PR from the same branch is
 * left out: a held case can be listed again on a later review PR, and then
 * that PR decides it.
 */
export function turnedDown(review: PrMentions, auto: PrMentions): { review: Set<string>; auto: Set<string> } {
  return {
    review: new Set([...review.merged, ...review.closed].filter((id) => !review.open.has(id))),
    auto: new Set([...auto.closed].filter((id) => !auto.open.has(id))),
  };
}

export interface ProgressContext {
  /** From `turnedDown`. */
  declined: { review: ReadonlySet<string>; auto: ReadonlySet<string> };
  /** When main got the change in `file`. */
  inDataAt: (file: string) => string;
}

/**
 * One item's progress from its decision. `applied` is `accepted` and
 * `needs_review` or `awaiting_approval` is `held`, until main holds the
 * change (`in_data`). A change a person turned down on its PR is `refused`
 * by the reviewer. Items that never change the data keep their decision's
 * state.
 */
export function progressOf(item: DecidedItem, main: MainData, context: ProgressContext): ProgressUpdate | undefined {
  const outcome = item.outcome;
  if (outcome?.result === undefined) return undefined;
  const place = placeOf(item) ?? undefined;
  const base = {
    id: item.id,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(place !== undefined ? { place } : {}),
    ...(outcome.run ? { decided_at: outcome.run } : {}),
  };
  return decisionProgress(base, outcome.result, () => {
    if (!changesData(item)) return undefined;
    const found = itemInDataOnMain(item, main);
    if (found.inData) return { ...base, state: "in_data", in_data_at: context.inDataAt(found.file), ...(found.place !== undefined ? { place: found.place } : {}) };
    if (outcome.result === "needs_review" && context.declined.review.has(item.id)) return { ...base, state: "refused", by: "reviewer", reason: REVIEWER_DECLINED };
    if (outcome.result === "applied" && context.declined.auto.has(item.id)) return { ...base, state: "refused", by: "reviewer", reason: AUTO_PR_CLOSED };
    return undefined;
  });
}

function decisionProgress(base: Omit<ProgressUpdate, "state">, result: Outcome, inDataOrRefused: () => ProgressUpdate | undefined): ProgressUpdate {
  if (result === "refused") return { ...base, state: "refused", by: "rules" };
  if (result === "waiting") return { ...base, state: "waiting" };
  if (result === "awaiting_approval") return { ...base, state: "held" };
  return inDataOrRefused() ?? { ...base, state: result === "applied" ? "accepted" : "held" };
}

const git = promisify(execFile);

/** The commit time of `git log -1` in `repo`, for the files given, or undefined when git can't say. */
async function commitTime(repo: string, files: readonly string[] = []): Promise<string | undefined> {
  try {
    const { stdout } = await git("git", ["-C", repo, "log", "-1", "--format=%ct", ...(files.length > 0 ? ["--", ...files] : [])]);
    const seconds = Number(stdout.trim());
    if (stdout.trim() === "" || !Number.isFinite(seconds)) return undefined;
    return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return undefined;
  }
}

/**
 * When main got each file's current content: the commit time of the last
 * commit on main that touched it, so a data release built from that commit
 * or a later one has the change. A file git has no commit for gets the time
 * of main's last commit, and without git, `fallback`.
 */
export async function lastCommitTimes(repo: string, files: Iterable<string>, fallback: string): Promise<Map<string, string>> {
  const unique = [...new Set(files)];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const head = (await commitTime(repo)) ?? fallback;
  for (const file of unique) out.set(file, (await commitTime(repo, [file])) ?? head);
  return out;
}

export interface SendProgressOptions {
  inbox: string;
  /** A checkout of the data repository's `main`, with its history, so each change is dated by its commit. */
  main: string;
  store: ProgressStore;
  /** Every item this run decided, but photos. Those it left in `pending/` (waiting) and owner submissions are sent from here. */
  decisions: readonly RunDecision[];
  /** Recent PRs from `feedback/review`, read before `main` was checked out. */
  reviewPrs?: readonly ReviewPr[];
  /** Recent PRs from `feedback/auto`, read before `main` was checked out. */
  autoPrs?: readonly ReviewPr[];
  botLogins?: readonly string[];
  /** Time of the run. Defaults to now. */
  now?: Date;
}

/** The intake takes at most this many items in one call. */
export const PROGRESS_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sends the intake every item's progress: each item decided in the last 90
 * days, from `applied/` and `refused/`, and this run's other decisions. A
 * change in the data is dated by the last commit on main that touched its
 * file. Sent in calls of up to 500. A call that fails is logged and the rest
 * are still sent, so the intake failing never fails the run. Returns how
 * many items were sent and how many were in failed calls.
 */
export async function sendProgress(options: SendProgressOptions): Promise<{ sent: number; failed: number }> {
  const now = options.now ?? new Date();
  const runAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const sinceDay = new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const history = [...(await readHistory(options.inbox, sinceDay)), ...(await readHistory(options.inbox, sinceDay, "refused"))].filter(
    (item) => item.type !== "photo",
  ) as DecidedItem[];

  const repo = new DataRepo(options.main);
  const places = await repo.places(history.map(placeOf).filter((p): p is string => p !== null));
  const reviews = new Map<string, Review[]>();
  const fees = new Map<string, Fee[]>();
  for (const item of history) {
    if (typeof item.place !== "string" || !places.has(item.place)) continue;
    if (item.type === "review" && !reviews.has(item.place)) reviews.set(item.place, await repo.reviews(item.place));
    if (item.type === "fee" && !fees.has(item.place)) fees.set(item.place, await repo.fees(item.place));
  }
  const doNotMatch = history.some((i) => i.type === "report" && i.report.kind === "commons_mismatch") ? await repo.doNotMatch() : [];
  const main: MainData = { places, reviews: (id) => reviews.get(id) ?? [], fees: (id) => fees.get(id) ?? [], doNotMatch };
  const botLogins = options.botLogins ?? [];
  const declined = turnedDown(idsOnPrs(options.reviewPrs ?? [], botLogins), idsOnPrs(options.autoPrs ?? [], botLogins));

  // Each file a change is in, dated once by its last commit on main.
  const files = history.flatMap((item) => {
    if ((item.outcome?.result !== "applied" && item.outcome?.result !== "needs_review") || !changesData(item)) return [];
    const found = itemInDataOnMain(item, main);
    return found.inData ? [found.file] : [];
  });
  const times = await lastCommitTimes(options.main, files, runAt);
  const context: ProgressContext = { declined, inDataAt: (file) => times.get(file) ?? runAt };

  const updates = new Map<string, ProgressUpdate>();
  for (const item of history) {
    const update = progressOf(item, main, context);
    if (update) updates.set(item.id, update);
  }
  for (const d of options.decisions) {
    if (updates.has(d.id)) continue;
    const base = { id: d.id, ...(d.reason ? { reason: d.reason } : {}), ...(d.place !== null ? { place: d.place } : {}), decided_at: runAt };
    updates.set(d.id, decisionProgress(base, d.outcome, () => undefined));
  }

  const all = [...updates.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  let sent = 0;
  let failed = 0;
  for (let start = 0; start < all.length; start += PROGRESS_BATCH) {
    const part = all.slice(start, start + PROGRESS_BATCH);
    try {
      await options.store.progress(part);
      sent += part.length;
    } catch (error) {
      failed += part.length;
      console.warn(`sending the progress of ${part.length} item(s) to the intake failed, trying again next run: ${String(error)}`);
    }
  }
  return { sent, failed };
}
