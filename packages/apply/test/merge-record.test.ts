import { describe, expect, it } from "vitest";
// @ts-expect-error a plain script with no types
import { dumpRecord, mergeRecords } from "../scripts/merge-record.mjs";
import { dumpPlace } from "../src/serialise.js";
import type { Place } from "../src/types.js";

const base = {
  id: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
  name: "Riverbend Camp",
  kind: "campground",
  group: "overnight",
  location: { lat: -36, lon: 144.55 },
  osm: { type: "node", id: 1, version: 1 },
  facts: { fee: true, nearest_major_road: { distance_m: 320, name: "River Road" } },
  fact_sources: { fee: "osm", nearest_major_road: "osm" },
  status: "open",
  rating: { mean: 4, count: 2 },
  updated: "2026-06-01T00:00:00Z",
};
const merge = (ours: object, theirs: object) => mergeRecords(base, ours, theirs) as { merged: Record<string, unknown>; conflicts: string[] };

describe("merging a place record key by key", () => {
  it("keeps a fact each branch added, with its source and date", () => {
    const ours = { ...base, facts: { ...base.facts, toilets: true }, fact_sources: { ...base.fact_sources, toilets: "feedback" }, fact_dates: { toilets: "2026-11-01T00:00:00Z" } };
    const theirs = { ...base, facts: { ...base.facts, power: false }, fact_sources: { ...base.fact_sources, power: "feedback" }, fact_dates: { power: "2026-11-02T00:00:00Z" } };
    const { merged, conflicts } = merge(ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.facts).toEqual({ ...base.facts, toilets: true, power: false });
    expect(merged.fact_sources).toEqual({ ...base.fact_sources, toilets: "feedback", power: "feedback" });
    expect(merged.fact_dates).toEqual({ toilets: "2026-11-01T00:00:00Z", power: "2026-11-02T00:00:00Z" });
  });

  it("takes a key one branch changed or removed, and the later updated time when both moved it", () => {
    const { facts: _, ...withoutFacts } = base;
    const ours = { ...withoutFacts, facts: { nearest_major_road: base.facts.nearest_major_road }, kind: "caravan_park", updated: "2026-11-01T00:00:00Z" };
    const theirs = { ...base, name: "Riverbend Camping Ground", updated: "2026-11-03T00:00:00Z" };
    const { merged, conflicts } = merge(ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged).toMatchObject({ kind: "caravan_park", name: "Riverbend Camping Ground", updated: "2026-11-03T00:00:00Z" });
    expect(merged.facts).toEqual({ nearest_major_road: base.facts.nearest_major_road });
  });

  it("names the keys both branches changed to different values", () => {
    const ours = { ...base, name: "Riverbend", facts: { ...base.facts, fee: false } };
    const theirs = { ...base, name: "River Bend", facts: { ...base.facts, fee: { amount: 10 } } };
    expect(merge(ours, theirs).conflicts.sort()).toEqual(["facts.fee", "name"]);
  });

  it("agrees when both branches made the same change", () => {
    const changed = { ...base, facts: { ...base.facts, power: true } };
    expect(merge(changed, structuredClone(changed))).toEqual({ merged: changed, conflicts: [] });
  });

  it("writes the same text as the apply's serialiser", () => {
    const record = { ...base, facts: { ...base.facts, tags: ["a", "b"], none: [] }, extra: {} };
    expect(dumpRecord(record)).toBe(dumpPlace(record as unknown as Place));
  });
});
