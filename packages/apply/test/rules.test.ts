import { describe, expect, it } from "vitest";
import { FEE_RETIRED, type StoredFeedback } from "@opencampingdb/feedback";
import { applyEdit, applyHeldReview, applyRules, GAP_FILL_DAILY_LIMIT, ratingOf, REPORTS_TO_HIDE, reviewIdOf, type ClosureEvidence, type HeldCase, type RulesInput } from "../src/rules.js";
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
/** A fee report as an older client sent it, before fee reports were retired. */
const fee = (day: number, who: string, amount: number, site = "powered", paid = "2026-06", placeId = PLACE): StoredFeedback =>
  ({ ...base(day, who, placeId), contributor: ctr(who), type: "fee", fee: { amount, site, paid } }) as unknown as StoredFeedback;
/** Stored items as `applied/` holds them, with the outcome a run gave them. */
const applied = (item: StoredFeedback, result = "applied") => ({ ...item, outcome: { result, reason: "", run: at(0) } }) as unknown as StoredFeedback;

function run(
  pending: StoredFeedback[],
  opts: {
    now?: number;
    history?: StoredFeedback[];
    places?: Place[];
    reviews?: Review[];
    blocked?: string[];
    recent?: RulesInput["recent"];
    extra?: Partial<RulesInput>;
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
    kinds: new Map([
      ["campground", "overnight"],
      ["free_camp", "overnight"],
      ["picnic_site", "utility"],
    ]),
    blocked: new Set(opts.blocked ?? []),
    ...(opts.recent !== undefined ? { recent: opts.recent } : {}),
    ...opts.extra,
  };
  const out = applyRules(input);
  const outcome = (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.outcome;
  return { ...out, outcome, after: (id = PLACE) => out.places.get(id) };
}

describe("attested fact reports", () => {
  const attested = (item: StoredFeedback) => ({ ...item, attested: "app_attest", contributor: ctr(item.device) }) as StoredFeedback;

  it("sends a link the intake held for one of these rules to a person, unless the intake says its links passed the checks", () => {
    const heldByRule = { ...attested(fact(0, "dev-a", "website", "https://new.example.org/camp")), intake: { state: "held", held_reason: "unknown_place" } } as StoredFeedback;
    const unchecked = run([heldByRule]);
    expect(unchecked.outcome(heldByRule)).toBe("needs_review");
    expect(unchecked.after()?.facts.website).toBeUndefined();
    expect(unchecked.changes).toEqual([expect.objectContaining({ automatic: false })]);
    const checked = { ...heldByRule, intake: { state: "held", held_reason: "unknown_place", links: "passed" } } as StoredFeedback;
    const out = run([checked]);
    expect(out.outcome(checked)).toBe("applied");
    expect(out.after()?.facts.website).toBe("https://new.example.org/camp");
    // A fact with no link is decided as before.
    const toilets = { ...attested(fact(0, "dev-a", "toilets", true)), intake: { state: "held", held_reason: "unknown_place" } } as StoredFeedback;
    expect(run([toilets]).outcome(toilets)).toBe("applied");
  });

  it("one attested report changes a fact at once", () => {
    const r = attested(fact(0, "dev-a", "power", true));
    const out = run([r]);
    expect(out.outcome(r)).toBe("applied");
    expect(out.after()?.facts).toMatchObject({ power: true });
    expect(out.after()?.fact_sources).toMatchObject({ power: "feedback" });
  });

  it("a later report from the same device changes it again", () => {
    const a = attested(fact(0, "dev-a", "power", true));
    const b = attested(fact(1, "dev-a", "power", false));
    const out = run([a, b], { now: 2 });
    expect(out.outcome(b)).toBe("applied");
    expect(out.after()?.facts).toMatchObject({ power: false });
  });

  it("sends a value another device disagrees with in the same run to a person", () => {
    const a = attested(fact(0, "dev-a", "power", true));
    const b = attested(fact(1, "dev-b", "power", false));
    const out = run([a, b], { now: 2 });
    expect(out.outcome(a)).toBe("applied");
    expect(out.outcome(b)).toBe("needs_review");
    expect(out.after()?.facts).toMatchObject({ power: true });
  });

  it("sends a value another device disagreed with in an earlier run to a person", () => {
    const earlier = applied(attested(fact(0, "dev-a", "power", true)));
    const r = attested(fact(5, "dev-b", "power", false));
    const out = run([r], { now: 6, history: [earlier], places: [place({ facts: { power: true } })] });
    expect(out.outcome(r)).toBe("needs_review");
  });

  it("applies a value once the disagreeing report is more than 90 days old", () => {
    const earlier = applied(attested(fact(0, "dev-a", "power", true)));
    const r = attested(fact(95, "dev-b", "power", false));
    const out = run([r], { now: 96, history: [earlier], places: [place({ facts: { power: true } })] });
    expect(out.after()?.facts).toMatchObject({ power: false });
    expect(out.outcome(r)).toBe("applied");
  });

  it("sends a report against a fact the owner set to a person at once", () => {
    const r = attested(fact(0, "dev-a", "power", true));
    const out = run([r], { places: [place({ fact_sources: { power: "owner" } })] });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
  });

  it("still waits for a second device on a report without attestation", () => {
    const r = fact(0, "dev-a", "power", true);
    expect(run([r]).outcome(r)).toBe("waiting");
  });
});

describe("attested contact fact reports", () => {
  const attested = (item: StoredFeedback) => ({ ...item, attested: "app_attest", contributor: ctr(item.device) }) as StoredFeedback;
  const addressReport = (day: number, device: string, value: object) =>
    ({ ...base(day, device), type: "report", report: { kind: "fact", fact: "address", value } }) as StoredFeedback;

  it("applies an attested contact that passes the link checks at once", () => {
    for (const [name, value] of [
      ["website", "https://park.example.org"],
      ["phone", "03 5555 0100"],
      ["phone_2", "03 5555 0101"],
      ["email", "stay@park.example.org"],
      ["facebook", "https://www.facebook.com/lakecamp"],
      ["instagram", "https://instagram.com/lakecamp"],
      ["tiktok", "https://www.tiktok.com/@lakecamp"],
      ["x", "https://x.com/lakecamp"],
    ] as const) {
      const r = attested(fact(0, "dev-a", name, value));
      const out = run([r]);
      expect(out.outcome(r)).toBe("applied");
      expect(out.after()?.facts).toMatchObject({ [name]: value });
      expect(out.after()?.fact_sources).toMatchObject({ [name]: "feedback" });
      expect(out.after()?.fact_dates).toMatchObject({ [name]: at(1) });
      expect(out.edits).toEqual([]);
    }
  });

  it("applies an attested address at once", () => {
    const value = { housenumber: "12", street: "Lake Road", suburb: "Lakeside", state: "VIC", postcode: "3999" };
    const r = attested(addressReport(0, "dev-a", value));
    const out = run([r]);
    expect(out.outcome(r)).toBe("applied");
    expect(out.after()?.facts.address).toEqual(value);
  });

  it("accepts an address that is already the place's address", () => {
    const value = { street: "Lake Road", suburb: "Lakeside" };
    const r = attested(addressReport(0, "dev-a", { ...value }));
    const out = run([r], { places: [place({ facts: { address: value } })] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.after()).toBeUndefined();
  });

  it("sends an attested contact that fails the link checks to a person", () => {
    for (const [name, value] of [
      ["website", "https://bit.ly/camp"],
      ["website", "https://10.0.0.1/"],
      ["facebook", "https://park.example.org/fb"],
      ["instagram", "https://tinyurl.com/camp"],
    ] as const) {
      const r = attested(fact(0, "dev-a", name, value));
      const out = run([r]);
      expect(out.outcome(r)).toBe("needs_review");
      expect(out.after()).toBeUndefined();
      expect(out.edits).toEqual([{ kind: "fact", place: PLACE, fact: name, value, feedback: r.id }]);
      expect(out.decisions[0]?.reason).toMatch(/fails the link checks/);
    }
  });

  it("sends a contact another device disagreed with to a person", () => {
    const earlier = applied(attested(fact(0, "dev-a", "website", "https://park.example.org")));
    const r = attested(fact(5, "dev-b", "website", "https://other.example.org"));
    const out = run([r], { now: 6, history: [earlier], places: [place({ facts: { website: "https://park.example.org" } })] });
    expect(out.outcome(r)).toBe("needs_review");
  });

  it("sends an address another device disagrees with in the same run to a person", () => {
    const a = attested(addressReport(0, "dev-a", { street: "Lake Road" }));
    const b = attested(addressReport(1, "dev-b", { street: "Creek Road" }));
    const out = run([a, b], { now: 2 });
    expect(out.outcome(a)).toBe("applied");
    expect(out.outcome(b)).toBe("needs_review");
  });

  it("sends a contact the owner set to a person", () => {
    const r = attested(fact(0, "dev-a", "phone", "03 5555 0100"));
    const out = run([r], { places: [place({ facts: { phone: "03 5555 0199" }, fact_sources: { phone: "owner" } })] });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
  });

  it("still sends a contact without attestation to a person", () => {
    const r = fact(0, "dev-a", "website", "https://park.example.org");
    const out = run([r]);
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
  });
});

describe("contact reports", () => {
  const withSite = () => place({ facts: { website: "https://spam.example.org", phone: "03 5555 0100" }, fact_sources: { website: "osm", phone: "osm" } });
  const contactReport = (day: number, device: string, name: string, reason = "spam", extra: Record<string, unknown> = {}) =>
    ({ ...base(day, device), type: "report", report: { kind: "contact", fact: name, reason }, ...extra }) as StoredFeedback;
  const attested = (item: StoredFeedback) => ({ ...item, attested: "app_attest", contributor: ctr(item.device) }) as StoredFeedback;

  it("sends one report to a person, naming the fact", () => {
    const r = attested(contactReport(0, "dev-a", "website"));
    const out = run([r], { places: [withSite()] });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.decisions[0]?.reason).toContain("website");
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: r.id }]);
    expect(out.changes).toEqual([expect.objectContaining({ automatic: false, summary: expect.stringContaining("website reported as spam") })]);
    expect(out.held).toEqual([]);
  });

  it("takes a contact down on reports from two sources, one attested, and lists it for a reviewer", () => {
    const a = attested(contactReport(0, "dev-a", "website", "spam"));
    const b = contactReport(1, "dev-b", "website", "wrong");
    const out = run([a, b], { now: 2, places: [withSite()] });
    expect(out.outcome(a)).toBe("applied");
    expect(out.outcome(b)).toBe("applied");
    expect(out.after()?.facts).toEqual({ phone: "03 5555 0100" });
    // The source and date go with the value, as the data validator requires.
    expect(out.after()?.fact_sources.website).toBeUndefined();
    expect(out.after()?.fact_dates?.website).toBeUndefined();
    expect(out.changes).toEqual([expect.objectContaining({ automatic: true, feedback: [a.id, b.id], summary: expect.stringContaining("website taken down") })]);
    expect(out.held).toEqual([
      {
        case: "contact_withdrawn",
        place: PLACE,
        location: { lat: -36.85, lon: 144.55 },
        kind: "free_camp",
        fact: "website",
        value: "https://spam.example.org",
        reasons: ["spam", "wrong"],
        feedback: [a.id, b.id],
      },
    ]);
  });

  it("counts a report from an earlier run within 90 days", () => {
    const earlier = applied(attested(contactReport(0, "dev-a", "phone", "wrong")), "needs_review");
    const r = contactReport(30, "dev-b", "phone", "wrong");
    const out = run([r], { now: 31, history: [earlier], places: [withSite()] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.after()?.facts.phone).toBeUndefined();
    expect(out.held).toEqual([expect.objectContaining({ case: "contact_withdrawn", fact: "phone", value: "03 5555 0100", feedback: [earlier.id, r.id] })]);
  });

  it("does not count a report more than 90 days old", () => {
    const earlier = applied(attested(contactReport(0, "dev-a", "phone")), "needs_review");
    const r = contactReport(95, "dev-b", "phone");
    const out = run([r], { now: 96, history: [earlier], places: [withSite()] });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
  });

  it("does not take a contact down on two sources neither of them attested", () => {
    const out = run([contactReport(0, "dev-a", "website"), contactReport(1, "dev-b", "website")], { now: 2, places: [withSite()] });
    expect(out.after()).toBeUndefined();
    expect(out.decisions.map((d) => d.outcome)).toEqual(["needs_review", "needs_review"]);
  });

  it("counts two devices on one network as one source", () => {
    const a = attested(contactReport(0, "dev-a", "website", "spam", { origin: "net-1" }));
    const b = contactReport(1, "dev-b", "website", "spam", { origin: "net-1" });
    const out = run([a, b], { now: 2, places: [withSite()] });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(b)).toBe("needs_review");
  });

  it("does not count a report sent before the contact was last set", () => {
    const earlier = applied(attested(contactReport(0, "dev-a", "website")), "needs_review");
    const r = contactReport(10, "dev-b", "website");
    const changed = place({ facts: { website: "https://park.example.org" }, fact_sources: { website: "feedback" }, fact_dates: { website: at(5) } });
    const out = run([r], { now: 11, history: [earlier], places: [changed] });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
  });

  it("leaves a contact the owner set to a person, however many report it", () => {
    const owned = place({ facts: { website: "https://park.example.org" }, fact_sources: { website: "owner" }, fact_dates: { website: at(-10) } });
    const a = attested(contactReport(0, "dev-a", "website"));
    const b = attested(contactReport(1, "dev-b", "website"));
    const out = run([a, b], { now: 2, places: [owned] });
    expect(out.outcome(a)).toBe("needs_review");
    expect(out.outcome(b)).toBe("needs_review");
    expect(out.decisions[0]?.reason).toMatch(/owner/);
    expect(out.after()).toBeUndefined();
    expect(out.held).toEqual([]);
  });

  it("refuses a report about a contact the place does not have", () => {
    const r = attested(contactReport(0, "dev-a", "instagram"));
    const out = run([r], { places: [withSite()] });
    expect(out.outcome(r)).toBe("refused");
    expect(out.decisions[0]?.reason).toBe("place has no instagram");
  });

  it("applies a third report about a contact taken down in the same run", () => {
    const reports = [attested(contactReport(0, "dev-a", "website")), contactReport(1, "dev-b", "website"), contactReport(1.5, "dev-c", "website", "wrong")];
    const out = run(reports, { now: 2, places: [withSite()] });
    expect(out.decisions.map((d) => d.outcome)).toEqual(["applied", "applied", "applied"]);
    expect(out.held).toEqual([expect.objectContaining({ case: "contact_withdrawn", reasons: ["spam", "wrong"], feedback: reports.map((r) => r.id) })]);
  });

  it("takes down an address", () => {
    const address = { street: "Lake Road", suburb: "Lakeside" };
    const p = place({ facts: { address }, fact_sources: { address: "feedback" }, fact_dates: { address: at(-30) } });
    const out = run([attested(contactReport(0, "dev-a", "address", "wrong")), contactReport(1, "dev-b", "address", "wrong")], { now: 2, places: [p] });
    expect(out.after()?.facts.address).toBeUndefined();
    expect(out.held).toEqual([expect.objectContaining({ case: "contact_withdrawn", fact: "address", value: address })]);
  });

  it("names the standing of a new place whose contact is taken down", () => {
    const p = place({ standing: "shown", osm: null, facts: { website: "https://spam.example.org" }, fact_sources: { location: "feedback", website: "feedback" }, fact_dates: { location: at(-5), website: at(-5) } });
    const out = run([attested(contactReport(0, "dev-a", "website")), contactReport(1, "dev-b", "website")], { now: 2, places: [p] });
    expect(out.held).toEqual([expect.objectContaining({ case: "contact_withdrawn", standing: "shown" })]);
  });
});

describe("doubts", () => {
  const withToilets = (extra: Partial<Place> = {}) =>
    place({
      facts: { power: false, fee: true, toilets: true },
      fact_sources: { power: "osm", fee: "osm", toilets: "feedback" },
      fact_dates: { toilets: at(-30) },
      ...extra,
    });
  const doubt = (day: number, device: string, name = "toilets", extra: Record<string, unknown> = {}) =>
    ({ ...base(day, device), type: "report", report: { kind: "doubt", fact: name, note: "none I could find" }, ...extra }) as StoredFeedback;
  const attested = (item: StoredFeedback) => ({ ...item, attested: "app_attest", contributor: ctr(item.device) }) as StoredFeedback;

  it("sends one doubt to a reviewer as a fact_doubted case, and the fact stays", () => {
    const d = attested(doubt(0, "dev-a"));
    const out = run([d], { places: [withToilets()] });
    expect(out.outcome(d)).toBe("needs_review");
    expect(out.decisions[0]?.reason).toBe("one traveller doubts toilets, so a reviewer reads it");
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: d.id }]);
    expect(out.changes).toEqual([expect.objectContaining({ automatic: false, summary: "toilets doubted by one traveller (decide: keep it or remove it)" })]);
    expect(out.held).toEqual([
      {
        case: "fact_doubted",
        place: PLACE,
        location: { lat: -36.85, lon: 144.55 },
        kind: "free_camp",
        fact: "toilets",
        value: true,
        taken_down: false,
        sources: 1,
        doubts: [d.id],
        confirmations: [],
        feedback: [d.id],
      },
    ]);
  });

  it("sends doubts to a reviewer instead of taking down a value the intake's checks refuse, and the fact stays", () => {
    const hours = place({
      facts: { power: false, fee: true, opening_hours: "Mon-Sun  06:00 - 22:00" },
      fact_sources: { power: "osm", fee: "osm", opening_hours: "feedback" },
      fact_dates: { opening_hours: at(-30) },
    });
    const a = doubt(0, "dev-a", "opening_hours");
    const b = attested(doubt(1, "dev-b", "opening_hours"));
    const out = run([a, b], { now: 2, places: [hours] });
    expect(out.outcome(a)).toBe("needs_review");
    expect(out.outcome(b)).toBe("needs_review");
    expect(out.decisions.some((d) => d.doubted !== undefined)).toBe(false);
    expect(out.after()).toBeUndefined();
    expect(out.held).toEqual([expect.objectContaining({ case: "fact_doubted", fact: "opening_hours", value: "Mon-Sun  06:00 - 22:00", taken_down: false, sources: 2 })]);
  });

  it("never writes a doubt's note to the PR", () => {
    const out = run([attested(doubt(0, "dev-a"))], { places: [withToilets()] });
    expect(JSON.stringify(out.changes)).not.toContain("none I could find");
    expect(JSON.stringify(out.held)).not.toContain("none I could find");
  });

  it("takes a fact down on doubts from two sources, one attested, with its source and date, and lists the case", () => {
    const confirm = fact(-5, "dev-c", "toilets", true);
    const a = attested(doubt(0, "dev-a"));
    const b = doubt(1, "dev-b");
    const d2 = doubt(1.5, "dev-d");
    const out = run([a, b], { now: 2, history: [applied(confirm)], places: [withToilets()] });
    expect(out.outcome(a)).toBe("applied");
    expect(out.outcome(b)).toBe("applied");
    expect(out.decisions[1]?.doubted).toEqual({ fact: "toilets", value: true, at: at(1) });
    expect(out.after()?.facts).toEqual({ power: false, fee: true });
    expect(out.after()?.fact_sources.toilets).toBeUndefined();
    expect(out.after()?.fact_dates?.toilets).toBeUndefined();
    expect(out.edits).toEqual([]);
    expect(out.changes).toEqual([
      expect.objectContaining({ automatic: true, feedback: [a.id, b.id], summary: "toilets taken down after doubts from 2 sources within 90 days" }),
    ]);
    expect(out.held).toEqual([
      {
        case: "fact_doubted",
        place: PLACE,
        location: { lat: -36.85, lon: 144.55 },
        kind: "free_camp",
        fact: "toilets",
        value: true,
        taken_down: true,
        sources: 2,
        doubts: [a.id, b.id],
        confirmations: [confirm.id],
        feedback: [a.id, b.id, confirm.id],
      },
    ]);
    // A third doubt in the same run joins the case.
    const three = run([a, b, d2], { now: 2, places: [withToilets()] });
    expect(three.decisions.map((d) => d.outcome)).toEqual(["applied", "applied", "applied"]);
    expect(three.held).toEqual([expect.objectContaining({ case: "fact_doubted", doubts: [a.id, b.id, d2.id], feedback: [a.id, b.id, d2.id] })]);
  });

  it("counts a doubt from an earlier run, and doesn't take a fact down on two unattested doubts", () => {
    const earlier = applied(attested(doubt(0, "dev-a")), "needs_review");
    const r = doubt(30, "dev-b");
    const out = run([r], { now: 31, history: [earlier], places: [withToilets()] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.after()?.facts.toilets).toBeUndefined();
    expect(out.held).toEqual([expect.objectContaining({ case: "fact_doubted", taken_down: true, doubts: [earlier.id, r.id] })]);
    const two = [doubt(0, "dev-a"), doubt(1, "dev-b")];
    const unattested = run(two, { now: 2, places: [withToilets()] });
    expect(unattested.after()).toBeUndefined();
    expect(unattested.decisions.map((d) => d.outcome)).toEqual(["needs_review", "needs_review"]);
    expect(unattested.decisions[1]?.reason).toContain("without attestation");
    // One case for the fact, with every doubt the run weighed.
    expect(unattested.held).toEqual([expect.objectContaining({ case: "fact_doubted", taken_down: false, sources: 2, doubts: two.map((d) => d.id) })]);
  });

  it("lists a case for doubts that do not outnumber the confirmations, and the fact stays", () => {
    const confirms = [applied(fact(-5, "dev-c", "toilets", true)), applied(fact(-4, "dev-d", "toilets", true))];
    const doubts = [attested(doubt(0, "dev-a")), doubt(1, "dev-b")];
    const out = run(doubts, { now: 2, history: confirms, places: [withToilets()] });
    expect(out.after()).toBeUndefined();
    expect(out.decisions.at(-1)?.reason).toContain("as many confirmations as doubts");
    expect(out.held).toEqual([
      expect.objectContaining({ case: "fact_doubted", taken_down: false, sources: 2, doubts: doubts.map((d) => d.id), confirmations: confirms.map((c) => c.id) }),
    ]);
  });

  it("never takes down a fact from OSM or the owner, and refuses a doubt about a fact the place doesn't have", () => {
    const owned = withToilets({ fact_sources: { power: "osm", fee: "osm", toilets: "owner" } });
    const pair = [attested(doubt(0, "dev-a")), attested(doubt(1, "dev-b"))];
    const out = run(pair, { now: 2, places: [owned] });
    expect(out.decisions.map((d) => d.outcome)).toEqual(["needs_review", "needs_review"]);
    expect(out.after()).toBeUndefined();
    expect(out.held).toEqual([expect.objectContaining({ case: "fact_doubted", fact: "toilets", taken_down: false, sources: 2, doubts: pair.map((d) => d.id) })]);
    expect(out.changes[0]?.summary).toBe("toilets doubted, but it came from the owner (decide: keep it or remove it)");
    const osm = run([attested(doubt(0, "dev-a", "power")), attested(doubt(1, "dev-b", "power"))], { now: 2, places: [withToilets()] });
    expect(osm.after()).toBeUndefined();
    expect(osm.changes[0]?.summary).toContain("came from OSM");
    expect(osm.held).toEqual([expect.objectContaining({ case: "fact_doubted", fact: "power", value: false, taken_down: false })]);
    const none = attested(doubt(0, "dev-a", "pets"));
    const refused = run([none], { places: [withToilets()] });
    expect(refused.outcome(none)).toBe("refused");
    expect(refused.decisions[0]?.reason).toBe("place has no pets");
  });

  it("takes back what a single doubt sent to a person when a later doubt in the run takes the fact down", () => {
    const a = doubt(0, "dev-a");
    const b = attested(doubt(1, "dev-b"));
    const out = run([a, b], { now: 2, places: [withToilets()] });
    expect(out.decisions.map((d) => d.outcome)).toEqual(["applied", "applied"]);
    expect(out.edits).toEqual([]);
    expect(out.changes.map((c) => c.automatic)).toEqual([true]);
    expect(out.held).toEqual([expect.objectContaining({ taken_down: true })]);
  });

  it("takes nothing down on a doubt the intake held for a check, though it counts as a source", () => {
    const held = { ...attested(doubt(1, "dev-b")), intake: { state: "held", held_reason: "text_check" } } as StoredFeedback;
    const out = run([doubt(0, "dev-a"), held], { now: 2, places: [withToilets()] });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(held)).toBe("needs_review");
    expect(out.changes.at(-1)?.summary).toBe("toilets doubted, held by the intake for text_check (decide: keep it or remove it)");
  });

  it("takes pets_months off with a seasonal pets fact doubts took down", () => {
    const seasonal = place({
      facts: { power: false, pets: "seasonal", pets_months: "May-Sep" },
      fact_sources: { power: "osm", pets: "feedback", pets_months: "feedback" },
      fact_dates: { pets: at(-30), pets_months: at(-30) },
    });
    const a = attested(doubt(0, "dev-a", "pets"));
    const b = doubt(1, "dev-b", "pets");
    const out = run([a, b], { now: 2, places: [seasonal] });
    expect(out.outcome(b)).toBe("applied");
    expect(out.after()).toMatchObject({ facts: { power: false }, fact_sources: { power: "osm" } });
    expect(out.after()?.facts).toEqual({ power: false });
    expect(out.after()?.fact_dates).toBeUndefined();
  });

  describe("a fact doubts took down", () => {
    // Taken down at day 1 in an earlier run: the inbox keeps the value on the doubt that did it.
    const down = (extra: Partial<Place> = {}) =>
      place({ facts: { power: false, fee: true }, fact_sources: { power: "osm", fee: "osm" }, ...extra });
    const takedown = () =>
      ({ ...attested(doubt(1, "dev-b")), outcome: { result: "applied", reason: "", run: at(1), doubted: { fact: "toilets", value: true, at: at(1) } } }) as unknown as StoredFeedback;
    const history = () => [applied(doubt(0, "dev-a")), takedown()];

    it("restores the value when two new travellers confirm it, and closes the case", () => {
      const c1 = fact(3, "dev-c", "toilets", true);
      const c2 = attested(fact(4, "dev-d", "toilets", true));
      const out = run([c1, c2], { now: 5, history: history(), places: [down()] });
      expect(out.decisions.map((d) => d.outcome)).toEqual(["applied", "applied"]);
      expect(out.after()?.facts.toilets).toBe(true);
      expect(out.after()?.fact_dates?.toilets).toBe(at(5));
      expect(out.changes).toEqual([
        expect.objectContaining({ automatic: true, feedback: [c1.id, c2.id], summary: "toilets restored after two travellers confirmed it (closes the fact_doubted case)" }),
      ]);
      expect(out.closed).toEqual([{ case: "fact_doubted", place: PLACE, fact: "toilets", settles: "restored", feedback: [c1.id, c2.id] }]);
    });

    it("keeps one new confirmation waiting for a second", () => {
      const c1 = attested(fact(3, "dev-c", "toilets", true));
      const out = run([c1], { now: 5, history: history(), places: [down()] });
      expect(out.outcome(c1)).toBe("waiting");
      expect(out.after()).toBeUndefined();
      expect(out.closed).toEqual([]);
    });

    it("needs the confirmations to outnumber doubts sent since the takedown", () => {
      const later = [applied(doubt(2, "dev-e"), "needs_review"), applied(doubt(2.5, "dev-f"), "needs_review")];
      const c1 = fact(3, "dev-c", "toilets", true);
      const c2 = attested(fact(4, "dev-d", "toilets", true));
      const out = run([c1, c2], { now: 5, history: [...history(), ...later], places: [down()] });
      expect(out.decisions.map((d) => d.outcome)).toEqual(["waiting", "waiting"]);
      expect(out.decisions[0]?.reason).toBe("toilets was taken down after doubts, and returns when two new travellers confirm it");
      expect(out.after()).toBeUndefined();
    });

    it("does not count a confirmation from a traveller who reported the value before the takedown", () => {
      const c1 = fact(3, "dev-c", "toilets", true);
      const c2 = attested(fact(4, "dev-d", "toilets", true));
      const out = run([c1, c2], { now: 5, history: [...history(), applied(fact(-10, "dev-d", "toilets", true))], places: [down()] });
      expect(out.decisions.map((d) => d.outcome)).toEqual(["waiting", "waiting"]);
      expect(out.after()).toBeUndefined();
      expect(out.closed).toEqual([]);
    });

    it("replaces the value with an attested report of another, and closes the case", () => {
      const r = attested(fact(3, "dev-c", "toilets", false));
      const out = run([r], { now: 5, history: [...history(), applied(fact(-10, "dev-e", "toilets", true))], places: [down()] });
      expect(out.outcome(r)).toBe("applied");
      expect(out.after()?.facts.toilets).toBe(false);
      expect(out.changes).toEqual([expect.objectContaining({ automatic: true, summary: "toilets set to false (one attested report) (closes the fact_doubted case)" })]);
      expect(out.closed).toEqual([{ case: "fact_doubted", place: PLACE, fact: "toilets", settles: "replaced", feedback: [r.id] }]);
    });

    it("closes the case when two devices without attestation agree on another value", () => {
      const a = fact(3, "dev-c", "toilets", false);
      const b = fact(4, "dev-d", "toilets", false);
      const out = run([a, b], { now: 5, history: history(), places: [down()] });
      expect(out.after()?.facts.toilets).toBe(false);
      expect(out.closed).toEqual([{ case: "fact_doubted", place: PLACE, fact: "toilets", settles: "replaced", feedback: [a.id, b.id] }]);
    });

    it("has no open case once the fact was set again, or a later report set it before it went again", () => {
      const c1 = attested(fact(3, "dev-c", "toilets", true));
      const setAgain = applied(attested(fact(2, "dev-e", "toilets", true)));
      const elsewhere = run([c1], { now: 5, history: [...history(), setAgain], places: [down()] });
      expect(elsewhere.outcome(c1)).toBe("applied");
      expect(elsewhere.after()?.facts.toilets).toBe(true);
      expect(elsewhere.closed).toEqual([]);
      const back = run([c1], { now: 5, history: history(), places: [withToilets({ fact_dates: { toilets: at(2) } })] });
      expect(back.outcome(c1)).toBe("applied");
      expect(back.closed).toEqual([]);
    });

    it("restores a fact taken down earlier in the same run, but not on a confirmation sent before the takedown", () => {
      const before = fact(0.5, "dev-e", "toilets", true);
      const a = doubt(0, "dev-a");
      const b = attested(doubt(1, "dev-b"));
      const c = doubt(1.2, "dev-f");
      const c1 = fact(2, "dev-c", "toilets", true);
      const c2 = attested(fact(3, "dev-d", "toilets", true));
      const out = run([before, a, b, c, c1, c2], { now: 4, places: [withToilets()] });
      expect(out.outcome(before)).toBe("applied");
      expect(out.decisions.find((d) => d.id === before.id)?.reason).toBe("counted as a confirmation of toilets before doubts took it down");
      expect(out.held).toEqual([expect.objectContaining({ case: "fact_doubted", taken_down: true })]);
      expect(out.after()?.facts.toilets).toBe(true);
      expect(out.closed).toEqual([{ case: "fact_doubted", place: PLACE, fact: "toilets", settles: "restored", feedback: [c1.id, c2.id] }]);
    });

    it("counts a confirmation sent at the takedown as one sent before it", () => {
      const a = doubt(0, "dev-a");
      const b = attested(doubt(1, "dev-b"));
      const same = fact(1, "dev-e", "toilets", true);
      const c1 = fact(2, "dev-c", "toilets", true);
      const c2 = attested(fact(3, "dev-d", "toilets", true));
      const out = run([a, b, same, c1, c2], { now: 4, places: [withToilets()] });
      expect(out.decisions.find((d) => d.id === same.id)?.reason).toBe("counted as a confirmation of toilets before doubts took it down");
      expect(out.after()?.facts.toilets).toBe(true);
      expect(out.closed).toEqual([{ case: "fact_doubted", place: PLACE, fact: "toilets", settles: "restored", feedback: [c1.id, c2.id] }]);
    });
  });
});

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
    // The place has power already, so the one valid power report would change it, and needs a second device.
    const out = run([a, b, c, d], { now: 2, places: [place({ facts: { power: false }, fact_sources: { power: "osm" } })] });
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

  it("sends an address to a person from one report", () => {
    const value = { housenumber: "12", street: "Lake Road", suburb: "Lakeside", state: "VIC" as const, postcode: "3999" };
    const a = { ...base(0, "dev-a"), type: "report", report: { kind: "fact", fact: "address", value } } as StoredFeedback;
    const out = run([a]);
    expect(out.outcome(a)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([{ kind: "fact", place: PLACE, fact: "address", value, feedback: a.id }]);
    expect(applyEdit(place(), { kind: "fact", place: PLACE, fact: "address", value, feedback: a.id }, at(1))?.facts.address).toEqual(value);
  });
});

describe("closed and reopened", () => {
  const web = (day: number, device: string, origin?: string): StoredFeedback =>
    ({ ...closed(day, device), human_checked: true, ...(origin ? { origin } : {}) }) as StoredFeedback;

  it("a closed report from a human check alone leaves the place open, counted as one source", () => {
    const a = web(0, "dev-a", "net-a");
    const out = run([a]);
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("applied");
  });

  it("two human-checked closures from one network still leave it open", () => {
    const out = run([web(0, "dev-a", "net-a"), web(1, "dev-b", "net-a")], { now: 2 });
    expect(out.after()).toBeUndefined();
  });

  it("a second source on another network closes it as two devices do", () => {
    const earlier = web(0, "dev-a", "net-a");
    const out = run([web(1, "dev-b", "net-b")], { now: 2, history: [earlier] });
    expect(out.after()?.status).toBe("closed");
  });

  it("an attested closure after a human-checked one reports it closed at once", () => {
    const attested = { ...closed(1, "dev-b"), attested: "app_attest" } as StoredFeedback;
    const out = run([web(0, "dev-a", "net-a"), attested], { now: 2 });
    expect(out.after()?.status).not.toBe("open");
  });

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

describe("evidence of closure", () => {
  const osm: ClosureEvidence = { kind: "osm_lifecycle", object: "node/123456", tags: ["disused:tourism=camp_site"], changeset: 191000001 };
  const evidence = (...found: ClosureEvidence[]) => ({ extra: { closureEvidence: new Map([[PLACE, found]]) } });

  it("one traveller's closure and OSM tagging the object disused: close the place, naming the evidence", () => {
    const a = closed(0, "dev-a");
    const out = run([a], { ...evidence(osm) });
    expect(out.after()?.status).toBe("closed");
    expect(out.outcome(a)).toBe("applied");
    expect(out.changes.map((c) => c.summary)).toContain(
      "status reported_closed to closed (1 device within 90 days, and OSM tagged node/123456 disused:tourism=camp_site in changeset 191000001)",
    );
  });

  it("a closure from a human check and the website's domain gone from DNS twice close the place", () => {
    const web = { ...closed(0, "dev-a"), human_checked: true, origin: "net-a" } as StoredFeedback;
    const dns: ClosureEvidence = { kind: "nxdomain", domain: "example.org", first: at(0), confirmed: at(1) };
    const out = run([web], { ...evidence(dns) });
    expect(out.after()?.status).toBe("closed");
    expect(out.changes.map((c) => c.summary)).toContain(
      "status reported_closed to closed (1 device within 90 days, and example.org was not found in DNS on 2026-07-01 or 2026-07-02)",
    );
  });

  it("evidence found in a later run, with nothing pending, closes a place a traveller reported closed", () => {
    const earlier = applied(closed(0, "dev-a"));
    const out = run([], { now: 20, history: [earlier], places: [place({ status: "reported_closed" })], ...evidence(osm) });
    expect(out.after()?.status).toBe("closed");
    const change = out.changes.find((c) => c.summary.startsWith("status reported_closed to closed"));
    expect(change?.feedback).toEqual([earlier.id]);
  });

  it("evidence found later also closes a place a human-checked closure left open", () => {
    const earlier = applied({ ...closed(0, "dev-a"), human_checked: true, origin: "net-a" } as StoredFeedback);
    const out = run([], { now: 3, history: [earlier], ...evidence(osm) });
    expect(out.after()?.status).toBe("closed");
  });

  it("evidence with no traveller's closure changes nothing", () => {
    const dns: ClosureEvidence = { kind: "nxdomain", domain: "example.org", first: at(0), confirmed: at(1) };
    const out = run([], { now: 2, ...evidence(osm, dns) });
    expect(out.after()).toBeUndefined();
    expect(out.changes).toEqual([]);
  });

  it("evidence does not count for a closure a later reopened report undid", () => {
    const out = run([], { now: 5, history: [applied(closed(0, "dev-a")), applied(reopened(2, "dev-b"))], ...evidence(osm) });
    expect(out.after()).toBeUndefined();
  });

  it("evidence does not count for a closure older than 90 days", () => {
    const out = run([], { now: 91, history: [applied(closed(0, "dev-a"))], places: [place({ status: "reported_closed" })], ...evidence(osm) });
    expect(out.after()).toBeUndefined();
  });

  it("evidence leaves an owner-verified place's closure to a person", () => {
    const a = closed(0, "dev-a");
    const out = run([a], { places: [place({ owner_verified: true })], ...evidence(osm) });
    expect(out.after()).toBeUndefined();
    expect(out.outcome(a)).toBe("waiting");
  });
});

describe("reviews", () => {
  it("accepts a trusted contributor's clean review and recalculates the rating", () => {
    const r = review(0, "sam", 3, "Shady, flat sites near the water.");
    const existing = [line(1, "kim", 5), line(2, "lee", 4)];
    const out = run([r], { reviews: existing, places: [place({ rating: { count: 2, mean: 4.5 } })] });
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

  it("refuses a trusted contributor's review that fails the SDK text rules", () => {
    for (const text of ["Flat sites. The ranger is a spaz and a poofter.", "Flat sites and clean toilets. Best crypto tips on whatsapp"]) {
      const r = review(0, "sam", 1, text);
      const out = run([r]);
      expect(out.outcome(r)).toBe("refused");
      expect(out.reviews.size).toBe(0);
    }
  });

  it("publishes a contributor's first review that passes the checks", () => {
    const r = review(0, "sam", 5, "Great little spot. Lots of rain but solid ground that drained well.");
    const out = run([r]);
    expect(out.outcome(r)).toBe("applied");
    expect(out.reviews.get(PLACE)).toEqual([expect.objectContaining({ contributor: ctr("sam"), stars: 5 })]);
    expect(out.changes).toEqual([expect.objectContaining({ place: PLACE, automatic: true, feedback: [r.id] })]);
    expect(out.edits).toEqual([]);
  });

  it("sends a first review the intake held for ai_check to a person", () => {
    const r = { ...review(0, "sam", 5, "Great little spot. Lots of rain but solid ground that drained well."), intake: { state: "held", held_reason: "ai_check" } } as StoredFeedback;
    const out = run([r]);
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.decisions[0]?.reason).toContain("ai_check");
    expect(out.decisions[0]?.reason).toContain("a person");
    expect(out.held).toEqual([]);
    expect(out.reviews.size).toBe(0);
    expect(out.changes).toEqual([expect.objectContaining({ automatic: false, feedback: [r.id] })]);
  });

  it("refuses a first review with bad language", () => {
    const r = review(0, "sam", 1, "Shit place, the fucking toilets were locked.");
    const out = run([r]);
    expect(out.outcome(r)).toBe("refused");
    expect(out.reviews.size).toBe(0);
    expect(out.edits).toEqual([]);
  });

  it("does not quote a held review's text in the change for a person, and names the inbox item", () => {
    const first = { ...review(0, "sam", 4, "Quiet and level, ask Jo Bloggs at number 12 for the gate"), intake: { state: "held", held_reason: "ai_check" } } as StoredFeedback;
    const repeatedText = "Best camp in the state, everyone should stay here at least once!";
    const other = applied(review(-3, "kim", 5, repeatedText, OTHER));
    const repeated = review(0, "lee", 5, repeatedText);
    const out = run([first, repeated], { history: [other] });
    expect(out.outcome(first)).toBe("needs_review");
    expect(out.outcome(repeated)).toBe("needs_review");
    const held = out.changes.filter((c) => !c.automatic);
    expect(held.map((c) => c.feedback)).toEqual([[first.id], [repeated.id]]);
    for (const c of held) {
      expect(c.summary).not.toMatch(/Jo Bloggs|Best camp/);
      expect(c.summary).toContain("inbox");
    }
  });

  it("publishes a review whether or not a person held the contributor's earlier one", () => {
    const earlier = applied(review(-5, "sam", 5, "Shady", OTHER));
    const held = applied(review(-5, "kim", 5, "Shady", OTHER), "needs_review");
    const a = review(0, "sam", 4, "Quiet");
    const b = review(0, "kim", 4, "Quiet");
    const c = review(0, "lee", 4, "Quiet");
    const out = run([a, b, c], { history: [earlier, held], places: [place(), place({ id: OTHER })] });
    expect([a, b, c].map(out.outcome)).toEqual(["applied", "applied", "applied"]);
  });

  for (const reason of ["repeated_text", "check_unavailable"]) {
    it(`sends a trusted contributor's review the intake held for ${reason} to a person`, () => {
      const r = { ...review(0, "sam", 5, "Lovely"), intake: { state: "held", held_reason: reason } } as StoredFeedback;
      const out = run([r]);
      expect(out.outcome(r)).toBe("needs_review");
      expect(out.decisions.find((d) => d.id === r.id)?.reason).toContain(reason);
      expect(out.reviews.size).toBe(0);
    });
  }

  it("keeps visited_nearby on the published line", () => {
    const r = { ...review(0, "sam", 5, "Lovely"), review: { stars: 5, text: "Lovely", visited: "2026-06", visited_nearby: true } } as StoredFeedback;
    const out = run([r]);
    expect(out.reviews.get(PLACE)?.[0]?.visited_nearby).toBe(true);
  });

  it("replaces a contributor's earlier review of the place sent from the same device", () => {
    const earlier = applied(review(-5, "sam", 5, "Lovely"));
    const r = review(0, "sam", 2, "Gone downhill");
    const existing = [{ ...line(1, "sam", 5), id: reviewIdOf(earlier) }, line(2, "kim", 4)];
    const out = run([r], { history: [earlier], reviews: existing, places: [place({ rating: { count: 2, mean: 4.5 } })] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.reviews.get(PLACE)?.map((l) => l.contributor)).toEqual([ctr("kim"), ctr("sam")]);
    expect(out.reviews.get(PLACE)?.map((l) => l.stars)).toEqual([4, 2]);
    expect(out.after()?.rating).toEqual({ count: 2, mean: 3 });
  });

  describe("a review that replaces the contributor's earlier review", () => {
    /** The earlier review in the history and its line in the data, then a new review from `device`. */
    function replacing(device: string, extra: Record<string, unknown> = {}, earlierExtra: Record<string, unknown> = {}) {
      const earlier = applied({ ...review(-5, "sam", 5, "Lovely"), ...earlierExtra } as StoredFeedback);
      const r = { ...review(0, "sam", 1, "Gone downhill"), device, ...extra } as StoredFeedback;
      const existing = [{ ...line(1, "sam", 5), id: reviewIdOf(earlier) }];
      return { r, earlier, existing };
    }

    it("is held for a person when it comes from another device and is not proved, and the earlier review stays", () => {
      const { r, earlier, existing } = replacing("other-phone");
      const out = run([r], { history: [earlier], reviews: existing, places: [place({ rating: { count: 1, mean: 5 } })] });
      expect(out.outcome(r)).toBe("needs_review");
      expect(out.decisions.find((d) => d.id === r.id)?.reason).toMatch(/earlier review/);
      expect(out.reviews.get(PLACE) ?? existing).toEqual(existing);
      expect(out.after()).toBeUndefined();
      expect(out.edits).toEqual([{ kind: "review", place: PLACE, review: expect.objectContaining({ contributor: ctr("sam"), stars: 1 }), feedback: r.id }]);
    });

    it("is held when the earlier review's item is no longer in the history", () => {
      const { r, existing } = replacing("sam");
      const out = run([r], { reviews: existing });
      expect(out.outcome(r)).toBe("needs_review");
    });

    it("applies when the intake recorded the contributor as proved", () => {
      const { r, existing } = replacing("other-phone", { proved: true });
      const out = run([r], { reviews: existing });
      expect(out.outcome(r)).toBe("applied");
      expect(out.reviews.get(PLACE)?.map((l) => l.stars)).toEqual([1]);
    });

    it("applies when it comes from the same attested key on another device id", () => {
      const { r, earlier, existing } = replacing("other-phone", { attest_key: "ak_0123456789abcdef" }, { attest_key: "ak_0123456789abcdef" });
      const out = run([r], { history: [earlier], reviews: existing });
      expect(out.outcome(r)).toBe("applied");
    });

    it("is held when it comes from another attested key", () => {
      const { r, earlier, existing } = replacing("other-phone", { attest_key: "ak_fedcba9876543210" }, { attest_key: "ak_0123456789abcdef" });
      const out = run([r], { history: [earlier], reviews: existing });
      expect(out.outcome(r)).toBe("needs_review");
    });
  });

  it("refuses everything from a blocked contributor", () => {
    const r = review(0, "spammer", 5, "Great");
    const c = { ...check(0, "spammer", true), contributor: ctr("spammer") } as StoredFeedback;
    const out = run([r, c], { blocked: [ctr("spammer")] });
    expect(out.outcome(r)).toBe("refused");
    expect(out.outcome(c)).toBe("refused");
    expect(out.decisions[0]?.reason).toBe("the contributor is blocked");
  });

  it("refuses a review a person removed, so it is never written back (audit run-2 OCDB-07)", () => {
    const r = review(0, "sam", 5, "Ring Jo on the number at the gate");
    const removed = new Set([reviewIdOf(r)]);
    const out = run([r], { extra: { removedReviews: removed } });
    expect(out.outcome(r)).toBe("refused");
    expect(out.decisions[0]?.reason).toBe("the review was removed by a moderator");
    expect(out.reviews.get(PLACE) ?? []).toEqual([]);
    const other = review(0, "kim", 4, "Fine");
    expect(run([other], { extra: { removedReviews: removed } }).outcome(other)).toBe("applied");
  });

  it("leaves hidden and blocked reviews out of the rating", () => {
    const r = review(0, "sam", 4, "Fine");
    const existing = [line(1, "kim", 1, { hidden: "reported" }), line(2, "bad", 1), line(3, "lee", 5)];
    const out = run([r], { reviews: existing, blocked: [ctr("bad")] });
    expect(out.after()?.rating).toEqual({ count: 2, mean: 4.5 });
  });

  it("holds text sent word for word for another place", () => {
    const text = "Best camp in the state, everyone should stay here at least once!";
    const other = applied(review(-3, "kim", 5, text, OTHER));
    const r = review(0, "sam", 5, text.toUpperCase());
    const out = run([r], { history: [other] });
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

  it("adds a held review in the review checkout, replacing the contributor's older one", () => {
    const held = applyHeldReview([line(1, "sam", 5), line(2, "kim", 3)], line(3, "sam", 1), new Set());
    expect(held?.lines.map((l) => l.id)).toEqual([line(2, "kim", 3).id, line(3, "sam", 1).id]);
    expect(held?.rating).toEqual({ count: 2, mean: 2 });
    expect(applyHeldReview([line(3, "sam", 1)], line(3, "sam", 1))).toBeUndefined();
  });
});

describe("fee reports", () => {
  it("are refused, saying what to send instead, and change nothing", () => {
    const f = fee(0, "sam", 32.5, "unpowered", "2026-06");
    const out = run([f]);
    expect(out.decisions.map((d) => [d.outcome, d.reason])).toEqual([["refused", FEE_RETIRED]]);
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([]);
    expect(out.changes).toEqual([]);
  });
});

describe("charges", () => {
  const attested = (item: StoredFeedback) => ({ ...item, attested: "app_attest", contributor: ctr(item.device) }) as StoredFeedback;
  const priced = (facts: Record<string, string>) => place({ facts: { fee: true, ...facts }, fact_sources: { fee: "osm", ...Object.fromEntries(Object.keys(facts).map((k) => [k, "osm"])) } });

  it("applies an attested charge in OSM's syntax", () => {
    for (const [name, value] of [["charge", "57 AUD/night"], ["charge_powered", "68 AUD/night"], ["charge_conditional", "75 AUD/night @ (Dec-Jan)"], ["charge", "2 AUD/hour"]] as const) {
      const r = attested(fact(0, "sam", name, value));
      const out = run([r]);
      expect(out.outcome(r)).toBe("applied");
      expect(out.after()?.facts).toMatchObject({ [name]: value });
      expect(out.after()?.fact_sources).toMatchObject({ [name]: "feedback" });
    }
  });

  it("holds a charge over 250 AUD a night for a person", () => {
    const r = attested(fact(0, "sam", "charge", "570 AUD/night"));
    const out = run([r]);
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.decisions[0]?.reason).toMatch(/more than 250 AUD a night/);
    expect(out.after()).toBeUndefined();
  });

  it("holds a charge more than 50% above or below the current one, and applies a smaller change", () => {
    for (const value of ["90 AUD/night", "25 AUD/night"]) {
      const r = attested(fact(0, "sam", "charge", value));
      const out = run([r], { places: [priced({ charge: "57 AUD/night" })] });
      expect(out.outcome(r)).toBe("needs_review");
    }
    const r = attested(fact(0, "sam", "charge_powered", "75 AUD/night"));
    const out = run([r], { places: [priced({ charge_powered: "68 AUD/night" })] });
    expect(out.outcome(r)).toBe("applied");
  });

  it("compares only charges in the same currency and units", () => {
    const r = attested(fact(0, "sam", "charge", "15 AUD/person/night"));
    const out = run([r], { places: [priced({ charge: "57 AUD/night" })] });
    expect(out.outcome(r)).toBe("applied");
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

  it("counts reports from one network once, whatever contributor ids they carry", () => {
    const fromOneNetwork = ["kim", "lee", "max"].map((who) => ({ ...reviewReport(0, who, target.id), origin: "net-a" }) as StoredFeedback);
    const out = run(fromOneNetwork, { reviews: [target], places: [place({ rating: { count: 1, mean: 5 } })] });
    expect(out.reviews.size).toBe(0);
    expect(out.changes.some((c) => c.automatic)).toBe(false);

    const fromThreeNetworks = ["kim", "lee", "max"].map((who, i) => ({ ...reviewReport(0, who, target.id), origin: `net-${i}` }) as StoredFeedback);
    expect(run(fromThreeNetworks, { reviews: [target], places: [place({ rating: { count: 1, mean: 5 } })] }).reviews.get(PLACE)).toEqual([
      { ...target, hidden: "reported" },
    ]);
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

  it("lists each name, kind and location change as a held case for the AI reviewer, with the value it replaces", () => {
    const name = rep({ kind: "name", value: "Lake Eppalock Free Camp" });
    const kind = rep({ kind: "kind", place_kind: "campground" });
    const move = { ...base(0, "dev-b"), type: "report", location: { lat: -36.851, lon: 144.552 }, report: { kind: "wrong_location" } } as StoredFeedback;
    const before = place({ fact_sources: { power: "osm", fee: "osm", name: "osm", kind: "feedback" }, fact_dates: { kind: "2026-05-01T00:00:00Z" } });
    const out = run([name, kind, move], { places: [before] });
    expect([name, kind, move].map(out.outcome)).toEqual(["needs_review", "needs_review", "needs_review"]);
    expect(out.edits.map((e) => e.kind)).toEqual(["name", "kind", "location"]);
    const common = { case: "place_change", place: PLACE, location: { lat: -36.85, lon: 144.55 }, kind: "free_camp" };
    expect(out.held).toEqual([
      { ...common, change: "name", from: "Lake Eppalock Camp", to: "Lake Eppalock Free Camp", from_source: "osm", feedback: [name.id] },
      {
        ...common,
        change: "kind",
        from: "free_camp",
        from_group: "overnight",
        to: "campground",
        from_source: "feedback",
        from_date: "2026-05-01T00:00:00Z",
        feedback: [kind.id],
      },
      // About 210 m: 111 m north and 178 m east.
      { ...common, change: "location", from: { lat: -36.85, lon: 144.55 }, to: { lat: -36.851, lon: 144.552 }, distance_m: 210, feedback: [move.id] },
    ]);
  });

  it("leaves a location report without a new location, and a name that fails the text rules, to a person with no held case", () => {
    const name = rep({ kind: "name", value: "Dummyname is a wanker" });
    const move = { ...base(0, "dev-b"), type: "report", report: { kind: "wrong_location" } } as StoredFeedback;
    const out = run([name, move]);
    expect([name, move].map(out.outcome)).toEqual(["needs_review", "needs_review"]);
    expect(out.held).toEqual([]);
  });

  it("sends a name or description that fails the text rules to a person as a note, with no edit and no value in the summary", () => {
    const name = rep({ kind: "name", value: "Dummyname is a wanker" });
    const text = rep({ kind: "description", value: "Dummyname is a wanker and a thief" });
    const out = run([name, text]);
    expect([name, text].map(out.outcome)).toEqual(["needs_review", "needs_review"]);
    expect(out.edits).toEqual([
      { kind: "note", place: PLACE, feedback: name.id },
      { kind: "note", place: PLACE, feedback: text.id },
    ]);
    expect(out.changes.map((c) => c.summary).join("\n")).not.toContain("wanker");
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

  it("leaves feedback for a new place on the recent list waiting", () => {
    const r = fact(0, "dev-a", "power", true, OTHER);
    const out = run([r], { recent: new Set([OTHER]) });
    expect(out.outcome(r)).toBe("waiting");
    expect(out.decisions[0]?.reason).toBe(`place ${OTHER} is a new place not in the data yet`);
  });

  it("refuses feedback for a place on neither the data nor the recent list", () => {
    const r = fact(0, "dev-a", "power", true, OTHER);
    const out = run([r], { recent: new Set([PLACE]) });
    expect(out.outcome(r)).toBe("refused");
    expect(out.decisions[0]?.reason).toBe(`place ${OTHER} is not in the data`);
  });

  it("leaves feedback for a place not in the data waiting when the recent list could not be read", () => {
    const r = fact(0, "dev-a", "power", true, OTHER);
    const out = run([r], { recent: "unreadable" });
    expect(out.outcome(r)).toBe("waiting");
    expect(out.decisions[0]?.reason).toBe(`place ${OTHER} is not in the data, and the recent list could not be read`);
  });

  it("refuses feedback for a new place that is still not in the data after 90 days", () => {
    const r = fact(0, "dev-a", "power", true, OTHER);
    const out = run([r], { recent: new Set([OTHER]), now: 91 });
    expect(out.outcome(r)).toBe("refused");
    expect(out.decisions[0]?.reason).toBe(`place ${OTHER} did not reach the data within 90 days`);
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
      report: { kind: "new_place", place_kind: "free_camp", ...extra },
    }) as StoredFeedback;
  const idOf = (item: StoredFeedback) => `ocdb_${item.id.slice(3)}`;

  it("leaves feedback about a new place added in the same run waiting for the data", () => {
    const item = added();
    const about = { ...fact(1, "dev-a", "power", true, OTHER), place: idOf(item) } as StoredFeedback;
    const out = run([item, about]);
    expect(out.outcome(item)).toBe("applied");
    expect(out.outcome(about)).toBe("waiting");
    expect(out.decisions.find((d) => d.id === about.id)?.reason).toBe(`place ${idOf(item)} is a new place not in the data yet`);
  });

  it("leaves feedback about a new place added in an earlier run waiting while it is not in the data", () => {
    const item = added();
    const about = { ...fact(1, "dev-a", "power", true, OTHER), place: idOf(item) } as StoredFeedback;
    const out = run([about], { history: [item] });
    expect(out.outcome(about)).toBe("waiting");
  });

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

  it("counts reports from one network once, whatever device ids they carry", () => {
    const item = added(0);
    const fromOneNetwork = [remove(1, "dev-b", item), remove(1, "dev-c", item)].map((r) => ({ ...r, origin: "net-x" }) as StoredFeedback);
    const out = run(fromOneNetwork, { ...inData(item), now: 2 });
    expect(out.places.size).toBe(0);
    expect(out.held).toEqual([]);
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

  describe("a duplicate the rules merge", () => {
    // About 30 m south of PLACE, "Lake Eppalock Camp".
    const near = { lat: -36.85027, lon: 144.55 };
    const same = (extra: Record<string, unknown> = {}, location = near) =>
      added(0, "dev-a", { name: "LAKE EPPALOCK CAMP", contacts: { phone: "03 5555 0100" }, ...extra }, location);

    const noRoad = { roads: { between: () => null } };

    it("merges a new place with the same name, in the same group, under 50 m away, into the place it duplicates", () => {
      const item = same();
      const out = run([item], { extra: noRoad });
      expect(out.outcome(item)).toBe("applied");
      expect(out.decisions[0]!.reason).toBe(`new place merged into ${PLACE}: the same name, 30 m away, in the same group, with no major road between`);
      expect(out.after(idOf(item))).toMatchObject({ id: idOf(item), status: "merged", merged_into: PLACE, name: "LAKE EPPALOCK CAMP", osm: null });
      expect(out.after(PLACE)).toMatchObject({ facts: { power: false, fee: true, phone: "03 5555 0100" }, fact_sources: { phone: "feedback" }, fact_dates: { phone: at(1) }, updated: at(1) });
      expect(out.edits).toEqual([]);
      expect(out.held).toEqual([]);
      expect(out.changes).toEqual([expect.objectContaining({ place: idOf(item), automatic: true, summary: expect.stringContaining(`merged into ${PLACE}`) })]);
    });

    it("lists a merged place's note for a person, as the kept record may need what it says", () => {
      const item = same({ note: "Address: 1 Lake Road" });
      const out = run([item], { extra: noRoad });
      expect(out.after(idOf(item))?.status).toBe("merged");
      expect(out.held).toEqual([expect.objectContaining({ case: "note", place: idOf(item), feedback: [item.id] })]);
      expect(JSON.stringify(out.held)).not.toContain("Lake Road");
    });

    it("holds it for a reviewer when the name differs, it is 50 m or more away, a major road runs between, or the run has no road data", () => {
      const roads = { between: () => ({ highway: "trunk", name: "Example Highway" }) };
      const cases: [StoredFeedback, Partial<RulesInput>][] = [
        [same({ name: "Lake Eppalock North" }), noRoad],
        [same({}, { lat: -36.8505, lon: 144.55 }), noRoad],
        [same(), { roads }],
        // Without road data the run cannot tell opposite sides of a road apart, so a reviewer decides.
        [same(), {}],
      ];
      for (const [item, extra] of cases) {
        const out = run([item], { extra });
        expect(out.outcome(item)).toBe("needs_review");
        expect(out.held).toContainEqual(expect.objectContaining({ case: "duplicate", place: idOf(item), duplicate_of: PLACE }));
      }
    });

    it("never merges into a place with a verified owner, a pair a person found separate, or a place the intake would not list", () => {
      const owned = run([same()], { places: [place({ owner_verified: true })], extra: noRoad });
      expect(owned.decisions[0]!.outcome).toBe("needs_review");
      const item = same();
      const distinct = run([item], { extra: { ...noRoad, distinct: new Set([[PLACE, idOf(item)].sort().join(" ")]) } });
      expect(distinct.outcome(item)).toBe("needs_review");
      const { attested: _attested, ...unattested } = same() as StoredFeedback & { attested?: string };
      expect(run([unattested], { extra: noRoad }).outcome(unattested)).toBe("needs_review");
    });
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

  it("publishes a place with the contacts that pass the link checks, and lists none for a person", () => {
    const item = added(0, "dev-a", { contacts: { phone: "03 5555 0100", website: "https://park.example.org" } });
    const history = [applied(added(-5, "dev-a", {}, { lat: -30, lon: 140 }))];
    const out = run([item], { history });
    expect(out.after(idOf(item))).toMatchObject({
      facts: { phone: "03 5555 0100", website: "https://park.example.org" },
      fact_sources: { phone: "feedback", website: "feedback" },
      fact_dates: { phone: at(1), website: at(1) },
    });
    expect(out.held).toEqual([]);
    expect(out.outcome(item)).toBe("applied");
  });

  it("leaves a contact that fails the link checks off the place, for a person", () => {
    const item = added(0, "dev-a", { contacts: { phone: "03 5555 0100", website: "https://bit.ly/camp" } });
    const history = [applied(added(-5, "dev-a", {}, { lat: -30, lon: 140 }))];
    const out = run([item], { history });
    expect(out.after(idOf(item))?.facts).toEqual({ phone: "03 5555 0100" });
    expect(out.after(idOf(item))?.fact_sources.website).toBeUndefined();
    expect(out.held).toEqual([
      { case: "contacts", place: idOf(item), standing: "shown", location: SPOT, kind: "free_camp", contacts: ["website"], feedback: [item.id] },
    ]);
    expect(JSON.stringify(out.held)).not.toContain("bit.ly");
  });

  it("publishes a place with its address, and leaves a failing address for a person", () => {
    const address = { street: "Lake Road", suburb: "Lakeside", state: "VIC" };
    const history = [applied(added(-5, "dev-a", {}, { lat: -30, lon: 140 }))];
    const good = added(0, "dev-a", { address, contacts: { phone: "03 5555 0100" } });
    const out = run([good], { history });
    expect(out.after(idOf(good))).toMatchObject({ facts: { address, phone: "03 5555 0100" }, fact_sources: { address: "feedback" }, fact_dates: { address: at(1) } });
    expect(out.held).toEqual([]);
    // An address stored before the address checks tightened can still fail them.
    const bad = added(0, "dev-a", { address: { suburb: "Lakeside" } });
    const held = run([bad], { history });
    expect(held.after(idOf(bad))?.facts).toEqual({});
    expect(held.held).toEqual([expect.objectContaining({ case: "contacts", place: idOf(bad), contacts: ["address"] })]);
    expect(JSON.stringify(held.held)).not.toContain("Lakeside");
  });

  it("publishes a place with its description and fee", () => {
    const item = added(0, "dev-a", { description: "Flat gravel sites, shade in the afternoon.", fee: "donation" });
    const history = [applied(added(-5, "dev-a", {}, { lat: -30, lon: 140 }))];
    const out = run([item], { history });
    expect(out.after(idOf(item))).toMatchObject({
      description: "Flat gravel sites, shade in the afternoon.",
      facts: { fee: "donation" },
      fact_sources: { description: "feedback", fee: "feedback" },
      fact_dates: { description: at(1), fee: at(1) },
    });
    expect(out.held).toEqual([]);
  });

  it("writes the description as the text checks read it", () => {
    const item = added(0, "dev-a", { description: "GREAT SPOT BY THE RIVER!!!!" });
    const history = [applied(added(-5, "dev-a", {}, { lat: -30, lon: 140 }))];
    expect(run([item], { history }).after(idOf(item))?.description).toBe("Great spot by the river!");
  });

  it("leaves a description that fails the text checks off the place, for a person", () => {
    const item = added(0, "dev-a", { description: "Shit hole, buy now", fee: true });
    const history = [applied(added(-5, "dev-a", {}, { lat: -30, lon: 140 }))];
    const out = run([item], { history });
    expect(out.outcome(item)).toBe("applied");
    expect(out.after(idOf(item))?.description).toBeUndefined();
    expect(out.after(idOf(item))?.fact_sources.description).toBeUndefined();
    expect(out.after(idOf(item))?.facts).toEqual({ fee: true });
    expect(out.held).toEqual([
      { case: "description", place: idOf(item), standing: "shown", location: SPOT, kind: "free_camp", problem: "rude", feedback: [item.id] },
    ]);
    expect(JSON.stringify(out.held)).not.toContain("hole");
  });

  it("leaves a description the data validator refuses off the place, for a person", () => {
    for (const description of ["Flat grassy spot by the creek, room for three vans. Cheers, Dave", "Shady sites near the river, drop toilet only. Thanks, Sarah"]) {
      const item = added(0, "dev-a", { description });
      const history = [applied(added(-5, "dev-a", {}, { lat: -30, lon: 140 }))];
      const out = run([item], { history });
      expect(out.outcome(item)).toBe("applied");
      expect(out.after(idOf(item))?.description).toBeUndefined();
      expect(out.held).toEqual([expect.objectContaining({ case: "description", place: idOf(item), problem: "contact" })]);
    }
  });

  it("drafts a held place for a person with every contact, as before", () => {
    const item = added(0, "dev-a", { contacts: { website: "https://bit.ly/camp", phone: "03 5555 0100" } });
    const out = run([item, remove(0.1, "dev-b", item), remove(0.2, "dev-c", item)]);
    expect(out.places.size).toBe(0);
    const edit = out.edits[0];
    expect(edit?.kind === "new_place" && edit.record.facts).toEqual({ website: "https://bit.ly/camp", phone: "03 5555 0100" });
    expect(out.held.map((h) => h.case)).toEqual(["hidden", "first_place"]);
  });

  it("drafts a held place for a person with its address", () => {
    const address = { place: "Lake Station", postcode: "3999" };
    const item = added(0, "dev-a", { address });
    const out = run([item, remove(0.1, "dev-b", item), remove(0.2, "dev-c", item)]);
    const edit = out.edits[0];
    expect(edit?.kind === "new_place" && edit.record).toMatchObject({ standing: "hidden", facts: { address }, fact_sources: { address: "feedback" } });
  });

  it("lists a published place's note for a person, without its words", () => {
    const item = added(0, "dev-a", { note: "Address: 12 River Road, Lakeside" });
    const history = [applied(added(-5, "dev-a", {}, { lat: -30, lon: 140 }))];
    const out = run([item], { history });
    expect(out.outcome(item)).toBe("applied");
    expect(out.after(idOf(item))?.standing).toBe("shown");
    expect(out.held).toEqual([{ case: "note", place: idOf(item), standing: "shown", location: SPOT, kind: "free_camp", feedback: [item.id] }]);
    expect(JSON.stringify(out.held)).not.toContain("River Road");
    expect(run([added(0, "dev-a", { note: "  " })], { history }).held).toEqual([]);
    expect(run([added(0, "dev-a")], { history }).held).toEqual([]);
  });

  it("lists the note of a place drafted for a person, and of one merged into the place it duplicates", () => {
    const drafted = added(0, "dev-a", { note: "Gravel pit off the highway" });
    const out = run([drafted, remove(0.1, "dev-b", drafted), remove(0.2, "dev-c", drafted)]);
    expect(out.held.map((h) => h.case)).toEqual(["hidden", "first_place", "note"]);
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
    const decided = (moderator: NonNullable<Place["moderator"]>, standing: Place["standing"]) => {
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
      const { item, input } = decided({ action: "keep", at: "soon" } as unknown as NonNullable<Place["moderator"]>, "shown");
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

describe("items the intake held for a check", () => {
  const SPOT = { lat: -35.1, lon: 149.2 };
  const attested = (item: StoredFeedback) => ({ ...item, attested: "app_attest", contributor: ctr(item.device) }) as StoredFeedback;
  const heldFor = (item: StoredFeedback, reason: string) => ({ ...item, intake: { state: "held", held_reason: reason } }) as StoredFeedback;
  const contactReport = (day: number, device: string, name: string) =>
    ({ ...base(day, device), type: "report", report: { kind: "contact", fact: name, reason: "spam" } }) as StoredFeedback;
  const withSite = () => place({ facts: { website: "https://spam.example.org" }, fact_sources: { website: "osm" } });
  const newPlace = (device: string) =>
    ({
      ...base(0, device, null),
      contributor: ctr(device),
      attested: "app_attest",
      type: "report",
      location: SPOT,
      report: { kind: "new_place", place_kind: "free_camp", note: "Gravel pit off the highway" },
    }) as StoredFeedback;
  const idOf = (item: StoredFeedback) => `ocdb_${item.id.slice(3)}`;

  for (const reason of ["text_check", "link_check", "ai_check", "daily_cap", "repeated_text", "check_unavailable", "network_reputation"]) {
    it(`sends an attested fact held for ${reason} to a person instead of applying it`, () => {
      const r = heldFor(attested(fact(0, "dev-a", "power", true)), reason);
      const out = run([r]);
      expect(out.outcome(r)).toBe("needs_review");
      expect(out.decisions[0]?.reason).toContain(reason);
      expect(out.after()).toBeUndefined();
      expect(out.edits).toEqual([{ kind: "fact", place: PLACE, fact: "power", value: true, feedback: r.id }]);
    });
  }

  it("sends a fact held for network_reputation or repeated_text to the AI reviewer, with the value it replaces, and others to a person", () => {
    for (const reason of ["network_reputation", "repeated_text"]) {
      const r = heldFor(attested(fact(0, "dev-a", "power", true)), reason);
      const out = run([r]);
      expect(out.decisions[0]?.reason).toContain("the AI reviewer");
      expect(out.held).toEqual([
        expect.objectContaining({ case: "intake_check", place: PLACE, about: "fact", fact: "power", value: false, held_for: reason, feedback: [r.id] }),
      ]);
    }
    const text = heldFor(attested(fact(0, "dev-a", "power", true)), "text_check");
    const out = run([text]);
    expect(out.held).toEqual([]);
    expect(out.decisions[0]?.reason).toContain("a person");
  });

  it("changes no status for a closure, a reopening or a check held for network_reputation, and sends each to the AI reviewer", () => {
    const shut = heldFor(attested(closed(0, "dev-a")), "network_reputation");
    const gone = heldFor(attested(check(0, "dev-b", false)), "network_reputation");
    const out = run([shut, gone]);
    expect(out.outcome(shut)).toBe("needs_review");
    expect(out.outcome(gone)).toBe("needs_review");
    expect(out.after()?.status ?? "open").toBe("open");
    expect(out.held.map((c) => [c.case, c.about, c.held_for, c.feedback])).toEqual([
      ["intake_check", "status", "network_reputation", [shut.id]],
      ["intake_check", "status", "network_reputation", [gone.id]],
    ]);
    // A held report counts for nothing later either: with a second device's closure the place is only reported closed.
    const later = attested(closed(2, "dev-c"));
    expect(run([later], { now: 3, history: [applied(shut, "needs_review")] }).after()?.status).toBe("reported_closed");
  });

  it("counts a held closure once the AI reviewer approves it, and never one it dismisses", () => {
    const shut = heldFor(attested(closed(0, "dev-a")), "network_reputation");
    const listed: HeldCase = {
      case: "intake_check",
      place: PLACE,
      location: { lat: -36.85, lon: 144.55 },
      kind: "free_camp",
      held_for: "network_reputation",
      about: "status",
      says: "closed",
      feedback: [shut.id],
    };
    const approve = { extra: { reviewerDecisions: [{ case: listed, decision: "approve" as const }] } };
    const history = [applied(shut, "needs_review")];
    const out = run([], { now: 2, history, ...approve });
    expect(out.after()?.status).toBe("reported_closed");
    // With a second device's closure, approved and unheld together close it.
    const second = applied(attested(closed(1, "dev-b")));
    expect(run([], { now: 2, history: [...history, second], ...approve }).after()?.status).toBe("closed");
    const dismissed = run([], { now: 2, history, extra: { reviewerDecisions: [{ case: listed, decision: "dismiss" }] } });
    expect(dismissed.after()).toBeUndefined();
  });

  it("sends a review held for network_reputation to the AI reviewer, a contributor's first review too", () => {
    const r = heldFor(attested(review(0, "sam", 5, "Shady sites near the water and clean toilets.")), "network_reputation");
    const out = run([r]);
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.decisions[0]?.reason).toContain("the AI reviewer");
    expect(out.held).toEqual([expect.objectContaining({ case: "intake_check", about: "review", review: `rev_${r.id.slice(3)}`, held_for: "network_reputation" })]);
  });

  it("tells the AI reviewer a name change was held for network_reputation, and sends one held for another check to a person", () => {
    const rename = (reason: string) => heldFor(attested({ ...base(0, "dev-a"), type: "report", report: { kind: "name", value: "Eppalock Foreshore Camp" } } as StoredFeedback), reason);
    const listed = rename("network_reputation");
    expect(run([listed]).held).toEqual([expect.objectContaining({ case: "place_change", change: "name", held_for: "network_reputation" })]);
    const flagged = rename("ai_check");
    const out = run([flagged]);
    expect(out.held).toEqual([]);
    expect(out.outcome(flagged)).toBe("needs_review");
  });

  it("sends a held fact for a reviewed fact, such as a website, to a person", () => {
    const r = heldFor(attested(fact(0, "dev-a", "website", "https://camp.example.org")), "link_check");
    const out = run([r]);
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
  });

  it("decides a fact the intake put live, or held for a rule, as before", () => {
    const live = { ...attested(fact(0, "dev-a", "power", true)), intake: { state: "live" } } as StoredFeedback;
    expect(run([live]).outcome(live)).toBe("applied");
    const owner = heldFor(attested(fact(0, "dev-a", "power", true)), "owner_value");
    expect(run([owner]).outcome(owner)).toBe("applied");
    const unknown = heldFor(attested(fact(0, "dev-a", "power", true)), "unknown_place");
    expect(run([unknown]).outcome(unknown)).toBe("applied");
  });

  it("applies a held fact the place already has, which changes nothing", () => {
    const r = heldFor(attested(fact(0, "dev-a", "power", false)), "daily_cap");
    expect(run([r]).outcome(r)).toBe("applied");
  });

  describe("gap fills the intake held only for daily_cap", () => {
    const GAPS = ["caravans", "toilets", "swimming", "walking_tracks", "scenery", "wildlife", "shade"];
    const fromOne = (item: StoredFeedback) => ({ ...item, contributor: ctr("dev-a") }) as StoredFeedback;

    for (const how of ["without attestation", "attested"]) {
      it(`applies seven gap fills from one contributor ${how}, as the rules decide them`, () => {
        const reports = GAPS.map((name, i) => {
          const r = fromOne({ ...fact(0, "dev-a", name, true), received: new Date(Date.parse(at(0)) + i * 1000).toISOString() } as StoredFeedback);
          return heldFor(how === "attested" ? attested(r) : r, "daily_cap");
        });
        const out = run(reports);
        expect(reports.map(out.outcome)).toEqual(GAPS.map(() => "applied"));
        expect(out.after()?.facts).toEqual({ power: false, fee: true, ...Object.fromEntries(GAPS.map((name) => [name, true])) });
        expect(out.changes).toHaveLength(GAPS.length);
        expect(out.changes.every((c) => c.automatic)).toBe(true);
        expect(out.edits).toEqual([]);
      });
    }

    it("still sends a report that changes a value the place has to a person", () => {
      const r = heldFor(attested(fact(0, "dev-a", "power", true)), "daily_cap");
      const out = run([r]);
      expect(out.outcome(r)).toBe("needs_review");
      expect(out.decisions[0]?.reason).toContain("daily_cap");
      expect(out.after()).toBeUndefined();
      expect(out.changes).toEqual([expect.objectContaining({ automatic: false, feedback: [r.id] })]);
    });

    it("still sends a link the intake never looked up to a person, and decides one whose links passed", () => {
      const site = heldFor(attested(fact(0, "dev-a", "website", "https://camp.example.org")), "daily_cap");
      const out = run([site]);
      expect(out.outcome(site)).toBe("needs_review");
      expect(out.decisions[0]?.reason).toContain("daily_cap");
      expect(out.after()).toBeUndefined();

      const passed = { ...site, intake: { state: "held", held_reason: "daily_cap", links: "passed" } } as StoredFeedback;
      const checked = run([passed]);
      expect(checked.outcome(passed)).toBe("applied");
      expect(checked.after()?.facts.website).toBe("https://camp.example.org");
    });

    it("still sends a gap fill held for another check to a person", () => {
      for (const reason of ["text_check", "link_check", "ai_check", "check_unavailable"]) {
        const r = heldFor(attested(fact(0, "dev-a", "toilets", true)), reason);
        const out = run([r]);
        expect(out.outcome(r)).toBe("needs_review");
        expect(out.after()).toBeUndefined();
      }
    });

    it("still sends other items held for daily_cap to a person", () => {
      const rename = heldFor(attested({ ...base(0, "dev-a"), type: "report", report: { kind: "name", value: "Eppalock Foreshore Camp" } } as StoredFeedback), "daily_cap");
      const added = heldFor(newPlace("dev-b"), "daily_cap");
      const said = heldFor(review(0, "sam", 5, "Great little spot. Lots of rain but solid ground that drained well."), "daily_cap");
      const out = run([rename, added, said]);
      expect([rename, added, said].map(out.outcome)).toEqual(["needs_review", "needs_review", "needs_review"]);
      expect(out.reviews.size).toBe(0);
    });
  });

  it("takes no contact down on a report held for a check, though it counts towards a later one", () => {
    const a = attested(contactReport(0, "dev-a", "website"));
    const b = heldFor(attested(contactReport(1, "dev-b", "website")), "daily_cap");
    const held = run([a, b], { now: 2, places: [withSite()] });
    expect(held.outcome(a)).toBe("needs_review");
    expect(held.outcome(b)).toBe("needs_review");
    expect(held.after()).toBeUndefined();
    expect(held.held).toEqual([]);

    const c = attested(contactReport(2, "dev-c", "website"));
    const out = run([a, b, c], { now: 3, places: [withSite()] });
    expect(out.after()?.facts).toEqual({});
    expect(out.outcome(c)).toBe("applied");
    // The held report stays with a person.
    expect(out.outcome(b)).toBe("needs_review");
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: b.id }]);
  });

  it("drafts a new place held for a check for a person instead of publishing it", () => {
    const item = heldFor(newPlace("dev-a"), "ai_check");
    const out = run([item]);
    expect(out.outcome(item)).toBe("needs_review");
    expect(out.decisions[0]?.reason).toContain("ai_check");
    expect(out.places.has(idOf(item))).toBe(false);
    expect(out.edits).toEqual([expect.objectContaining({ kind: "new_place", feedback: item.id, record: expect.objectContaining({ standing: "held" }) })]);
  });

  it("publishes a new place held for a rule only, or put live, as before", () => {
    const live = { ...newPlace("dev-a"), intake: { state: "live" } } as StoredFeedback;
    expect(run([live]).outcome(live)).toBe("applied");
    const old = newPlace("dev-b");
    expect(run([old]).outcome(old)).toBe("applied");
  });

  it("reads a malformed intake field as no decision", () => {
    const r = { ...attested(fact(0, "dev-a", "power", true)), intake: "held" } as unknown as StoredFeedback;
    expect(run([r]).outcome(r)).toBe("applied");
  });
});

describe("results the data validator would refuse", () => {
  const attested = (item: StoredFeedback) => ({ ...item, attested: "app_attest", contributor: ctr(item.device) }) as StoredFeedback;

  it("sends a fact whose record would fail the data checks to a person, and still applies the rest of the place's changes", () => {
    const broken = attested(fact(0, "dev-a", "operator", "Parks \ud83d Board"));
    const fine = attested(fact(0.5, "dev-b", "power", true));
    const out = run([broken, fine]);
    expect(out.outcome(broken)).toBe("needs_review");
    expect(out.decisions.find((d) => d.id === broken.id)?.reason).toBe(
      "the change would fail the data checks (facts/operator is not well formed text, so the file cannot be in canonical form), so a person decides",
    );
    expect(out.outcome(fine)).toBe("applied");
    expect(out.after()?.facts).toEqual({ power: true, fee: true });
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: broken.id }]);
    expect(out.changes).toEqual([
      expect.objectContaining({ automatic: false, feedback: [broken.id], summary: expect.stringContaining("would fail the data checks") }),
      expect.objectContaining({ automatic: true, feedback: [fine.id] }),
    ]);
    expect(JSON.stringify(out.changes)).not.toContain("Parks");
  });

  it("sends a trusted contributor's review whose line would fail the data checks to a person, and writes no line", () => {
    const r = review(0, "sam", 4, "Great camp \ud83d by the lake.");
    const out = run([r]);
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.reviews.size).toBe(0);
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: r.id }]);
  });

  it("leaves a run whose results pass the data checks as it was", () => {
    const r = review(0, "sam", 4, "Great camp 😀 by the lake.");
    const out = run([r]);
    expect(out.outcome(r)).toBe("applied");
    expect(out.reviews.get(PLACE)).toHaveLength(1);
  });
});

describe("gap fills", () => {
  const web = (item: StoredFeedback, origin = "net-1") => ({ ...item, origin, human_checked: true }) as StoredFeedback;
  const reasonOf = (out: ReturnType<typeof run>, item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.reason;

  it("puts a fixed-value fact the place has no value for live on one report without attestation", () => {
    const r = web(fact(0, "dev-a", "toilets", true));
    const out = run([r]);
    expect(out.outcome(r)).toBe("applied");
    expect(reasonOf(out, r)).toBe("toilets set to true (filled a gap: the place had no value)");
    expect(out.after()?.facts).toMatchObject({ toilets: true });
    expect(out.after()?.fact_sources).toMatchObject({ toilets: "feedback" });
    expect(out.changes).toEqual([expect.objectContaining({ automatic: true, feedback: [r.id], summary: "toilets set to true (filled a gap: the place had no value)" })]);
  });

  it("keeps the two-source rule for a fact with free words, a contact and a change to a value the place has", () => {
    const operator = web(fact(0, "dev-a", "operator", "Example Shire Council"));
    const hours = web(fact(0, "dev-a", "opening_hours", "Mo-Su 08:00-18:00"));
    const changed = web(fact(0, "dev-a", "power", true));
    const out = run([operator, hours, changed]);
    expect([out.outcome(operator), out.outcome(hours), out.outcome(changed)]).toEqual(["waiting", "waiting", "waiting"]);
    expect(out.after()).toBeUndefined();
  });

  it("waits when another source sent a different value within 90 days, before or after it", () => {
    const a = web(fact(0, "dev-a", "toilets", true), "net-1");
    const b = web(fact(1, "dev-b", "toilets", false), "net-2");
    const out = run([a, b], { now: 2 });
    expect([out.outcome(a), out.outcome(b)]).toEqual(["waiting", "waiting"]);
    expect(out.after()).toBeUndefined();
  });

  it("sends a gap fill the intake held for repeated text to the AI reviewer, not into the data", () => {
    const r = { ...web(fact(0, "dev-a", "toilets", true)), intake: { state: "held", held_reason: "repeated_text" } } as StoredFeedback;
    const out = run([r]);
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
    expect(out.held).toEqual([expect.objectContaining({ case: "intake_check", held_for: "repeated_text", fact: "toilets" })]);
  });

  it("fills at most GAP_FILL_DAILY_LIMIT gaps a day from one client network, and the rest wait for a second source", () => {
    const others = Array.from({ length: GAP_FILL_DAILY_LIMIT }, (_, n) => `ocdb_01JBXK3M8Q4R5S6T7V8W9X${String(n).padStart(4, "0")}`);
    const places = [place(), ...others.map((id) => place({ id }))];
    const earlier = others.map((id) => applied(web(fact(1, "dev-a", "toilets", true, id))));
    for (const e of earlier) (e as unknown as { outcome: { reason: string } }).outcome.reason = "toilets set to true (filled a gap: the place had no value)";
    const sameDay = web(fact(1, "dev-b", "toilets", true));
    const out = run([sameDay], { now: 2, places, history: earlier });
    expect(out.outcome(sameDay)).toBe("waiting");
    expect(reasonOf(out, sameDay)).toMatch(/gap fills a day/);
    // Another network, or the next day, fills it.
    const otherNetwork = web(fact(1, "dev-c", "toilets", true), "net-2");
    expect(run([otherNetwork], { now: 2, places, history: earlier }).outcome(otherNetwork)).toBe("applied");
    const nextDay = web(fact(2, "dev-b", "toilets", true));
    expect(run([nextDay], { now: 3, places, history: earlier }).outcome(nextDay)).toBe("applied");
  });
});

describe("unconfirmed facts", () => {
  const web = (item: StoredFeedback, origin = "net-1") => ({ ...item, origin, human_checked: true }) as StoredFeedback;
  const reasonOf = (out: ReturnType<typeof run>, item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.reason;

  it("lists a report still waiting for a second source after 7 days for the AI reviewer", () => {
    const r = web(fact(0, "dev-a", "power", true));
    expect(run([r], { now: 6 }).held).toEqual([]);
    const out = run([r], { now: 7 });
    expect(out.outcome(r)).toBe("waiting");
    expect(out.held).toEqual([
      {
        case: "unconfirmed_fact",
        place: PLACE,
        location: { lat: -36.85, lon: 144.55 },
        kind: "free_camp",
        fact: "power",
        value: true,
        from_source: "osm",
        feedback: [r.id],
      },
    ]);
    expect(reasonOf(out, r)).toBe("waiting for a second device to agree on power, and listed for the AI reviewer");
  });

  it("puts the value in the data when the AI reviewer confirms it, refuses it on dismiss, and sends it to a person on leave", () => {
    const r = web(fact(0, "dev-a", "power", true));
    const listed = run([r], { now: 7 }).held[0]!;
    const decided = (decision: "confirm" | "dismiss" | "leave") => run([r], { now: 8, extra: { reviewerDecisions: [{ case: listed, decision }] } });

    const confirmed = decided("confirm");
    expect(confirmed.outcome(r)).toBe("applied");
    expect(reasonOf(confirmed, r)).toBe("power set to true (the AI reviewer confirmed it)");
    expect(confirmed.after()?.facts.power).toBe(true);
    expect(confirmed.after()?.fact_sources.power).toBe("feedback");
    expect(confirmed.held).toEqual([]);

    const dismissed = decided("dismiss");
    expect(dismissed.outcome(r)).toBe("refused");
    expect(reasonOf(dismissed, r)).toBe("the AI reviewer dismissed power = true");
    expect(dismissed.after()).toBeUndefined();
    expect(dismissed.held).toEqual([]);

    const left = decided("leave");
    expect(left.outcome(r)).toBe("needs_review");
    expect(left.after()).toBeUndefined();
    expect(left.edits).toEqual([{ kind: "fact", place: PLACE, fact: "power", value: true, feedback: r.id }]);
    expect(left.held).toEqual([]);
  });

  const no = (day: number, device: string, name: string, origin: string) =>
    ({ ...base(day, device), origin, type: "report", report: { kind: "doubt", fact: name } }) as StoredFeedback;

  it("sends a report a doubt from another source answers No to straight to the AI reviewer, with the doubt counted", () => {
    // A change of the place's value, and a gap fill a doubt in the same run stops.
    const change = web(fact(0, "dev-a", "power", true));
    const gap = web(fact(0, "dev-a", "toilets", true));
    const d1 = no(1, "dev-b", "power", "net-2");
    const d2 = no(1, "dev-b", "toilets", "net-2");
    const out = run([change, gap, d1, d2], { now: 2 });
    expect([out.outcome(d1), out.outcome(d2)]).toEqual(["applied", "applied"]);
    expect([out.outcome(change), out.outcome(gap)]).toEqual(["waiting", "waiting"]);
    // The doubt counts against the report, not the place's value.
    expect(out.after()).toBeUndefined();
    expect(out.held).toEqual([
      expect.objectContaining({ case: "unconfirmed_fact", fact: "power", value: true, doubts: [d1.id], feedback: [change.id] }),
      expect.objectContaining({ case: "unconfirmed_fact", fact: "toilets", value: true, doubts: [d2.id], feedback: [gap.id] }),
    ]);
  });

  it("refuses a report doubts from two sources on different networks answer No to", () => {
    const r = web(fact(0, "dev-a", "toilets", true));
    const first = no(1, "dev-b", "toilets", "net-2");
    const earlier = run([r, first], { now: 2 });
    const kept = applied(first, earlier.outcome(first));
    (kept as unknown as { outcome: { reason: string } }).outcome.reason = earlier.decisions.find((d) => d.id === first.id)!.reason;
    const second = no(3, "dev-c", "toilets", "net-3");
    const out = run([r, second], { now: 4, history: [kept] });
    expect(out.outcome(r)).toBe("refused");
    expect(reasonOf(out, r)).toBe("doubts from 2 sources say toilets = true is wrong");
    expect(out.outcome(second)).toBe("applied");
    expect(out.after()).toBeUndefined();
    // Two doubts on one network count once.
    const sameNetwork = no(3, "dev-c", "toilets", "net-2");
    expect(run([r, sameNetwork], { now: 4, history: [kept] }).outcome(r)).toBe("waiting");
  });

  it("weighs a doubt as before when no report waits for the fact", () => {
    const d = no(1, "dev-b", "toilets", "net-2");
    expect(run([d], { now: 2 }).outcome(d)).toBe("refused");
  });

  it("sends a confirmed value to a person when another source has reported a different value since the case was listed", () => {
    const r = web(fact(0, "dev-a", "power", true));
    const listed = run([r], { now: 7 }).held[0]!;
    const since = { ...fact(7, "dev-b", "power", false), attested: "app_attest" } as StoredFeedback;
    const out = run([r, since], { now: 8, extra: { reviewerDecisions: [{ case: listed, decision: "confirm" }] } });
    expect(out.outcome(r)).toBe("needs_review");
    expect(reasonOf(out, r)).toBe("the AI reviewer confirmed it, but another source has reported a different value since, so a person decides");
    expect(out.after()?.facts.power).not.toBe(true);
  });

  it("sends a confirmed value to a person when a traveller doubted it since, and refuses it when two sources did", () => {
    const r = web(fact(0, "dev-a", "power", true));
    const listed = run([r], { now: 7 }).held[0]!;
    const confirmed = { reviewerDecisions: [{ case: listed, decision: "confirm" as const }] };
    const one = no(7, "dev-b", "power", "net-2");
    const out = run([r, one], { now: 8, extra: confirmed });
    expect(out.outcome(one)).toBe("applied");
    expect(out.outcome(r)).toBe("needs_review");
    expect(reasonOf(out, r)).toBe("the AI reviewer confirmed it, but a traveller has doubted it since, so a person decides");
    const two = no(7, "dev-c", "power", "net-3");
    const refused = run([r, one, two], { now: 8, extra: confirmed });
    expect(refused.outcome(r)).toBe("refused");
    expect(refused.after()).toBeUndefined();
  });

  it("never weighs a No counted against a waiting report against the place's value", () => {
    const owned = place({ facts: { power: false, fee: true, toilets: false }, fact_sources: { power: "osm", fee: "osm", toilets: "feedback" } });
    const r = web(fact(0, "dev-a", "toilets", true));
    const first = { ...no(1, "dev-b", "toilets", "net-2"), attested: "app_attest" } as StoredFeedback;
    const earlier = run([r, first], { now: 2, places: [owned] });
    expect(earlier.outcome(first)).toBe("applied");
    const kept = applied(first);
    (kept as unknown as { outcome: { reason: string } }).outcome.reason = reasonOf(earlier, first)!;
    // The report is refused, and a second traveller doubts the place's own value: one doubt, so the fact stays.
    const refusedReport = { ...applied(r, "refused") } as StoredFeedback;
    const later = { ...no(3, "dev-c", "toilets", "net-3"), attested: "app_attest" } as StoredFeedback;
    const out = run([later], { now: 4, places: [owned], history: [kept, refusedReport] });
    expect(out.outcome(later)).toBe("needs_review");
    expect(out.after()?.facts.toilets ?? false).toBe(false);
  });

  it("weighs a No about a fact with free words as a doubt of the place's value, even while a report of it waits", () => {
    const owned = place({ facts: { power: false, fee: true, operator: "Example Shire" }, fact_sources: { power: "osm", fee: "osm", operator: "feedback" } });
    const r = web(fact(0, "dev-a", "operator", "Example Parks"));
    const d = no(1, "dev-b", "operator", "net-2");
    const out = run([r, d], { now: 2, places: [owned] });
    expect(reasonOf(out, d)).not.toMatch(/counted against/);
  });

  it("lists a report for the AI reviewer though a refused report from another source sent a different value", () => {
    const r = web(fact(0, "dev-a", "power", true));
    const refusedOther = applied(web(fact(1, "dev-b", "power", "4wd"), "net-2"), "refused");
    const out = run([r], { now: 7, history: [refusedOther] });
    expect(out.held).toEqual([expect.objectContaining({ case: "unconfirmed_fact", fact: "power", feedback: [r.id] })]);
  });

  it("sends a confirmed value to a person when the owner has set the fact since", () => {
    const r = web(fact(0, "dev-a", "power", true));
    const listed = run([r], { now: 7 }).held[0]!;
    const owned = place({ fact_sources: { power: "owner", fee: "osm" } });
    const out = run([r], { now: 8, places: [owned], extra: { reviewerDecisions: [{ case: listed, decision: "confirm" }] } });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
  });
});
