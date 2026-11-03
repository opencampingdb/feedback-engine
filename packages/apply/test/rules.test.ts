import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyEdit, applyHeldReview, applyRules, ratingOf, REPORTS_TO_HIDE, type RulesInput } from "../src/rules.js";
import type { Fee, Place, Review } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T00:00:00Z");

const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: PLACE,
    name: "Lake Eppalock Camp",
    kind: "free_camp",
  group: "overnight",
    location: { lat: -36.85, lon: 144.55 },
    osm: { type: "node", id: 123456, version: 7 },
    facts: { power: false, fee: true },
    status: "open",
    rating: null,
    fact_sources: { power: "osm", fee: "osm" },
    updated: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

let seq = 0;
function fbId(): string {
  seq += 1;
  return `fb_01JC${String(seq).padStart(22, "0")}`;
}

function base(day: number, device: string, placeId: string | null = PLACE) {
  return { id: fbId(), received: at(day), app: "example-app", place: placeId, device, app_version: "1.0.0", consent: true as const };
}

const fact = (day: number, device: string, name: string, value: boolean | string, placeId = PLACE): StoredFeedback =>
  ({ ...base(day, device, placeId), type: "report", report: { kind: "fact", fact: name, value } }) as StoredFeedback;
const closed = (day: number, device: string): StoredFeedback =>
  ({ ...base(day, device), type: "report", report: { kind: "closed" } }) as StoredFeedback;
const reopened = (day: number, device: string): StoredFeedback =>
  ({ ...base(day, device), type: "report", report: { kind: "reopened" } }) as StoredFeedback;
const check = (day: number, device: string, stillThere: boolean): StoredFeedback =>
  ({ ...base(day, device), type: "check", check: { visited: at(day).slice(0, 10), still_there: stillThere } }) as StoredFeedback;
/** A contributor id for a test name, `ctr_` and 16 hex characters. */
const ctr = (name: string) => `ctr_${Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16)}`;
const review = (day: number, who: string, stars: number, text: string, placeId = PLACE): StoredFeedback =>
  ({ ...base(day, who, placeId), contributor: ctr(who), type: "review", review: { stars, text, visited: "2026-06" } }) as StoredFeedback;
const reviewReport = (day: number, who: string, reviewId: string, reason = "spam_ad"): StoredFeedback =>
  ({ ...base(day, who), contributor: ctr(who), type: "review_report", review_report: { review: reviewId, reason } }) as StoredFeedback;
const line = (n: number, who: string, stars: number, extra: Partial<Review> = {}): Review => ({
  id: `rev_01JA00000000000000000000${String(n).padStart(2, "0")}`,
  place: PLACE,
  stars,
  text: "",
  visited: "2026-01",
  created: "2026-01-05T00:00:00Z",
  app: "example-app",
  contributor: ctr(who),
  ...extra,
});
const fee = (day: number, who: string, amount: number, site = "powered", paid = "2026-06", placeId = PLACE): StoredFeedback =>
  ({ ...base(day, who, placeId), contributor: ctr(who), type: "fee", fee: { amount, site, paid } }) as StoredFeedback;
const feeLine = (n: number, who: string, amount: number, extra: Partial<Fee> = {}): Fee => ({
  id: `fee_01JA00000000000000000000${String(n).padStart(2, "0")}`,
  place: PLACE,
  amount,
  site: "powered",
  paid: "2026-01",
  created: "2026-01-05T00:00:00Z",
  app: "example-app",
  contributor: ctr(who),
  ...extra,
});
/** Stored items as `applied/` holds them, with the outcome a run gave them. */
const applied = (item: StoredFeedback, result = "applied") => ({ ...item, outcome: { result, reason: "", run: at(0) } }) as unknown as StoredFeedback;

function run(
  pending: StoredFeedback[],
  opts: {
    now?: number;
    history?: StoredFeedback[];
    places?: Place[];
    reviews?: Review[];
    fees?: Fee[];
    blocked?: string[];
    reviewers?: string[];
  } = {},
) {
  const places = new Map((opts.places ?? [place()]).map((p) => [p.id, p]));
  const input: RulesInput = {
    everyPlace: [...places.values()],
    now: at(opts.now ?? 1),
    pending,
    history: opts.history ?? [],
    places,
    reviews: (id) => (opts.reviews ?? []).filter((r) => r.place === id),
    fees: (id) => (opts.fees ?? []).filter((f) => f.place === id),
    kinds: new Map([
      ["campground", "overnight"],
      ["free_camp", "overnight"],
      ["picnic_site", "utility"],
    ]),
    blocked: new Set(opts.blocked ?? []),
    reviewers: new Set(opts.reviewers ?? []),
  };
  const out = applyRules(input);
  const outcome = (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.outcome;
  return { ...out, outcome, after: (id = PLACE) => out.places.get(id) };
}

describe("fact reports", () => {
  it("one report does not change a fact", () => {
    const r = fact(0, "dev-a", "power", true);
    const out = run([r]);
    expect(out.after()).toBeUndefined();
    expect(out.outcome(r)).toBe("waiting");
  });

  it("two reports from the same device do not change a fact", () => {
    const a = fact(0, "dev-a", "power", true);
    const b = fact(2, "dev-a", "power", true);
    const out = run([a, b], { now: 3 });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("waiting");
    expect(out.outcome(b)).toBe("waiting");
  });

  it("two reports from different devices within 90 days change the fact and mark it as feedback", () => {
    const a = fact(0, "dev-a", "power", true);
    const b = fact(90, "dev-b", "power", true);
    const out = run([a, b], { now: 90 });
    expect(out.after()?.facts.power).toBe(true);
    expect(out.after()?.fact_sources.power).toBe("feedback");
    expect(out.after()?.fact_dates).toEqual({ power: at(90) });
    expect(out.after()?.updated).toBe(at(90));
    expect(out.outcome(a)).toBe("applied");
    expect(out.outcome(b)).toBe("applied");
    expect(out.needsReview).toBe(false);
  });

  it("a second report on the 91st day does not change the fact", () => {
    const a = fact(0, "dev-a", "power", true);
    const b = fact(91, "dev-b", "power", true);
    const out = run([a, b], { now: 91 });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("refused");
    expect(out.decisions.find((d) => d.id === a.id)?.reason).toMatch(/90 days/);
    expect(out.outcome(b)).toBe("waiting");
  });

  it("two devices that disagree do not change the fact", () => {
    const a = fact(0, "dev-a", "power", true);
    const b = fact(1, "dev-b", "power", "4wd");
    const c = fact(1, "dev-c", "access", "2wd");
    const d = fact(2, "dev-d", "access", "4wd");
    const out = run([a, b, c, d], { now: 2, places: [place({ facts: {}, fact_sources: {} })] });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("waiting");
    expect(out.outcome(b)).toBe("refused"); // not a valid value for power
    expect(out.outcome(c)).toBe("waiting");
    expect(out.outcome(d)).toBe("waiting");
  });

  it("refuses the losing side once two devices agree", () => {
    const a = fact(0, "dev-a", "power", true);
    const b = fact(1, "dev-b", "power", false);
    const c = fact(2, "dev-c", "power", true);
    const out = run([a, b, c], { now: 3, places: [place({ facts: { fee: true }, fact_sources: { fee: "osm" } })] });
    expect(out.after()?.facts.power).toBe(true);
    expect(out.outcome(b)).toBe("refused");
  });

  it("a report that matches the current value is applied without a change", () => {
    const a = fact(0, "dev-a", "fee", true);
    const out = run([a]);
    expect(out.outcome(a)).toBe("applied");
    expect(out.after()).toBeUndefined();
  });

  it("adds a fact the place did not have", () => {
    const out = run([fact(0, "dev-a", "access", "4wd"), fact(5, "dev-b", "access", "4wd")], { now: 5 });
    expect(out.after()?.facts.access).toBe("4wd");
    expect(out.after()?.fact_sources.access).toBe("feedback");
  });

  it("changes entry when two devices agree", () => {
    const out = run([fact(0, "dev-a", "entry", "customers"), fact(1, "dev-b", "entry", "customers")], { now: 1 });
    expect(out.after()?.facts.entry).toBe("customers");
    expect(out.after()?.fact_sources.entry).toBe("feedback");
  });

  it("two device ids on one network do not change a fact", () => {
    const a = { ...fact(0, "dev-a", "power", true), origin: "net-1" };
    const b = { ...fact(1, "dev-b", "power", true), origin: "net-1" };
    const out = run([a, b], { now: 1 });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("waiting");
    expect(out.outcome(b)).toBe("waiting");
  });

  it("refuses opening hours that hold contact details", () => {
    const a = fact(0, "dev-a", "opening_hours", "Ring 0412 345 678");
    const b = fact(1, "dev-b", "opening_hours", "Ring 0412 345 678");
    const out = run([a, b], { now: 1 });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("refused");
    expect(out.outcome(b)).toBe("refused");
  });

  it("sends website and phone changes to a person", () => {
    const a = fact(0, "dev-a", "website", "https://example.org");
    const out = run([a]);
    expect(out.outcome(a)).toBe("needs_review");
    expect(out.after()).toBeUndefined(); // never on the automatic branch
    expect(out.edits).toEqual([{ kind: "fact", place: PLACE, fact: "website", value: "https://example.org", feedback: a.id }]);
    expect(out.needsReview).toBe(true);
  });
});

describe("closed and reopened", () => {
  it("one closed report sets reported_closed at once", () => {
    const a = closed(0, "dev-a");
    const out = run([a]);
    expect(out.after()?.status).toBe("reported_closed");
    expect(out.outcome(a)).toBe("applied");
    expect(out.needsReview).toBe(false);
  });

  it("two closed reports from the same device leave it reported_closed", () => {
    const out = run([closed(0, "dev-a"), closed(3, "dev-a")], { now: 4 });
    expect(out.after()?.status).toBe("reported_closed");
  });

  it("closed reports from two devices within 90 days close the place", () => {
    const out = run([closed(0, "dev-a"), closed(10, "dev-b")], { now: 10 });
    expect(out.after()?.status).toBe("closed");
  });

  it("marks a closure as coming from feedback", () => {
    const out = run([closed(0, "dev-a"), closed(10, "dev-b")], { now: 10 });
    expect(out.after()?.fact_sources.status).toBe("feedback");
    expect(out.after()?.fact_dates?.status).toBe(at(10));
  });

  it("counts a closed report from an earlier run as history", () => {
    const earlier = closed(0, "dev-a");
    const out = run([closed(30, "dev-b")], {
      now: 30,
      history: [earlier],
      places: [place({ status: "reported_closed" })],
    });
    expect(out.after()?.status).toBe("closed");
  });

  it("closed reports 91 days apart do not close the place", () => {
    const out = run([closed(91, "dev-b")], {
      now: 91,
      history: [closed(0, "dev-a")],
      places: [place({ status: "reported_closed" })],
    });
    expect(out.after()).toBeUndefined();
  });

  it("a check with still_there false confirms a closed report", () => {
    const out = run([closed(0, "dev-a"), check(2, "dev-b", false)], { now: 2 });
    expect(out.after()?.status).toBe("closed");
  });

  it("a check on its own changes nothing", () => {
    const c = check(0, "dev-a", false);
    const out = run([c]);
    expect(out.after()).toBeUndefined();
    expect(out.outcome(c)).toBe("applied");
  });

  it("closed then reopened returns the place to open", () => {
    const a = closed(0, "dev-a");
    const first = run([a], { now: 0 });
    expect(first.after()?.status).toBe("reported_closed");

    const b = reopened(1, "dev-b");
    const second = run([b], { now: 1, history: [a], places: [first.after()!] });
    expect(second.after()?.status).toBe("open");
    expect(second.outcome(b)).toBe("applied");
  });

  it("closed and reopened in the same run leave the record unchanged", () => {
    const a = closed(0, "dev-a");
    const b = reopened(1, "dev-b");
    const out = run([a, b], { now: 2 });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("applied");
    expect(out.outcome(b)).toBe("applied");
  });

  it("a check with still_there true clears reported_closed", () => {
    const out = run([check(5, "dev-b", true)], {
      now: 5,
      history: [closed(0, "dev-a")],
      places: [place({ status: "reported_closed" })],
    });
    expect(out.after()?.status).toBe("open");
  });

  it("a check with still_there true records last_confirmed without moving updated", () => {
    const c = check(0, "dev-a", true);
    const out = run([c], { now: 1 });
    expect(out.after()?.last_confirmed).toBe(at(1));
    expect(out.after()?.updated).toBe("2026-06-01T00:00:00Z");
    expect(out.outcome(c)).toBe("applied");
    expect(out.changes.map((ch) => ch.summary)).toEqual(["confirmed there by a traveller"]);
  });

  it("a later check moves last_confirmed on", () => {
    const out = run([check(30, "dev-a", true)], { now: 30, places: [place({ last_confirmed: at(1) })] });
    expect(out.after()?.last_confirmed).toBe(at(30));
    expect(out.after()?.updated).toBe("2026-06-01T00:00:00Z");
  });

  it("a check that clears reported_closed records last_confirmed and moves updated", () => {
    const out = run([check(5, "dev-b", true)], {
      now: 5,
      history: [closed(0, "dev-a")],
      places: [place({ status: "reported_closed" })],
    });
    expect(out.after()?.last_confirmed).toBe(at(5));
    expect(out.after()?.updated).toBe(at(5));
  });

  it("a single check on a closed place does not record last_confirmed", () => {
    const out = run([check(0, "dev-a", true)], { places: [place({ status: "closed" })] });
    expect(out.after()).toBeUndefined();
  });

  it("checks on a closed place from two devices reopen it and record last_confirmed", () => {
    const out = run([check(0, "dev-a", true), check(1, "dev-b", true)], {
      now: 1,
      places: [place({ status: "closed" })],
    });
    expect(out.after()?.status).toBe("open");
    expect(out.after()?.last_confirmed).toBe(at(1));
  });

  it("a check on a temporarily closed place does not record last_confirmed", () => {
    const out = run([check(0, "dev-a", true)], {
      places: [place({ status: "temporarily_closed", fact_sources: { power: "osm", fee: "osm", status: "owner" } })],
    });
    expect(out.after()).toBeUndefined();
  });

  it("a check followed by a closed report in the same run does not record last_confirmed", () => {
    const out = run([check(0, "dev-a", true), closed(1, "dev-b")], { now: 1 });
    expect(out.after()?.status).toBe("reported_closed");
    expect(out.after()?.last_confirmed).toBeUndefined();
  });

  it("a check with still_there false does not record last_confirmed", () => {
    const out = run([check(0, "dev-a", false)]);
    expect(out.after()).toBeUndefined();
  });

  it("reports before a reopening no longer count towards closing", () => {
    const out = run([closed(0, "dev-a"), reopened(1, "dev-b"), closed(2, "dev-c")], { now: 3 });
    expect(out.after()?.status).toBe("reported_closed");
  });

  it("a closed place needs two devices to reopen", () => {
    const one = reopened(0, "dev-a");
    const first = run([one], { places: [place({ status: "closed" })] });
    expect(first.after()).toBeUndefined();
    expect(first.outcome(one)).toBe("waiting");

    const two = reopened(3, "dev-b");
    const second = run([one, two], { now: 3, places: [place({ status: "closed" })] });
    expect(second.after()?.status).toBe("open");
    expect(second.outcome(one)).toBe("applied");
  });

  it("closed reports from two device ids on one network leave it reported_closed", () => {
    const a = { ...closed(0, "dev-a"), origin: "net-1" };
    const b = { ...closed(1, "dev-b"), origin: "net-1" };
    const out = run([a, b], { now: 1 });
    expect(out.after()?.status).toBe("reported_closed");
  });

  it("closed reports from two networks close the place", () => {
    const a = { ...closed(0, "dev-a"), origin: "net-1" };
    const b = { ...closed(1, "dev-b"), origin: "net-2" };
    const out = run([a, b], { now: 1 });
    expect(out.after()?.status).toBe("closed");
  });

  it("sends closed reports from two networks for an owner-verified place to a person", () => {
    const a = closed(0, "dev-a");
    const b = closed(1, "dev-b");
    const out = run([a, b], { now: 1, places: [place({ owner_verified: true })] });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("needs_review");
    expect(out.outcome(b)).toBe("needs_review");
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: b.id }]);
    expect(out.changes).toMatchObject([{ place: PLACE, automatic: false, feedback: [a.id, b.id] }]);
  });

  it("leaves one closed report for an owner-verified place waiting, with nothing for a person", () => {
    const a = closed(0, "dev-a");
    const out = run([a], { places: [place({ owner_verified: true })] });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("waiting");
    expect(out.edits).toEqual([]);
    expect(out.needsReview).toBe(false);
  });

  it("treats a place whose status the owner set the same way", () => {
    const c = check(0, "dev-a", false);
    const one = run([c], { places: [place({ fact_sources: { status: "owner" } })] });
    expect(one.after()).toBeUndefined();
    expect(one.outcome(c)).toBe("applied");
    expect(one.edits).toEqual([]);

    const r = closed(2, "dev-b");
    const two = run([r], { now: 2, history: [c], places: [place({ fact_sources: { status: "owner" } })] });
    expect(two.after()).toBeUndefined();
    expect(two.outcome(r)).toBe("needs_review");
    expect(two.edits).toEqual([{ kind: "note", place: PLACE, feedback: r.id }]);
  });

  it("does not count two device ids on one network towards an owner-verified closure", () => {
    const a = { ...closed(0, "dev-a"), origin: "net-1" };
    const b = { ...closed(1, "dev-b"), origin: "net-1" };
    const out = run([a, b], { now: 1, places: [place({ owner_verified: true })] });
    expect(out.outcome(a)).toBe("waiting");
    expect(out.outcome(b)).toBe("waiting");
    expect(out.edits).toEqual([]);
  });
});

describe("reviews", () => {
  it("accepts a trusted contributor's clean review and recalculates the rating", () => {
    const r = review(0, "sam", 3, "Shady, flat sites near the water.");
    const existing = [line(1, "kim", 5), line(2, "lee", 4)];
    const out = run([r], { reviews: existing, reviewers: [ctr("sam")], places: [place({ rating: { count: 2, mean: 4.5 } })] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.reviews.get(PLACE)).toEqual([
      ...existing,
      {
        id: `rev_${r.id.slice(3)}`,
        place: PLACE,
        stars: 3,
        text: "Shady, flat sites near the water.",
        visited: "2026-06",
        created: r.received,
        app: "example-app",
        contributor: ctr("sam"),
      },
    ]);
    expect(out.after()?.rating).toEqual({ count: 3, mean: 4 });
  });

  it("holds a contributor's first review for a person", () => {
    const r = review(0, "sam", 4, "Quiet and level");
    const out = run([r]);
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.reviews.size).toBe(0);
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([{ kind: "review", place: PLACE, review: expect.objectContaining({ contributor: ctr("sam"), stars: 4 }), feedback: r.id }]);
  });

  it("trusts a contributor whose feedback was applied before", () => {
    const earlier = applied({ ...check(-5, "sam", true), contributor: ctr("sam") } as StoredFeedback);
    const held = applied({ ...check(-5, "kim", true), contributor: ctr("kim") } as StoredFeedback, "needs_review");
    const a = review(0, "sam", 4, "Quiet");
    const b = review(0, "kim", 4, "Quiet");
    const out = run([a, b], { history: [earlier, held] });
    expect(out.outcome(a)).toBe("applied");
    expect(out.outcome(b)).toBe("needs_review");
  });

  it("keeps visited_nearby on the published line", () => {
    const r = { ...review(0, "sam", 5, "Lovely"), review: { stars: 5, text: "Lovely", visited: "2026-06", visited_nearby: true } } as StoredFeedback;
    const out = run([r], { reviewers: [ctr("sam")] });
    expect(out.reviews.get(PLACE)?.[0]?.visited_nearby).toBe(true);
  });

  it("replaces a contributor's earlier review of the place", () => {
    const r = review(0, "sam", 2, "Gone downhill");
    const out = run([r], { reviews: [line(1, "sam", 5), line(2, "kim", 4)], reviewers: [ctr("sam")], places: [place({ rating: { count: 2, mean: 4.5 } })] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.reviews.get(PLACE)?.map((l) => l.contributor)).toEqual([ctr("kim"), ctr("sam")]);
    expect(out.reviews.get(PLACE)?.map((l) => l.stars)).toEqual([4, 2]);
    expect(out.after()?.rating).toEqual({ count: 2, mean: 3 });
  });

  it("refuses everything from a blocked contributor", () => {
    const r = review(0, "spammer", 5, "Great");
    const c = { ...check(0, "spammer", true), contributor: ctr("spammer") } as StoredFeedback;
    const out = run([r, c], { blocked: [ctr("spammer")], reviewers: [ctr("spammer")] });
    expect(out.outcome(r)).toBe("refused");
    expect(out.outcome(c)).toBe("refused");
    expect(out.decisions[0]?.reason).toBe("the contributor is blocked");
  });

  it("leaves hidden and blocked reviews out of the rating", () => {
    const r = review(0, "sam", 4, "Fine");
    const existing = [line(1, "kim", 1, { hidden: "reported" }), line(2, "bad", 1), line(3, "lee", 5)];
    const out = run([r], { reviews: existing, blocked: [ctr("bad")], reviewers: [ctr("sam")] });
    expect(out.after()?.rating).toEqual({ count: 2, mean: 4.5 });
  });

  it("holds text sent word for word for another place", () => {
    const text = "Best camp in the state, everyone should stay here at least once!";
    const other = applied(review(-3, "kim", 5, text, OTHER));
    const r = review(0, "sam", 5, text.toUpperCase());
    const out = run([r], { history: [other], reviewers: [ctr("sam")] });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.decisions[0]?.reason).toMatch(/another place/);
  });

  it("refuses a review with no contributor", () => {
    const { contributor: _, ...r } = review(0, "sam", 4, "Nice") as StoredFeedback & { contributor: string };
    const out = run([r as StoredFeedback]);
    expect(out.outcome(r as StoredFeedback)).toBe("refused");
  });

  it("refuses a review with an email address", () => {
    const r = review(0, "dev-a", 5, "Great spot, write to me at jo@example.com");
    const out = run([r]);
    expect(out.outcome(r)).toBe("refused");
    expect(out.decisions[0]?.reason).toMatch(/email/);
    expect(out.reviews.size).toBe(0);
    expect(out.after()).toBeUndefined();
  });

  it.each([
    ["Book at www.example.com", /link/],
    ["Ring 0412 345 678", /phone/],
    ["Follow @campingjo for more", /handle/],
    ["My name is Jo and I loved it", /name/],
    ["Lovely and quiet. Cheers, Sam", /name/],
    ["This place is shit", /language/],
    ["Powered sites $45 per night, book now!", /advertising/],
  ])("refuses %j", (text, reason) => {
    const r = review(0, "dev-a", 2, text);
    const out = run([r]);
    expect(out.outcome(r)).toBe("refused");
    expect(out.decisions[0]?.reason).toMatch(reason);
  });

  it("does not add the same review twice", () => {
    const r = review(0, "sam", 4, "Nice");
    const existing: Review = { ...line(1, "sam", 4), id: `rev_${r.id.slice(3)}`, text: "Nice", visited: "2026-06", created: r.received };
    const out = run([r], { reviews: [existing], reviewers: [ctr("sam")], places: [place({ rating: { count: 1, mean: 4 } })] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.reviews.size).toBe(0);
  });

  it("rounds the mean to 1 decimal place", () => {
    const out = run([review(0, "a", 5, ""), review(0, "b", 4, ""), review(0, "c", 4, "")], { reviewers: [ctr("a"), ctr("b"), ctr("c")] });
    expect(out.after()?.rating).toEqual({ count: 3, mean: 4.3 });
  });

  it("rounds a mean that is exactly half way up", () => {
    // 23 / 20 = 1.15, which floating point rounds down to 1.1.
    const stars = [...Array(17).fill(1), 2, 2, 2] as number[];
    expect(ratingOf(stars.map((s) => ({ stars: s })))).toEqual({ count: 20, mean: 1.2 });
    expect(ratingOf([{ stars: 4 }, { stars: 5 }])).toEqual({ count: 2, mean: 4.5 });
    expect(ratingOf([{ stars: 4 }, { stars: 4 }, { stars: 5 }, { stars: 5 }, { stars: 5 }, { stars: 4 }, { stars: 4 }, { stars: 4 }])).toEqual({ count: 8, mean: 4.4 });
  });

  it("adds a held review in the review checkout, replacing the contributor's older one", () => {
    const held = applyHeldReview([line(1, "sam", 5), line(2, "kim", 3)], line(3, "sam", 1), new Set());
    expect(held?.lines.map((l) => l.id)).toEqual([line(2, "kim", 3).id, line(3, "sam", 1).id]);
    expect(held?.rating).toEqual({ count: 2, mean: 2 });
    expect(applyHeldReview([line(3, "sam", 1)], line(3, "sam", 1))).toBeUndefined();
  });
});

describe("fees", () => {
  it("publishes a fee at once, even from a new contributor, and leaves the record alone", () => {
    const f = fee(0, "sam", 32.5, "unpowered", "2026-06");
    const existing = [feeLine(1, "kim", 40)];
    const out = run([f], { fees: existing });
    expect(out.outcome(f)).toBe("applied");
    expect(out.fees.get(PLACE)).toEqual([
      ...existing,
      {
        id: `fee_${f.id.slice(3)}`,
        place: PLACE,
        amount: 32.5,
        site: "unpowered",
        paid: "2026-06",
        created: f.received,
        app: "example-app",
        contributor: ctr("sam"),
      },
    ]);
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([]);
    expect(out.changes).toEqual([{ place: PLACE, summary: "unpowered fee of $32.50 a night paid 2026-06", automatic: true, feedback: [f.id] }]);
  });

  it("keeps one fee per contributor per site type, the newer replacing the older", () => {
    const a = fee(0, "sam", 45, "powered");
    const b = fee(0, "sam", 120, "cabin");
    const out = run([a, b], { fees: [feeLine(1, "sam", 38), feeLine(2, "sam", 30, { site: "unpowered" }), feeLine(3, "kim", 40)] });
    expect(out.outcome(a)).toBe("applied");
    expect(out.decisions[0]?.reason).toMatch(/replacing/);
    const lines = out.fees.get(PLACE)!;
    expect(lines.map((l) => [l.contributor, l.site, l.amount])).toEqual([
      [ctr("sam"), "unpowered", 30],
      [ctr("kim"), "powered", 40],
      [ctr("sam"), "powered", 45],
      [ctr("sam"), "cabin", 120],
    ]);
    expect(lines.map((l) => l.id)).toEqual([...lines.map((l) => l.id)].sort());
  });

  it("lets the later of two fees in one run win", () => {
    const first = fee(0, "sam", 30);
    const second = fee(1, "sam", 35);
    const out = run([second, first], { now: 2 });
    expect(out.fees.get(PLACE)?.map((l) => l.amount)).toEqual([35]);
  });

  it("refuses fees from a blocked contributor or without one", () => {
    const blockedFee = fee(0, "spammer", 10);
    const { contributor: _, ...anonymous } = fee(0, "sam", 20) as StoredFeedback & { contributor: string };
    const out = run([blockedFee, anonymous as StoredFeedback], { blocked: [ctr("spammer")] });
    expect(out.decisions.map((d) => [d.outcome, d.reason])).toEqual([
      ["refused", "the contributor is blocked"],
      ["refused", "fee has no contributor"],
    ]);
    expect(out.fees.size).toBe(0);
  });

  it("follows a merged place and refuses a place not in the data", () => {
    const tombstone = place({ id: OTHER, status: "merged", merged_into: PLACE });
    const moved = fee(0, "sam", 25, "powered", "2026-06", OTHER);
    const missing = fee(0, "kim", 25, "powered", "2026-06", "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZC");
    const out = run([moved, missing], { places: [place(), tombstone] });
    expect(out.outcome(moved)).toBe("applied");
    expect(out.fees.get(PLACE)?.[0]?.place).toBe(PLACE);
    expect(out.outcome(missing)).toBe("refused");
  });

  it("does not add the same fee twice", () => {
    const f = fee(0, "sam", 25);
    const out = run([f], { fees: [{ ...feeLine(1, "sam", 25), id: `fee_${f.id.slice(3)}` }] });
    expect(out.outcome(f)).toBe("applied");
    expect(out.fees.size).toBe(0);
  });
});

describe("review reports", () => {
  const target = line(1, "author", 5, { text: "Cheap sites, see our page" });

  it("sends every report to a person", () => {
    const r = reviewReport(0, "kim", target.id);
    const out = run([r], { reviews: [target], places: [place({ rating: { count: 1, mean: 5 } })] });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: r.id }]);
    expect(out.changes[0]?.summary).toMatch(/reported as spam_ad/);
    expect(out.reviews.size).toBe(0);
  });

  it(`hides a review once ${REPORTS_TO_HIDE} different contributors report it, and the rating leaves it out`, () => {
    const earlier = [applied(reviewReport(-2, "kim", target.id), "needs_review"), applied(reviewReport(-1, "kim", target.id), "needs_review")];
    const second = reviewReport(0, "lee", target.id, "fake");
    const out1 = run([second], { history: earlier, reviews: [target], places: [place({ rating: { count: 1, mean: 5 } })] });
    expect(out1.reviews.size).toBe(0); // kim twice counts once

    const third = reviewReport(0, "max", target.id, "offensive");
    const out2 = run([second, third], { history: earlier, reviews: [target], places: [place({ rating: { count: 1, mean: 5 } })] });
    expect(out2.reviews.get(PLACE)).toEqual([{ ...target, hidden: "reported" }]);
    expect(out2.after()?.rating).toBeNull();
    expect(out2.changes.some((c) => c.automatic && /hidden after reports from 3/.test(c.summary))).toBe(true);
  });

  it("refuses a report of a review that is not there, or of one's own review", () => {
    const missing = reviewReport(0, "kim", "rev_01JA0000000000000000000099");
    const own = reviewReport(0, "author", target.id);
    const out = run([missing, own], { reviews: [target] });
    expect(out.outcome(missing)).toBe("refused");
    expect(out.outcome(own)).toBe("refused");
  });
});

describe("items for a person", () => {
  const newPlace = (note?: string) =>
    ({
      ...base(0, "dev-a", null),
      contributor: ctr("dev-a"),
      attested: "play_integrity",
      type: "report",
      location: { lat: -35.1, lon: 149.2 },
      report: { kind: "new_place", ...(note ? { note } : {}) },
    }) as StoredFeedback;

  it("gives a new place the same id when the same item is run again", () => {
    const item = newPlace();
    const first = run([item]).places.keys().next().value;
    const second = run([item], { now: 2 }).places.keys().next().value;
    expect(first).toBe(`ocdb_${item.id.slice(3)}`);
    expect(second).toBe(first);
  });

  it("wrong_location with a location becomes a location edit", () => {
    const item = { ...base(0, "dev-a"), type: "report", location: { lat: -36.9, lon: 144.6 }, report: { kind: "wrong_location" } } as StoredFeedback;
    const out = run([item]);
    expect(out.outcome(item)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([{ kind: "location", place: PLACE, location: { lat: -36.9, lon: 144.6 }, feedback: item.id }]);
  });

  it("other reports need review and change no record", () => {
    const item = { ...base(0, "dev-a"), type: "report", report: { kind: "other", note: "Gate locked at night" } } as StoredFeedback;
    const out = run([item]);
    expect(out.outcome(item)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: item.id }]);
  });

  it("keeps automatic and review changes to one place apart", () => {
    const move = { ...base(0, "dev-c"), type: "report", location: { lat: -36.9, lon: 144.6 }, report: { kind: "wrong_location" } } as StoredFeedback;
    const out = run([fact(0, "dev-a", "power", true), fact(1, "dev-b", "power", true), move], { now: 1 });
    expect(out.after()?.facts.power).toBe(true);
    expect(out.after()?.location).toEqual({ lat: -36.85, lon: 144.55 });
    expect(out.edits.map((e) => e.kind)).toEqual(["location"]);
  });
});

describe("name, description and kind reports", () => {
  const rep = (r: object) => ({ ...base(0, "dev-a"), type: "report", report: r }) as StoredFeedback;

  it("routes each to a person as an edit", () => {
    const name = rep({ kind: "name", value: "Discovery Parks - Lane Cove" });
    const text = rep({ kind: "description", value: "Shady sites by the river." });
    const kind = rep({ kind: "kind", place_kind: "free_camp" });
    const out = run([name, text, kind]);
    expect([name, text, kind].map(out.outcome)).toEqual(["needs_review", "needs_review", "needs_review"]);
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([
      { kind: "name", place: PLACE, name: "Discovery Parks - Lane Cove", feedback: name.id },
      { kind: "description", place: PLACE, description: "Shady sites by the river.", feedback: text.id },
      { kind: "kind", place: PLACE, placeKind: "free_camp", group: "overnight", feedback: kind.id },
    ]);
  });

  it("refuses a kind the data does not know", () => {
    const item = rep({ kind: "kind", place_kind: "space_port" });
    const out = run([item]);
    expect(out.outcome(item)).toBe("refused");
    expect(out.edits).toEqual([]);
  });

  it("sends a contact fact to a person even from one device", () => {
    const item = fact(0, "dev-a", "email", "stay@example.com.au");
    const out = run([item]);
    expect(out.outcome(item)).toBe("needs_review");
    expect(out.edits).toEqual([{ kind: "fact", place: PLACE, fact: "email", value: "stay@example.com.au", feedback: item.id }]);
  });

  it("applies a site feature when two devices agree", () => {
    const out = run([fact(0, "dev-a", "campfires", true), fact(0, "dev-b", "campfires", true)]);
    expect(out.after()?.facts.campfires).toBe(true);
    expect(out.after()?.fact_sources.campfires).toBe("feedback");
  });
});

describe("applyEdit description and kind", () => {
  const now = "2026-10-30T00:00:00Z";

  it("writes a description with its source and date", () => {
    const out = applyEdit(place(), { kind: "description", place: PLACE, description: "Shady sites.", feedback: "fb_x" }, now);
    expect(out).toMatchObject({ description: "Shady sites.", fact_sources: { description: "feedback" }, fact_dates: { description: now }, updated: now });
  });

  it("removes a description for an empty string", () => {
    const out = applyEdit(place({ description: "Old" }), { kind: "description", place: PLACE, description: "", feedback: "fb_x" }, now);
    expect(out?.description).toBeUndefined();
  });

  it("writes kind and group and marks the kind as feedback", () => {
    const out = applyEdit(place(), { kind: "kind", place: PLACE, placeKind: "picnic_site", group: "utility", feedback: "fb_x" }, now);
    expect(out).toMatchObject({ kind: "picnic_site", group: "utility", fact_sources: { kind: "feedback" }, fact_dates: { kind: now } });
  });
});

describe("applyEdit", () => {
  const now = "2026-10-30T00:00:00Z";

  it("moves a place and marks the location as feedback", () => {
    const out = applyEdit(place(), { kind: "location", place: PLACE, location: { lat: -36.9, lon: 144.6 }, feedback: "fb_x" }, now);
    expect(out).toMatchObject({
      location: { lat: -36.9, lon: 144.6 },
      fact_sources: { location: "feedback" },
      fact_dates: { location: now },
      updated: now,
    });
  });

  it("keeps the dates of other values and moves only the edited one", () => {
    const earlier = "2026-09-01T00:00:00Z";
    const before = place({
      fact_sources: { power: "feedback", fee: "osm", name: "feedback" },
      fact_dates: { power: earlier, name: earlier },
    });
    const out = applyEdit(before, { kind: "name", place: PLACE, name: "Eppalock Camp", feedback: "fb_x" }, now);
    expect(out?.fact_dates).toEqual({ power: earlier, name: now });
  });

  it("sets a reviewed fact and marks it as feedback", () => {
    const out = applyEdit(place(), { kind: "fact", place: PLACE, fact: "phone", value: "+61 2 6123 4567", feedback: "fb_x" }, now);
    expect(out?.facts.phone).toBe("+61 2 6123 4567");
    expect(out?.fact_sources.phone).toBe("feedback");
  });

  it("returns undefined when the edit is already there", () => {
    const moved = place({
      location: { lat: -36.9, lon: 144.6 },
      fact_sources: { power: "osm", fee: "osm", location: "feedback" },
      fact_dates: { location: "2026-09-01T00:00:00Z" },
    });
    expect(applyEdit(moved, { kind: "location", place: PLACE, location: { lat: -36.9, lon: 144.6 }, feedback: "fb_x" }, now)).toBeUndefined();
  });

  it("does not overwrite a draft a person has already edited", () => {
    const draft = place({ id: "ocdb_01JC0000000000000000000001", name: "Creek camp", osm: null });
    const edit = { kind: "new_place" as const, record: { ...draft, name: null }, feedback: "fb_01JC0000000000000000000001" };
    expect(applyEdit(draft, edit, now)).toBeUndefined();
    expect(applyEdit(undefined, edit, now)).toEqual({ ...draft, name: null });
  });
});

describe("unknown places", () => {
  it("refuses feedback for a place that is not in the data", () => {
    const r = fact(0, "dev-a", "power", true, OTHER);
    const out = run([r]);
    expect(out.outcome(r)).toBe("refused");
    expect(out.decisions[0]?.reason).toMatch(/not in the data/);
  });
});

describe("merged places", () => {
  const tombstone = () => place({ id: OTHER, status: "merged", merged_into: PLACE });

  it("redirects feedback for a merged id to the place it was merged into", () => {
    const item = closed(0, "dev-a");
    const aimed = { ...item, place: OTHER } as StoredFeedback;
    const out = run([aimed], { places: [tombstone(), place()] });
    expect(out.after()?.status).toBe("reported_closed");
    expect(out.after(OTHER)).toBeUndefined();
    expect(out.outcome(aimed)).toBe("applied");
  });

  it("never writes to a tombstone whose target is missing", () => {
    const aimed = { ...closed(0, "dev-a"), place: OTHER } as StoredFeedback;
    const out = run([aimed], { places: [place({ id: OTHER, status: "merged", merged_into: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZZ" })] });
    expect(out.outcome(aimed)).toBe("refused");
    expect(out.places.size).toBe(0);
  });
});

describe("new place kind", () => {
  const newPlace = (placeKind?: string) =>
    ({
      ...base(0, "dev-a", null),
      contributor: ctr("dev-a"),
      attested: "app_attest",
      type: "report",
      location: { lat: -35.1, lon: 149.2 },
      report: { kind: "new_place", ...(placeKind ? { place_kind: placeKind } : {}) },
    }) as StoredFeedback;
  const draftOf = (out: ReturnType<typeof run>) => [...out.places.values()].find((p) => p.osm === null);

  it("uses the kind the user picked, with its group from kinds.json", () => {
    expect(draftOf(run([newPlace("picnic_site")]))).toMatchObject({ kind: "picnic_site", group: "utility" });
  });

  it("falls back to campground for a kind the data does not know", () => {
    expect(draftOf(run([newPlace("spaceport")]))).toMatchObject({ kind: "campground", group: "overnight" });
    expect(draftOf(run([newPlace()]))).toMatchObject({ kind: "campground", group: "overnight" });
  });
});

describe("new places", () => {
  const SPOT = { lat: -35.1, lon: 149.2 };
  const added = (day = 0, device = "dev-a", extra: Record<string, unknown> = {}, location = SPOT) =>
    ({
      ...base(day, device, null),
      contributor: ctr(device),
      attested: "app_attest",
      type: "report",
      location,
      report: { kind: "new_place", place_kind: "free_camp", note: "Gravel pit off the highway", ...extra },
    }) as StoredFeedback;
  const idOf = (item: StoredFeedback) => `ocdb_${item.id.slice(3)}`;

  it("publishes a new place at once, marked shown", () => {
    const item = added();
    const out = run([item]);
    expect(out.outcome(item)).toBe("applied");
    expect(out.after(idOf(item))).toEqual({
      id: idOf(item),
      name: null,
      kind: "free_camp",
      group: "overnight",
      location: SPOT,
      osm: null,
      facts: {},
      status: "open",
      rating: null,
      standing: "shown",
      fact_sources: { location: "feedback" },
      fact_dates: { location: at(1) },
      updated: at(1),
    });
    expect(out.changes).toEqual([expect.objectContaining({ place: idOf(item), automatic: true })]);
    expect(out.edits).toEqual([]);
  });

  const withdraw = (day: number, device: string, target: StoredFeedback) =>
    ({ ...base(day, device, idOf(target)), type: "withdraw" }) as StoredFeedback;

  it("does not write a place its adder withdrew within 24 hours", () => {
    const item = added(0);
    const back = withdraw(0.5, "dev-a", item);
    const out = run([item, back]);
    expect(out.outcome(item)).toBe("refused");
    expect(out.outcome(back)).toBe("applied");
    expect(out.places.size).toBe(0);
    expect(out.removed).toEqual([]);
  });

  const remove = (day: number, device: string, target: StoredFeedback, reason = "fake") =>
    ({ ...base(day, device, idOf(target)), type: "report", report: { kind: "remove", reason } }) as StoredFeedback;
  const visit = (day: number, device: string, target: StoredFeedback, stillThere: boolean, nearby = true) =>
    ({
      ...base(day, device, idOf(target)),
      type: "check",
      check: { visited: at(day).slice(0, 10), still_there: stillThere, ...(nearby ? { nearby: true } : {}) },
    }) as StoredFeedback;
  /** The new place's record as an earlier run wrote it. */
  const written = (item: StoredFeedback, standing: Place["standing"] = "shown") =>
    place({ id: idOf(item), name: null, osm: null, facts: {}, fact_sources: { location: "feedback" }, location: SPOT, standing });
  const inData = (item: StoredFeedback, standing: Place["standing"] = "shown") => ({ history: [applied(item)], places: [place(), written(item, standing)] });

  it("removes a published place its adder withdrew within 24 hours", () => {
    const item = added(0);
    const back = withdraw(0.9, "dev-a", item);
    const out = run([back], { ...inData(item), now: 1 });
    expect(out.outcome(back)).toBe("applied");
    expect(out.removed).toEqual([idOf(item)]);
    expect(out.changes).toEqual([expect.objectContaining({ place: idOf(item), automatic: true, feedback: [back.id] })]);
  });

  it("refuses a withdrawal from another install", () => {
    const item = added(0);
    const back = withdraw(0.5, "dev-b", item);
    const out = run([back], inData(item));
    expect(out.outcome(back)).toBe("refused");
    expect(out.removed).toEqual([]);
    expect(out.places.size).toBe(0);
  });

  it("refuses a withdrawal for a place nobody added", () => {
    const back = { ...base(0, "dev-a", OTHER), type: "withdraw" } as StoredFeedback;
    expect(run([back]).outcome(back)).toBe("refused");
  });

  it("counts a withdrawal after 24 hours as one more report", () => {
    const item = added(0);
    const out = run([withdraw(3, "dev-a", item), remove(3, "dev-b", item)], { ...inData(item), now: 4 });
    expect(out.removed).toEqual([]);
    expect(out.after(idOf(item))?.standing).toBe("hidden");
  });

  it("hides a published place reported by two devices and lists it for a person", () => {
    const item = added(0);
    const first = remove(1, "dev-b", item, "private_land");
    const second = visit(1, "dev-c", item, false);
    const out = run([first, second], { ...inData(item), now: 2 });
    expect(out.outcome(first)).toBe("applied");
    expect(out.outcome(second)).toBe("applied");
    expect(out.after(idOf(item))?.standing).toBe("hidden");
    expect(out.held).toEqual([
      {
        case: "hidden",
        place: idOf(item),
        standing: "hidden",
        location: SPOT,
        kind: "free_camp",
        reports: 2,
        reasons: ["not_there", "private_land"],
        feedback: [first.id, second.id],
      },
    ]);
  });

  it("one report leaves a published place shown and lists nothing", () => {
    const item = added(0);
    const out = run([remove(1, "dev-b", item)], { ...inData(item), now: 2 });
    expect(out.places.size).toBe(0);
    expect(out.held).toEqual([]);
  });

  it("confirms a place two other devices found there nearby, and then needs three reports to hide it", () => {
    const item = added(0);
    const yes = [visit(1, "dev-b", item, true), visit(1, "dev-c", item, true)];
    const confirmed = run(yes, { ...inData(item), now: 2 });
    expect(confirmed.after(idOf(item))?.standing).toBe("confirmed");
    const history = [applied(item), ...yes.map((y) => applied(y))];
    const places = [place(), written(item, "confirmed")];
    const two = run([remove(3, "dev-d", item), remove(3, "dev-e", item)], { history, places, now: 4 });
    expect(two.places.size).toBe(0);
    const three = run([remove(3, "dev-d", item), remove(3, "dev-e", item), remove(3, "dev-f", item)], { history, places, now: 4 });
    expect(three.after(idOf(item))?.standing).toBe("hidden");
  });

  it("does not confirm a place on checks that were not sent near it, or from its adder", () => {
    const item = added(0);
    const out = run([visit(1, "dev-b", item, true, false), visit(1, "dev-a", item, true), visit(1, "dev-c", item, true)], { ...inData(item), now: 2 });
    expect(out.places.size).toBe(0);
  });

  it("holds a new place within 150 m of a place in the same group for a person", () => {
    const near = { lat: -36.851, lon: 144.5505 };
    const item = added(0, "dev-a", {}, near);
    const out = run([item]);
    expect(out.outcome(item)).toBe("needs_review");
    expect(out.places.size).toBe(0);
    expect(out.edits).toEqual([{ kind: "new_place", record: expect.objectContaining({ id: idOf(item), standing: "held" }), feedback: item.id }]);
    expect(out.changes).toEqual([expect.objectContaining({ automatic: false, summary: expect.stringContaining(`possible duplicate of ${PLACE}, 120 m away`) })]);
    expect(out.held).toEqual([
      expect.objectContaining({ case: "duplicate", place: idOf(item), standing: "held", duplicate_of: PLACE, distance_m: 120, feedback: [item.id] }),
      expect.objectContaining({ case: "first_place" }),
    ]);
  });

  it("does not hold a new place near a place in another group, or further than 150 m away", () => {
    const toilet = added(0, "dev-a", { place_kind: "picnic_site" }, { lat: -36.851, lon: 144.5505 });
    const far = added(0, "dev-b", {}, { lat: -36.852, lon: 144.5505 });
    const out = run([toilet, far]);
    expect(out.outcome(toilet)).toBe("applied");
    expect(out.outcome(far)).toBe("applied");
  });

  it("holds the second of two places added at the same spot in one run", () => {
    const first = added(0, "dev-a");
    const second = added(0.1, "dev-b");
    const out = run([first, second]);
    expect(out.outcome(first)).toBe("applied");
    expect(out.outcome(second)).toBe("needs_review");
    expect(out.held).toContainEqual(expect.objectContaining({ case: "duplicate", place: idOf(second), duplicate_of: idOf(first), distance_m: 0 }));
  });

  it("publishes a place with contacts but leaves the contacts for a person", () => {
    const item = added(0, "dev-a", { contacts: { phone: "03 5555 0100", website: "https://park.example.org" } });
    const history = [applied(added(-5, "dev-a", {}, { lat: -30, lon: 140 }))];
    const out = run([item], { history });
    expect(out.after(idOf(item))?.facts).toEqual({});
    expect(out.held).toEqual([
      { case: "contacts", place: idOf(item), standing: "shown", location: SPOT, kind: "free_camp", contacts: ["phone", "website"], feedback: [item.id] },
    ]);
    expect(JSON.stringify(out.held)).not.toContain("5555");
  });

  it("lists a contributor's first place, published, and not their second", () => {
    const first = added(0, "dev-a");
    const out = run([first]);
    expect(out.outcome(first)).toBe("applied");
    expect(out.held).toEqual([expect.objectContaining({ case: "first_place", place: idOf(first), standing: "shown", contributor: ctr("dev-a") })]);
    const second = added(2, "dev-a", {}, { lat: -30, lon: 140 });
    expect(run([second], { history: [applied(first)], now: 3 }).held).toEqual([]);
  });

  it("drafts a place reported down before it was ever published for a person, with its contacts", () => {
    const item = added(0, "dev-a", { contacts: { phone: "03 5555 0100" } });
    const reports = [remove(0.1, "dev-b", item), remove(0.2, "dev-c", item)];
    const out = run([item, ...reports]);
    expect(out.outcome(item)).toBe("needs_review");
    expect(out.places.size).toBe(0);
    const edit = out.edits[0];
    expect(edit?.kind === "new_place" && edit.record).toMatchObject({ standing: "hidden", facts: { phone: "03 5555 0100" }, fact_sources: { phone: "feedback" } });
    expect(out.held.map((h) => h.case)).toEqual(["hidden", "first_place"]);
  });

  it("hides a published place once its contributor is blocked", () => {
    const item = added(0);
    const out = run([visit(1, "dev-b", item, true)], { ...inData(item), blocked: [ctr("dev-a")], now: 2 });
    expect(out.after(idOf(item))?.standing).toBe("hidden");
    expect(out.held).toEqual([expect.objectContaining({ case: "hidden", blocked: true })]);
  });

  it("sends a removal report on a place that is not new to a person", () => {
    const report = { ...base(0, "dev-b"), type: "report", report: { kind: "remove", reason: "fake" } } as StoredFeedback;
    const out = run([report]);
    expect(out.outcome(report)).toBe("needs_review");
    expect(out.changes).toEqual([expect.objectContaining({ place: PLACE, automatic: false, summary: expect.stringContaining("fake") })]);
  });

  it("sends a new place to a person when the intake would not list it", () => {
    const unproven = { ...added(0, "dev-a"), attested: undefined } as unknown as StoredFeedback;
    const anonymous = { ...added(0, "dev-b", {}, { lat: -30, lon: 140 }), contributor: undefined } as unknown as StoredFeedback;
    const rude = added(0, "dev-c", { note: "Call 0400 000 000 for a spot" }, { lat: -31, lon: 141 });
    const out = run([unproven, anonymous, rude]);
    expect(out.places.size).toBe(0);
    for (const item of [unproven, anonymous, rude]) expect(out.outcome(item)).toBe("needs_review");
    expect(out.edits.map((e) => e.kind === "new_place" && e.record.standing)).toEqual(["held", "held", "held"]);
    expect(out.changes.map((c) => c.summary)).toEqual([
      expect.stringContaining("not proven by attestation"),
      expect.stringContaining("no contributor"),
      expect.stringContaining("note fails the text checks (contact)"),
    ]);
  });

  it("confirms a place only on checks sent near it, as the intake does", () => {
    const item = added(0);
    const out = run([visit(1, "dev-b", item, true, false), visit(1, "dev-c", item, true, false)], { ...inData(item), now: 2 });
    expect(out.places.size).toBe(0);
  });

  describe("a moderator's decision", () => {
    /** A place hidden by two reports, which a person has since restored or hidden on its record. */
    const decided = (moderator: Place["moderator"], standing: Place["standing"]) => {
      const item = added(0);
      const reports = [remove(1, "dev-b", item), remove(1, "dev-c", item)];
      return {
        item,
        input: { history: [applied(item), ...reports.map((r) => applied(r))], places: [place(), { ...written(item, standing), moderator }] },
      };
    };

    it("keeps a restored place shown, setting aside the reports before the restore", () => {
      const { item, input } = decided({ action: "restore", at: at(2) }, "shown");
      const out = run([visit(3, "dev-d", item, true)], { ...input, now: 4 });
      expect(out.places.get(idOf(item))?.standing ?? "shown").toBe("shown");
      expect(out.held).toEqual([]);
    });

    it("hides a restored place again on two reports after the restore", () => {
      const { item, input } = decided({ action: "restore", at: at(2) }, "shown");
      const out = run([remove(3, "dev-d", item), remove(3, "dev-e", item)], { ...input, now: 4 });
      expect(out.after(idOf(item))?.standing).toBe("hidden");
    });

    it("keeps a place a person hid hidden, whatever travellers find", () => {
      const { item, input } = decided({ action: "hide", at: at(2) }, "hidden");
      const out = run([visit(3, "dev-d", item, true), visit(3, "dev-e", item, true)], { ...input, now: 4 });
      expect(out.places.get(idOf(item))?.standing ?? "hidden").toBe("hidden");
    });

    it("sets a place's standing to match a decision made without it", () => {
      const { item, input } = decided({ action: "restore", at: at(2) }, "hidden");
      const out = run([visit(3, "dev-d", item, true)], { ...input, now: 4 });
      expect(out.after(idOf(item))?.standing).toBe("shown");
    });

    it("leaves out a decision it can't read", () => {
      const { item, input } = decided({ action: "keep", at: "soon" } as unknown as Place["moderator"], "shown");
      const out = run([visit(3, "dev-d", item, true)], { ...input, now: 4 });
      expect(out.after(idOf(item))?.standing).toBe("hidden");
    });

    it("tells the person how to restore a place hidden before it was published", () => {
      const item = added(0);
      const out = run([item, remove(0.1, "dev-b", item), remove(0.2, "dev-c", item)]);
      expect(out.changes.find((c) => c.place === idOf(item) && !c.automatic)?.summary).toContain(
        `set standing to shown and moderator to {"action": "restore", "at": "${at(1)}"}`,
      );
    });
  });

  it("names a new place with the name its report carries", () => {
    const item = added(0, "dev-a", { name: "Gravel Pit Rest Area" });
    expect(run([item]).after(idOf(item))).toMatchObject({
      name: "Gravel Pit Rest Area",
      fact_sources: { location: "feedback", name: "feedback" },
      fact_dates: { location: at(1), name: at(1) },
    });
  });
});
