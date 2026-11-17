import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { buildingFootprints, carriageways, landMask, type PlaceGeometry } from "../src/plausible.js";
import { applyRules, type RulesInput } from "../src/rules.js";

// The fixture: a lake with an island at 151.00 to 151.02 E, the sea east of
// 151.10 E (in two pieces, cut at 151.20 E as the data repository cuts it into
// tiles), a building at 151.05 E and a trunk road running north to south
// along 151.06 E.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/place-geometry/${name}`, import.meta.url), "utf8").split("\n");
const geometry: PlaceGeometry = {
  water: landMask(fixture("water.ndjson")),
  buildings: buildingFootprints(fixture("buildings.ndjson")),
  roads: carriageways(fixture("roads.ndjson")),
};

const NOW = "2026-07-02T00:00:00Z";
let seq = 0;
const ctr = (name: string) => `ctr_${Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16)}`;

function added(location: { lat: number; lon: number }, placeKind = "free_camp", intake?: unknown): StoredFeedback {
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
    attested: "app_attest",
    type: "report",
    location,
    report: { kind: "new_place", place_kind: placeKind },
    ...(intake !== undefined ? { intake } : {}),
  } as StoredFeedback;
}
const idOf = (item: StoredFeedback) => `ocdb_${item.id.slice(3)}`;

function run(item: StoredFeedback, extra: Partial<RulesInput> = { placeGeometry: geometry }) {
  const out = applyRules({
    now: NOW,
    pending: [item],
    history: [],
    places: new Map(),
    everyPlace: [],
    reviews: () => [],
    kinds: new Map([
      ["free_camp", "overnight"],
      ["caravan_park", "overnight"],
      ["swimming_spot", "attraction"],
      ["campground", "overnight"],
    ]),
    ...extra,
  });
  const decision = out.decisions.find((d) => d.id === item.id)!;
  const cases = out.held.filter((c) => c.case === "implausible_location");
  return { out, decision, cases };
}

describe("plausible locations for new places", () => {
  it("holds a new place in the sea for the AI reviewer, drafted as held", () => {
    const item = added({ lat: -33.05, lon: 151.15 });
    const { out, decision, cases } = run(item);
    expect(decision.outcome).toBe("needs_review");
    expect(decision.reason).toBe("implausible location: in the sea, so the AI reviewer checks it");
    expect(out.places.has(idOf(item))).toBe(false);
    expect(out.edits).toEqual([expect.objectContaining({ kind: "new_place", record: expect.objectContaining({ id: idOf(item), standing: "held" }) })]);
    expect(cases).toEqual([
      expect.objectContaining({ case: "implausible_location", place: idOf(item), standing: "held", hit: "water", problem: "in the sea", feedback: [item.id] }),
    ]);
  });

  it("holds a new place in a lake, naming the lake", () => {
    const { decision, cases } = run(added({ lat: -33.045, lon: 151.005 }));
    expect(decision.reason).toBe("implausible location: in Example Lake, so the AI reviewer checks it");
    expect(cases[0]).toMatchObject({ hit: "water", problem: "in Example Lake" });
  });

  it("holds a new place on a major road's carriageway", () => {
    const { decision, cases } = run(added({ lat: -33.05, lon: 151.06003 }));
    expect(decision.outcome).toBe("needs_review");
    expect(cases[0]).toMatchObject({ hit: "road", problem: "on the carriageway of Example Highway (trunk)" });
  });

  it("holds a new camp inside a building footprint", () => {
    const { decision, cases } = run(added({ lat: -33.01985, lon: 151.05015 }));
    expect(decision.outcome).toBe("needs_review");
    expect(cases[0]).toMatchObject({ hit: "building", problem: "inside a building (way/42)" });
  });

  it("holds a new place well out in the sea next to where the sea is cut into tiles", () => {
    expect(run(added({ lat: -33.05, lon: 151.2001 })).cases[0]).toMatchObject({ hit: "water", problem: "in the sea" });
  });

  it("publishes a remote place on land: remoteness is never a reason", () => {
    const item = added({ lat: -25.3, lon: 131.0 });
    const { out, decision, cases } = run(item);
    expect(decision.outcome).toBe("applied");
    expect(out.places.get(idOf(item))?.standing).toBe("shown");
    expect(cases).toEqual([]);
  });

  it("publishes places near water, beside the road, on an island and next to a building", () => {
    // 10 m inside the shore, as a beach camp may be pinned; 35 m from the road's centre line;
    // on the island in the lake; 10 m from the building.
    for (const location of [
      { lat: -33.05, lon: 151.1001 },
      { lat: -33.05, lon: 151.0604 },
      { lat: -33.04, lon: 151.01 },
      { lat: -33.01985, lon: 151.0504 },
    ]) {
      expect(run(added(location)).decision.outcome, JSON.stringify(location)).toBe("applied");
    }
  });

  it("does not hold a place that belongs in the water or in a building for being there", () => {
    expect(run(added({ lat: -33.045, lon: 151.005 }, "swimming_spot")).decision.outcome).toBe("applied");
    expect(run(added({ lat: -33.01985, lon: 151.05015 }, "caravan_park")).decision.outcome).toBe("applied");
  });

  it("passes every new place when the run has no geometry", () => {
    const item = added({ lat: -33.05, lon: 151.15 });
    expect(run(item, {}).decision.outcome).toBe("applied");
    expect(run(added({ lat: -33.05, lon: 151.15 }), { placeGeometry: {} }).decision.outcome).toBe("applied");
  });

  it("holds a new place the intake found implausible, though this run has no geometry", () => {
    const item = added({ lat: -33.05, lon: 151.15 }, "free_camp", { state: "held", held_reason: "implausible_location" });
    const { decision, cases } = run(item, {});
    expect(decision.outcome).toBe("needs_review");
    expect(cases[0]).toMatchObject({ hit: "intake", problem: "the intake found the location implausible" });
  });
});
