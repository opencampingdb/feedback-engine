import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { decideFact, type PlaceState, type ReportItem } from "../src/decide.js";
import { applyRules } from "../src/rules.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

let seq = 0;
const attested = <T extends StoredFeedback>(item: T): T => ({ ...item, attested: "app_attest", contributor: "ctr_00000000000000aa" });
function fact(day: number, device: string, name: string, value: unknown): ReportItem {
  seq += 1;
  return {
    id: `fb_01JE${String(seq).padStart(22, "0")}`,
    received: at(day),
    app: "example-app",
    place: PLACE,
    device,
    app_version: "1.0.0",
    consent: true,
    type: "report",
    report: { kind: "fact", fact: name, value },
  } as ReportItem;
}
const state = (facts: Record<string, unknown>): PlaceState => ({ facts, fact_sources: {}, fact_dates: {} }) as PlaceState;

describe("pets_months in the shared rules", () => {
  it("sets the months on a seasonal place, as other facts", () => {
    const item = attested(fact(0, "dev-a", "pets_months", "May-Sep"));
    expect(decideFact({ item, place: state({ pets: "seasonal" }), earlier: [] })).toEqual({
      verdict: "live",
      changes: [{ place: PLACE, fact: "pets_months", value: "May-Sep" }],
      why: 'pets_months set to "May-Sep"',
    });
  });

  it("holds the months for a place whose pets is not seasonal", () => {
    for (const pets of [undefined, "yes", "no"]) {
      const item = attested(fact(0, "dev-a", "pets_months", "Dec-Feb"));
      expect(decideFact({ item, place: state(pets ? { pets } : {}), earlier: [] })).toEqual({
        verdict: "held",
        reason: "not_seasonal",
        why: "pets_months applies only when pets is seasonal, so a person checks it",
      });
    }
  });

  it("clears the months when pets stops being seasonal", () => {
    const item = attested(fact(0, "dev-a", "pets", "leashed"));
    expect(decideFact({ item, place: state({ pets: "seasonal", pets_months: "May-Sep" }), earlier: [] })).toEqual({
      verdict: "live",
      changes: [
        { place: PLACE, fact: "pets", value: "leashed" },
        { place: PLACE, fact: "pets_months", value: null },
      ],
      why: 'pets set to "leashed"',
    });
  });
});

describe("pets_months in the apply", () => {
  const place = (facts: Record<string, unknown>): Place => ({
    id: PLACE,
    name: "Example Camp",
    kind: "campground",
    group: "overnight",
    location: { lat: -33, lon: 151 },
    osm: null,
    facts,
    status: "open",
    rating: null,
    fact_sources: { pets: "osm", pets_months: "feedback" },
    fact_dates: { pets_months: at(-10) },
    updated: at(-10),
  }) as Place;
  const run = (facts: Record<string, unknown>, pending: StoredFeedback[]) =>
    applyRules({ now: at(1), pending, history: [], places: new Map([[PLACE, place(facts)]]), reviews: () => [] });

  it("takes pets_months off when two devices agree pets is no longer seasonal", () => {
    const out = run({ pets: "seasonal", pets_months: "May-Sep" }, [fact(0, "dev-a", "pets", "yes"), fact(0, "dev-b", "pets", "yes")]);
    const after = out.places.get(PLACE)!;
    expect(after.facts).toEqual({ pets: "yes" });
    expect(after.fact_sources.pets_months).toBeUndefined();
    expect(after.fact_dates?.pets_months).toBeUndefined();
  });

  it("sets the months after pets becomes seasonal in the same run, whichever arrived first", () => {
    const out = run({ pets: "yes" }, [attested(fact(0, "dev-a", "pets_months", "Oct-Mar")), attested(fact(0.5, "dev-b", "pets", "seasonal"))]);
    expect(out.places.get(PLACE)!.facts).toEqual({ pets: "seasonal", pets_months: "Oct-Mar" });
    expect(out.decisions.map((d) => d.outcome)).toEqual(["applied", "applied"]);
  });

  it("sends the months for a place that is not seasonal to a person", () => {
    const out = run({ pets: "yes" }, [attested(fact(0, "dev-a", "pets_months", "Oct-Mar"))]);
    expect(out.decisions[0]).toMatchObject({ outcome: "needs_review", reason: "pets_months applies only when pets is seasonal, so a person checks it" });
    expect(out.edits).toEqual([{ kind: "fact", place: PLACE, fact: "pets_months", value: "Oct-Mar", feedback: out.decisions[0]!.id }]);
  });
});
