import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isFeedbackId, type PhotoHeldReason, type StoredFeedback } from "@opencampingdb/feedback";
import { DataRepo, readHistory } from "./io.js";
import type { ReviewPr } from "./owners.js";
import { placeOf, type ProgressUpdate } from "./progress-update.js";
import { inDataOnMain as changeReportOnMain } from "./recent.js";
import type { DoNotMatchEntry } from "./review.js";
import { feeIdOf, newPlaceIdOf, reviewIdOf, WINDOW_DAYS, WITHDRAWN, type Outcome } from "./rules.js";
import type { RunDecision } from "./run.js";
import { roundCoord } from "./serialise.js";
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
export type DecidedItem = StoredFeedback & { outcome?: { result?: Outcome; reason?: string; run?: string; held_reason?: PhotoHeldReason } };

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
  if (item.type === "review_report" || item.type === "photo_report" || item.type === "photo_erasure" || item.type === "photo_removal" || item.type === "photo") return false;
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
 * Whether the place on main already holds what a name, description, kind,
 * location or status report asks for. A review edit identical to what the
 * place has writes nothing and dates nothing, so its item counts by its value.
 */
function holdsReportedValue(item: Extract<DecidedItem, { type: "report" }>, place: Place): boolean {
  const report = item.report as { kind: string; value?: unknown; place_kind?: unknown };
  switch (report.kind) {
    case "name":
      return typeof report.value === "string" && place.name === report.value;
    case "description":
      return typeof report.value === "string" && (place.description ?? "") === report.value;
    case "kind":
      return typeof report.place_kind === "string" && place.kind === report.place_kind;
    case "wrong_location": {
      const at = (item as { location?: { lat: number; lon: number } }).location;
      return at !== undefined && place.location.lat === roundCoord(at.lat) && place.location.lon === roundCoord(at.lon);
    }
    case "closed":
      return place.status === "closed";
    case "reopened":
      return place.status === "open";
    default:
      return false;
  }
}

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
      if (key !== undefined) return onPlace(datedByRun(place, key) || holdsReportedValue(item, place));
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

/** The hash and commit time of `git log -1` in `repo`, for the files given, or undefined when git can't say. */
async function lastCommit(repo: string, files: readonly string[] = []): Promise<{ hash: string; at: string } | undefined> {
  try {
    const { stdout } = await git("git", ["-C", repo, "log", "-1", "--format=%H %ct", ...(files.length > 0 ? ["--", ...files] : [])]);
    const [hash, seconds] = stdout.trim().split(" ");
    if (!hash || !seconds || !Number.isFinite(Number(seconds))) return undefined;
    return { hash, at: new Date(Number(seconds) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") };
  } catch {
    return undefined;
  }
}

/** The commits a shallow checkout starts from. Git shows each as adding every file, so they say nothing about when a file changed. */
async function shallowRoots(repo: string): Promise<Set<string>> {
  try {
    const { stdout } = await git("git", ["-C", repo, "rev-parse", "--git-path", "shallow"]);
    const text = await readFile(resolve(repo, stdout.trim()), "utf8");
    return new Set(text.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * When main got each file's current content: the commit time of the last
 * commit on main that touched it, so a data release built from that commit
 * or a later one has the change. A file with no commit in the checkout's
 * history (a shallow checkout holds the last 14 days) gets the time of main's
 * last commit, and without git, `fallback`.
 */
export async function lastCommitTimes(repo: string, files: Iterable<string>, fallback: string): Promise<Map<string, string>> {
  const unique = [...new Set(files)];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const head = (await lastCommit(repo))?.at ?? fallback;
  const roots = await shallowRoots(repo);
  for (const file of unique) {
    const found = await lastCommit(repo, [file]);
    out.set(file, found === undefined || roots.has(found.hash) ? head : found.at);
  }
  return out;
}

/** Where the inbox keeps the progress last sent for each item. */
export const SENT_FILE = "progress/sent.json";

/**
 * `progress/sent.json` in the inbox: the state last sent for each item in the
 * 90-day window, and when all of them were last sent.
 */
export interface SentRecord<Value extends string = ProgressUpdate["state"]> {
  reconciled_at?: string;
  items: Record<string, Value>;
}

/** States the intake never moves an item out of, so they are not sent again. */
const FINAL_STATES: ReadonlySet<string> = new Set(["in_data", "refused"]);

/** The record of what was last sent, in `file` of the inbox. Empty when there is none. */
export async function readSent<Value extends string = ProgressUpdate["state"]>(inbox: string, file = SENT_FILE): Promise<SentRecord<Value>> {
  try {
    const parsed = JSON.parse(await readFile(join(inbox, file), "utf8")) as Partial<SentRecord<Value>>;
    return { ...(typeof parsed.reconciled_at === "string" ? { reconciled_at: parsed.reconciled_at } : {}), items: parsed.items ?? {} };
  } catch {
    return { items: {} };
  }
}

/** 00:00 UTC on the Monday of `now`'s week, ISO 8601. */
export function mondayOf(now: Date): string {
  const day = (now.getUTCDay() + 6) % 7;
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day);
  return new Date(monday).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface SendProgressOptions {
  inbox: string;
  /** A checkout of the data repository's `main`, with its last 14 days of history, so each change is dated by its commit. */
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
 * Sends the intake the progress of each item decided in the last 90 days,
 * from `applied/` and `refused/`, and of this run's other decisions, when it
 * differs from what `progress/sent.json` in the inbox says was last sent. An
 * item last sent `in_data` or `refused` is final and not worked out again.
 * The first run after 00:00 UTC each Monday sends every item. A change in
 * the data is dated by the last commit on main that touched its file. Sent
 * in calls of up to 500. A call that fails is logged, the rest are still
 * sent and its items are sent again next run, so the intake failing never
 * fails the run. Returns how many items were sent, how many were in failed
 * calls, and whether `progress/sent.json` changed (for the inbox commit).
 */
export async function sendProgress(options: SendProgressOptions): Promise<{ sent: number; failed: number; recorded: boolean }> {
  const now = options.now ?? new Date();
  const runAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const sinceDay = new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const window = [...(await readHistory(options.inbox, sinceDay)), ...(await readHistory(options.inbox, sinceDay, "refused"))].filter(
    (item) => item.type !== "photo",
  ) as DecidedItem[];
  const record = await readSent(options.inbox);
  const reconcile = (record.reconciled_at ?? "") < mondayOf(now);
  const isFinal = (id: string) => !reconcile && FINAL_STATES.has(record.items[id] ?? "");
  const history = window.filter((item) => !isFinal(item.id));

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
    if (updates.has(d.id) || isFinal(d.id)) continue;
    const base = { id: d.id, ...(d.reason ? { reason: d.reason } : {}), ...(d.place !== null ? { place: d.place } : {}), decided_at: runAt };
    updates.set(d.id, decisionProgress(base, d.outcome, () => undefined));
  }

  // The record keeps only items still in the window.
  const inWindow = new Set([...window.map((i) => i.id), ...options.decisions.map((d) => d.id)]);
  return sendChanged({
    inbox: options.inbox,
    file: SENT_FILE,
    record,
    reconcile,
    runAt,
    updates: updates.values(),
    value: (u) => u.state,
    keep: (id) => inWindow.has(id),
    send: (part) => options.store.progress(part),
    what: "item(s) to the intake",
  });
}

export interface SendChangedOptions<Update extends { id: string }, Value extends string> {
  inbox: string;
  /** The record of what was last sent, in the inbox. */
  file: string;
  record: SentRecord<Value>;
  /** Send every update, whatever the record says (the first run each Monday). */
  reconcile: boolean;
  runAt: string;
  updates: Iterable<Update>;
  /** What the record keeps for an update: an update is sent when this differs from the record's. */
  value: (update: Update) => Value;
  /** What the record holds for an id. Defaults to the record's own entry. */
  last?: (id: string) => Value | undefined;
  /** Whether the record keeps an id it holds, with the value it holds for it. */
  keep: (id: string, value: Value) => boolean;
  send: (part: readonly Update[]) => Promise<void>;
  /** What a failed call is logged as sending, such as "item(s) to the intake". */
  what: string;
}

/**
 * The send both progress runs share: sends the updates whose value differs
 * from the record's (every one when reconciling), in id order, in calls of
 * up to PROGRESS_BATCH. A call that fails is logged, the rest are still
 * sent, and its updates are sent again next run, so the intake failing never
 * fails the run. Then writes the record: what each sent update was, the
 * entries `keep` keeps, and when the last reconcile that sent everything ran.
 */
export async function sendChanged<Update extends { id: string }, Value extends string>(
  options: SendChangedOptions<Update, Value>,
): Promise<{ sent: number; failed: number; recorded: boolean }> {
  const { record, reconcile, runAt, value } = options;
  const last = options.last ?? ((id: string) => record.items[id]);
  const due = [...options.updates].filter((u) => reconcile || last(u.id) !== value(u)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const items = Object.fromEntries(Object.entries(record.items).filter(([id, v]) => options.keep(id, v))) as Record<string, Value>;
  let sent = 0;
  let failed = 0;
  for (let start = 0; start < due.length; start += PROGRESS_BATCH) {
    const part = due.slice(start, start + PROGRESS_BATCH);
    try {
      await options.send(part);
      sent += part.length;
      for (const u of part) items[u.id] = value(u);
    } catch (error) {
      failed += part.length;
      console.warn(`sending the progress of ${part.length} ${options.what} failed, trying again next run: ${String(error)}`);
    }
  }
  const next: SentRecord<Value> = {
    ...(reconcile && failed === 0 ? { reconciled_at: runAt } : record.reconciled_at !== undefined ? { reconciled_at: record.reconciled_at } : {}),
    items,
  };
  return { sent, failed, recorded: await writeSent(options.inbox, options.file, next) };
}

/** Writes the record of what was sent to `file` in the inbox, items sorted by id. Returns whether the file changed. */
export async function writeSent<Value extends string>(inbox: string, file: string, record: SentRecord<Value>): Promise<boolean> {
  const sorted = { ...record, items: Object.fromEntries(Object.entries(record.items).sort(([a], [b]) => (a < b ? -1 : 1))) };
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  const path = join(inbox, file);
  const before = await readFile(path, "utf8").catch(() => undefined);
  if (text === before) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, "utf8");
  return true;
}
