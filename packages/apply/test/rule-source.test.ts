import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { decideDoubt, decideFact, protectedSource, type PlaceState, type ReportItem } from "../src/decide.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

let seq = 0;
function report(day: number, origin: string, body: Record<string, unknown>, attested = false): ReportItem {
  seq += 1;
  return {
    id: `fb_01JG${String(seq).padStart(22, "0")}`,
    received: at(day),
    app: "example-app",
    place: PLACE,
    device: `dev-${origin}`,
    origin,
    app_version: "1.0.0",
    consent: true,
    type: "report",
    report: body,
    ...(attested ? { attested: "app_attest", contributor: "ctr_00000000000000aa" } : {}),
  } as unknown as ReportItem;
}

// A fact the release set by a rule: source rule, and no date, as the place index holds it.
const ruled: PlaceState = { facts: { vehicle_access: "heavy_vehicles_only", toilets: true }, fact_sources: { vehicle_access: "rule", toilets: "osm" }, fact_dates: {} } as PlaceState;

describe("a fact set by a rule in the release", () => {
  it("is replaced by one attested report, as a fact from feedback is", () => {
    const item = report(0, "net-a", { kind: "fact", fact: "toilets", value: false }, true);
    const fromRule = { ...ruled, fact_sources: { ...ruled.fact_sources, toilets: "rule" } } as PlaceState;
    expect(decideFact({ item, place: fromRule, earlier: [] })).toEqual({
      verdict: "live",
      changes: [{ place: PLACE, fact: "toilets", value: false }],
      why: "toilets set to false",
    });
  });

  it("is not protected from doubts: two sources, one attested, take it down", () => {
    expect(protectedSource(ruled, "vehicle_access")).toBeUndefined();
    expect(protectedSource(ruled, "toilets")).toBe("OSM");
    const first = report(-2, "net-a", { kind: "doubt", fact: "vehicle_access" });
    const second = report(0, "net-b", { kind: "doubt", fact: "vehicle_access" }, true);
    expect(decideDoubt({ item: second, place: ruled, earlier: [first] as StoredFeedback[] })).toMatchObject({
      verdict: "live",
      changes: [{ place: PLACE, fact: "vehicle_access", value: null }],
    });
    expect(decideDoubt({ item: report(0, "net-c", { kind: "doubt", fact: "vehicle_access" }, true), place: ruled, earlier: [] })).toMatchObject({ verdict: "held", reason: "single_doubt" });
  });
});
