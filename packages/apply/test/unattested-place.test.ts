import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyRules, type RulesInput } from "../src/rules.js";
import { reviewPrBody } from "../src/prbody.js";
import type { Place } from "../src/types.js";

const NOW = "2026-07-02T00:00:00Z";
let seq = 0;
const ctr = (name: string) => `ctr_${Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16)}`;

/** A new place from an install without attestation, with a contributor. */
function added(report: Record<string, unknown> = {}, location = { lat: -36.85, lon: 144.55 }, extra: Record<string, unknown> = {}): StoredFeedback {
  seq += 1;
  return {
    id: `fb_01JD${String(seq).padStart(22, "0")}`,
    received: "2026-07-01T00:00:00Z",
    app: "example-app",
    place: null,
    device: `dev-${seq}`,
    app_version: "1.0.0",
    consent: true,
    contributor: ctr(`dev-${seq}`),
    type: "report",
    location,
    report: { kind: "new_place", place_kind: "free_camp", name: "Creek Bend", ...report },
    ...extra,
  } as StoredFeedback;
}
const idOf = (item: StoredFeedback) => `ocdb_${item.id.slice(3)}`;

/** A place in the data, `metresNorth` of the new places' spot. */
function inData(n: number, metresNorth: number, overrides: Partial<Place> = {}): Place {
  return {
    id: `ocdb_01JBXK3M8Q4R5S6T7V8W9X0Y${"ABCDEFGHJK"[n]}${"ABCDEFGHJK"[n]}`,
    name: `Creek Bend ${n}`,
    kind: "free_camp",
    group: "overnight",
    location: { lat: -36.85 + metresNorth / 111_195, lon: 144.55 },
    osm: { type: "node", id: n + 1, version: 1 },
    facts: {},
    status: "open",
    rating: null,
    fact_sources: { name: "osm" },
    updated: "2026-06-01T00:00:00Z",
    ...overrides,
  } as Place;
}

function run(items: StoredFeedback[], extra: Partial<RulesInput> = {}) {
  return applyRules({
    now: NOW,
    pending: items,
    history: [],
    places: new Map(),
    everyPlace: [],
    reviews: () => [],
    kinds: new Map([
      ["free_camp", "overnight"],
      ["caravan_park", "overnight"],
      ["lookout", "attraction"],
    ]),
    ...extra,
  });
}

describe("unattested new places", () => {
  it("drafts an unattested new place as held and lists it for the AI reviewer", () => {
    const item = added();
    const out = run([item]);
    const decision = out.decisions.find((d) => d.id === item.id)!;
    expect(decision.outcome).toBe("needs_review");
    expect(decision.reason).toBe("not proven by attestation, so the AI reviewer checks it");
    expect(out.places.has(idOf(item))).toBe(false);
    expect(out.edits).toEqual([expect.objectContaining({ kind: "new_place", record: expect.objectContaining({ id: idOf(item), standing: "held" }) })]);
    expect(out.held.filter((c) => c.case === "unattested_place")).toEqual([
      expect.objectContaining({ case: "unattested_place", place: idOf(item), standing: "held", candidates: [], feedback: [item.id] }),
    ]);
  });

  it("lists the nearest places in its group within 500 m as merge candidates, nearest first", () => {
    const item = added();
    const places = [
      inData(0, 400),
      inData(1, 200),
      inData(2, 300, { kind: "lookout", group: "attraction" }),
      inData(3, 700),
      inData(4, 250, { status: "merged", merged_into: inData(1, 0).id } as Partial<Place>),
      inData(5, 450),
      inData(6, 480),
    ];
    const [c] = run([item], { everyPlace: places }).held.filter((h) => h.case === "unattested_place");
    expect(c!.candidates).toEqual([
      { place: places[1]!.id, distance_m: 200 },
      { place: places[0]!.id, distance_m: 400 },
      { place: places[5]!.id, distance_m: 450 },
    ]);
  });

  it("holds a possible duplicate as a duplicate case, not for this one", () => {
    const item = added();
    const out = run([item], { everyPlace: [inData(1, 100)] });
    expect(out.held.map((h) => h.case)).toEqual(["duplicate", "first_place"]);
  });

  it("holds an implausible location as an implausible_location case, not for this one", () => {
    const item = added({}, { lat: -36.85, lon: 144.55 }, { intake: { state: "held", held_reason: "implausible_location" } });
    const out = run([item]);
    expect(out.held.map((h) => h.case)).toEqual(["first_place", "implausible_location"]);
  });

  it("sends to a person a place that fails the text or link checks, has no contributor, or the intake held for a check", () => {
    const items = [
      added({ note: "Call 0400 000 000 for a spot" }),
      added({ description: "Visit https://spam.example.org now" }),
      added({ contacts: { website: "not a link" } }),
      added({}, undefined, { contributor: undefined }),
      added({}, undefined, { intake: { state: "held", held_reason: "repeated_text" } }),
      added({ contacts: { website: "https://creek.example.org" } }, undefined, { intake: { state: "held", held_reason: "not_attested" } }),
    ];
    const out = run(items);
    for (const item of items) {
      expect(out.decisions.find((d) => d.id === item.id)).toMatchObject({ outcome: "needs_review", reason: expect.stringContaining("so a person checks it") });
    }
    expect(out.held.filter((h) => h.case === "unattested_place")).toEqual([]);
  });

  it("lists the place for the reviewer once the intake's link checks passed", () => {
    const item = added({ contacts: { website: "https://creek.example.org" } }, undefined, { intake: { state: "held", held_reason: "not_attested", links: "passed" } });
    expect(run([item]).held.map((h) => h.case)).toContain("unattested_place");
  });

  it("leaves an attested new place out of it: it is published", () => {
    const item = added({}, undefined, { attested: "app_attest" });
    const out = run([item]);
    expect(out.places.get(idOf(item))?.standing).toBe("shown");
    expect(out.held.map((h) => h.case)).toEqual(["first_place"]);
  });

  it("keeps the reviewer's decision in later runs: an approved place stays shown and a taken down one hidden", () => {
    const item = added();
    const decided = { ...item, outcome: { result: "needs_review", reason: "", run: "2026-07-01T01:00:00Z" } } as unknown as StoredFeedback;
    const record = (standing: Place["standing"], moderator?: Place["moderator"]): Place =>
      ({ ...inData(0, 0, { id: idOf(item), name: "Creek Bend", osm: null, fact_sources: { name: "feedback", location: "feedback" } }), standing, ...(moderator ? { moderator } : {}) }) as Place;
    const check = {
      ...added(),
      place: idOf(item),
      type: "check",
      check: { visited: "2026-07-01", still_there: true, nearby: true },
    } as unknown as StoredFeedback;
    for (const [before, after] of [
      [record("shown"), "shown"],
      [record("hidden", { action: "hide", at: "2026-07-01T02:00:00Z" }), "hidden"],
    ] as const) {
      const out = run([check], { history: [decided], places: new Map([[idOf(item), before]]) });
      expect(out.places.get(idOf(item))?.standing ?? before.standing).toBe(after);
      expect(out.held.filter((h) => h.case === "unattested_place")).toEqual([]);
    }
  });
});


describe("new places past the contributor's new places for the day", () => {
  const capped = (report: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
    added(report, undefined, { attested: "app_attest", intake: { state: "held", held_reason: "new_place_cap" }, ...extra });

  it("drafts an attested new place the intake held as new_place_cap as held and lists it for the AI reviewer", () => {
    const item = capped();
    const places = [inData(1, 200)];
    const out = run([item], { everyPlace: places });
    expect(out.decisions.find((d) => d.id === item.id)).toMatchObject({
      outcome: "needs_review",
      reason: "past its contributor's new places for the day, so the AI reviewer checks it",
    });
    expect(out.places.has(idOf(item))).toBe(false);
    expect(out.edits).toEqual([expect.objectContaining({ kind: "new_place", record: expect.objectContaining({ id: idOf(item), standing: "held" }) })]);
    expect(out.held.filter((c) => c.case === "new_place_cap")).toEqual([
      expect.objectContaining({
        case: "new_place_cap",
        place: idOf(item),
        standing: "held",
        candidates: [{ place: places[0]!.id, distance_m: 200 }],
        sender: expect.stringMatching(/^snd_[0-9a-f]{16}$/),
        feedback: [item.id],
      }),
    ]);
    expect(out.held.filter((c) => c.case === "unattested_place")).toEqual([]);
  });

  it("labels each case with an opaque sender for the run, and never puts the contributor in the review PR body", () => {
    const first = capped();
    const second = capped({}, { contributor: first.contributor, device: first.device });
    const other = capped();
    const out = run([first, second, other]);
    const cases = out.held.filter((c) => c.case === "new_place_cap");
    expect(cases.map((c) => c.contributor)).toEqual([undefined, undefined, undefined]);
    const [a, b, c] = cases.map((h) => h.sender);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    // Another run labels the same contributor differently, so labels can't be joined across PRs.
    expect(run([first]).held.find((h) => h.case === "new_place_cap")!.sender).not.toBe(a);
    const body = reviewPrBody("2026-07-02T00:00:00Z", [], new Map(), [], cases);
    for (const item of [first, other]) expect(body).not.toContain(item.contributor!);
    expect(body).toContain(a!);
  });

  it("lists it for the reviewer when its links passed the intake's checks, and sends it to a person when they were not looked up", () => {
    const passed = capped({ contacts: { website: "https://creek.example.org" } }, { intake: { state: "held", held_reason: "new_place_cap", links: "passed" } });
    const unchecked = capped({ contacts: { website: "https://creek.example.org" } });
    const out = run([passed, unchecked]);
    expect(out.held.filter((c) => c.case === "new_place_cap").map((c) => c.feedback)).toEqual([[passed.id]]);
    expect(out.decisions.find((d) => d.id === unchecked.id)).toMatchObject({ outcome: "needs_review", reason: expect.stringContaining("so a person checks it") });
  });

  it("sends to a person a place past the day's new places that fails the text or link checks", () => {
    const items = [
      capped({ name: "Call 0400 000 000" }),
      capped({ description: "Visit https://spam.example.org now" }),
      capped({ contacts: { website: "not a link" } }, { intake: { state: "held", held_reason: "new_place_cap", links: "passed" } }),
    ];
    const out = run(items);
    for (const item of items) {
      expect(out.decisions.find((d) => d.id === item.id)).toMatchObject({ outcome: "needs_review", reason: expect.stringContaining("so a person checks it") });
      expect(out.places.has(idOf(item))).toBe(false);
    }
    expect(out.held.filter((h) => h.case === "new_place_cap")).toEqual([]);
  });
});
