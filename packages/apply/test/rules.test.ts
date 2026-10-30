import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyEdit, applyRules, ratingOf, type RulesInput } from "../src/rules.js";
import type { Place, Review } from "../src/types.js";

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
  return { id: fbId(), received: at(day), app: "camporacle", place: placeId, device, app_version: "1.0.0", consent: true as const };
}

const fact = (day: number, device: string, name: string, value: boolean | string, placeId = PLACE): StoredFeedback =>
  ({ ...base(day, device, placeId), type: "report", report: { kind: "fact", fact: name, value } }) as StoredFeedback;
const closed = (day: number, device: string): StoredFeedback =>
  ({ ...base(day, device), type: "report", report: { kind: "closed" } }) as StoredFeedback;
const reopened = (day: number, device: string): StoredFeedback =>
  ({ ...base(day, device), type: "report", report: { kind: "reopened" } }) as StoredFeedback;
const check = (day: number, device: string, stillThere: boolean): StoredFeedback =>
  ({ ...base(day, device), type: "check", check: { visited: at(day).slice(0, 10), still_there: stillThere } }) as StoredFeedback;
const review = (day: number, device: string, stars: number, text: string): StoredFeedback =>
  ({ ...base(day, device), type: "review", review: { stars, text, visited: "2026-06" } }) as StoredFeedback;

function run(
  pending: StoredFeedback[],
  opts: { now?: number; history?: StoredFeedback[]; places?: Place[]; reviews?: Review[] } = {},
) {
  const places = new Map((opts.places ?? [place()]).map((p) => [p.id, p]));
  const input: RulesInput = {
    now: at(opts.now ?? 1),
    pending,
    history: opts.history ?? [],
    places,
    reviews: (id) => (opts.reviews ?? []).filter((r) => r.place === id),
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
});

describe("reviews", () => {
  it("accepts a clean review, appends it and recalculates the rating", () => {
    const r = review(0, "dev-a", 3, "Shady, flat sites near the water.");
    const existing: Review[] = [
      { id: "rev_01JA0000000000000000000001", place: PLACE, stars: 5, text: "", visited: "2026-01", created: "2026-01-05T00:00:00Z", app: "camporacle" },
      { id: "rev_01JA0000000000000000000002", place: PLACE, stars: 4, text: "", visited: "2026-02", created: "2026-02-05T00:00:00Z", app: "camporacle" },
    ];
    const out = run([r], { reviews: existing, places: [place({ rating: { count: 2, mean: 4.5 } })] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.reviews.get(PLACE)).toEqual([
      {
        id: `rev_${r.id.slice(3)}`,
        place: PLACE,
        stars: 3,
        text: "Shady, flat sites near the water.",
        visited: "2026-06",
        created: r.received,
        app: "camporacle",
      },
    ]);
    expect(out.after()?.rating).toEqual({ count: 3, mean: 4 });
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
  ])("refuses %j", (text, reason) => {
    const r = review(0, "dev-a", 2, text);
    const out = run([r]);
    expect(out.outcome(r)).toBe("refused");
    expect(out.decisions[0]?.reason).toMatch(reason);
  });

  it("does not add the same review twice", () => {
    const r = review(0, "dev-a", 4, "Nice");
    const existing: Review = { id: `rev_${r.id.slice(3)}`, place: PLACE, stars: 4, text: "Nice", visited: "2026-06", created: r.received, app: "camporacle" };
    const out = run([r], { reviews: [existing], places: [place({ rating: { count: 1, mean: 4 } })] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.reviews.size).toBe(0);
  });

  it("rounds the mean to 1 decimal place", () => {
    const out = run([review(0, "a", 5, ""), review(0, "b", 4, ""), review(0, "c", 4, "")]);
    expect(out.after()?.rating).toEqual({ count: 3, mean: 4.3 });
  });

  it("rounds a mean that is exactly half way up", () => {
    // 23 / 20 = 1.15, which floating point rounds down to 1.1.
    const stars = [...Array(17).fill(1), 2, 2, 2] as number[];
    expect(ratingOf(stars.map((s) => ({ stars: s })))).toEqual({ count: 20, mean: 1.2 });
    expect(ratingOf([{ stars: 4 }, { stars: 5 }])).toEqual({ count: 2, mean: 4.5 });
    expect(ratingOf([{ stars: 4 }, { stars: 4 }, { stars: 5 }, { stars: 5 }, { stars: 5 }, { stars: 4 }, { stars: 4 }, { stars: 4 }])).toEqual({ count: 8, mean: 4.4 });
  });
});

describe("items for a person", () => {
  const newPlace = (note?: string) =>
    ({
      ...base(0, "dev-a", null),
      type: "report",
      location: { lat: -35.1, lon: 149.2 },
      report: { kind: "new_place", ...(note ? { note } : {}) },
    }) as StoredFeedback;

  it("a new place becomes a draft edit, never an automatic change", () => {
    const item = newPlace("Free camp beside the creek");
    const out = run([item]);
    expect(out.outcome(item)).toBe("needs_review");
    expect(out.needsReview).toBe(true);
    expect(out.places.size).toBe(0);
    expect(out.edits).toHaveLength(1);
    const edit = out.edits[0]!;
    expect(edit.kind).toBe("new_place");
    if (edit.kind !== "new_place") return;
    // The id comes from the feedback id, so a second run writes the same file.
    expect(edit.record.id).toBe(`ocdb_${item.id.slice(3)}`);
    expect(edit.record).toMatchObject({
      name: null,
      location: { lat: -35.1, lon: 149.2 },
      osm: null,
      status: "open",
      facts: {},
      fact_sources: { location: "feedback" },
    });
  });

  it("gives the same draft id when the same item is run again", () => {
    const item = newPlace();
    const first = run([item]).edits[0];
    const second = run([item], { now: 2 }).edits[0];
    expect(first?.kind === "new_place" && second?.kind === "new_place" && first.record.id === second.record.id).toBe(true);
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

describe("applyEdit", () => {
  const now = "2026-10-30T00:00:00Z";

  it("moves a place and marks the location as feedback", () => {
    const out = applyEdit(place(), { kind: "location", place: PLACE, location: { lat: -36.9, lon: 144.6 }, feedback: "fb_x" }, now);
    expect(out).toMatchObject({ location: { lat: -36.9, lon: 144.6 }, fact_sources: { location: "feedback" }, updated: now });
  });

  it("sets a reviewed fact and marks it as feedback", () => {
    const out = applyEdit(place(), { kind: "fact", place: PLACE, fact: "phone", value: "+61 2 6123 4567", feedback: "fb_x" }, now);
    expect(out?.facts.phone).toBe("+61 2 6123 4567");
    expect(out?.fact_sources.phone).toBe("feedback");
  });

  it("returns undefined when the edit is already there", () => {
    const moved = place({ location: { lat: -36.9, lon: 144.6 }, fact_sources: { power: "osm", fee: "osm", location: "feedback" } });
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
