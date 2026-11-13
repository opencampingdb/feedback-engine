import {
  FEE_RETIRED,
  firstProblem,
  isCommonsFileName,
  isValidFactValue,
  newPlaceStanding,
  safeSearchVerdict,
  tidyName,
  tidyText,
  type ContactFactName,
  type ContactReportReason,
  type FactName,
  type FactValue,
  type NewPlaceReportReason,
  type PhotoHeldReason,
  type ReportFactName,
  type StoredFeedback,
} from "@opencampingdb/feedback";
import {
  decideContactReport,
  decideDoubt,
  decideFact,
  distinctSources as distinctDevices,
  factRefusal,
  factsClearedBy,
  heldForCheck,
  inWindow,
  newPlaceFields,
  newPlaceListing,
  protectedSource,
  restoreWeight,
  REVIEWED_FACTS,
  takenDownWhy,
  sameValue,
  sourceOf,
  weighFact,
  WINDOW_DAYS,
  type ItemDecision,
  type OpenDoubt,
} from "./decide.js";
import { moderateReview } from "./moderation.js";
import { mergePlaces, mergeProblem, type ClosedCase, type DoNotMatchEntry, type HeldCase } from "./review.js";
import type { EarlierFact } from "./io.js";
import type { MajorRoads } from "./roads.js";
import { roundCoord } from "./serialise.js";
import { doNotMatchProblems, newProblems, placeProblems, reviewProblems } from "./data-check.js";
import { dropSource, setSource } from "./sources.js";
import type { Photo, Place, RemovedPhotos, Review, Source, SourceKey } from "./types.js";

export type { ClosedCase, HeldCase };

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

/** The rules for one item against one place live in `decide.ts`, shared with the intake. */
export { inWindow, REVIEWED_FACTS, WINDOW_DAYS };
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;

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
/** The id a review gets from its feedback item: `rev_` and the item's ulid. */
export const reviewIdOf = (item: { id: string }) => `rev_${item.id.replace(/^fb_/, "")}`;

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
  /** On a photo held for a person: why, as photo progress names it. The inbox keeps it with the outcome. */
  held_reason?: PhotoHeldReason;
  /**
   * On the doubt that took a fact down: the fact, the value it had and the
   * date set on it. The inbox keeps it with the outcome, and later runs read
   * it back as the open `fact_doubted` case (see `openDoubt`).
   */
  doubted?: DoubtedRecord;
}

/** A fact doubts took down, as the inbox keeps it on the doubt that did it. */
export interface DoubtedRecord extends OpenDoubt {
  fact: FactName;
}

export interface Change {
  place: string;
  summary: string;
  /** False when a person has to check the change before merging. */
  automatic: boolean;
  feedback: string[];
  /** The photo a person has to look at, for a held photo: the review PR links a preview of it when it can. */
  photo?: string;
}

export interface RulesInput {
  /** Time of this run, ISO 8601 UTC. */
  now: string;
  pending: readonly StoredFeedback[];
  history: readonly StoredFeedback[];
  places: ReadonlyMap<string, Place>;
  /** Reviews already in the data for a place. */
  reviews: (placeId: string) => readonly Review[];
  /** Kind code to group, from `data/schema/kinds.json`. */
  kinds?: ReadonlyMap<string, string>;
  /** Contributors in `moderation/blocked_contributors.json`. */
  blocked?: ReadonlySet<string>;
  /** Review ids in `moderation/removed_reviews.json`: a person removed them, so they are never written again. */
  removedReviews?: ReadonlySet<string>;
  /** Contributors with a visible review in the data: their reviews are trusted. */
  reviewers?: ReadonlySet<string>;
  /**
   * Every review line in the data, when the run has a review erasure. The
   * places they are on must be in `places`, and `reviews` must answer for them.
   */
  allReviews?: readonly Review[];
  /** Every photo line in the data. None when left out. */
  photos?: readonly Photo[];
  /** Licence id written on new photo lines. Defaults to CC-BY-4.0. */
  photoLicence?: string;
  /** Every record in the data, for the duplicates check on new places. None when left out. */
  everyPlace?: readonly Place[];
  /** Pairs on `moderation/commons-do-not-match.json`: a Commons photo that is not of the place. None when left out. */
  doNotMatch?: readonly Pick<DoNotMatchEntry, "place" | "file">[];
  /** Pairs on `moderation/distinct_places.json`, as `pairKey` makes them: never merged. None when left out. */
  distinct?: ReadonlySet<string>;
  /**
   * The major roads in the data repository's geometry sidecar, for the rule
   * that keeps two places on opposite sides of a road apart. Left out, no
   * duplicate is merged without a reviewer.
   */
  roads?: MajorRoads;
  /**
   * Ids on the intake's recent list, or "unreadable" when the list was asked
   * for and could not be read. Feedback about a place on the list that is not
   * in the data yet waits for it, and with an unreadable list all feedback
   * about places not in the data waits. Left out, that feedback is refused.
   */
  recent?: ReadonlySet<string> | "unreadable";
  /**
   * Earlier values, from the data's history, of facts that pending doubts and
   * contact reports name and their place no longer has, by place id and fact.
   * When those reports take the earlier value down again, the takedown is
   * theirs: a run published it and stopped before it recorded its inbox
   * moves. They are decided as that run decided them. None when left out.
   */
  earlierFacts?: ReadonlyMap<string, ReadonlyMap<string, EarlierFact>>;
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
  /** Removes the contributor's held reviews from the review checkout. */
  | { kind: "review_erasure"; contributor: string; feedback: string }
  /** Removes the contributor's held photos from the review checkout. */
  | { kind: "photo_erasure"; contributor: string; feedback: string }
  /** Removes one held photo, at its contributor's request, from the review checkout. */
  | { kind: "photo_removal"; place: string; photo: string; feedback: string }
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
  /** Held cases the rules closed: a doubted fact restored or replaced. */
  closed: ClosedCase[];
  /** Held cases of takedowns already in the data (see `earlierFacts`), to list again although no file changes. */
  replayed: HeldCase[];
  /** New places withdrawn by their adder whose records are to be deleted from the data. */
  removed: string[];
  /** Place and Commons file pairs to add to `moderation/commons-do-not-match.json`. */
  doNotMatch: DoNotMatchEntry[];
  needsReview: boolean;
}

type ReportItem = Extract<StoredFeedback, { type: "report" }>;
type ReviewItem = Extract<StoredFeedback, { type: "review" }>;
type CheckItem = Extract<StoredFeedback, { type: "check" }>;
type ReviewReportItem = Extract<StoredFeedback, { type: "review_report" }>;
type PhotoItem = Extract<StoredFeedback, { type: "photo" }>;
type PhotoReportItem = Extract<StoredFeedback, { type: "photo_report" }>;
type ErasureItem = Extract<StoredFeedback, { type: "photo_erasure" }>;
type RemovalItem = Extract<StoredFeedback, { type: "photo_removal" }>;
type ReviewErasureItem = Extract<StoredFeedback, { type: "review_erasure" }>;

/** Reports from this many different contributors hide a review or a photo until a person decides. */
export const REPORTS_TO_HIDE = 3;

/**
 * How many independent reporters `reports` have: distinct contributors, but no
 * more than the distinct sources (networks, else devices) they came from, so
 * contributor ids made up on one network count once.
 */
function independentReporters(reports: readonly StoredFeedback[]): number {
  const counted = reports.filter((r) => r.contributor !== undefined);
  return Math.min(new Set(counted.map((r) => r.contributor)).size, new Set(counted.map(sourceOf)).size);
}
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

/** A photo upload's photo id: `pho_` and the item's ulid. */
export const photoIdOf = (item: Pick<StoredFeedback, "id">) => `pho_${item.id.replace(/^fb_/, "")}`;

/** The reason given for holding a photo for a person, by its held reason in photo progress. */
export const PHOTO_HELD_WHY = {
  same_file: "the same file was sent for another place",
  check_unavailable: "SafeSearch could not check it",
  safesearch: "SafeSearch rates it",
  first_photo: "first photo from this contributor",
} as const satisfies Partial<Record<PhotoHeldReason, string>>;

/** Whether a stored item was applied by the rules (not held for a person, not refused). */
function wasApplied(item: StoredFeedback): boolean {
  return (item as { outcome?: { result?: string } }).outcome?.result === "applied";
}

/** Review text with case, spacing and punctuation removed, to spot one text sent for several places. */
const sameText = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

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
/** A possible duplicate closer than this, with the same name and no major road between, is merged without anyone asked. */
export const MERGE_DISTANCE_M = 50;

/** Great-circle distance in metres, as the data repository's duplicates check works it out. */
function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

/**
 * Takes a fact off a place, with its source and date, as the data validator
 * requires, and `pets_months` with a `pets` fact. The inbox keeps what was
 * taken down on the item that did it.
 */
function takeDown(place: Place, fact: FactName): void {
  for (const gone of [fact, ...factsClearedBy(place.facts, fact, null)]) {
    delete (place.facts as Record<string, FactValue | undefined>)[gone];
    dropSource(place, gone);
  }
}

/** One key for a fact on a place. */
const factKey = (place: string, fact: string) => `${place}\u0000${fact}`;

/** `place` with `fact` set back to an earlier value, its source and its date, keeping the order of keys already there. */
function withEarlierFact(place: Place, fact: string, earlier: EarlierFact): Place {
  (place.facts as Record<string, FactValue>)[fact] = earlier.value;
  const sources = place.fact_sources as Record<string, Source>;
  if (earlier.source !== undefined) sources[fact] = earlier.source;
  else delete sources[fact];
  if (earlier.date !== undefined) place.fact_dates = Object.assign(place.fact_dates ?? {}, { [fact]: earlier.date });
  else if (place.fact_dates) delete (place.fact_dates as Record<string, string>)[fact];
  return place;
}

/** The text check a name or description report's value fails, or null when it passes. */
const textRulesFail = (kind: "name" | "description", value: string) => firstProblem(kind === "name" ? tidyName(value) : tidyText(value));

const quote = (text: string | undefined) => (text ? `: "${text}"` : "");

/** What a change that settles a `fact_doubted` case adds to its summary. */
const CLOSES_CASE = " (closes the fact_doubted case)";

/**
 * Decides every pending item and returns what the run writes. Every record,
 * review line and do-not-match pair bound for the automatic branch is checked
 * against the data repository's validator (`data-check.ts`). An item whose
 * result would fail it is set aside: decided `needs_review` with the reason,
 * listed for a person, and nothing is written for it. The items are decided
 * again without it, so one item never holds back the rest of the run.
 */
export function applyRules(input: RulesInput): RulesOutput {
  const setAside = new Map<string, string>();
  let out = rulesOnce(input, setAside);
  // Set aside every item behind a failing result, until none is left.
  for (let failing = dataCheckFailures(input, out); failing.size > 0; failing = dataCheckFailures(input, out)) {
    const before = setAside.size;
    for (const [id, reason] of failing) if (!setAside.has(id)) setAside.set(id, reason);
    if (setAside.size === before) break;
    out = rulesOnce(input, setAside);
  }
  if (setAside.size === 0) return out;
  // Then decide again each item that fails nothing on its own: only the items that cause a failure stay with a person.
  for (const id of [...setAside.keys()]) {
    const without = new Map(setAside);
    without.delete(id);
    const trial = rulesOnce(input, without);
    if (dataCheckFailures(input, trial).size === 0) {
      setAside.delete(id);
      out = trial;
    }
  }
  return rulesOnce(input, setAside);
}

/** Items deletion requests come from: always honoured, never set aside. */
const DELETIONS = new Set(["review_erasure", "photo_erasure", "photo_removal"]);

/**
 * The items behind each result in `out` that the data validator would refuse,
 * with the reason. Only problems the change brings count: a record that
 * already fails a check on main does not stop changes to it.
 */
function dataCheckFailures(input: RulesInput, out: RulesOutput): Map<string, string> {
  const failing = new Map<string, string>();
  const applied = new Set(out.decisions.filter((d) => d.outcome === "applied").map((d) => d.id));
  const pending = input.pending.filter((i) => applied.has(i.id) && !DELETIONS.has(i.type));
  const why = (problems: readonly string[]) => `the change would fail the data checks (${problems.join("; ")})`;
  const blame = (ids: Iterable<string>, problems: readonly string[]) => {
    for (const id of ids) if (!failing.has(id)) failing.set(id, why(problems));
  };
  const check = { now: input.now, ...(input.kinds ? { kinds: input.kinds } : {}) };
  for (const [id, place] of out.places) {
    const original = input.places.get(id);
    const problems = newProblems(original ? placeProblems(original, check) : [], placeProblems(place, check));
    if (problems.length === 0) continue;
    const behind = new Set(out.changes.filter((c) => c.automatic && c.place === id).flatMap((c) => c.feedback));
    blame(pending.filter((i) => behind.has(i.id) || out.decisions.some((d) => d.id === i.id && d.place === id)).map((i) => i.id), problems);
  }
  for (const [placeId, lines] of out.reviews) {
    const before = new Map(input.reviews(placeId).map((r) => [r.id, JSON.stringify(r)]));
    for (const line of lines) {
      if (before.get(line.id) === JSON.stringify(line)) continue;
      const problems = reviewProblems(line);
      if (problems.length > 0) blame(pending.filter((i) => i.type === "review" && reviewIdOf(i) === line.id).map((i) => i.id), problems);
    }
  }
  for (const entry of out.doNotMatch) {
    const problems = doNotMatchProblems(entry);
    if (problems.length === 0) continue;
    blame(pending.filter((i) => i.type === "report" && i.report.kind === "commons_mismatch" && i.place === entry.place && i.report.file === entry.file).map((i) => i.id), problems);
  }
  return failing;
}

function rulesOnce(input: RulesInput, setAside: ReadonlyMap<string, string>): RulesOutput {
  const now = Date.parse(input.now);
  const nowIso = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const decisions = new Map<string, Decision>();
  const working = new Map<string, Place>();
  const newReviews = new Map<string, Review[]>();
  const changes: Change[] = [];
  const edits: ReviewEdit[] = [];
  const held: HeldCase[] = [];
  const closed: ClosedCase[] = [];
  const replayed: HeldCase[] = [];
  const removed: string[] = [];
  let everyPlaceById: Map<string, Place> | undefined;
  const doNotMatch: DoNotMatchEntry[] = [];

  const decide = (item: StoredFeedback, outcome: Outcome, reason: string, heldReason?: PhotoHeldReason) => {
    decisions.set(item.id, { id: item.id, place: item.place, outcome, reason, ...(heldReason ? { held_reason: heldReason } : {}) });
  };
  const record = (id: string): Place => {
    const existing = working.get(id);
    if (existing) return existing;
    const copy = structuredClone(input.places.get(id)!);
    working.set(id, copy);
    return copy;
  };
  const note = (place: string, summary: string, automatic: boolean, feedback: readonly StoredFeedback[], photo?: string) => {
    changes.push({ place, summary, automatic, feedback: feedback.map((f) => f.id), ...(photo ? { photo } : {}) });
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
  // An erasure stands for the history window: each contributor's latest review
  // and photo erasure, from this run and from applied erasures in the history.
  const erasedUpTo = (type: "review_erasure" | "photo_erasure") => {
    const at = new Map<string, number>();
    for (const i of [...input.history.filter(wasApplied), ...pending]) {
      if (i.type === type && i.contributor !== undefined) at.set(i.contributor, Math.max(at.get(i.contributor) ?? 0, time(i)));
    }
    return at;
  };
  const reviewsErasedUpTo = erasedUpTo("review_erasure");
  const photosErasedUpTo = erasedUpTo("photo_erasure");
  const newPlaceEvidence: StoredFeedback[] = [];
  const known: StoredFeedback[] = [];
  // Items about a place that is not in the data yet, left waiting for it.
  const waitingForData = new Set<string>();
  for (const item of pending) {
    // Fee reports are no longer collected. One sent before the intake refused them is refused here.
    if ((item as { type: string }).type === "fee") {
      decide(item, "refused", FEE_RETIRED);
      continue;
    }
    // An item whose result would fail the data checks waits for a person, and nothing is written for it.
    const asideFor = setAside.get(item.id);
    if (asideFor !== undefined) {
      const placeId = isNewPlaceReport(item) ? newPlaceIdOf(item) : (item.place ?? "(none)");
      edits.push({ kind: "note", place: placeId, feedback: item.id });
      note(placeId, `${item.type} ${asideFor}: decide it by hand`, false, [item]);
      decide(item, "needs_review", `${asideFor}, so a person decides`);
      continue;
    }
    // A deletion request about the contributor's own photos or reviews is honoured even when they are blocked.
    if (item.contributor !== undefined && blocked.has(item.contributor) && !DELETIONS.has(item.type)) {
      if (item.type === "photo_report" && item.withheld === true && item.place !== null) {
        // The intake withheld the photo on this report, so a person releases it rather than nobody.
        edits.push({ kind: "note", place: item.place, feedback: item.id });
        note(
          item.place,
          `photo ${item.photo_report.photo} was withheld at once by a report from a blocked contributor: ` +
            "delete its withheld key to release it, unless it should stay down",
          false,
          [item],
        );
        decide(item, "needs_review", "a withheld report from a blocked contributor");
        continue;
      }
      decide(item, "refused", "the contributor is blocked");
      continue;
    }
    if (item.type === "review" && input.removedReviews?.has(reviewIdOf(item))) {
      decide(item, "refused", "the review was removed by a moderator");
      continue;
    }
    // A review or photo sent at or before the contributor's erasure is refused whichever run decides it,
    // before it can be left waiting. A refused upload's files go on the removed list below.
    const erasedAt =
      item.contributor === undefined
        ? undefined
        : item.type === "review"
          ? reviewsErasedUpTo.get(item.contributor)
          : item.type === "photo"
            ? photosErasedUpTo.get(item.contributor)
            : undefined;
    if (erasedAt !== undefined && time(item) <= erasedAt) {
      decide(item, "refused", item.type === "review" ? "the contributor's reviews were erased at their request" : "the contributor asked for their photos to be removed");
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
    // New places, and erasures, which name no place.
    const isNewPlace = (item.type === "report" && item.report.kind === "new_place") || item.type === "photo_erasure" || item.type === "review_erasure";
    if (isNewPlace) {
      known.push(item);
      continue;
    }
    const target = resolvePlace(item.place, input.places);
    const unknown = item.place !== null && !input.places.has(item.place);
    const recent = input.recent;
    if (unknown && origins.has(item.place!)) {
      // A new place added in this run, or held for a person, is not in the data yet.
      decide(item, "waiting", `place ${item.place} is a new place not in the data yet`);
      waitingForData.add(item.id);
    } else if (unknown && recent === "unreadable") {
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

  // Erasures first, so a review the contributor sent before erasing is refused in this run too.
  // A review sent at or before an erasure was refused above (reviewsErasedUpTo), this run's erasures included.
  applyReviewErasures(known.filter((i): i is ReviewErasureItem => i.type === "review_erasure"));
  applyReviews(known.filter((i): i is ReviewItem => i.type === "review"));
  applyReviewReports(known.filter((i): i is ReviewReportItem => i.type === "review_report"));
  for (const placeId of changedReviews) {
    const lines = linesOf(placeId).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    newReviews.set(placeId, lines);
    record(placeId).rating = ratingOf(lines.filter((r) => isVisible(r, blocked)));
  }
  // Erasures first, so a photo sent in the same run by an erased contributor is refused.
  const erased = applyErasures(known.filter((i): i is ErasureItem => i.type === "photo_erasure"));
  applyPhotos(known.filter((i): i is PhotoItem => i.type === "photo"), erased);
  // After photos, so a photo accepted or held in this run can be removed in it too.
  applyPhotoRemovals(known.filter((i): i is RemovalItem => i.type === "photo_removal"));
  applyPhotoReports(known.filter((i): i is PhotoReportItem => i.type === "photo_report"));
  for (const lines of newPhotos.values()) lines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  applyStatus(
    known.filter(
      (i): i is ReportItem | CheckItem =>
        i.type === "check" || (i.type === "report" && (i.report.kind === "closed" || i.report.kind === "reopened")),
    ),
  );
  // Doubts before facts, so a confirmation sent after a takedown in this run can restore it.
  const downInRun = new Map<string, DoubtedRecord>();
  applyDoubts(known.filter((i): i is ReportItem => i.type === "report" && i.report.kind === "doubt"));
  applyFacts(known.filter((i): i is ReportItem => i.type === "report" && i.report.kind === "fact"));
  applyNewPlaces(known.filter((i): i is ReportItem => isNewPlaceReport(i)), newPlaceEvidence);
  applyContactReports(known.filter((i): i is ReportItem => i.type === "report" && i.report.kind === "contact"));
  applyCommonsReports(known.filter((i): i is ReportItem => i.type === "report" && i.report.kind === "commons_mismatch"));
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
    photos: newPhotos,
    removedPhotos,
    doNotMatch,
    edits,
    changes,
    held,
    closed,
    replayed,
    removed,
    needsReview: ordered.some((d) => d.outcome === "needs_review"),
  };

  /**
   * Removes every review line from each erasing contributor, on every place,
   * and their held reviews from the review checkout. Answers, by contributor,
   * the time of their latest erasure: reviews they sent before it are refused.
   */
  function applyReviewErasures(items: ReviewErasureItem[]): void {
    for (const item of items) {
      const contributor = item.contributor;
      if (contributor === undefined) {
        decide(item, "refused", "erasure has no contributor");
        continue;
      }
      let count = 0;
      const placesWith = new Set((input.allReviews ?? []).filter((r) => r.contributor === contributor).map((r) => r.place));
      for (const placeId of placesWith) {
        if (!input.places.has(placeId)) continue;
        const lines = linesOf(placeId);
        for (const r of lines.filter((l) => l.contributor === contributor)) {
          lines.splice(lines.indexOf(r), 1);
          count += 1;
        }
        changedReviews.add(placeId);
      }
      edits.push({ kind: "review_erasure", contributor, feedback: item.id });
      note("(all places)", `reviews from ${contributor} removed at their request (${count} published)`, true, [item]);
      decide(item, "applied", `reviews removed at the contributor's request, ${count} published`);
    }
  }

  function applyReviews(items: ReviewItem[]): void {
    // Trust comes from a visible review in the data or an applied review, and from no other kind of feedback.
    const trusted = new Set(input.reviewers ?? []);
    for (const h of input.history) if (h.type === "review" && h.contributor !== undefined && wasApplied(h)) trusted.add(h.contributor);
    const reviewsSent = [...input.history, ...items].filter((i): i is ReviewItem => i.type === "review");
    // The item each review line came from, while it is in the history or this run.
    const senderOf = new Map(reviewsSent.map((i) => [reviewIdOf(i), i]));
    // A review replaces the contributor's earlier one by itself only when the app's server proved the
    // contributor, or when it comes from the device or attested key that sent each review it replaces.
    const sameSender = (item: ReviewItem, line: Review) => {
      const from = senderOf.get(line.id);
      return from !== undefined && (from.device === item.device || (from.attest_key !== undefined && from.attest_key === item.attest_key));
    };

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
      const reviewId = reviewIdOf(item);
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
      const unproved = item.proved !== true && lines.some((r) => r.contributor === item.contributor && !sameSender(item, r));
      if (repeated || !trusted.has(item.contributor) || unproved) {
        const why = repeated ? "the same text was sent for another place" : !trusted.has(item.contributor) ? "first review from this contributor" : "it replaces the contributor's earlier review from another device";
        edits.push({ kind: "review", place: item.place, review, feedback: item.id });
        // The public PR names the inbox item and never quotes the text, so an erasure or removal leaves no copy there.
        note(item.place, `${item.review.stars} star review, ${why} (read its text in the inbox item before merging)`, false, [item]);
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

  /**
   * Removes one photo at its own contributor's request: its line in the data,
   * or the held photo on the review branch, and its files. A removal from
   * anyone else is refused.
   */
  function applyPhotoRemovals(items: RemovalItem[]): void {
    for (const item of items) {
      const photoId = item.photo_removal.photo;
      // The line stays filed under the place it was sent for, which may since have been merged into this one.
      const filedUnder = (input.photos ?? []).find((p) => p.id === photoId)?.place ?? item.place;
      const lines = photoLinesOf(filedUnder);
      const line = lines.find((p) => p.id === photoId);
      // A photo not in the lines may be held for a person, or sent in this run.
      const upload = [...input.history, ...pending].find((h): h is PhotoItem => h.type === "photo" && photoIdOf(h) === photoId);
      const owner = line?.contributor ?? upload?.contributor;
      const sentFor = line ? filedUnder : upload?.place;
      const at = sentFor === undefined || sentFor === null ? undefined : (resolvePlace(sentFor, input.places) ?? sentFor);
      if (owner === undefined || at !== item.place) {
        decide(item, "refused", `photo ${photoId} is not in the data for this place`);
        continue;
      }
      if (item.contributor === undefined || owner !== item.contributor) {
        decide(item, "refused", "only the photo's contributor can remove it");
        continue;
      }
      if (line) lines.splice(lines.indexOf(line), 1);
      else edits.push({ kind: "photo_removal", place: item.place, photo: photoId, feedback: item.id });
      removePhoto(photoId, "removed");
      note(item.place, `photo ${photoId} removed at its contributor's request`, true, [item]);
      decide(item, "applied", "photo removed at its contributor's request");
    }
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
        const held: keyof typeof PHOTO_HELD_WHY = repeated ? "same_file" : flagged ? (rated === "unchecked" ? "check_unavailable" : "safesearch") : "first_photo";
        const why =
          held === "safesearch" && rated !== undefined && rated !== "unchecked"
            ? `${PHOTO_HELD_WHY.safesearch} adult ${rated.adult}, violence ${rated.violence}, racy ${rated.racy}`
            : PHOTO_HELD_WHY[held];
        edits.push({ kind: "photo", place: item.place, photo, feedback: item.id });
        note(item.place, `photo ${photoId} (${photo.width} x ${photo.height}), ${why} (look at it before merging)`, false, [item], photoId);
        decide(item, "needs_review", `${why}, so a person checks it`, held);
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
      if (!target || target.contributor === item.contributor) {
        const cannotAct = !target ? `photo ${photoId} is not in the data for this place` : "a contributor cannot report their own photo";
        if (item.withheld === true) {
          // The intake withheld the photo on this report, so a person decides rather than nobody.
          edits.push({ kind: "note", place: item.place, feedback: item.id });
          note(
            item.place,
            `photo ${photoId} was withheld at once by a ${reason} report the rules cannot act on (${cannotAct}): ` +
              "delete its withheld key to release it, unless it should stay down",
            false,
            [item],
          );
          decide(item, "needs_review", `a withheld report the rules cannot act on: ${cannotAct}`);
        } else {
          decide(item, "refused", cannotAct);
        }
        continue;
      }
      reportsSent.push(item);
      edits.push({ kind: "note", place: item.place, feedback: item.id });
      // One report hides a photo at once only from an attested install or from the photo's own app.
      const vouched = item.attested !== undefined || item.app === target.app;
      const release = item.withheld === true ? ": delete its withheld key to release it, unless it should stay down" : "";
      const unvouched = !vouched && (reason === "illegal" || item.withheld === true);
      if (!unvouched && reason === "illegal") {
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
      if (!unvouched && item.withheld === true) {
        // A reason on the photo service's withhold list: the intake withheld the photo on this first report.
        if (target.hidden === undefined) target.hidden = "reported";
        note(
          item.place,
          `photo ${photoId} reported as ${reason}, hidden and withheld until a person decides ` +
            "(release it: remove `hidden` and delete its withheld key; or remove it, or block the contributor)",
          false,
          [item],
        );
        decide(item, "needs_review", `a ${reason} report withholds the photo at once and is read by a person`);
        continue;
      }
      if (unvouched) {
        note(
          item.place,
          `${reason === "illegal" ? "URGENT: " : ""}photo ${photoId} reported as ${reason} from another app without attestation, so not hidden at once` +
            `${release} (decide: keep, hide, remove or block the contributor)`,
          false,
          [item],
        );
        decide(item, "needs_review", `a ${reason} report from another app without attestation is read by a person`);
      } else {
        note(item.place, `photo ${photoId} reported as ${reason} (decide: keep, hide, remove or block the contributor)`, false, [item]);
        decide(item, "needs_review", "photo reports are read by a person");
      }
      const reporters = independentReporters(reportsSent.filter((r) => r.photo_report.photo === photoId));
      if (target.hidden === undefined && reporters >= REPORTS_TO_HIDE) {
        target.hidden = "reported";
        note(
          item.place,
          `photo ${photoId} hidden after reports from ${reporters} contributors, until a person decides`,
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

      const reporters = independentReporters(reportsSent.filter((r) => r.review_report.review === reviewId));
      if (target.hidden === undefined && reporters >= REPORTS_TO_HIDE) {
        target.hidden = "reported";
        changedReviews.add(item.place);
        note(
          item.place,
          `review ${reviewId} hidden after reports from ${reporters} contributors, until a person decides`,
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

  /**
   * The open `fact_doubted` case for a fact, when doubts took it down and
   * nothing has set or removed it since: the takedown in this run, or the
   * latest one the inbox keeps on a doubt applied in the last 90 days, with no
   * fact or contact report about the fact applied after it. The inbox is the apply's own record, read
   * every run over the same 90 days the doubts count for; the review PR can
   * be edited, merged or closed, and lists a case only until it is.
   */
  function openDoubt(placeId: string, fact: FactName, place: Place): OpenDoubt | undefined {
    if ((place.facts as Record<string, unknown>)[fact] !== undefined) return undefined;
    let found = downInRun.get(factKey(placeId, fact));
    if (found === undefined) {
      for (const h of input.history) {
        const kept = (h as { outcome?: { doubted?: DoubtedRecord } }).outcome?.doubted;
        if (h.place !== placeId || kept?.fact !== fact || !wasApplied(h)) continue;
        if (found === undefined || kept.at > found.at) found = kept;
      }
    }
    if (found === undefined) return undefined;
    // A report applied after the takedown set the fact again, so a later change took it off: that takedown's case is over.
    const setSince = input.history.some(
      (h) => h.type === "report" && h.place === placeId && h.report.fact === fact && (h.report.kind === "fact" || h.report.kind === "contact") && wasApplied(h) && h.received > found!.at,
    );
    return setSince ? undefined : { value: found.value, at: found.at };
  }

  /** Fact reports about a place applied in earlier runs. */
  function factHistory(placeId: string, fact: string): ReportItem[] {
    return input.history.filter(
      (h): h is ReportItem => h.type === "report" && h.report.kind === "fact" && h.place === placeId && h.report.fact === fact && wasApplied(h),
    );
  }

  function applyFacts(items: ReportItem[]): void {
    const groups = new Map<string, ReportItem[]>();
    for (const item of items) {
      const refusal = factRefusal(item);
      if (refusal !== null) {
        decide(item, "refused", refusal.why);
        continue;
      }
      const key = factKey(item.place as string, item.report.fact as string);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }

    // pets_months last, so it is decided against the pets this run leaves.
    const ordered = [...groups.values()].sort((a, b) => Number(a[0]!.report.fact === "pets_months") - Number(b[0]!.report.fact === "pets_months"));
    for (const reports of ordered) {
      const placeId = reports[0]!.place as string;
      const fact = reports[0]!.report.fact as FactName;
      const place = record(placeId);
      const current = () => (place.facts as Record<string, unknown>)[fact];
      const setFact = (value: FactValue) => {
        for (const cleared of factsClearedBy(place.facts, fact, value)) {
          delete (place.facts as Record<string, FactValue | undefined>)[cleared];
          dropSource(place, cleared);
        }
        (place.facts as Record<string, FactValue>)[fact] = value;
        setSource(place, fact, "feedback", nowIso);
      };

      // The shared rules decide each report on its own: an attested report, a
      // contact fact's report and a report of the value the place already has.
      const evidence = [...factHistory(placeId, fact), ...reports];
      const settle = (item: ReportItem, decision: ItemDecision) => {
        const value = item.report.value as FactValue;
        if (decision.verdict === "refused") {
          decide(item, "refused", decision.why);
          return;
        }
        const check = heldForCheck(item);
        if (decision.verdict === "live" && decision.changes.length > 0 && check !== null) {
          edits.push({ kind: "fact", place: placeId, fact, value, feedback: item.id });
          note(placeId, `${fact} set to ${JSON.stringify(value)}, which the intake held for ${check} (check before merging)`, false, [item]);
          decide(item, "needs_review", `the intake held it for ${check}, so a person checks it`);
          return;
        }
        if (decision.verdict === "live") {
          if (decision.changes.length > 0) {
            setFact(value);
            note(placeId, `${fact} set to ${JSON.stringify(value)} (one attested report)`, true, [item]);
          }
          decide(item, "applied", decision.why);
          return;
        }
        const summary =
          decision.reason === "owner_value"
            ? `${fact}: a device reports ${JSON.stringify(value)}, the owner set ${JSON.stringify(current())}`
            : decision.reason === "link_check"
              ? `${fact} set to ${JSON.stringify(value)}, which fails the link checks: ${decision.problem} (check before merging)`
              : decision.reason === "disagreement"
                ? `${fact} set to ${JSON.stringify(value)}, which another device disagrees with (check before merging)`
                : `${fact} set to ${JSON.stringify(value)} (check before merging)`;
        edits.push({ kind: "fact", place: placeId, fact, value, feedback: item.id });
        note(placeId, summary, false, [item]);
        decide(item, "needs_review", decision.why);
      };

      if (REVIEWED_FACTS.has(fact)) {
        for (const item of reports) settle(item, decideFact({ item, place, earlier: evidence }));
        continue;
      }

      // A fact doubts took down: confirmations of its value restore it, and another value replaces it.
      let openCase = openDoubt(placeId, fact, place);
      // Every fact report and doubt not refused, which `restoreWeight` weighs as the intake does.
      const restoreEvidence = [...input.history, ...known].filter(
        (r) =>
          r.type === "report" &&
          (r.report.kind === "doubt" || r.report.kind === "fact") &&
          r.place === placeId &&
          r.report.fact === fact &&
          decisions.get(r.id)?.outcome !== "refused",
      );
      const closeCase = (settles: ClosedCase["settles"], by: readonly StoredFeedback[]) => {
        closed.push({ case: "fact_doubted", place: placeId, fact, settles, feedback: by.map((r) => r.id) });
        openCase = undefined;
      };

      // A report without attestation of any other fact waits for a second device to agree.
      const open = new Set(reports);
      for (const item of reports) {
        if (!open.has(item)) continue;
        const value = item.report.value as FactValue;
        if (openCase !== undefined && sameValue(value, openCase.value)) {
          open.delete(item);
          if (time(item) <= Date.parse(openCase.at)) {
            // Weighed against the doubts when they took the fact down in this run.
            decide(item, "applied", `counted as a confirmation of ${fact} before doubts took it down`);
            continue;
          }
          const decision = decideFact({ item, place, earlier: restoreEvidence, openCase });
          if (decision.verdict === "live" && decision.settles === "restored" && heldForCheck(item) === null) {
            const weight = restoreWeight({ place: placeId, fact, value, at: item.received, reports: restoreEvidence, takenDownAt: openCase.at });
            const counted = new Set(weight.confirmations.feedback);
            const confirming = reports.filter((r) => counted.has(r.id));
            setFact(value);
            note(placeId, `${decision.why}${CLOSES_CASE}`, true, confirming);
            for (const r of confirming) {
              open.delete(r);
              decide(r, "applied", decision.why);
            }
            closeCase("restored", confirming);
            continue;
          }
          if (decision.verdict === "held" && decision.reason === "taken_down") {
            open.add(item);
            continue;
          }
          settle(item, decision);
          continue;
        }
        const decision = decideFact({ item, place, earlier: evidence, ...(openCase !== undefined ? { openCase } : {}) });
        if (decision.verdict !== "held" || decision.reason !== "not_attested") {
          open.delete(item);
          settle(item, decision);
          if (decision.verdict === "live" && decision.settles === "replaced" && decisions.get(item.id)?.outcome === "applied") {
            changes[changes.length - 1]!.summary += CLOSES_CASE;
            closeCase("replaced", [item]);
          }
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
          `${fact} set to ${JSON.stringify(value)} (${distinctDevices(agreeing)} devices within ${WINDOW_DAYS} days)${openCase !== undefined ? CLOSES_CASE : ""}`,
          true,
          agreeing,
        );
        if (openCase !== undefined) closeCase("replaced", agreeing);
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
      for (const item of open) {
        decide(item, "waiting", openCase !== undefined && sameValue(item.report.value, openCase.value) ? takenDownWhy(fact) : `waiting for a second device to agree on ${fact}`);
      }
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
          contributor: { device: origin.device, source: sourceOf(origin), blocked: isBlocked, firstPlace },
          checks: items
            .filter((i): i is CheckItem => i.type === "check")
            .map((c) => ({ device: c.device, source: sourceOf(c), stillThere: c.check.still_there, nearby: c.check.nearby === true, day: c.received })),
          reports: items
            .filter((i): i is ReportItem => i.type === "report")
            .map((r) => ({ device: r.device, source: sourceOf(r), reason: r.report.reason as NewPlaceReportReason, day: r.received })),
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
      // Contact facts and the address. A published place carries those that pass
      // the link and spam checks; the rest wait for a person. A draft for a person carries them all.
      const { contacts: heldFacts, failing, descriptionProblem } = newPlaceFields(origin);
      const contacts = Object.keys(heldFacts) as (keyof typeof heldFacts)[];
      const where = `${origin.location!.lat}, ${origin.location!.lon}`;
      const against = [...earlier, ...mine].filter((i) => i.type === "report" || (i.type === "check" && !i.check.still_there));
      const reasons = [...new Set(against.map((i) => (i.type === "report" ? i.report.reason! : "not_there")))].sort();
      const caseFor = (kind: HeldCase["case"], feedback: readonly StoredFeedback[]): HeldCase => ({
        case: kind,
        place: id,
        standing: standing as NonNullable<HeldCase["standing"]>,
        location: { lat: roundCoord(origin.location!.lat), lon: roundCoord(origin.location!.lon) },
        kind: (existing ?? draftOf(origin)).kind,
        ...(kind === "duplicate" && duplicate ? { duplicate_of: duplicate.place, distance_m: duplicate.distance } : {}),
        ...(kind === "hidden" ? (isBlocked ? { blocked: true as const } : { reports: new Set(against.map((i) => i.device)).size, reasons }) : {}),
        ...(kind === "contacts" ? { contacts: failing } : {}),
        ...(kind === "description" && descriptionProblem !== null ? { problem: descriptionProblem } : {}),
        ...(kind === "first_place" && origin.contributor ? { contributor: origin.contributor } : {}),
        feedback: feedback.map((f) => f.id),
      });

      // A duplicate the rules settle: merged into the place it duplicates, with no one asked.
      const target = isPending && !existing && standing === "held" && unlisted === undefined && duplicate ? mergeTarget(origin, duplicate.place) : undefined;
      if (target) {
        const draft: Place = { ...draftOf(origin), standing };
        for (const fact of contacts) {
          if (failing.includes(fact)) continue;
          (draft.facts as Record<string, FactValue>)[fact] = heldFacts[fact]!;
          setSource(draft, fact, "feedback", nowIso);
        }
        const { kept, tombstone } = mergePlaces(working.get(target.place.id) ?? structuredClone(target.place), draft, nowIso);
        working.set(kept.id, kept);
        working.set(id, tombstone);
        const why = `new place merged into ${kept.id}: the same name, ${target.distance} m away, in the same group, with no major road between`;
        note(id, `${why} (to undo: set status back to open, remove merged_into, and list the pair in moderation/distinct_places.json)`, true, [origin]);
        decide(origin, "applied", why);
        continue;
      }

      if (existing || published) {
        if (existing) {
          const place = record(id);
          place.standing = standing;
          if (before !== standing) note(id, `standing ${before ?? "(none)"} to ${standing}`, true, mine);
          if (isPending) decide(origin, "applied", `new place is already in the data, ${standing}`);
        } else {
          const draft: Place = { ...draftOf(origin), standing };
          for (const fact of contacts) {
            if (failing.includes(fact)) continue;
            (draft.facts as Record<string, FactValue>)[fact] = heldFacts[fact]!;
            setSource(draft, fact, "feedback", nowIso);
          }
          working.set(id, draft);
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
      if (isPending && published && failing.length > 0) held.push(caseFor("contacts", [origin]));
      if (isPending && published && descriptionProblem !== null) held.push(caseFor("description", [origin]));
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

  /** Why the intake would not list a new place or did not, or undefined when it would. */
  function whyNotListed(item: ReportItem): string | undefined {
    const check = heldForCheck(item);
    return newPlaceListing(item)?.why ?? (check === null ? undefined : `held by the intake for ${check}`);
  }

  /** A new place's record as its report describes it, with no standing yet. */
  function draftOf(item: ReportItem): Place {
    const picked = item.report.place_kind;
    const pickedGroup = picked === undefined ? undefined : input.kinds?.get(picked);
    const name = item.report.name ?? null;
    const draft: Place = {
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
    const { fee, description } = newPlaceFields(item);
    if (fee !== undefined) {
      draft.facts.fee = fee;
      setSource(draft, "fee", "feedback", nowIso);
    }
    // The description is written as the text checks read it, and left off when it fails them.
    if (description !== undefined) {
      draft.description = description;
      setSource(draft, "description", "feedback", nowIso);
    }
    return draft;
  }

  /**
   * Reports that a contact on a place is wrong or spam. One source sends it to
   * a person. Reports from two sources within 90 days, at least one attested,
   * take the contact off the place at once and list a `contact_withdrawn`
   * case for a reviewer. A contact the owner set is left to a person, and a
   * report about a contact the place does not have is refused. Reports sent
   * before the contact was last set are about an older value and do not count.
   */
  function applyContactReports(items: ReportItem[]): void {
    const takenDown = new Map<string, HeldCase>();
    const again = replayTakedowns(items, (item, place) => {
      const earlier = [...input.history, ...items].filter((r) => r === item || decisions.get(r.id)?.outcome !== "refused");
      const decision = decideContactReport({ item, place, earlier });
      return decision.verdict === "live" && decision.takedown !== undefined && heldForCheck(item) === null;
    });
    // What a single report sent to a person, to take back if a later report in this run takes the contact down.
    const sentToPerson = new Map<string, { edit: ReviewEdit; change: Change }>();
    for (const item of items) {
      const placeId = item.place as string;
      const fact = item.report.fact as ContactFactName;
      const reason = item.report.reason as ContactReportReason;
      const key = factKey(placeId, fact);
      const done = takenDown.get(key);
      if (done) {
        done.feedback.push(item.id);
        if (!done.reasons!.includes(reason)) done.reasons!.push(reason);
        done.reasons!.sort();
        decide(item, "applied", `${fact} was taken down after reports from two sources`);
        continue;
      }
      const place = record(placeId);
      // Reports refused earlier in this run do not count.
      const earlier = [...input.history, ...items].filter((r) => r === item || decisions.get(r.id)?.outcome !== "refused");
      const decision = decideContactReport({ item, place, earlier });
      if (decision.verdict === "refused") {
        decide(item, "refused", decision.why);
        continue;
      }
      if (decision.verdict === "held" && decision.reason === "owner_value") {
        edits.push({ kind: "note", place: placeId, feedback: item.id });
        note(placeId, `${fact} reported as ${reason}, but the owner set it (decide: keep it or remove it)`, false, [item]);
        decide(item, "needs_review", decision.why);
        continue;
      }
      // A report the intake held for a check takes nothing down on its own, though it still counts as a source.
      const check = heldForCheck(item);
      if (decision.verdict === "live" && decision.takedown && check === null) {
        const { value, sources, reasons, feedback } = decision.takedown;
        const reports = earlier.filter((r) => feedback.includes(r.id));
        takeDown(place, fact);
        note(placeId, `${fact} taken down after reports from ${sources} sources within ${WINDOW_DAYS} days (${reasons.join(", ")})`, true, reports);
        for (const r of reports) {
          if (!items.includes(r as ReportItem) || heldForCheck(r) !== null) continue;
          const sent = sentToPerson.get(r.id);
          if (sent) {
            edits.splice(edits.indexOf(sent.edit), 1);
            changes.splice(changes.indexOf(sent.change), 1);
          }
          decide(r, "applied", decision.why);
        }
        const heldCase: HeldCase = {
          case: "contact_withdrawn",
          place: placeId,
          ...(place.standing !== undefined ? { standing: place.standing } : {}),
          location: { lat: roundCoord(place.location.lat), lon: roundCoord(place.location.lon) },
          kind: place.kind,
          fact,
          value,
          reasons,
          feedback: [...feedback],
        };
        held.push(heldCase);
        if (again.has(key)) replayed.push(heldCase);
        takenDown.set(key, heldCase);
        continue;
      }
      const edit: ReviewEdit = { kind: "note", place: placeId, feedback: item.id };
      edits.push(edit);
      const heldBy = check === null ? "" : `, held by the intake for ${check}`;
      note(placeId, `${fact} reported as ${reason}${heldBy} (decide: keep it or remove it)`, false, [item]);
      sentToPerson.set(item.id, { edit, change: changes[changes.length - 1]! });
      decide(item, "needs_review", check === null ? decision.why : `the intake held it for ${check}, so a person checks it`);
    }
  }

  /**
   * Doubts that a fact on a place is right, from travellers who don't know the
   * right value. Doubts from two sources within 90 days, at least one attested
   * and more than the sources confirming the value, take the fact off the place
   * at once, with its source and date (and `pets_months` with `pets`), and list a `fact_doubted`
   * case. Doubts that leave the fact on the place (one source, none attested,
   * as many confirmations or more, or a fact from OSM or the owner) go to a
   * reviewer as one `fact_doubted` case for the place and fact. A doubt about
   * a fact the place does not have is refused. A doubt's note is
   * for reviewers in the inbox and never reaches the PR.
   */
  function applyDoubts(items: ReportItem[]): void {
    const takenDown = new Map<string, HeldCase>();
    // What a doubt sent to a person, to take back if a later doubt in this run takes the fact down.
    const sentToPerson = new Map<string, { edit: ReviewEdit; change: Change }>();
    // The case for a fact that stays, one for each place and fact, with every doubt weighed so far.
    const stays = new Map<string, HeldCase>();
    const dropStays = (key: string) => {
      const listed = stays.get(key);
      if (listed !== undefined && held.includes(listed)) held.splice(held.indexOf(listed), 1);
      stays.delete(key);
    };
    const evidence = (item: ReportItem) =>
      [...input.history, ...known].filter(
        (r) => r === item || (r.type === "report" && (r.report.kind === "doubt" || r.report.kind === "fact") && decisions.get(r.id)?.outcome !== "refused"),
      );
    const takesDown = (item: ReportItem, place: Place) => {
      const decision = decideDoubt({ item, place, earlier: evidence(item) });
      return (
        decision.verdict === "live" &&
        decision.doubtTakedown !== undefined &&
        heldForCheck(item) === null &&
        isValidFactValue(decision.doubtTakedown.fact as ReportFactName, decision.doubtTakedown.value)
      );
    };
    const again = replayTakedowns(items, takesDown);
    for (const item of items) {
      const placeId = item.place as string;
      const fact = item.report.fact as FactName;
      const key = factKey(placeId, fact);
      const downCase = takenDown.get(key);
      if (downCase) {
        downCase.doubts!.push(item.id);
        downCase.feedback.push(item.id);
        decide(item, "applied", `${fact} was taken down after doubts from two sources`);
        continue;
      }
      const place = record(placeId);
      const earlier = evidence(item);
      const weighed = decideDoubt({ item, place, earlier });
      // The intake takes a doubt case only for a value its checks accept, so a reviewer decides on any other value.
      const decision: ItemDecision =
        weighed.verdict === "live" && weighed.doubtTakedown && !isValidFactValue(fact as ReportFactName, weighed.doubtTakedown.value)
          ? { verdict: "held", reason: "disagreement", why: `${fact} holds a value the intake's checks refuse, so a reviewer decides` }
          : weighed;
      if (decision.verdict === "refused") {
        decide(item, "refused", decision.why);
        continue;
      }
      // A doubt the intake held for a check takes nothing down on its own, though it still counts as a source.
      const check = heldForCheck(item);
      if (decision.verdict === "live" && decision.doubtTakedown && check === null) {
        const { value, sources, doubts, confirmations } = decision.doubtTakedown;
        takeDown(place, fact);
        const counted = earlier.filter((r) => doubts.includes(r.id));
        note(placeId, `${fact} taken down after doubts from ${sources} sources within ${WINDOW_DAYS} days`, true, counted);
        for (const r of counted) {
          if (!items.includes(r as ReportItem) || heldForCheck(r) !== null) continue;
          const sent = sentToPerson.get(r.id);
          if (sent) {
            edits.splice(edits.indexOf(sent.edit), 1);
            changes.splice(changes.indexOf(sent.change), 1);
          }
          decide(r, "applied", decision.why);
        }
        dropStays(key);
        const kept: DoubtedRecord = { fact, value, at: item.received };
        const taken = decisions.get(item.id);
        if (taken) taken.doubted = kept;
        downInRun.set(key, kept);
        const heldCase = doubtCase(placeId, place, fact, value, true, sources, doubts, confirmations);
        held.push(heldCase);
        if (again.has(key)) replayed.push(heldCase);
        takenDown.set(key, heldCase);
        continue;
      }
      const edit: ReviewEdit = { kind: "note", place: placeId, feedback: item.id };
      edits.push(edit);
      note(placeId, `${fact} doubted${whyDoubtStays(decision, check, protectedSource(place, fact))} (decide: keep it or remove it)`, false, [item]);
      if (check === null) {
        // Doubts that leave the fact on the place, for whatever reason: a reviewer may dismiss them.
        const value = (place.facts as Record<string, FactValue>)[fact]!;
        const weight = weighFact({ place: placeId, fact, value, at: item.received, reports: earlier, ...(place.fact_dates?.[fact] ? { doubtsSince: place.fact_dates[fact] } : {}) });
        dropStays(key);
        const heldCase = doubtCase(placeId, place, fact, value, false, weight.doubts.sources, weight.doubts.feedback, weight.confirmations.feedback);
        held.push(heldCase);
        stays.set(key, heldCase);
      }
      sentToPerson.set(item.id, { edit, change: changes[changes.length - 1]! });
      decide(item, "needs_review", check === null ? decision.why : `the intake held it for ${check}, so a person checks it`);
    }
  }

  /**
   * Takedowns already in the data that reports in `items` made in a run that
   * stopped before it recorded its inbox moves. For each place and fact the
   * place no longer has, with an earlier value in `earlierFacts` and no
   * applied report about it in the history since that value was set, the
   * earlier value is put back on the working record when `takesDown` says one
   * of the reports takes it down. The takedown then runs again as it did then
   * and leaves the record as the data holds it. Returns the keys put back.
   */
  function replayTakedowns(items: readonly ReportItem[], takesDown: (item: ReportItem, place: Place) => boolean): Set<string> {
    const keys = new Set<string>();
    for (const item of items) {
      const placeId = item.place as string;
      const fact = item.report.fact as string;
      const key = factKey(placeId, fact);
      const earlier = input.earlierFacts?.get(placeId)?.get(fact);
      if (keys.has(key) || earlier === undefined || !input.places.has(placeId)) continue;
      const current = input.places.get(placeId)!;
      if ((current.facts as Record<string, unknown>)[fact] !== undefined) continue;
      // A takedown the inbox recorded is not this run's to repeat.
      const recorded = input.history.some(
        (h) =>
          h.type === "report" && h.place === placeId && h.report.fact === fact && (h.report.kind === "doubt" || h.report.kind === "contact") &&
          wasApplied(h) && (earlier.date === undefined || h.received >= earlier.date),
      );
      if (recorded) continue;
      const restored = withEarlierFact(structuredClone(record(placeId)), fact, earlier);
      if (!items.some((i) => i.place === placeId && i.report.fact === fact && takesDown(i, restored))) continue;
      withEarlierFact(record(placeId), fact, earlier);
      keys.add(key);
    }
    return keys;
  }

  /** What the PR says after "<fact> doubted" about doubts that leave the fact on the place. */
  function whyDoubtStays(decision: ItemDecision, check: string | null, from: string | undefined): string {
    if (check !== null) return `, held by the intake for ${check}`;
    const reason = decision.verdict === "held" ? decision.reason : undefined;
    if (reason === "single_doubt") return " by one traveller";
    if (reason === "protected_source" && from !== undefined) return `, but it came from ${from}`;
    return `: ${decision.why}`;
  }

  function doubtCase(
    placeId: string,
    place: Place,
    fact: FactName,
    value: FactValue,
    takenDown: boolean,
    sources: number,
    doubts: readonly string[],
    confirmations: readonly string[],
  ): HeldCase {
    return {
      case: "fact_doubted",
      place: placeId,
      ...(place.standing !== undefined ? { standing: place.standing } : {}),
      location: { lat: roundCoord(place.location.lat), lon: roundCoord(place.location.lon) },
      kind: place.kind,
      fact,
      value,
      taken_down: takenDown,
      sources,
      doubts: [...doubts],
      confirmations: [...confirmations],
      feedback: [...doubts, ...confirmations],
    };
  }

  /**
   * The place a new place held as a possible duplicate of `placeId` merges
   * into without anyone asked, or undefined when a reviewer decides: a place
   * in the data (not one added in this run) with the same name once tidied,
   * in the same group, less than MERGE_DISTANCE_M away, with no major road
   * between them in `roads`, and neither an owner's place nor a pair on the
   * distinct list. A run without road data merges nothing on its own.
   */
  function mergeTarget(item: ReportItem, placeId: string): { place: Place; distance: number } | undefined {
    const other = (everyPlaceById ??= new Map((input.everyPlace ?? []).map((p) => [p.id, p]))).get(placeId);
    if (!other || item.report.name === undefined || other.name === null) return undefined;
    const distance = distanceM(item.location!, other.location);
    if (distance >= MERGE_DISTANCE_M) return undefined;
    if (tidyName(item.report.name).toLowerCase() !== tidyName(other.name).toLowerCase()) return undefined;
    if (mergeProblem(draftOf(item), other, input.distinct) !== null) return undefined;
    // Without road data, two places on opposite sides of a road look the same, so a reviewer decides.
    if (!input.roads || input.roads.between(item.location!, other.location)) return undefined;
    return { place: other, distance: Math.round(distance) };
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

  /**
   * Reports that a Commons photo is not of a place, by place and file. Each
   * source counts once. Reports from two sources within 90 days, at least one
   * attested, put the pair on the do-not-match list; until then each report
   * is a `commons_mismatch` case for a reviewer. A pair already on the list
   * changes nothing.
   */
  function applyCommonsReports(items: ReportItem[]): void {
    const groups = new Map<string, ReportItem[]>();
    for (const item of items) {
      // The file is written to public files only when it has the shape of a Commons file name.
      if (!isCommonsFileName(item.report.file)) {
        decide(item, "refused", "the file is not a Commons file name");
        continue;
      }
      const key = factKey(item.place as string, item.report.file);
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const reports of groups.values()) {
      const placeId = reports[0]!.place as string;
      const file = reports[0]!.report.file as string;
      if ([...(input.doNotMatch ?? []), ...doNotMatch].some((p) => p.place === placeId && p.file === file)) {
        for (const r of reports) decide(r, "applied", "the Commons photo is on the do-not-match list already");
        continue;
      }
      const latest = time(reports[reports.length - 1]!);
      const earlier = input.history.filter(
        (h): h is ReportItem => h.type === "report" && h.report.kind === "commons_mismatch" && h.place === placeId && h.report.file === file,
      );
      const counted = [...earlier, ...reports].filter((r) => inWindow(r, latest) && heldForCheck(r) === null);
      const sources = distinctDevices(counted);
      if (sources >= 2 && counted.some((r) => r.attested !== undefined)) {
        doNotMatch.push({ place: placeId, file, added: nowIso.slice(0, 10), source: "reports" });
        note(placeId, `Commons photo ${JSON.stringify(file)} goes on the do-not-match list after reports from ${sources} sources within ${WINDOW_DAYS} days`, true, counted);
        for (const r of reports) decide(r, "applied", `the Commons photo goes on the do-not-match list after reports from ${sources} sources`);
        continue;
      }
      const target = input.places.get(placeId)!;
      for (const r of reports) {
        edits.push({ kind: "note", place: placeId, feedback: r.id });
        note(placeId, `Commons photo ${JSON.stringify(file)} reported as not of this place${quote(r.report.note)}`, false, [r]);
        decide(r, "needs_review", "one source reports the Commons photo, so a reviewer looks");
      }
      held.push({
        case: "commons_mismatch",
        place: placeId,
        location: { lat: roundCoord(target.location.lat), lon: roundCoord(target.location.lon) },
        kind: target.kind,
        file,
        sources: Math.max(sources, 1),
        feedback: reports.map((r) => r.id),
      });
    }
  }

  function routeToPerson(items: ReportItem[]): void {
    for (const item of items) {
      const { kind, note: text, value } = item.report;
      const problem = (kind === "name" || kind === "description") && typeof value === "string" ? textRulesFail(kind, value) : null;
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
      } else if (problem !== null && item.place) {
        // The value never reaches the review checkout: a person reads it in the inbox.
        edits.push({ kind: "note", place: item.place, feedback: item.id });
        note(item.place, `${kind} report fails the text checks (${problem}), read it in the inbox`, false, [item]);
        decide(item, "needs_review", `the ${kind} fails the text checks, so a person reads it`);
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
  edit: Exclude<ReviewEdit, { kind: "review" | "review_erasure" | "photo" | "photo_erasure" | "photo_removal" }>,
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
