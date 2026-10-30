import { describe, expect, it } from "vitest";
import { dumpPlace, dumpReviewLine, placePath, pythonFloat } from "../src/serialise.js";
import type { Place } from "../src/types.js";

describe("pythonFloat", () => {
  it.each([
    [4, "4.0"],
    [-36, "-36.0"],
    [4.33, "4.33"],
    [-36.851235, "-36.851235"],
    [0.00005, "5e-05"],
    [1e16, "1e+16"],
    [0, "0.0"],
  ])("writes %d as %s", (x, text) => {
    expect(pythonFloat(x)).toBe(text);
  });
});

describe("dumpPlace", () => {
  it("matches Python json.dumps(sort_keys=True, indent=2, ensure_ascii=False)", () => {
    const place: Place = {
      id: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
      name: "Lac de l'Été",
      kind: "camp_site",
      location: { lat: -36, lon: 144.55 },
      osm: { type: "node", id: 123456, version: 7 },
      facts: { power: true },
      status: "open",
      rating: { count: 2, mean: 4 },
      fact_sources: { power: "feedback" },
      updated: "2026-10-30T12:00:00Z",
    };
    // The text Python 3 writes for the same record.
    expect(dumpPlace(place)).toBe(
      [
        "{",
        '  "fact_sources": {',
        '    "power": "feedback"',
        "  },",
        '  "facts": {',
        '    "power": true',
        "  },",
        '  "id": "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",',
        '  "kind": "camp_site",',
        '  "location": {',
        '    "lat": -36.0,',
        '    "lon": 144.55',
        "  },",
        `  "name": "Lac de l'Été",`,
        '  "osm": {',
        '    "id": 123456,',
        '    "type": "node",',
        '    "version": 7',
        "  },",
        '  "rating": {',
        '    "count": 2,',
        '    "mean": 4.0',
        "  },",
        '  "status": "open",',
        '  "updated": "2026-10-30T12:00:00Z"',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("writes empty objects and nulls the way Python does", () => {
    const text = dumpPlace({
      id: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
      name: null,
      kind: "rest_area",
      location: { lat: -30.5, lon: 150.25 },
      osm: null,
      facts: {},
      status: "open",
      rating: null,
      fact_sources: {},
      updated: "2026-10-30T12:00:00Z",
    });
    expect(text).toContain('  "facts": {},\n');
    expect(text).toContain('  "osm": null,\n');
  });
});

describe("dumpReviewLine", () => {
  it("sorts keys with no spaces", () => {
    expect(
      dumpReviewLine({
        id: "rev_1",
        place: "ocdb_1",
        stars: 4,
        text: 'Quiet "spot"',
        visited: "2026-10",
        created: "2026-10-30T00:00:00Z",
        app: "camporacle",
      }),
    ).toBe(
      '{"app":"camporacle","created":"2026-10-30T00:00:00Z","id":"rev_1","place":"ocdb_1","stars":4,"text":"Quiet \\"spot\\"","visited":"2026-10"}',
    );
  });
});

describe("placePath", () => {
  it("follows SPEC: places/<last 2 characters of id, lower case>/<id>.json", () => {
    expect(placePath("ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA")).toBe("places/za/ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA.json");
  });
});
