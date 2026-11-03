import {
  isFactName,
  isValidFactValue,
  safeSearchVerdict,
  type FactName,
  type FactValue,
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
]);

/** Kind given to a draft record for a `new_place` report until a person sets it. */
export const DRAFT_KIND = "campground";
const DRAFT_GROUP = "overnight";

/**
 * Follows a merged id to the record it was merged into (a person may merge a
 * record whose target was itself merged later). Returns undefined when the id
 * is not in `places`, the chain is broken or it loops. Never returns a tombstone.
 */
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
  needsReview: boolean;
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
  const known: StoredFeedback[] = [];
  for (const item of pending) {
    if (item.contributor !== undefined && blocked.has(item.contributor)) {
      decide(item, "refused", "the contributor is blocked");
      continue;
    }
    const isNewPlace = (item.type === "report" && item.report.kind === "new_place") || item.type === "photo_erasure";
    if (isNewPlace) {
      known.push(item);
      continue;
    }
    const target = resolvePlace(item.place, input.places);
    if (target === undefined) {
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
  routeToPerson(known.filter((i): i is ReportItem => i.type === "report"));

  // Anything still waiting past the window can no longer be confirmed.
  for (const item of pending) {
    if (decisions.get(item.id)?.outcome === "waiting" && now - time(item) > WINDOW_MS) {
      decide(item, "refused", `not confirmed by a second device within ${WINDOW_DAYS} days`);
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

  function routeToPerson(items: ReportItem[]): void {
    for (const item of items) {
      const { kind, note: text } = item.report;
      if (kind === "new_place" && item.location) {
        // The id comes from the feedback id, so running the same item again writes the same file.
        const id = `ocdb_${item.id.replace(/^fb_/, "")}`;
        const picked = item.report.place_kind;
        const pickedGroup = picked === undefined ? undefined : input.kinds?.get(picked);
        const draft: Place = {
          id,
          name: null,
          kind: pickedGroup ? picked! : DRAFT_KIND,
          group: pickedGroup ?? input.kinds?.get(DRAFT_KIND) ?? DRAFT_GROUP,
          location: { lat: roundCoord(item.location.lat), lon: roundCoord(item.location.lon) },
          osm: null,
          facts: {},
          status: "open",
          rating: null,
          fact_sources: { location: "feedback" },
          fact_dates: { location: nowIso },
          updated: nowIso,
        };
        edits.push({ kind: "new_place", record: draft, feedback: item.id });
        const where = `${item.location.lat}, ${item.location.lon}`;
        note(id, `new place at ${where}${quote(text)} (set kind and name before merging)`, false, [item]);
        decide(item, "needs_review", "new place drafted for a person to check");
      } else if (kind === "wrong_location" && item.place) {
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
