import { describe, expect, it } from "vitest";
import { reviewPrBody } from "../src/prbody.js";
import { allowedDecisions, applyDecision, parseHeldCases, settleByRules, vehicleAccessCases, type HeldCase } from "../src/review.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
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
  it("lists each candidate place once, with the value its name suggests", () => {
    const places = new Map([[PLACE, restArea()], [OTHER, restArea({ id: OTHER })]]);
    expect(vehicleAccessCases([PLACE, OTHER], places, new Set([OTHER]))).toEqual([candidate]);
  });

  it("skips a candidate that is missing, merged, closed or already has the fact", () => {
    const cases = (record: Place | undefined) => vehicleAccessCases([PLACE], new Map(record ? [[PLACE, record]] : []), new Set());
    expect(cases(undefined)).toEqual([]);
    expect(cases(restArea({ status: "merged", merged_into: OTHER }))).toEqual([]);
    expect(cases(restArea({ status: "closed" }))).toEqual([]);
    expect(cases(restArea({ facts: { vehicle_access: "heavy_vehicles_only" } }))).toEqual([]);
  });

  it("reads back from the review PR body with no feedback ids", () => {
    const body = reviewPrBody(AT, [], new Map(), [], [candidate]);
    expect(parseHeldCases(body)).toEqual([candidate]);
    expect(parseHeldCases(`- held-case ${JSON.stringify({ ...candidate, fact: "toilets" })}`)).toEqual([]);
  });

  it("lets a reviewer confirm the fact, or leave it to a person", () => {
    expect(allowedDecisions(candidate)).toEqual(["confirm", "leave"]);
    expect(settleByRules(candidate, restArea())).toBeNull();
  });

  it("leaves a place that has the fact, has a verified owner, or is gone", () => {
    expect(settleByRules(candidate, restArea({ facts: { vehicle_access: "heavy_vehicles_only" } }))).toEqual({ decision: "leave", reason: "the place has vehicle_access already" });
    expect(settleByRules(candidate, restArea({ owner_verified: true }))).toEqual({ decision: "leave", reason: "the place has a verified owner" });
    expect(settleByRules(candidate, restArea({ status: "closed" }))).toEqual({ decision: "leave", reason: "the place is not open" });
    expect(settleByRules(candidate, undefined)).toMatchObject({ decision: "leave" });
  });

  it("sets the fact from feedback on confirm, and nothing on leave", () => {
    const next = applyDecision(restArea(), candidate, "confirm", AT)!;
    expect(next.facts).toEqual({ toilets: true, vehicle_access: "heavy_vehicles_only" });
    expect(next.fact_sources.vehicle_access).toBe("feedback");
    expect(next.fact_dates).toEqual({ vehicle_access: AT });
    expect(next.updated).toBe(AT);
    expect(applyDecision(restArea(), candidate, "leave", AT)).toBeNull();
  });
});

describe("vehicle_access_candidate cases in a run", async () => {
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { run } = await import("../src/run.js");
  const { dumpPlace } = await import("../src/serialise.js");
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };

  it("reads the place column of a candidates file with a quoted location", async () => {
    const { DataRepo } = await import("../src/io.js");
    const root = await mkdtemp(join(tmpdir(), "ocdb-vehicle-"));
    try {
      await put(join(root, "moderation", "heavy-vehicle-candidates.csv"), `place,name,location\r\n${PLACE},Heavy Vehicle Rest Area,"-31.5,147.2"\r\n${OTHER},"Truck Bay, ""north""","-31.6,147.3"\r\n`);
      expect(await new DataRepo(root).heavyVehicleCandidates()).toEqual([PLACE, OTHER]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lists each candidate in the data's candidates file on the review PR once, and remembers it in the inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocdb-vehicle-"));
    try {
      const inbox = join(root, "inbox");
      const data = join(root, "data");
      await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace(restArea()));
      await put(join(data, "places", "zb", `${OTHER}.json`), dumpPlace(restArea({ id: OTHER, facts: { vehicle_access: "heavy_vehicles_only" } })));
      await put(join(data, "moderation", "heavy-vehicle-candidates.csv"), `place,name,matched\n${PLACE},"Heavy Vehicle Rest Area, north",heavy vehicle\n${OTHER},Truck Bay,truck\n`);

      const first = await run({ inbox, data, now: new Date(AT) });
      expect(first.review_changed).toBe(true);
      expect(parseHeldCases(first.review_pr_body)).toEqual([candidate]);
      expect(first.inbox_changed).toBe(true);
      expect(JSON.parse(await readFile(join(inbox, "listed", "vehicle_access_candidate.json"), "utf8"))).toEqual({ places: [PLACE] });

      const second = await run({ inbox, data, now: new Date(AT) });
      expect(second.review_changed).toBe(false);
      expect(second.inbox_changed).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
