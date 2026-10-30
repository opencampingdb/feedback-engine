import {
  isFactName,
  isValidFactValue,
  type FactName,
  type FactValue,
  type StoredFeedback,
} from "@opencampingdb/feedback";
import { moderateReview } from "./moderation.js";
import { roundCoord } from "./serialise.js";
import type { Place, Review } from "./types.js";

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
export const REVIEWED_FACTS: ReadonlySet<FactName> = new Set<FactName>(["website", "phone"]);

/** Kind given to a draft record for a `new_place` report until a person sets it. */
export const DRAFT_KIND = "campground";

export type Outcome = "applied" | "refused" | "needs_review" | "waiting";

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
}

/**
 * A change a person decides on. These never touch the automatic branch; the
 * runner applies them to the review checkout with `applyEdit`.
 */
export type ReviewEdit =
  | { kind: "new_place"; record: Place; feedback: string }
  | { kind: "location"; place: string; location: { lat: number; lon: number }; feedback: string }
  | { kind: "fact"; place: string; fact: FactName; value: FactValue; feedback: string }
  /** Nothing to write: the PR body carries it for a person to read. */
  | { kind: "note"; place: string; feedback: string };

export interface RulesOutput {
  /** One per pending item, in the order they arrived. */
  decisions: Decision[];
  /** Place records changed by the automatic rules, with `updated` set. */
  places: Map<string, Place>;
  /** Review lines to append, per place. */
  reviews: Map<string, Review[]>;
  /** Changes for a person, in the order they arrived. */
  edits: ReviewEdit[];
  changes: Change[];
  needsReview: boolean;
}

type ReportItem = Extract<StoredFeedback, { type: "report" }>;
type ReviewItem = Extract<StoredFeedback, { type: "review" }>;
type CheckItem = Extract<StoredFeedback, { type: "check" }>;

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

function distinctDevices(items: readonly StoredFeedback[]): number {
  return new Set(items.map((i) => i.device)).size;
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

const quote = (text: string | undefined) => (text ? `: "${text}"` : "");

export function applyRules(input: RulesInput): RulesOutput {
  const now = Date.parse(input.now);
  const nowIso = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const decisions = new Map<string, Decision>();
  const working = new Map<string, Place>();
  const newReviews = new Map<string, Review[]>();
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

  // Feedback about a place that is not in the data is refused, except new places.
  const known: StoredFeedback[] = [];
  for (const item of pending) {
    const isNewPlace = item.type === "report" && item.report.kind === "new_place";
    if (!isNewPlace && (item.place === null || !input.places.has(item.place))) {
      decide(item, "refused", `place ${item.place ?? "(none)"} is not in the data`);
    } else {
      known.push(item);
    }
  }

  applyReviews(known.filter((i): i is ReviewItem => i.type === "review"));
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

  // Keep only records that really changed, and stamp them.
  const changed = new Map<string, Place>();
  for (const [id, place] of working) {
    const original = input.places.get(id);
    if (!original || JSON.stringify(original) !== JSON.stringify(place)) {
      place.updated = nowIso;
      changed.set(id, place);
    }
  }

  const ordered = pending.map((p) => decisions.get(p.id)!);
  return {
    decisions: ordered,
    places: changed,
    reviews: newReviews,
    edits,
    changes,
    needsReview: ordered.some((d) => d.outcome === "needs_review"),
  };

  function applyReviews(items: ReviewItem[]): void {
    const accepted = new Map<string, ReviewItem[]>();
    for (const item of items) {
      const reasons = moderateReview(item.review.text);
      if (reasons.length > 0) {
        decide(item, "refused", `review text contains ${reasons.join(", ")}`);
        continue;
      }
      const reviewId = `rev_${item.id.replace(/^fb_/, "")}`;
      const added = newReviews.get(item.place) ?? [];
      if (input.reviews(item.place).some((r) => r.id === reviewId) || added.some((r) => r.id === reviewId)) {
        decide(item, "applied", "review is already in the data");
        continue;
      }
      added.push({
        id: reviewId,
        place: item.place,
        stars: item.review.stars,
        text: item.review.text,
        visited: item.review.visited,
        created: item.received,
        app: item.app,
      });
      newReviews.set(item.place, added);
      accepted.set(item.place, [...(accepted.get(item.place) ?? []), item]);
      decide(item, "applied", "review accepted");
    }
    for (const [placeId, added] of newReviews) {
      const place = record(placeId);
      place.rating = ratingOf([...input.reviews(placeId), ...added]);
      const plural = added.length === 1 ? "" : "s";
      note(
        placeId,
        `${added.length} review${plural} added, rating ${place.rating!.mean} from ${place.rating!.count}`,
        true,
        accepted.get(placeId) ?? [],
      );
    }
  }

  function applyStatus(items: (ReportItem | CheckItem)[]): void {
    for (const placeId of new Set(items.map((i) => i.place as string))) {
      const mine = items.filter((i) => i.place === placeId);
      const evidence = [...input.history.filter((h) => h.place === placeId), ...mine].sort(byReceived);
      const place = record(placeId);

      // Evidence one way counts only if it came after the latest evidence the other way.
      const latest = (at: number, test: (i: StoredFeedback) => boolean) =>
        evidence.filter((e) => test(e) && time(e) <= at).reduce((max, e) => Math.max(max, time(e)), -Infinity);
      const supporting = (at: number, test: (i: StoredFeedback) => boolean, against: (i: StoredFeedback) => boolean) => {
        const after = latest(at, against);
        return evidence.filter((e) => test(e) && inWindow(e, at) && time(e) > after);
      };
      const waitingReopens: StoredFeedback[] = [];

      for (const item of mine) {
        const at = time(item);
        const isReport = item.type === "report";

        if (isClosureEvidence(item)) {
          if (place.status === "closed") {
            decide(item, "applied", isReport ? "place is already closed" : "check recorded");
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
        place.fact_sources[fact] = "feedback";
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
        const draft: Place = {
          id,
          name: null,
          kind: DRAFT_KIND,
          group: "overnight",
          location: { lat: roundCoord(item.location.lat), lon: roundCoord(item.location.lon) },
          osm: null,
          facts: {},
          status: "open",
          rating: null,
          fact_sources: { location: "feedback" },
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
      } else if (kind === "other" && item.place) {
        edits.push({ kind: "note", place: item.place, feedback: item.id });
        note(item.place, `report${quote(text) || " with no note"}`, false, [item]);
        decide(item, "needs_review", "other reports are read by a person");
      }
    }
  }
}

/**
 * Applies one review edit to the record as it is in the review checkout.
 * Returns the new record, or undefined when there is nothing to write: the
 * edit is already there, it is a note, or a person has already edited the
 * draft of a new place.
 */
export function applyEdit(current: Place | undefined, edit: ReviewEdit, nowIso: string): Place | undefined {
  if (edit.kind === "note") return undefined;
  if (edit.kind === "new_place") return current ? undefined : edit.record;
  if (!current) return undefined;
  const next = structuredClone(current);
  if (edit.kind === "location") {
    next.location = { ...edit.location };
    next.fact_sources.location = "feedback";
  } else {
    (next.facts as Record<string, FactValue>)[edit.fact] = edit.value;
    next.fact_sources[edit.fact] = "feedback";
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return undefined;
  next.updated = nowIso;
  return next;
}
