import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { decideDoubt, decideFact, type PlaceState, type ReportItem } from "../src/decide.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

let seq = 0;
function base(day: number, device: string, extra: Record<string, unknown> = {}) {
  seq += 1;
  return { id: `fb_01JD${String(seq).padStart(22, "0")}`, received: at(day), app: "example-app", place: PLACE, device, app_version: "1.0.0", consent: true as const, ...extra };
}
const attested = <T extends StoredFeedback>(item: T): T => ({ ...item, attested: "app_attest", contributor: "ctr_00000000000000aa" });
const doubt = (day: number, device: string, name = "toilets", extra: Record<string, unknown> = {}): ReportItem =>
  ({ ...base(day, device, extra), type: "report", report: { kind: "doubt", fact: name } }) as ReportItem;

function state(overrides: Partial<PlaceState> = {}): PlaceState {
  return {
    facts: { toilets: true, power: false, pets: "yes" },
    fact_sources: { toilets: "feedback", power: "osm", pets: "owner" },
    fact_dates: { toilets: at(-30), pets: at(-30) },
    ...overrides,
  };
}

describe("decideDoubt", () => {
  it("holds one doubt for a reviewer, and the fact stays", () => {
    const item = attested(doubt(0, "dev-a"));
    expect(decideDoubt({ item, place: state(), earlier: [] })).toEqual({
      verdict: "held",
      reason: "single_doubt",
      why: "one traveller doubts toilets, so a reviewer reads it",
    });
  });

  it("takes the fact down after doubts from two sources, one attested, with the case for a reviewer", () => {
    const first = doubt(-3, "dev-a");
    const item = attested(doubt(0, "dev-b"));
    expect(decideDoubt({ item, place: state(), earlier: [first] })).toEqual({
      verdict: "live",
      changes: [{ place: PLACE, fact: "toilets", value: null }],
      why: "toilets taken down after doubts from two sources",
      doubted: { fact: "toilets", value: true, sources: 2, doubts: [first.id, item.id], confirmations: [] },
    });
  });

  it("needs at least one attested doubt to take a fact down", () => {
    const decision = decideDoubt({ item: doubt(0, "dev-b"), place: state(), earlier: [doubt(-3, "dev-a")] });
    expect(decision).toEqual({ verdict: "held", reason: "not_attested", why: "doubts about toilets without attestation are read by a reviewer" });
  });

  it("counts a source once however many times it doubts, by network before device", () => {
    const again = attested(doubt(0, "dev-a"));
    expect(decideDoubt({ item: again, place: state(), earlier: [doubt(-3, "dev-a"), doubt(-2, "dev-a")] })).toMatchObject({ verdict: "held", reason: "single_doubt" });
    const sameNetwork = attested(doubt(0, "dev-b", "toilets", { origin: "net-1" }));
    expect(decideDoubt({ item: sameNetwork, place: state(), earlier: [doubt(-3, "dev-a", "toilets", { origin: "net-1" })] })).toMatchObject({
      verdict: "held",
      reason: "single_doubt",
    });
  });

  it("never takes down a fact from OSM or the owner", () => {
    for (const [fact, from] of [["power", "OSM"], ["pets", "the owner"]] as const) {
      const item = attested(doubt(0, "dev-b", fact));
      expect(decideDoubt({ item, place: state(), earlier: [attested(doubt(-1, "dev-a", fact)), doubt(-2, "dev-c", fact)] })).toEqual({
        verdict: "held",
        reason: "protected_source",
        why: `${fact} came from ${from}, so a reviewer decides`,
      });
    }
  });

  it("refuses a doubt about a fact the place does not have, or one that cannot be doubted", () => {
    expect(decideDoubt({ item: attested(doubt(0, "dev-a", "showers")), place: state(), earlier: [] })).toEqual({
      verdict: "refused",
      reason: "no_value",
      why: "place has no showers",
    });
    expect(decideDoubt({ item: attested(doubt(0, "dev-a", "website")), place: state({ facts: { website: "https://park.example.org" } }), earlier: [] })).toMatchObject({
      verdict: "refused",
      reason: "invalid_value",
    });
  });

  it("stops counting a doubt after 90 days", () => {
    const item = attested(doubt(0, "dev-b"));
    const place = state({ fact_dates: { toilets: at(-200) } });
    expect(decideDoubt({ item, place, earlier: [doubt(-91, "dev-a")] })).toMatchObject({ verdict: "held", reason: "single_doubt" });
    expect(decideDoubt({ item, place, earlier: [doubt(-90, "dev-a")] })).toMatchObject({ verdict: "live" });
  });

  it("does not count doubts sent before the fact was last set", () => {
    const item = attested(doubt(0, "dev-b"));
    expect(decideDoubt({ item, place: state({ fact_dates: { toilets: at(-2) } }), earlier: [doubt(-3, "dev-a")] })).toMatchObject({
      verdict: "held",
      reason: "single_doubt",
    });
  });

  it("holds doubts that do not outnumber confirmations of the value", () => {
    const confirm = (day: number, device: string, value: unknown = true) =>
      ({ ...base(day, device), type: "report", report: { kind: "fact", fact: "toilets", value } }) as ReportItem;
    const item = attested(doubt(0, "dev-b"));
    const doubts = [doubt(-3, "dev-a")];
    expect(decideDoubt({ item, place: state(), earlier: [...doubts, confirm(-40, "dev-c"), confirm(-5, "dev-d")] })).toEqual({
      verdict: "held",
      reason: "disagreement",
      why: "toilets has as many confirmations as doubts or more, so a reviewer decides",
    });
    // A report of another value is not a confirmation, and one older than 90 days no longer counts.
    const c = confirm(-5, "dev-d");
    expect(decideDoubt({ item, place: state(), earlier: [...doubts, confirm(-95, "dev-c"), c, confirm(-4, "dev-e", false)] })).toMatchObject({
      verdict: "live",
      doubted: { sources: 2, confirmations: [c.id] },
    });
  });

  it("counts a traveller on the side of their latest report", () => {
    const confirm = (day: number, device: string) => ({ ...base(day, device), type: "report", report: { kind: "fact", fact: "toilets", value: true } }) as ReportItem;
    const item = attested(doubt(0, "dev-b"));
    // dev-a doubted, then confirmed: one doubt against one confirmation.
    expect(decideDoubt({ item, place: state(), earlier: [doubt(-5, "dev-a"), confirm(-2, "dev-a")] })).toMatchObject({ verdict: "held", reason: "single_doubt" });
    // dev-c confirmed, then doubted: two doubts, no confirmations.
    expect(decideDoubt({ item, place: state(), earlier: [confirm(-5, "dev-c"), doubt(-2, "dev-c")] })).toMatchObject({ verdict: "live", doubted: { confirmations: [] } });
  });
});

describe("decideFact on a fact taken down after doubts", () => {
  const fact = (day: number, device: string, value: unknown = true, name = "toilets") =>
    ({ ...base(day, device), type: "report", report: { kind: "fact", fact: name, value } }) as ReportItem;
  // Taken down at day 0: the fact is gone, with the doubters' source and the date.
  const down = (): PlaceState => ({ facts: { power: false }, fact_sources: { power: "osm", toilets: "feedback" }, fact_dates: { toilets: at(0) } });
  const doubted = { value: true, at: at(0) };

  it("waits for a second new traveller to confirm the value", () => {
    const item = attested(fact(1, "dev-c"));
    expect(decideFact({ item, place: down(), earlier: [fact(-10, "dev-d")], doubted })).toEqual({
      verdict: "held",
      reason: "taken_down",
      why: "toilets was taken down after doubts, and returns when two new travellers confirm it",
    });
  });

  it("restores the value when two new travellers confirm it, and settles the case", () => {
    const first = fact(1, "dev-c");
    const item = attested(fact(2, "dev-d"));
    expect(decideFact({ item, place: down(), earlier: [first], doubted })).toEqual({
      verdict: "live",
      changes: [{ place: PLACE, fact: "toilets", value: true }],
      why: "toilets restored after two travellers confirmed it",
      settles: "restored",
    });
  });

  it("needs one of the confirmations to be attested", () => {
    expect(decideFact({ item: fact(2, "dev-d"), place: down(), earlier: [fact(1, "dev-c")], doubted })).toMatchObject({ verdict: "held", reason: "not_attested" });
  });

  it("needs the confirmations to outnumber doubts sent since the takedown", () => {
    const item = attested(fact(3, "dev-d"));
    const earlier = [fact(1, "dev-c"), doubt(1, "dev-e"), doubt(2, "dev-f")];
    expect(decideFact({ item, place: down(), earlier, doubted })).toMatchObject({ verdict: "held", reason: "taken_down" });
    expect(decideFact({ item, place: down(), earlier: [...earlier, fact(2, "dev-g")], doubted })).toMatchObject({ verdict: "live", settles: "restored" });
  });

  it("does not count the doubts that took the fact down against a restore", () => {
    // dev-a's doubt arrived at the takedown itself, dev-b's before it: only dev-e's, since, counts.
    const earlier = [doubt(-1, "dev-b"), doubt(0, "dev-a"), doubt(1, "dev-e"), fact(1, "dev-c")];
    expect(decideFact({ item: attested(fact(2, "dev-d")), place: down(), earlier, doubted })).toMatchObject({ verdict: "live", settles: "restored" });
  });

  it("counts only confirmations sent after the takedown, from travellers who had not reported the value before it", () => {
    const item = attested(fact(2, "dev-d"));
    // dev-c reported the value at the takedown itself.
    expect(decideFact({ item, place: down(), earlier: [fact(0, "dev-c")], doubted })).toMatchObject({ verdict: "held", reason: "taken_down" });
    // dev-d reported it before the takedown: its confirmation since is not a new traveller's.
    expect(decideFact({ item, place: down(), earlier: [fact(-10, "dev-d"), fact(1, "dev-c")], doubted })).toMatchObject({ verdict: "held", reason: "taken_down" });
  });

  it("replaces the value with an attested report of another, and settles the case", () => {
    const item = attested(fact(1, "dev-c", false));
    // The doubted value's own reports were outweighed and do not hold the new one.
    expect(decideFact({ item, place: down(), earlier: [fact(-10, "dev-d")], doubted })).toEqual({
      verdict: "live",
      changes: [{ place: PLACE, fact: "toilets", value: false }],
      why: "toilets set to false",
      settles: "replaced",
    });
    // A traveller confirming the doubted value since the takedown still disagrees, as everywhere.
    const later = attested(fact(2, "dev-c", false));
    expect(decideFact({ item: later, place: down(), earlier: [fact(1, "dev-d")], doubted })).toMatchObject({ verdict: "held", reason: "disagreement" });
    expect(decideFact({ item: fact(1, "dev-c", false), place: down(), earlier: [], doubted })).toMatchObject({ verdict: "held", reason: "not_attested" });
  });

  it("is decided as usual when the place has the fact again", () => {
    const place: PlaceState = { facts: { toilets: true }, fact_sources: { toilets: "feedback" }, fact_dates: { toilets: at(3) } };
    expect(decideFact({ item: attested(fact(4, "dev-c")), place, earlier: [], doubted })).toEqual({ verdict: "live", changes: [], why: "toilets is already true" });
  });
});

