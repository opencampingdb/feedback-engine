import type { RefusedBy, StoredFeedback } from "@opencampingdb/feedback";
import { DataRepo, readHistory } from "./io.js";
import type { ReviewPr } from "./owners.js";
import { inDataOnMain as changeReportOnMain } from "./recent.js";
import { newPlaceIdOf, WINDOW_DAYS, WITHDRAWN, type Outcome } from "./rules.js";
import type { DoNotMatchEntry } from "./review.js";
import type { Fee, Place, Review, SourceKey } from "./types.js";

/**
 * Where each contribution is, sent to the intake after every run so apps can
 * ask about their own contributions (`GET /v1/feedback/progress`). Built from
 * the inbox's decisions of the last 90 days and the data's `main` branch.
 */

/** One item of the intake's `POST /v1/feedback/progress`. */
export interface ProgressUpdate {
  id: string;
  state: "waiting" | "accepted" | "held" | "refused" | "in_data";
  /** The engine's own words for the decision. Never a traveller's. */
  reason?: string;
  /** Only on `refused`. */
  by?: RefusedBy;
  place?: string;
  /** The run that decided it. */
  decided_at?: string;
  /** Only on `in_data`: this run's time. The intake keeps the first it is sent. */
  in_data_at?: string;
}

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

/** An inbox item with the outcome the run that decided it kept on it. */
type Decided = StoredFeedback & { outcome?: { result?: Outcome; reason?: string; run?: string } };

/** The reason sent for a change a reviewer turned down. */
export const REVIEWER_DECLINED = "a reviewer merged or closed the review PR without this change";

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

/**
 * Whether main holds the change an applied or reviewed item made, and the
 * place to name for it. The apply stamps `fact_dates[key]` with the run's
 * time whenever it writes a change (by the rules or in a review draft), so a
 * change to key `k` is in the data when main's `fact_dates[k]` is that run's
 * time or later, whoever merged it, and still when a later change replaced
 * it. A person who took the change out of the review PR leaves no such date.
 * A place merged into another counts as in the data, as the data has moved on.
 */
export function itemInDataOnMain(item: Decided, main: MainData): { inData: false } | { inData: true; place?: string } {
  const no = { inData: false } as const;
  const yes = (place?: string) => ({ inData: true as const, ...(place !== undefined ? { place } : {}) });
  const run = item.outcome?.run;
  const dated = (place: Place, key: SourceKey) => typeof run === "string" && (place.fact_dates?.[key] ?? "") >= run;

  if (item.type === "report" && item.report.kind === "new_place") {
    const place = main.places.get(newPlaceIdOf(item));
    if (place === undefined) return no;
    return place.status === "merged" ? yes(place.merged_into) : yes();
  }
  const place = typeof item.place === "string" ? main.places.get(item.place) : undefined;
  if (item.type === "withdraw" && item.outcome?.reason === WITHDRAWN.withdrawal) {
    // The run deletes a withdrawn new place's record.
    return place === undefined || place.status === "merged" ? yes() : no;
  }
  if (place === undefined) return no;
  if (place.status === "merged") return yes();

  switch (item.type) {
    case "report": {
      const kind = item.report.kind;
      if (kind === "fact" || kind === "contact" || kind === "doubt") {
        return changeReportOnMain(item as Parameters<typeof changeReportOnMain>[0], place) ? yes() : no;
      }
      const key = REPORT_KEYS[kind];
      if (key !== undefined) return dated(place, key) ? yes() : no;
      if (kind === "remove") return place.standing === "hidden" ? yes() : no;
      if (kind === "commons_mismatch") return main.doNotMatch.some((p) => p.place === place.id && p.file === item.report.file) ? yes() : no;
      return no;
    }
    case "check":
      // A new place's standing is worked out from all its checks on every run, so a check on one counts once the place is on main.
      return (typeof run === "string" && (place.last_confirmed ?? "") >= run) || dated(place, "status") || place.standing !== undefined ? yes() : no;
    case "withdraw":
      // Withdrawn more than 24 hours after it was added: it counts as a removal report.
      return place.standing === "hidden" ? yes() : no;
    case "fee": {
      const feeId = `fee_${item.id.replace(/^fb_/, "")}`;
      // A later fee from the same contributor for the same site type replaces it.
      const lines = main.fees(place.id);
      return lines.some((f) => f.id === feeId || (f.id > feeId && f.contributor === item.contributor && f.site === item.fee.site)) ? yes() : no;
    }
    case "review": {
      const reviewId = `rev_${item.id.replace(/^fb_/, "")}`;
      // A later review from the same contributor replaces it.
      const lines = main.reviews(place.id);
      return lines.some((r) => r.id === reviewId || (r.id > reviewId && r.contributor === item.contributor)) ? yes() : no;
    }
    default:
      return no;
  }
}

const FEEDBACK_ID = /fb_[0-9A-HJKMNP-TV-Z]{26}/g;

/**
 * The feedback ids named in review PRs that were merged or closed: in the
 * body, or in a comment by the bot. Only PRs the bot opened from the data
 * repository itself count, as for owner approvals.
 */
export function idsOnDecidedReviewPrs(prs: readonly ReviewPr[], botLogins: readonly string[]): Set<string> {
  const logins = new Set(botLogins.flatMap((l) => [l, `${l}[bot]`, `app/${l}`]));
  const ids = new Set<string>();
  for (const pr of prs) {
    if (pr.state === "OPEN" || pr.isCrossRepository !== false || !pr.author || !logins.has(pr.author.login)) continue;
    const texts = [pr.body, ...pr.comments.filter((c) => c.author && logins.has(c.author.login)).map((c) => c.body)];
    for (const text of texts) for (const m of text.matchAll(FEEDBACK_ID)) ids.add(m[0]);
  }
  return ids;
}

/**
 * One item's progress from its decision. `applied` is `accepted` and
 * `needs_review` or `awaiting_approval` is `held`, until main holds the
 * change (`in_data`). A held change whose review PR was merged or closed
 * without it is `refused` by the reviewer. Items that never change the data
 * keep their decision's state.
 */
export function progressOf(
  item: Decided,
  main: MainData,
  context: { declined: ReadonlySet<string>; runAt: string },
): ProgressUpdate | undefined {
  const outcome = item.outcome;
  if (outcome?.result === undefined) return undefined;
  const place = item.type === "report" && item.report.kind === "new_place" ? newPlaceIdOf(item) : (item.place ?? undefined);
  const base = {
    id: item.id,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(place !== undefined ? { place } : {}),
    ...(outcome.run ? { decided_at: outcome.run } : {}),
  };
  return decisionProgress(base, outcome.result, () => {
    if (!changesData(item)) return undefined;
    const found = itemInDataOnMain(item, main);
    if (found.inData) return { ...base, state: "in_data", in_data_at: context.runAt, ...(found.place !== undefined ? { place: found.place } : {}) };
    if (outcome.result === "needs_review" && context.declined.has(item.id)) return { ...base, state: "refused", by: "reviewer", reason: REVIEWER_DECLINED };
    return undefined;
  });
}

function decisionProgress(
  base: Omit<ProgressUpdate, "state">,
  result: Outcome,
  later: () => ProgressUpdate | undefined,
): ProgressUpdate {
  if (result === "refused") return { ...base, state: "refused", by: "rules" };
  if (result === "waiting") return { ...base, state: "waiting" };
  if (result === "awaiting_approval") return { ...base, state: "held" };
  return later() ?? { ...base, state: result === "applied" ? "accepted" : "held" };
}

/** An item this run decided, as the run summary lists it. */
export interface RunDecision {
  id: string;
  place: string | null;
  outcome: Outcome;
  reason: string;
}

export interface SendProgressOptions {
  inbox: string;
  /** A checkout of the data repository's `main`. */
  main: string;
  store: ProgressStore;
  /** Every item this run decided, but photos. Those it left in `pending/` (waiting) and owner submissions are sent from here. */
  decisions: readonly RunDecision[];
  /** Recent PRs from `feedback/review`, read before `main` was checked out. */
  reviewPrs?: readonly ReviewPr[];
  botLogins?: readonly string[];
  /** Time of the run. Defaults to now. */
  now?: Date;
}

/** The intake takes at most this many items in one call. */
export const PROGRESS_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Sends the intake every item's progress: each item decided in the last 90
 * days, from `applied/` and `refused/`, and this run's other decisions. Sent
 * in calls of up to 500. A call that fails is logged and the rest are still
 * sent, so the intake failing never fails the run. Returns how many items
 * were sent and how many were in failed calls.
 */
export async function sendProgress(options: SendProgressOptions): Promise<{ sent: number; failed: number }> {
  const now = options.now ?? new Date();
  const runAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const sinceDay = new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const history = [...(await readHistory(options.inbox, sinceDay)), ...(await readHistory(options.inbox, sinceDay, "refused"))].filter(
    (item) => item.type !== "photo",
  ) as Decided[];

  const repo = new DataRepo(options.main);
  const placeIds = new Set<string>();
  for (const item of history) {
    if (item.type === "report" && item.report.kind === "new_place") placeIds.add(newPlaceIdOf(item));
    else if (typeof item.place === "string") placeIds.add(item.place);
  }
  const places = await repo.places(placeIds);
  const reviews = new Map<string, Review[]>();
  const fees = new Map<string, Fee[]>();
  for (const item of history) {
    if (typeof item.place !== "string" || !places.has(item.place)) continue;
    if (item.type === "review" && !reviews.has(item.place)) reviews.set(item.place, await repo.reviews(item.place));
    if (item.type === "fee" && !fees.has(item.place)) fees.set(item.place, await repo.fees(item.place));
  }
  const doNotMatch = history.some((i) => i.type === "report" && i.report.kind === "commons_mismatch") ? await repo.doNotMatch() : [];
  const main: MainData = { places, reviews: (id) => reviews.get(id) ?? [], fees: (id) => fees.get(id) ?? [], doNotMatch };
  const declined = idsOnDecidedReviewPrs(options.reviewPrs ?? [], options.botLogins ?? []);

  const updates = new Map<string, ProgressUpdate>();
  for (const item of history) {
    const update = progressOf(item, main, { declined, runAt });
    if (update) updates.set(item.id, update);
  }
  for (const d of options.decisions) {
    if (updates.has(d.id)) continue;
    updates.set(
      d.id,
      decisionProgress({ id: d.id, ...(d.reason ? { reason: d.reason } : {}), ...(d.place !== null ? { place: d.place } : {}), decided_at: runAt }, d.outcome, () => undefined),
    );
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
