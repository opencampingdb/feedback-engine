import { describe, expect, it } from "vitest";
import { dropSource, setSource } from "../src/sources.js";
import type { Place } from "../src/types.js";

const AT = "2026-10-31T09:00:00Z";

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
    name: "Lake Eppalock Camp",
    kind: "free_camp",
    group: "overnight",
    location: { lat: -36.85, lon: 144.55 },
    osm: { type: "node", id: 123456, version: 7, timestamp: "2024-05-06T07:08:09Z" },
    facts: { power: false },
    status: "open",
    rating: null,
    fact_sources: { power: "osm" },
    updated: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

describe("setSource", () => {
  it("dates a value that is not from OSM", () => {
    const p = place();
    setSource(p, "power", "feedback", AT);
    expect(p.fact_sources.power).toBe("feedback");
    expect(p.fact_dates).toEqual({ power: AT });
  });

  it("moves the date when the value is accepted again", () => {
    const p = place({ fact_sources: { power: "owner" }, fact_dates: { power: "2026-01-01T00:00:00Z" } });
    setSource(p, "power", "owner", AT);
    expect(p.fact_dates).toEqual({ power: AT });
  });

  it("gives an OSM value no date, and leaves out an empty fact_dates", () => {
    const p = place({ fact_sources: { power: "feedback" }, fact_dates: { power: AT } });
    setSource(p, "power", "osm", AT);
    expect(p.fact_sources.power).toBe("osm");
    expect(p.fact_dates).toBeUndefined();
  });
});

describe("dropSource", () => {
  it("removes the source and its date, and keeps the other dates", () => {
    const p = place({ fact_sources: { power: "osm", status: "owner", description: "owner" }, fact_dates: { status: AT, description: AT } });
    dropSource(p, "description");
    expect(p.fact_sources).toEqual({ power: "osm", status: "owner" });
    expect(p.fact_dates).toEqual({ status: AT });
  });
});
