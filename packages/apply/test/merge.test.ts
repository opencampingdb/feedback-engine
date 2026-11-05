import { describe, expect, it } from "vitest";
import { allowedDecisions, applyDecision, mergeProblem, mergePlaces, pairKey, type HeldCase } from "../src/review.js";
import type { Place } from "../src/types.js";

const NEW = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OLD = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const AT = "2026-11-05T09:00:00Z";

function record(overrides: { [K in keyof Place]?: Place[K] | undefined } = {}): Place {
  return {
    id: OLD,
    name: "Creek Bend Rest Area",
    kind: "rest_area",
    group: "overnight",
    location: { lat: -36.85, lon: 144.55 },
    osm: { type: "node", id: 7, version: 2 },
    facts: { toilets: true },
    status: "open",
    rating: null,
    fact_sources: { name: "osm", toilets: "osm" },
    updated: "2026-10-01T00:00:00Z",
    ...overrides,
  } as Place;
}
const added = (overrides: Partial<Place> = {}) =>
  record({
    id: NEW,
    osm: null,
    facts: { fee: false, toilets: false, phone: "03 5555 0100" },
    fact_sources: { name: "feedback", location: "feedback", fee: "feedback", toilets: "feedback", phone: "feedback" },
    fact_dates: { name: AT, location: AT, fee: AT, toilets: AT, phone: AT },
    standing: "held",
    last_confirmed: "2026-11-04T00:00:00Z",
    updated: AT,
    ...overrides,
  });

describe("merging a new place into the place it duplicates", () => {
  it("moves the facts travellers gave that the kept place lacks, and leaves the new place as a tombstone", () => {
    const { kept, tombstone } = mergePlaces(record(), added(), AT);
    expect(kept.facts).toEqual({ toilets: true, fee: false, phone: "03 5555 0100" });
    expect(kept.fact_sources).toEqual({ name: "osm", toilets: "osm", fee: "feedback", phone: "feedback" });
    expect(kept.fact_dates).toEqual({ fee: AT, phone: AT });
    expect(kept.last_confirmed).toBe("2026-11-04T00:00:00Z");
    expect(kept.updated).toBe(AT);
    expect(tombstone).toEqual({ ...added(), status: "merged", merged_into: OLD });
  });

  it("lets a reviewer merge a duplicate case", () => {
    const c: HeldCase = { case: "duplicate", place: NEW, location: { lat: -36.85, lon: 144.55 }, kind: "rest_area", standing: "held", duplicate_of: OLD, distance_m: 30, feedback: ["fb_01JC0000000000000000000001"] };
    expect(allowedDecisions(c)).toEqual(["approve", "merge", "take_down", "leave"]);
    // A merge writes two records, with mergePlaces: on its own the new place does not change.
    expect(applyDecision(added(), c, "merge", AT)).toBeNull();
  });

  it("never merges into an owner's place, a tombstone, another group, or a pair a person found distinct", () => {
    expect(mergeProblem(added(), record())).toBeNull();
    expect(mergeProblem(added(), record({ owner_verified: true }))).toBe("the place it duplicates has a verified owner");
    expect(mergeProblem(added(), record({ status: "merged", merged_into: NEW }))).toBe("the place it duplicates was merged into another");
    expect(mergeProblem(added(), record({ group: "stopover" }))).toBe("the two places are in different groups");
    expect(mergeProblem(added(), undefined)).toBe("the place it duplicates is not on the review branch");
    expect(mergeProblem(added(), record(), new Set([pairKey(OLD, NEW)]))).toBe("moderation/distinct_places.json lists the two as separate places");
    expect(pairKey(NEW, OLD)).toBe(pairKey(OLD, NEW));
  });
});

describe("merges in a run", async () => {
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { run } = await import("../src/run.js");
  const { dumpPlace } = await import("../src/serialise.js");
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };
  const FB = "fb_01JD0000000000000000000001";
  const TOMBSTONE = "ocdb_01JD0000000000000000000001";

  async function setUp(root: string) {
    const inbox = join(root, "inbox");
    const data = join(root, "data");
    await put(join(data, "places", "yb", `${OLD}.json`), dumpPlace(record({ location: { lat: -36.85, lon: 144.55 } })));
    await put(join(data, "schema", "kinds.json"), JSON.stringify({ kinds: [{ code: "rest_area", label: "Rest area", group: "overnight" }] }));
    await put(
      join(inbox, "pending", "2026-11-05", `${FB}.json`),
      JSON.stringify({
        id: FB,
        received: "2026-11-05T01:00:00Z",
        app: "example-app",
        type: "report",
        place: null,
        location: { lat: -36.85027, lon: 144.55 },
        device: "dev-a",
        contributor: "ctr_00000000000000aa",
        attested: "app_attest",
        app_version: "1.0.0",
        consent: true,
        report: { kind: "new_place", name: "Creek Bend Rest Area", place_kind: "rest_area" },
      }),
    );
    return { inbox, data };
  }

  it("writes the merge as a tombstone into the automatic checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocdb-merge-"));
    try {
      const { inbox, data } = await setUp(root);
      // A sidecar with no major road near the pair.
      const geometry = join(root, "geometry.ndjson");
      await put(geometry, '{"coords":[[145.0,-37.0],[145.1,-37.0]],"highway":"primary","road":5}\n');
      const summary = await run({ inbox, data, now: new Date(AT), geometry });
      expect(summary.counts.applied).toBe(1);
      const tombstone = JSON.parse(await readFile(join(data, "places", "01", `${TOMBSTONE}.json`), "utf8")) as Place;
      expect(tombstone).toMatchObject({ status: "merged", merged_into: OLD });
      expect(summary.auto_pr_body).toContain(`merged into ${OLD}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not merge a pair on the distinct list, across a major road in the geometry sidecar, or without the sidecar", async () => {
    for (const extra of ["distinct", "geometry", "no geometry"] as const) {
      const root = await mkdtemp(join(tmpdir(), "ocdb-merge-"));
      try {
        const { inbox, data } = await setUp(root);
        const geometry = join(root, "geometry.ndjson");
        if (extra === "distinct") {
          const [a, b] = [OLD, TOMBSTONE].sort();
          await put(join(data, "moderation", "distinct_places.json"), JSON.stringify({ pairs: [{ a, b, added: "2026-11-05", reason: "other" }] }));
          await put(geometry, "");
        } else if (extra === "geometry") {
          await put(geometry, '{"coords":[[144.549,-36.85013],[144.551,-36.85013]],"highway":"primary","road":5}\n');
        }
        const summary = await run({ inbox, data, now: new Date(AT), ...(extra === "no geometry" ? {} : { geometry }) });
        expect(summary.counts.needs_review).toBe(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});

describe("what a reviewer may merge", async () => {
  const { reviewerMergeProblem } = await import("../src/review.js");
  const near = { lat: -36.85018, lon: 144.55 }; // about 20 m
  const further = { lat: -36.85036, lon: 144.55 }; // about 40 m
  const crossing = { between: () => ({ highway: "trunk", name: "Example Highway" }) };
  const clear = { between: () => null };

  it("refuses a pair across a major road when the road data is there, and allows the rest", () => {
    expect(reviewerMergeProblem(added({ name: "Other Name", location: further }), record(), new Set(), clear)).toBeNull();
    expect(reviewerMergeProblem(added({ location: near }), record(), new Set(), crossing)).toBe("a major road runs between them (Example Highway)");
  });

  it("without road data, allows only the same name, in the same group, less than 25 m apart", () => {
    expect(reviewerMergeProblem(added({ location: near }), record())).toBeNull();
    expect(reviewerMergeProblem(added({ location: further }), record())).toBe("without road data, only places less than 25 m apart are merged");
    expect(reviewerMergeProblem(added({ location: near, name: "Creek Bend North" }), record())).toBe("without road data, only places with the same name are merged");
    expect(reviewerMergeProblem(added({ location: near }), record({ owner_verified: true }))).toBe("the place it duplicates has a verified owner");
  });
});
