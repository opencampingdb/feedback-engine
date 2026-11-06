import { describe, expect, it } from "vitest";
import { reviewPrBody } from "../src/prbody.js";
import { allowedDecisions, applyDecision, parseHeldCases, settleByRules, type HeldCase } from "../src/review.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const AT = "2026-11-05T09:00:00Z";

function restArea(overrides: { [K in keyof Place]?: Place[K] | undefined } = {}): Place {
  return {
    id: PLACE,
    name: "Heavy Vehicle Rest Area",
    kind: "rest_area",
    group: "stopover",
    location: { lat: -31.5, lon: 147.2 },
    osm: { type: "node", id: 42, version: 3 },
    facts: { toilets: true },
    status: "open",
    rating: null,
    fact_sources: { name: "osm", toilets: "osm" },
    updated: "2026-11-01T00:00:00Z",
    ...overrides,
  } as Place;
}

const candidate: HeldCase = {
  case: "vehicle_access_candidate",
  place: PLACE,
  location: { lat: -31.5, lon: 147.2 },
  kind: "rest_area",
  fact: "vehicle_access",
  value: "heavy_vehicles_only",
  feedback: [],
};

describe("vehicle_access_candidate cases", () => {
  it("reads back from a review PR body an older run wrote, with no feedback ids", () => {
    const body = reviewPrBody(AT, [], new Map(), [], [candidate]);
    expect(parseHeldCases(body)).toEqual([candidate]);
    expect(parseHeldCases(`- held-case ${JSON.stringify({ ...candidate, fact: "toilets" })}`)).toEqual([]);
  });

  it("is always left: a name alone never sets a fact", () => {
    expect(allowedDecisions(candidate)).toEqual(["leave"]);
    expect(settleByRules(candidate, restArea())).toEqual({ decision: "leave", reason: "a name alone never sets a fact, so the place is tagged in OpenStreetMap" });
    expect(settleByRules(candidate, undefined)).toMatchObject({ decision: "leave" });
  });

  it("changes nothing on confirm or leave", () => {
    expect(applyDecision(restArea(), candidate, "confirm", AT)).toBeNull();
    expect(applyDecision(restArea(), candidate, "leave", AT)).toBeNull();
  });
});

describe("vehicle_access_candidate cases in a run", async () => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { run } = await import("../src/run.js");
  const { dumpPlace } = await import("../src/serialise.js");
  const { existsSync } = await import("node:fs");
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };

  it("does not list the data's candidates on the review PR", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocdb-vehicle-"));
    try {
      const inbox = join(root, "inbox");
      const data = join(root, "data");
      await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace(restArea()));
      await put(join(data, "moderation", "heavy-vehicle-candidates.csv"), `place,name,matched\n${PLACE},Heavy Vehicle Rest Area,heavy vehicle\n`);
      const result = await run({ inbox, data, now: new Date(AT) });
      expect(result.review_changed).toBe(false);
      expect(parseHeldCases(result.review_pr_body)).toEqual([]);
      expect(existsSync(join(inbox, "listed", "vehicle_access_candidate.json"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
