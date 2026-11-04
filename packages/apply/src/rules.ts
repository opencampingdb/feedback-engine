import {
  isFactName,
  firstProblem,
  isValidFactValue,
  newPlaceStanding,
  tidyText,
  safeSearchVerdict,
  type FactName,
  type FactValue,
  type NewPlaceContacts,
  type StoredFeedback,
} from "@opencampingdb/feedback";
import { moderateReview } from "./moderation.js";
import { roundCoord } from "./serialise.js";
import { setSource } from "./sources.js";
import type { Fee, Photo, Place, RemovedPhotos, Review, Source, SourceKey } from "./types.js";

/**
 * The apply-feedback rules from SPEC "Apply feedback", as pure functions.
 *
 * Each pending item gets one decision:
 * - applied: accepted. The item moves to `applied/`.
 * - refused: the item moves to `refused/` with the reason.
 * - needs_review: a person decides on the data PR. The item moves to `applied/`.
 * - waiting: not enough agreement yet. The item stays in `pending/` and is
 *   looked at again next run, until 90 days after it arrived.
 *
 * `history` holds items applied in earlier runs within the last 90 days. They
 * never get a new decision, but count as evidence for closures and reopenings.
 */

export const WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;

/** Facts a person must check: a single report proposes the change on the PR. */
export const REVIEWED_FACTS: ReadonlySet<FactName> = new Set<FactName>([
  "website",
  "phone",
  "phone_2",
  "email",
  "facebook",
  "instagram",
  "tiktok",
  "x",
  "address",
]);

/** Kind given to a draft record for a `new_place` report until a person sets it. */
export const DRAFT_KIND = "campground";
const DRAFT_GROUP = "overnight";

/**
 * Follows a merged id to the record it was merged into (a person may merge a
 * record whose target was itself merged later). Returns undefined when the id
 * is not in `places`, the chain is broken or it loops. Never returns a tombstone.
 */
/** The id a new place gets from its `new_place` report: `ocdb_` and the report's ulid, as the SDK's `newPlaceId` makes it. */
export const newPlaceIdOf = (item: { id: string }) => `ocdb_${item.id.replace(/^fb_/, "")}`;

/** Decision reasons the recent places store is settled by. */
export const WITHDRAWN = { place: "the person who added it withdrew it", withdrawal: "new place withdrawn" } as const;

export function resolvePlace(id: string | null, places: ReadonlyMap<string, Place>): string | undefined {
  let current = id ?? undefined;
  for (let hops = 0; current !== undefined && hops < 10; hops++) {
    const record = places.get(current);
    if (!record) return undefined;
    if (record.status !== "merged") return current;
    current = record.merged_into;
  }
  return undefined;
}

export type Outcome = "applied" | "refused" | "needs_review" | "waiting" | "awaiting_approval";

export interface Decision {
  id: string;
  place: string | null;
  outcome: Outcome;
  reason: string;
}

export interface Change {
  place: string;
  summary: string;
  /** False when a person has to check the change before merging. */
  automatic: boolean;
  feedback: string[];
}

export interface RulesInput {
  /** Time of this run, ISO 8601 UTC. */
  now: string;
  pending: readonly StoredFeedback[];
  history: readonly StoredFeedback[];
  places: ReadonlyMap<string, Place>;
  /** Reviews already in the data for a place. */
  reviews: (placeId: string) => readonly Review[];
  /** Fees already in the data for a place. None when left out. */
  fees?: (placeId: string) => readonly Fee[];
  /** Kind code to group, from `data/schema/kinds.json`. */
  kinds?: ReadonlyMap<string, string>;
  /** Contributors in `moderation/blocked_contributors.json`. */
  blocked?: ReadonlySet<string>;
  /** Contributors with a visible review in the data: their reviews are trusted. */
  reviewers?: ReadonlySet<string>;
  /** Every photo line in the data. None when left out. */
  photos?: readonly Photo[];
  /** Licence id written on new photo lines. Defaults to CC-BY-4.0. */
  photoLicence?: string;
  /** Every record in the data, for the duplicates check on new places. None when left out. */
  everyPlace?: readonly Place[];
  /**
   * Ids on the intake's recent list, or "unreadable" when the list was asked
   * for and could not be read. Feedback about a place on the list that is not
   * in the data yet waits for it, and with an unreadable list all feedback
   * about places not in the data waits. Left out, that feedback is refused.
   */
  recent?: ReadonlySet<string> | "unreadable";
}

/**
 * A change a person decides on. These never touch the automatic branch; the
 * runner applies them to the review checkout with `applyEdit`.
 */
export type ReviewEdit =
  | { kind: "new_place"; record: Place; feedback: string }
  | { kind: "location"; place: string; location: { lat: number; lon: number }; feedback: string; source?: Source }
  | { kind: "fact"; place: string; fact: FactName; value: FactValue; feedback: string; source?: Source }
  | { kind: "name"; place: string; name: string; feedback: string; source?: Source }
  /** A new description. An empty string removes it. */
  | { kind: "description"; place: string; description: string; feedback: string; source?: Source }
  /** A new kind, with its group from `data/schema/kinds.json`. */
  | { kind: "kind"; place: string; placeKind: string; group: string; feedback: string; source?: Source }
  /** A review held for a person: the first from its contributor, or text also sent for another place. */
  | { kind: "review"; place: string; review: Review; feedback: string }
  /** A photo held for a person: the first from its contributor, or a file also sent for another place. */
  | { kind: "photo"; place: string; photo: Photo; feedback: string }
  /** Removes the contributor's held photos from the review checkout. */
  | { kind: "photo_erasure"; contributor: string; feedback: string }
  /** Nothing to write: the PR body carries it for a person to read. */
  | { kind: "note"; place: string; feedback: string };

export interface RulesOutput {
  /** One per pending item, in the order they arrived. */
  decisions: Decision[];
  /**
   * Place records changed by the automatic rules, with `updated` set. A record
   * whose only change is `last_confirmed` keeps its `updated`.
   */
  places: Map<string, Place>;
  /**
   * Every review line of each place whose reviews changed, as the file should
   * now hold them: new reviews added, a contributor's older review replaced,
   * reviews hidden after reports.
   */
  reviews: Map<string, Review[]>;
  /**
   * Every fee line of each place whose fees changed, sorted by id: new fees
   * added, a contributor's older fee for the same site type replaced.
   */
  fees: Map<string, Fee[]>;
  /**
   * Every photo line of each place whose photos changed, sorted by id. An
   * empty list means the place has no photos left.
   */
  photos: Map<string, Photo[]>;
  /** Photos whose files are deleted: refused uploads and erased contributors' photos. */
  removedPhotos: RemovedPhotos["photos"];
  /** Changes for a person, in the order they arrived. */
  edits: ReviewEdit[];
  changes: Change[];
  /** New places a person, or a triage agent, should look at, in the order they were decided. */
  held: HeldCase[];
  /** New places withdrawn by their adder whose records are to be deleted from the data. */
  removed: string[];
  needsReview: boolean;
}

/**
 * One new place for a person or a triage agent to look at, listed in the
 * review PR body as JSON. `duplicate`: held as a possible duplicate of
 * `duplicate_of`. `hidden`: hidden by `reports` reports for `reasons`, or
 * because its contributor is `blocked`. `contacts`: published, with the
 * contact facts and address named in `contacts` waiting in the inbox for a person.
 * `first_place`: the first place from its contributor, published. Contact
 * values, notes and device ids are never in it.
 */
export interface HeldCase {
  case: "duplicate" | "hidden" | "contacts" | "first_place";
  place: string;
  standing: "shown" | "confirmed" | "held" | "hidden";
  location: { lat: number; lon: number };
  kind: string;
  duplicate_of?: string;
  distance_m?: number;
  reports?: number;
  reasons?: string[];
  blocked?: true;
  contacts?: string[];
  contributor?: string;
  /** The feedback ids the case comes from, to read in the inbox. */
  feedback: string[];
}

type ReportItem = Extract<StoredFeedback, { type: "report" }>;
type ReviewItem = Extract<StoredFeedback, { type: "review" }>;
type CheckItem = Extract<StoredFeedback, { type: "check" }>;
type ReviewReportItem = Extract<StoredFeedback, { type: "review_report" }>;
type FeeItem = Extract<StoredFeedback, { type: "fee" }>;
type PhotoItem = Extract<StoredFeedback, { type: "photo" }>;
type PhotoReportItem = Extract<StoredFeedback, { type: "photo_report" }>;
type ErasureItem = Extract<StoredFeedback, { type: "photo_erasure" }>;

/** Reports from this many different contributors hide a review or a photo until a person decides. */
export const REPORTS_TO_HIDE = 3;
/** Review text this long or longer, sent word for word for two places, goes to a person. */
const REPEATED_TEXT_LENGTH = 40;

const time = (item: StoredFeedback) => Date.parse(item.received);

function byReceived(a: StoredFeedback, b: StoredFeedback): number {
  return time(a) - time(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Count and mean of the stars, the mean rounded to 1 decimal place, half up.
 * Worked in whole numbers so that a mean such as 1.15 rounds to 1.2, which
 * floating point arithmetic gets wrong.
 */
export function ratingOf(reviews: readonly Pick<Review, "stars">[]): Place["rating"] {
  if (reviews.length === 0) return null;
  const count = reviews.length;
  const sum = reviews.reduce((total, r) => total + r.stars, 0);
  const tenths = Math.floor((20 * sum + count) / (2 * count));
  return { count, mean: tenths / 10 };
}

/** Whether a review is published and counts in the rating: not hidden, not from a blocked contributor. */
export function isVisible(review: Review, blocked: ReadonlySet<string> = new Set()): boolean {
  return review.hidden === undefined && !blocked.has(review.contributor);
}

/** Whether a stored item was applied by the rules (not held for a person, not refused). */
/** A photo upload's photo id: `pho_` and the item's ulid. */
const photoIdOf = (item: StoredFeedback) => `pho_${item.id.replace(/^fb_/, "")}`;

function wasApplied(item: StoredFeedback): boolean {
  return (item as { outcome?: { result?: string } }).outcome?.result === "applied";
}

/** Review text with case, spacing and punctuation removed, to spot one text sent for several places. */
const sameText = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Independent sources among `items`. Items from one client network count once,
 * whatever device ids they carry. Items stored without a network count by device.
 */
function distinctDevices(items: readonly StoredFeedback[]): number {
  return new Set(items.map((i) => i.origin ?? i.device)).size;
}

/** Whether `item` arrived at or before `at`, and no more than 90 days before it. */
export function inWindow(item: StoredFeedback, at: number): boolean {
  const t = time(item);
  return t <= at && at - t <= WINDOW_MS;
}

/** Closure evidence: a closed report, or a check that found the place gone. */
function isClosureEvidence(item: StoredFeedback): boolean {
  return (
    (item.type === "report" && item.report.kind === "closed") ||
    (item.type === "check" && item.check.still_there === false)
  );
}

/** Reopening evidence: a reopened report, or a check that found the place there. */
function isReopenEvidence(item: StoredFeedback): boolean {
  return (
    (item.type === "report" && item.report.kind === "reopened") ||
    (item.type === "check" && item.check.still_there === true)
  );
}

/** The record without last_confirmed, to tell a confirmation from a change. */
function withoutConfirmed(place: Place): Omit<Place, "last_confirmed"> {
  const { last_confirmed: _, ...rest } = place;
  return rest;
}

const isNewPlaceReport = (item: StoredFeedback): item is ReportItem => item.type === "report" && item.report.kind === "new_place";

/** What can be sent about a new place once it is added: a check, a removal report or its adder's withdrawal. */
const isNewPlaceEvidence = (item: StoredFeedback) =>
  item.type === "withdraw" || item.type === "check" || (item.type === "report" && item.report.kind === "remove");

/** A new place this close to a place in the same group is a possible duplicate. */
export const DUPLICATE_DISTANCE_M = 150;

/** Great-circle distance in metres, as the data repository's duplicates check works it out. */
function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

const quote = (text: string | undefined) => (text ? `: "${text}"` : "");

export function applyRules(input: RulesInput): RulesOutput {
  const now = Date.parse(input.now);
  const nowIso = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const decisions = new Map<string, Decision>();
  const working = new Map<string, Place>();
  const newReviews = new Map<string, Review[]>();
  const newFees = new Map<string, Fee[]>();
  const changes: Change[] = [];
  const edits: ReviewEdit[] = [];
  const held: HeldCase[] = [];
  const removed: string[] = [];

  const decide = (item: StoredFeedback, outcome: Outcome, reason: string) => {
    decisions.set(item.id, { id: item.id, place: item.place, outcome, reason });
  };
  const record = (id: string): Place => {
    const existing = working.get(id);
    if (existing) return existing;
    const copy = structuredClone(input.places.get(id)!);
    working.set(id, copy);
    return copy;
  };
  const note = (place: string, summary: string, automatic: boolean, feedback: readonly StoredFeedback[]) => {
    changes.push({ place, summary, automatic, feedback: feedback.map((f) => f.id) });
  };

  const pending = [...input.pending].sort(byReceived);
  const blocked = input.blocked ?? new Set<string>();
  const newPhotos = new Map<string, Photo[]>();
  const removedPhotos: RemovedPhotos["photos"] = [];
  const removePhoto = (photo: string, reason: RemovedPhotos["photos"][number]["reason"]) => {
    if (!removedPhotos.some((r) => r.photo === photo)) removedPhotos.push({ photo, removed: nowIso, reason });
  };

  // Feedback for a merged id goes to the record it was merged into. Feedback
  // about a place that is not in the data is refused, except new places.
  // Everything from a blocked contributor is refused.
  // New places added in this run or in the last 90 days, by id, and what
  // has been sent about them since.
  const origins = new Map<string, ReportItem>();
  for (const item of [...input.history, ...pending]) {
    if (isNewPlaceReport(item) && item.location) origins.set(newPlaceIdOf(item), item);
  }
  const newPlaceEvidence: StoredFeedback[] = [];
  const known: StoredFeedback[] = [];
  // Items about a place that is not in the data yet, left waiting for it.
  const waitingForData = new Set<string>();
  for (const item of pending) {
    if (item.contributor !== undefined && blocked.has(item.contributor)) {
      decide(item, "refused", "the contributor is blocked");
      continue;
    }
    if (isNewPlaceEvidence(item) && item.place !== null && origins.has(item.place)) {
      newPlaceEvidence.push(item);
      continue;
    }
    if (item.type === "withdraw") {
      decide(item, "refused", `no new place ${item.place} was added in the last ${WINDOW_DAYS} days`);
      continue;
    }
    const isNewPlace = (item.type === "report" && item.report.kind === "new_place") || item.type === "photo_erasure";
    if (isNewPlace) {
      known.push(item);
      continue;
    }
    const target = resolvePlace(item.place, input.places);
    const unknown = item.place !== null && !input.places.has(item.place);
    const recent = input.recent;
    if (unknown && recent === "unreadable") {
      decide(item, "waiting", `place ${item.place} is not in the data, and the recent list could not be read`);
      waitingForData.add(item.id);
    } else if (unknown && recent !== undefined && recent !== "unreadable" && recent.has(item.place!)) {
      decide(item, "waiting", `place ${item.place} is a new place not in the data yet`);
      waitingForData.add(item.id);
    } else if (target === undefined) {
      const merged = item.place !== null && input.places.get(item.place)?.status === "merged";
      decide(item, "refused", merged ? `place ${item.place} was merged into a record that is not in the data` : `place ${item.place ?? "(none)"} is not in the data`);
    } else {
      known.push(target === item.place ? item : ({ ...item, place: target } as StoredFeedback));
    }
  }

  // The review lines of each place as this run leaves them.
  const reviewLines = new Map<string, Review[]>();
  const linesOf = (placeId: string): Review[] => {
    let lines = reviewLines.get(placeId);
    if (!lines) {
      lines = input.reviews(placeId).map((r) => ({ ...r }));
      reviewLines.set(placeId, lines);
    }
    return lines;
  };
  const changedReviews = new Set<string>();

  applyReviews(known.filter((i): i is ReviewItem => i.type === "review"));
  applyReviewReports(known.filter((i): i is ReviewReportItem => i.type === "review_report"));
  for (const placeId of changedReviews) {
    const lines = linesOf(placeId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    newReviews.set(placeId, lines);
    record(placeId).rating = ratingOf(lines.filter((r) => isVisible(r, blocked)));
  }
  applyFees(known.filter((i): i is FeeItem => i.type === "fee"));
  // Erasures first, so a photo sent in the same run by an erased contributor is refused.
  const erased = applyErasures(known.filter((i): i is ErasureItem => i.type === "photo_erasure"));
  applyPhotos(known.filter((i): i is PhotoItem => i.type === "photo"), erased);
  applyPhotoReports(known.filter((i): i is PhotoReportItem => i.type === "photo_report"));
  for (const lines of newPhotos.values()) lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  applyStatus(
    known.filter(
      (i): i is ReportItem | CheckItem =>
        i.type === "check" || (i.type === "report" && (i.report.kind === "closed" || i.report.kind === "reopened")),
    ),
  );
  applyFacts(known.filter((i): i is ReportItem => i.type === "report" && i.report.kind === "fact"));
  applyNewPlaces(known.filter((i): i is ReportItem => isNewPlaceReport(i)), newPlaceEvidence);
  routeToPerson(known.filter((i): i is ReportItem => i.type === "report"));

  // Anything still waiting past the window can no longer be confirmed.
  for (const item of pending) {
    if (decisions.get(item.id)?.outcome === "waiting" && now - time(item) > WINDOW_MS) {
      decide(
        item,
        "refused",
        waitingForData.has(item.id)
          ? `place ${item.place} did not reach the data within ${WINDOW_DAYS} days`
          : `not confirmed by a second device within ${WINDOW_DAYS} days`,
      );
    }
  }

  // Keep only records that really changed, and stamp them. A new
  // last_confirmed alone is written but does not move `updated`.
  const changed = new Map<string, Place>();
  for (const [id, place] of working) {
    const original = input.places.get(id);
    if (!original || JSON.stringify(withoutConfirmed(original)) !== JSON.stringify(withoutConfirmed(place))) {
      place.updated = nowIso;
      changed.set(id, place);
    } else if (original.last_confirmed !== place.last_confirmed) {
      changed.set(id, place);
    }
  }

  // A refused upload's files are deleted.
  for (const item of pending) {
    if (item.type === "photo" && decisions.get(item.id)?.outcome === "refused") removePhoto(photoIdOf(item), "refused");
  }

  const ordered = pending.map((p) => decisions.get(p.id)!);
  return {
    decisions: ordered,
    places: changed,
    reviews: newReviews,
    fees: newFees,
    photos: newPhotos,
    removedPhotos,
    edits,
    changes,
    held,
    removed,
    needsReview: ordered.some((d) => d.outcome === "needs_review"),
  };

  function applyReviews(items: ReviewItem[]): void {
    const trusted = new Set(input.reviewers ?? []);
    for (const h of input.history) if (h.contributor !== undefined && wasApplied(h)) trusted.add(h.contributor);
    const reviewsSent = [...input.history, ...items].filter((i): i is ReviewItem => i.type === "review");

    for (const item of items) {
      const reasons = moderateReview(item.review.text);
      if (reasons.length > 0) {
        decide(item, "refused", `review text contains ${reasons.join(", ")}`);
        continue;
      }
      if (item.contributor === undefined) {
        decide(item, "refused", "review has no contributor");
        continue;
      }
      const reviewId = `rev_${item.id.replace(/^fb_/, "")}`;
      const lines = linesOf(item.place);
      if (lines.some((r) => r.id === reviewId)) {
        decide(item, "applied", "review is already in the data");
        continue;
      }
      const review: Review = {
        id: reviewId,
        place: item.place,
        stars: item.review.stars,
        text: item.review.text,
        visited: item.review.visited,
        created: item.received,
        app: item.app,
        contributor: item.contributor,
        ...(item.review.visited_nearby === true ? { visited_nearby: true as const } : {}),
      };
      const text = sameText(item.review.text);
      const repeated =
        text.length >= REPEATED_TEXT_LENGTH &&
        reviewsSent.some((other) => other.place !== item.place && other.id !== item.id && sameText(other.review.text) === text);
      if (repeated || !trusted.has(item.contributor)) {
        const why = repeated ? "the same text was sent for another place" : "first review from this contributor";
        edits.push({ kind: "review", place: item.place, review, feedback: item.id });
        note(item.place, `${item.review.stars} star review, ${why}${quote(item.review.text.slice(0, 300))} (check before merging)`, false, [item]);
        decide(item, "needs_review", `${why}, so a person checks it`);
        continue;
      }
      // One review per contributor per place: the newer replaces the older.
      const older = lines.filter((r) => r.contributor === item.contributor);
      for (const r of older) lines.splice(lines.indexOf(r), 1);
      lines.push(review);
      changedReviews.add(item.place);
      const replaced = older.length > 0 ? `, replacing ${older.map((r) => r.id).join(", ")}` : "";
      note(item.place, `review added${replaced}`, true, [item]);
      decide(item, "applied", older.length > 0 ? "review accepted, replacing the contributor's earlier review" : "review accepted");
    }
  }

  /**
   * Fees hold no free text, so they are published at once. One fee per
   * contributor per place per site type: the newer replaces the older.
   */
  function applyFees(items: FeeItem[]): void {
    const feeLines = new Map<string, Fee[]>();
    for (const item of items) {
      if (item.contributor === undefined) {
        decide(item, "refused", "fee has no contributor");
        continue;
      }
      let lines = feeLines.get(item.place);
      if (!lines) {
        lines = (input.fees?.(item.place) ?? []).map((f) => ({ ...f }));
        feeLines.set(item.place, lines);
      }
      const feeId = `fee_${item.id.replace(/^fb_/, "")}`;
      if (lines.some((f) => f.id === feeId)) {
        decide(item, "applied", "fee is already in the data");
        continue;
      }
      const older = lines.filter((f) => f.contributor === item.contributor && f.site === item.fee.site);
      for (const f of older) lines.splice(lines.indexOf(f), 1);
      lines.push({
        id: feeId,
        place: item.place,
        amount: item.fee.amount,
        site: item.fee.site,
        paid: item.fee.paid,
        created: item.received,
        app: item.app,
        contributor: item.contributor,
      });
      newFees.set(item.place, lines);
      const replaced = older.length > 0 ? `, replacing ${older.map((f) => f.id).join(", ")}` : "";
      note(item.place, `${item.fee.site} fee of $${item.fee.amount.toFixed(2)} a night paid ${item.fee.paid}${replaced}`, true, [item]);
      decide(item, "applied", older.length > 0 ? "fee accepted, replacing the contributor's earlier fee for this site type" : "fee accepted");
    }
    for (const lines of newFees.values()) lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** The photo lines of a place as this run leaves them. */
  function photoLinesOf(placeId: string): Photo[] {
    let lines = newPhotos.get(placeId);
    if (!lines) {
      lines = (input.photos ?? []).filter((p) => p.place === placeId).map((p) => ({ ...p }));
      newPhotos.set(placeId, lines);
    }
    return lines;
  }

  /**
   * Removes every photo from each contributor that asked: lines in the data,
   * photos they sent in the last 90 days, and held ones on the review branch.
   * Returns the erased contributors.
   */
  function applyErasures(items: ErasureItem[]): Set<string> {
    const erased = new Set<string>();
    for (const item of items) {
      const contributor = item.contributor;
      if (contributor === undefined) {
        decide(item, "refused", "erasure has no contributor");
        continue;
      }
      erased.add(contributor);
      let count = 0;
      for (const placeId of new Set((input.photos ?? []).filter((p) => p.contributor === contributor).map((p) => p.place))) {
        const lines = photoLinesOf(placeId);
        for (const p of lines.filter((l) => l.contributor === contributor)) {
          lines.splice(lines.indexOf(p), 1);
          removePhoto(p.id, "erased");
          count += 1;
        }
      }
      for (const h of input.history) {
        if (h.type === "photo" && h.contributor === contributor) removePhoto(photoIdOf(h), "erased");
      }
      edits.push({ kind: "photo_erasure", contributor, feedback: item.id });
      note("(all places)", `photos from ${contributor} removed at their request (${count} published)`, true, [item]);
      decide(item, "applied", `photos removed at the contributor's request, ${count} published`);
    }
    return erased;
  }

  function applyPhotos(items: PhotoItem[], erased: ReadonlySet<string>): void {
    const trusted = new Set(
      (input.photos ?? []).filter((p) => p.hidden === undefined && !blocked.has(p.contributor)).map((p) => p.contributor),
    );
    for (const h of input.history) if (h.type === "photo" && h.contributor !== undefined && wasApplied(h)) trusted.add(h.contributor);
    const sent = [...input.history, ...items].filter((i): i is PhotoItem => i.type === "photo");
    for (const item of items) {
      if (item.contributor === undefined) {
        decide(item, "refused", "photo has no contributor");
        continue;
      }
      if (erased.has(item.contributor)) {
        decide(item, "refused", "the contributor asked for their photos to be removed");
        continue;
      }
      const photoId = photoIdOf(item);
      const lines = photoLinesOf(item.place);
      if (lines.some((p) => p.id === photoId)) {
        decide(item, "applied", "photo is already in the data");
        continue;
      }
      const photo: Photo = {
        id: photoId,
        place: item.place,
        contributor: item.contributor,
        created: item.received,
        app: item.app,
        licence: input.photoLicence ?? "CC-BY-4.0",
        width: item.photo.width,
        height: item.photo.height,
        sha256: item.photo.full_sha256,
      };
      const repeated =
        (input.photos ?? []).some((p) => p.sha256 === photo.sha256 && p.place !== item.place) ||
        sent.some((other) => other.id !== item.id && other.place !== item.place && other.photo.full_sha256 === photo.sha256);
      // SafeSearch ratings from the intake, when it checks photos: a likely adult
      // or violent photo, or one it couldn't check, waits for a person.
      const rated = item.photo.safesearch;
      const flagged = rated !== undefined && safeSearchVerdict(rated) !== "pass";
      if (repeated || flagged || !trusted.has(item.contributor)) {
        const why = repeated
          ? "the same file was sent for another place"
          : flagged
            ? rated === "unchecked"
              ? "SafeSearch could not check it"
              : `SafeSearch rates it adult ${rated.adult}, violence ${rated.violence}, racy ${rated.racy}`
            : "first photo from this contributor";
        edits.push({ kind: "photo", place: item.place, photo, feedback: item.id });
        note(item.place, `photo ${photoId} (${photo.width} x ${photo.height}), ${why} (look at it before merging)`, false, [item]);
        decide(item, "needs_review", `${why}, so a person checks it`);
        continue;
      }
      lines.push(photo);
      note(item.place, `photo ${photoId} added`, true, [item]);
      decide(item, "applied", "photo accepted");
    }
  }

  function applyPhotoReports(items: PhotoReportItem[]): void {
    const reportsSent = [...input.history.filter((h): h is PhotoReportItem => h.type === "photo_report")];
    for (const item of items) {
      const { photo: photoId, reason } = item.photo_report;
      if (item.contributor === undefined) {
        decide(item, "refused", "photo report has no contributor");
        continue;
      }
      const target = photoLinesOf(item.place).find((p) => p.id === photoId);
      if (!target) {
        decide(item, "refused", `photo ${photoId} is not in the data for this place`);
        continue;
      }
      if (target.contributor === item.contributor) {
        decide(item, "refused", "a contributor cannot report their own photo");
        continue;
      }
      reportsSent.push(item);
      edits.push({ kind: "note", place: item.place, feedback: item.id });
      if (reason === "illegal") {
        // One report is enough: the intake has already withheld the photo at the photo server.
        if (target.hidden === undefined) target.hidden = "reported";
        note(
          item.place,
          `URGENT: photo ${photoId} reported as illegal (child abuse, an intimate image shared without consent, or terrorist material). ` +
            "Hidden and withheld until a person decides. Follow the safety procedure: remove it, and report it where the procedure says",
          false,
          [item],
        );
        decide(item, "needs_review", "an illegal-content report hides the photo at once and is read by a person");
        continue;
      }
      note(item.place, `photo ${photoId} reported as ${reason} (decide: keep, hide, remove or block the contributor)`, false, [item]);
      decide(item, "needs_review", "photo reports are read by a person");
      const reporters = new Set(
        reportsSent.filter((r) => r.photo_report.photo === photoId && r.contributor !== undefined).map((r) => r.contributor),
      );
      if (target.hidden === undefined && reporters.size >= REPORTS_TO_HIDE) {
        target.hidden = "reported";
        note(
          item.place,
          `photo ${photoId} hidden after reports from ${reporters.size} contributors, until a person decides`,
          true,
          reportsSent.filter((r) => r.photo_report.photo === photoId),
        );
      }
    }
  }

  function applyReviewReports(items: ReviewReportItem[]): void {
    const reportsSent = [...input.history.filter((h): h is ReviewReportItem => h.type === "review_report")];
    for (const item of items) {
      const { review: reviewId, reason } = item.review_report;
      if (item.contributor === undefined) {
        decide(item, "refused", "review report has no contributor");
        continue;
      }
      const target = linesOf(item.place).find((r) => r.id === reviewId);
      if (!target) {
        decide(item, "refused", `review ${reviewId} is not in the data for this place`);
        continue;
      }
      if (target.contributor === item.contributor) {
        decide(item, "refused", "a contributor cannot report their own review");
        continue;
      }
      reportsSent.push(item);
      edits.push({ kind: "note", place: item.place, feedback: item.id });
      note(item.place, `review ${reviewId} reported as ${reason} (decide: keep, hide or block the contributor)`, false, [item]);
      decide(item, "needs_review", "review reports are read by a person");

      const reporters = new Set(
        reportsSent.filter((r) => r.review_report.review === reviewId && r.contributor !== undefined).map((r) => r.contributor),
      );
      if (target.hidden === undefined && reporters.size >= REPORTS_TO_HIDE) {
        target.hidden = "reported";
        changedReviews.add(item.place);
        note(
          item.place,
          `review ${reviewId} hidden after reports from ${reporters.size} contributors, until a person decides`,
          true,
          reportsSent.filter((r) => r.review_report.review === reviewId),
        );
      }
    }
  }

  function applyStatus(items: (ReportItem | CheckItem)[]): void {
    for (const placeId of new Set(items.map((i) => i.place as string))) {
      const mine = items.filter((i) => i.place === placeId);
      const evidence = [...input.history.filter((h) => h.place === placeId), ...mine].sort(byReceived);
      const place = record(placeId);
      const statusBefore = place.status;

      // Evidence one way counts only if it came after the latest evidence the other way.
      const latest = (at: number, test: (i: StoredFeedback) => boolean) =>
        evidence.filter((e) => test(e) && time(e) <= at).reduce((max, e) => Math.max(max, time(e)), -Infinity);
      const supporting = (at: number, test: (i: StoredFeedback) => boolean, against: (i: StoredFeedback) => boolean) => {
        const after = latest(at, against);
        return evidence.filter((e) => test(e) && inWindow(e, at) && time(e) > after);
      };
      const waitingReopens: StoredFeedback[] = [];
      const waitingClosures: StoredFeedback[] = [];

      for (const item of mine) {
        const at = time(item);
        const isReport = item.type === "report";

        // The owner closed it for a while; the owner's dates decide, not reports.
        if (place.status === "temporarily_closed") {
          decide(item, "applied", "place is temporarily closed by its owner");
          continue;
        }

        if (isClosureEvidence(item)) {
          if (place.status === "closed") {
            decide(item, "applied", isReport ? "place is already closed" : "check recorded");
            continue;
          }
          // The verified owner manages the status. Once two devices report a
          // closure, a person decides instead of the rules.
          if (place.fact_sources.status === "owner" || place.owner_verified) {
            const devices = supporting(at, isClosureEvidence, isReopenEvidence);
            if (distinctDevices(devices) >= 2) {
              edits.push({ kind: "note", place: placeId, feedback: item.id });
              note(
                placeId,
                `closure reported by ${distinctDevices(devices)} devices within ${WINDOW_DAYS} days for an owner-verified place (check before closing)`,
                false,
                devices,
              );
              const why = "the owner manages this place's status, so a person decides";
              decide(item, "needs_review", why);
              for (const w of waitingClosures.splice(0)) decide(w, "needs_review", why);
            } else if (isReport) {
              waitingClosures.push(item);
              decide(item, "waiting", "an owner-verified place needs a second device before a person checks a closure");
            } else {
              decide(item, "applied", "check recorded");
            }
            continue;
          }
          if (place.status === "open" && isReport) {
            place.status = "reported_closed";
            note(placeId, "status open to reported_closed", true, [item]);
          }
          const devices = supporting(at, isClosureEvidence, isReopenEvidence);
          if (place.status === "reported_closed" && distinctDevices(devices) >= 2) {
            place.status = "closed";
            note(
              placeId,
              `status reported_closed to closed (${distinctDevices(devices)} devices within ${WINDOW_DAYS} days)`,
              true,
              devices,
            );
          }
          decide(item, "applied", isReport ? `place is ${place.status}` : "check recorded");
          continue;
        }

        // Reopening evidence.
        if (place.status === "open") {
          decide(item, "applied", isReport ? "place is already open" : "check recorded");
          continue;
        }
        if (place.status === "reported_closed") {
          place.status = "open";
          const why = isReport ? "reopened report" : "check found it there";
          note(placeId, `status reported_closed to open (${why})`, true, [item]);
          decide(item, "applied", "cleared reported_closed");
          continue;
        }
        // Closed: two devices within 90 days reopen it.
        const devices = supporting(at, isReopenEvidence, isClosureEvidence);
        if (distinctDevices(devices) >= 2) {
          place.status = "open";
          note(
            placeId,
            `status closed to open (${distinctDevices(devices)} devices within ${WINDOW_DAYS} days)`,
            true,
            devices,
          );
          decide(item, "applied", "place reopened");
          for (const w of waitingReopens.splice(0)) decide(w, "applied", "place reopened");
        } else if (isReport) {
          waitingReopens.push(item);
          decide(item, "waiting", "a closed place needs a second device to reopen it");
        } else {
          decide(item, "applied", "check recorded");
        }
      }
      // Marks the status as coming from feedback, so the OSM notes can tell it from a contributed closure.
      if (place.status !== statusBefore) setSource(place, "status", "feedback", nowIso);

      // A traveller found it there and it is still open after this run. One
      // device is enough, as for clearing reported_closed: it confirms the
      // status the record already has and changes nothing a traveller sees.
      const confirming = mine.filter(
        (i) => i.type === "check" && i.check.still_there === true && decisions.get(i.id)?.outcome === "applied",
      );
      if (place.status === "open" && confirming.length > 0) {
        place.last_confirmed = nowIso;
        note(placeId, "confirmed there by a traveller", true, confirming);
      }
    }
  }

  function applyFacts(items: ReportItem[]): void {
    const groups = new Map<string, ReportItem[]>();
    for (const item of items) {
      const { fact, value } = item.report;
      if (!isFactName(fact) || !isValidFactValue(fact, value)) {
        decide(item, "refused", `${String(fact)} = ${JSON.stringify(value)} is not a valid fact`);
        continue;
      }
      const key = `${item.place}\u0000${fact}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }

    for (const reports of groups.values()) {
      const placeId = reports[0]!.place as string;
      const fact = reports[0]!.report.fact as FactName;
      const place = record(placeId);
      const current = () => (place.facts as Record<string, unknown>)[fact];
      const setFact = (value: FactValue) => {
        (place.facts as Record<string, FactValue>)[fact] = value;
        setSource(place, fact, "feedback", nowIso);
      };

      if (REVIEWED_FACTS.has(fact)) {
        for (const item of reports) {
          const value = item.report.value as FactValue;
          edits.push({ kind: "fact", place: placeId, fact, value, feedback: item.id });
          note(placeId, `${fact} set to ${JSON.stringify(value)} (check before merging)`, false, [item]);
          decide(item, "needs_review", `${fact} changes are checked by a person`);
        }
        continue;
      }

      const open = new Set(reports);
      for (const item of reports) {
        if (!open.has(item)) continue;
        const value = item.report.value as FactValue;
        if (current() === value) {
          open.delete(item);
          decide(item, "applied", `${fact} is already ${JSON.stringify(value)}`);
          continue;
        }
        const at = time(item);
        const agreeing = [...open].filter((r) => r.report.value === value && inWindow(r, at));
        if (distinctDevices(agreeing) < 2) continue;
        if (place.fact_sources[fact] === "owner") {
          // The verified owner set this value. A person decides between them.
          edits.push({ kind: "fact", place: placeId, fact, value, feedback: agreeing[0]!.id });
          note(placeId, `${fact}: ${distinctDevices(agreeing)} devices report ${JSON.stringify(value)}, the owner set ${JSON.stringify(current())}`, false, agreeing);
          for (const r of agreeing) {
            open.delete(r);
            decide(r, "needs_review", `${fact} was set by the owner, so a person decides`);
          }
          continue;
        }
        setFact(value);
        note(
          placeId,
          `${fact} set to ${JSON.stringify(value)} (${distinctDevices(agreeing)} devices within ${WINDOW_DAYS} days)`,
          true,
          agreeing,
        );
        for (const r of agreeing) {
          open.delete(r);
          decide(r, "applied", `${fact} set to ${JSON.stringify(value)}`);
        }
        for (const r of [...open]) {
          if (time(r) <= at) {
            open.delete(r);
            decide(r, "refused", `${fact} was set to ${JSON.stringify(value)} by reports from other devices`);
          }
        }
      }
      for (const item of open) decide(item, "waiting", `waiting for a second device to agree on ${fact}`);
    }
  }

  /**
   * New places from travellers, and the checks, removal reports and
   * withdrawals sent about them. Each is written with its standing from
   * `newPlaceStanding`: `shown` and `confirmed` places go straight into the
   * data, much as trusted reviews do. A `held` or `hidden` place that is not
   * in the data yet is drafted for a person instead, a `withdrawn` one is
   * not written and is removed if it was. Every case a person should look
   * at is listed in `held`.
   */
  function applyNewPlaces(pendingNew: ReportItem[], evidence: StoredFeedback[]): void {
    const ids = new Set([...pendingNew.filter((i) => i.location).map(newPlaceIdOf), ...evidence.map((e) => e.place as string)]);
    for (const id of ids) {
      const origin = origins.get(id)!;
      const isPending = pendingNew.includes(origin);
      const mine = evidence.filter((e) => e.place === id);
      const earlier = input.history.filter((h) => h.place === id && isNewPlaceEvidence(h));
      const existing = input.places.get(id);
      const key = origin.contributor ?? origin.device;
      const firstPlace = !input.history.some((h) => h.id !== origin.id && isNewPlaceReport(h) && (h.contributor ?? h.device) === key);
      const isBlocked = origin.contributor !== undefined && blocked.has(origin.contributor);
      // Once a person has let a place into the data as anything but held, it is no longer a possible duplicate.
      const duplicate = existing && existing.standing !== "held" ? undefined : nearestDuplicate(id, origin);
      const standingFrom = (items: readonly StoredFeedback[]) =>
        newPlaceStanding({
          added: origin.received,
          contributor: { device: origin.device, blocked: isBlocked, firstPlace },
          checks: items
            .filter((i): i is CheckItem => i.type === "check")
            .map((c) => ({ device: c.device, stillThere: c.check.still_there, nearby: c.check.nearby === true, day: c.received })),
          reports: items
            .filter((i): i is ReportItem => i.type === "report")
            .map((r) => ({ device: r.device, reason: r.report.reason!, day: r.received })),
          withdrawnAt: items.filter((i) => i.type === "withdraw" && i.device === origin.device).map((i) => i.received).sort()[0] ?? null,
          duplicateOf: duplicate?.place ?? null,
          moderator: moderatorOf(existing),
          now: nowIso,
        });
      const standing = standingFrom([...earlier, ...mine]);
      const before = existing ? existing.standing : isPending ? undefined : standingFrom(earlier);

      for (const e of mine) {
        if (e.type === "withdraw") {
          if (e.device !== origin.device) decide(e, "refused", "only the install that added a place can withdraw it");
          else if (standing === "withdrawn") decide(e, "applied", WITHDRAWN.withdrawal);
          else decide(e, "applied", "withdrawn more than 24 hours after it was added, so it counts as a report");
        } else {
          decide(e, "applied", e.type === "check" ? "check recorded" : "report recorded");
        }
      }

      if (standing === "withdrawn") {
        const by = mine.filter((e) => e.type === "withdraw" && e.device === origin.device);
        if (existing) {
          removed.push(id);
          note(id, "new place withdrawn by the person who added it, so its record is removed", true, by);
        }
        if (isPending) decide(origin, "refused", WITHDRAWN.place);
        continue;
      }

      // The intake lists a new place only when it passes these, so apply publishes no other.
      const unlisted = existing ? undefined : whyNotListed(origin);
      const published = (standing === "shown" || standing === "confirmed") && unlisted === undefined;
      // Contact facts and the address wait for a person, so they are held alike.
      const heldFacts: Partial<Record<keyof NewPlaceContacts | "address", FactValue>> = { ...origin.report.contacts, ...(origin.report.address ? { address: origin.report.address } : {}) };
      const contacts = Object.keys(heldFacts) as (keyof typeof heldFacts)[];
      const where = `${origin.location!.lat}, ${origin.location!.lon}`;
      const against = [...earlier, ...mine].filter((i) => i.type === "report" || (i.type === "check" && !i.check.still_there));
      const reasons = [...new Set(against.map((i) => (i.type === "report" ? i.report.reason! : "not_there")))].sort();
      const caseFor = (kind: HeldCase["case"], feedback: readonly StoredFeedback[]): HeldCase => ({
        case: kind,
        place: id,
        standing: standing as HeldCase["standing"],
        location: { lat: roundCoord(origin.location!.lat), lon: roundCoord(origin.location!.lon) },
        kind: (existing ?? draftOf(origin)).kind,
        ...(kind === "duplicate" && duplicate ? { duplicate_of: duplicate.place, distance_m: duplicate.distance } : {}),
        ...(kind === "hidden" ? (isBlocked ? { blocked: true as const } : { reports: new Set(against.map((i) => i.device)).size, reasons }) : {}),
        ...(kind === "contacts" ? { contacts } : {}),
        ...(kind === "first_place" && origin.contributor ? { contributor: origin.contributor } : {}),
        feedback: feedback.map((f) => f.id),
      });

      if (existing || published) {
        if (existing) {
          const place = record(id);
          place.standing = standing;
          if (before !== standing) note(id, `standing ${before ?? "(none)"} to ${standing}`, true, mine);
          if (isPending) decide(origin, "applied", `new place is already in the data, ${standing}`);
        } else {
          working.set(id, { ...draftOf(origin), standing });
          note(id, `new place at ${where}, published as ${standing}`, true, [origin]);
          decide(origin, "applied", `new place published as ${standing}`);
        }
      } else if (isPending) {
        // Held or hidden before it was ever published: a person decides, with the contacts in the draft.
        const draft: Place = { ...draftOf(origin), standing };
        for (const fact of contacts) {
          (draft.facts as Record<string, FactValue>)[fact] = heldFacts[fact]!;
          setSource(draft, fact, "feedback", nowIso);
        }
        edits.push({ kind: "new_place", record: draft, feedback: origin.id });
        if (unlisted !== undefined && !(standing === "held" || standing === "hidden")) draft.standing = "held";
        const why =
          unlisted !== undefined && draft.standing === "held" && standing !== "held"
            ? `${unlisted}, so it is not published (keep it: set standing to shown)`
            : standing === "held"
            ? `possible duplicate of ${duplicate!.place}, ${duplicate!.distance} m away (keep it: set standing to shown; the same place: merge it into ${duplicate!.place})`
            : `hidden before it was published (keep it: set standing to shown and moderator to {"action": "restore", "at": "${nowIso}"})`;
        note(id, `new place at ${where}, ${why}`, false, [origin]);
        decide(
          origin,
          "needs_review",
          standing === "hidden" ? "hidden by reports, so a person checks it" : standing === "held" ? "possible duplicate, so a person checks it" : `${unlisted}, so a person checks it`,
        );
      } else if (before !== standing) {
        // Not in the data and already with a person: only the listing changes.
        edits.push({ kind: "note", place: id, feedback: mine[0]!.id });
        note(id, `standing ${before} to ${standing}`, false, mine);
      }

      if (standing === "held" && (isPending || before !== "held")) held.push(caseFor("duplicate", isPending ? [origin] : mine));
      if (standing === "hidden" && (isPending || before !== "hidden")) held.push(caseFor("hidden", isPending ? [origin, ...mine] : mine));
      if (isPending && published && contacts.length > 0) held.push(caseFor("contacts", [origin]));
      if (isPending && firstPlace) held.push(caseFor("first_place", [origin]));
    }
  }

  /** A person's decision on a new place's record, or null when it has none it can read. */
  function moderatorOf(place: Place | undefined): { action: "restore" | "hide"; at: string } | null {
    const decision = place?.moderator;
    if (decision === undefined || (decision.action !== "restore" && decision.action !== "hide")) return null;
    if (typeof decision.at !== "string" || !/^\d{4}-\d{2}-\d{2}(T|$)/.test(decision.at) || Number.isNaN(Date.parse(decision.at))) return null;
    return { action: decision.action, at: decision.at };
  }

  /** Why the intake would not list a new place, or undefined when it would. */
  function whyNotListed(item: ReportItem): string | undefined {
    if (item.attested === undefined) return "not proven by attestation";
    if (item.contributor === undefined) return "no contributor";
    const problem = item.report.note === undefined ? null : firstProblem(tidyText(item.report.note));
    return problem === null ? undefined : `note fails the text checks (${problem})`;
  }

  /** A new place's record as its report describes it, with no standing yet. */
  function draftOf(item: ReportItem): Place {
    const picked = item.report.place_kind;
    const pickedGroup = picked === undefined ? undefined : input.kinds?.get(picked);
    const name = item.report.name ?? null;
    return {
      id: newPlaceIdOf(item),
      name,
      kind: pickedGroup ? picked! : DRAFT_KIND,
      group: pickedGroup ?? input.kinds?.get(DRAFT_KIND) ?? DRAFT_GROUP,
      location: { lat: roundCoord(item.location!.lat), lon: roundCoord(item.location!.lon) },
      osm: null,
      facts: {},
      status: "open",
      rating: null,
      fact_sources: name === null ? { location: "feedback" } : { location: "feedback", name: "feedback" },
      fact_dates: name === null ? { location: nowIso } : { location: nowIso, name: nowIso },
      updated: nowIso,
    };
  }

  /**
   * The nearest place in the same group within 150 m of a new place: every
   * record in the data and the new places published earlier in this run.
   * Merged and hidden records do not count.
   */
  function nearestDuplicate(id: string, item: ReportItem): { place: string; distance: number } | undefined {
    const group = draftOf(item).group;
    let best: { place: string; distance: number } | undefined;
    const candidates = [...(input.everyPlace ?? []), ...[...working.values()].filter((p) => p.standing !== undefined)];
    for (const other of candidates) {
      if (other.id === id || other.group !== group || other.status === "merged" || other.standing === "hidden") continue;
      const distance = Math.round(distanceM(item.location!, other.location));
      if (distance <= DUPLICATE_DISTANCE_M && (!best || distance < best.distance)) best = { place: other.id, distance };
    }
    return best;
  }

  function routeToPerson(items: ReportItem[]): void {
    for (const item of items) {
      const { kind, note: text } = item.report;
      if (kind === "wrong_location" && item.place) {
        if (item.location) {
          const location = { lat: roundCoord(item.location.lat), lon: roundCoord(item.location.lon) };
          edits.push({ kind: "location", place: item.place, location, feedback: item.id });
          const where = `${item.location.lat}, ${item.location.lon}`;
          note(item.place, `location moved to ${where}${quote(text)} (check before merging)`, false, [item]);
        } else {
          edits.push({ kind: "note", place: item.place, feedback: item.id });
          note(item.place, `location reported wrong, no new location given${quote(text)}`, false, [item]);
        }
        decide(item, "needs_review", "location reports are checked by a person");
      } else if (kind === "name" && item.place && typeof item.report.value === "string") {
        edits.push({ kind: "name", place: item.place, name: item.report.value, feedback: item.id });
        note(item.place, `name changed to ${JSON.stringify(item.report.value)}${quote(text)} (check before merging)`, false, [item]);
        decide(item, "needs_review", "names are checked by a person");
      } else if (kind === "description" && item.place && typeof item.report.value === "string") {
        edits.push({ kind: "description", place: item.place, description: item.report.value, feedback: item.id });
        note(item.place, `description set to ${JSON.stringify(item.report.value)}${quote(text)} (check before merging)`, false, [item]);
        decide(item, "needs_review", "descriptions are checked by a person");
      } else if (kind === "kind" && item.place) {
        const picked = item.report.place_kind;
        const group = picked === undefined ? undefined : input.kinds?.get(picked);
        if (picked === undefined || group === undefined) {
          decide(item, "refused", `${String(picked)} is not a kind in data/schema/kinds.json`);
          continue;
        }
        edits.push({ kind: "kind", place: item.place, placeKind: picked, group, feedback: item.id });
        note(item.place, `kind changed to ${picked}${quote(text)} (check before merging)`, false, [item]);
        decide(item, "needs_review", "kind changes are checked by a person");
      } else if (kind === "remove" && item.place) {
        // Only places added in the last 90 days come down on reports. On any other place a person decides.
        edits.push({ kind: "note", place: item.place, feedback: item.id });
        note(item.place, `removal reported as ${item.report.reason}${quote(text)} (decide: keep it, close it or hide it)`, false, [item]);
        decide(item, "needs_review", "removal reports on places that are not new are read by a person");
      } else if (kind === "other" && item.place) {
        edits.push({ kind: "note", place: item.place, feedback: item.id });
        note(item.place, `report${quote(text) || " with no note"}`, false, [item]);
        decide(item, "needs_review", "other reports are read by a person");
      }
    }
  }
}

/**
 * Adds a held review to the review lines as the review checkout has them,
 * replacing the same contributor's older review of the place, and returns
 * the lines and the place's new rating. Undefined when the review is already
 * there.
 */
export function applyHeldReview(
  lines: readonly Review[],
  review: Review,
  blocked: ReadonlySet<string> = new Set(),
): { lines: Review[]; rating: Place["rating"] } | undefined {
  if (lines.some((r) => r.id === review.id)) return undefined;
  const next = [...lines.filter((r) => r.contributor !== review.contributor), review].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return { lines: next, rating: ratingOf(next.filter((r) => isVisible(r, blocked))) };
}

/**
 * Applies one review edit to the record as it is in the review checkout. A
 * held review is written by `applyHeldReview` instead, and photo edits by the
 * runner.
 * Returns the new record, or undefined when there is nothing to write: the
 * edit is already there, it is a note, or a person has already edited the
 * draft of a new place.
 */
export function applyEdit(
  current: Place | undefined,
  edit: Exclude<ReviewEdit, { kind: "review" | "photo" | "photo_erasure" }>,
  nowIso: string,
): Place | undefined {
  if (edit.kind === "note") return undefined;
  if (edit.kind === "new_place") return current ? undefined : edit.record;
  if (!current) return undefined;
  const next = structuredClone(current);
  if (current.status === "merged") return undefined; // never write to a tombstone
  const source = edit.source ?? "feedback";
  let key: SourceKey;
  if (edit.kind === "location") {
    next.location = { ...edit.location };
    key = "location";
  } else if (edit.kind === "name") {
    next.name = edit.name;
    key = "name";
  } else if (edit.kind === "description") {
    if (edit.description === "") delete next.description;
    else next.description = edit.description;
    key = "description";
  } else if (edit.kind === "kind") {
    next.kind = edit.placeKind;
    next.group = edit.group;
    key = "kind";
  } else {
    (next.facts as Record<string, FactValue>)[edit.fact] = edit.value;
    key = edit.fact;
  }
  next.fact_sources[key] = source;
  if (source === "owner") next.owner_verified = true;
  // Compared before the date is set, so an edit already in the record writes nothing.
  if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
  setSource(next, key, source, nowIso);
  next.updated = nowIso;
  return next;
}
