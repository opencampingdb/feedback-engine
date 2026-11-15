import { describe, expect, it } from "vitest";
import { FACT_SOURCES, isFactSource, type FactSource } from "../src/index.js";

describe("fact sources", () => {
  it("lists every source a release record's fact_sources may name, overture among them", () => {
    expect([...FACT_SOURCES].sort()).toEqual(["community_report", "contributed", "feedback", "osm", "overture", "owner", "rule"]);
  });

  it("knows an overture value from a source it has never heard of", () => {
    const source: FactSource = "overture";
    expect(isFactSource(source)).toBe(true);
    expect(isFactSource("osm")).toBe(true);
    expect(isFactSource("overture_maps")).toBe(false);
    expect(isFactSource(undefined)).toBe(false);
  });
});
