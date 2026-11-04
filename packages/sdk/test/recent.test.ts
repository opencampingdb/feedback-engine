import { describe, expect, expectTypeOf, it } from "vitest";
import { dataVersionTime, withRecentChanges, type RecentChange, type RecentPlace } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const RELEASE = "20261103T090000Z-abc1234";

const released = {
  id: PLACE,
  name: "River Bend",
  facts: { toilets: false, phone: "+61 3 5555 0100", water: true },
  fact_sources: { toilets: "osm", phone: "feedback", water: "osm" },
  fact_dates: { phone: "2026-10-01T00:00:00Z" },
  updated: "2026-10-30T16:00:00Z",
};

const change = (fact: string, value: RecentChange["value"], accepted: string, in_data_at: string | null = null, place = PLACE): RecentChange => ({
  place,
  fact,
  value,
  accepted,
  in_data_at,
});

describe("dataVersionTime", () => {
  it("reads the commit time at the front of a data_version", () => {
    expect(dataVersionTime("20261030T160000Z-abc1234")).toBe(Date.parse("2026-10-30T16:00:00Z"));
    expect(dataVersionTime("20261030T160000Z")).toBe(Date.parse("2026-10-30T16:00:00Z"));
  });

  it("refuses anything else", () => {
    for (const bad of ["", "data-20261030T160000Z", "2026-10-30T16:00:00Z", "20261030T160000-abc1234", "20261330T160000Z-abc1234", "20261030T250000Z-abc1234", "20261031T160000Zabc"]) {
      expect(dataVersionTime(bad), bad).toBeUndefined();
    }
  });
});

describe("withRecentChanges", () => {
  it("sets a fact, with feedback as its source and the time it was accepted", () => {
    const out = withRecentChanges(released, [change("toilets", true, "2026-11-03T10:00:00Z")], RELEASE);
    expect(out.facts).toEqual({ toilets: true, phone: "+61 3 5555 0100", water: true });
    expect(out.fact_sources).toEqual({ toilets: "feedback", phone: "feedback", water: "osm" });
    expect(out.fact_dates).toEqual({ phone: "2026-10-01T00:00:00Z", toilets: "2026-11-03T10:00:00Z" });
    expect(out.name).toBe("River Bend");
    expect(out.updated).toBe(released.updated);
  });

  it("takes a fact down when the value is null", () => {
    const out = withRecentChanges(released, [change("phone", null, "2026-11-03T10:00:00Z")], RELEASE);
    expect(out.facts).toEqual({ toilets: false, water: true });
    expect(out.fact_sources).toEqual({ toilets: "osm", water: "osm" });
    expect(out.fact_dates).toEqual({});
  });

  it("adds an address as a whole value", () => {
    const address = { street: "River Road", suburb: "Bright", state: "VIC", postcode: "3741" } as const;
    expect(withRecentChanges(released, [change("address", address, "2026-11-03T10:00:00Z")], RELEASE).facts).toMatchObject({ address });
  });

  it("leaves the release record as it was", () => {
    const before = structuredClone(released);
    withRecentChanges(released, [change("toilets", true, "2026-11-03T10:00:00Z"), change("phone", null, "2026-11-03T10:00:00Z")], RELEASE);
    expect(released).toEqual(before);
  });

  it("returns the record itself when no change applies", () => {
    expect(withRecentChanges(released, [], RELEASE)).toBe(released);
    expect(withRecentChanges(released, [change("toilets", true, "2026-11-03T10:00:00Z", null, OTHER)], RELEASE)).toBe(released);
  });

  it("ignores changes to other places", () => {
    const out = withRecentChanges(released, [change("toilets", true, "2026-11-03T10:00:00Z", null, OTHER), change("water", false, "2026-11-03T10:00:00Z")], RELEASE);
    expect(out.facts).toEqual({ toilets: false, phone: "+61 3 5555 0100", water: false });
  });

  it("skips a change that reached the data before the release, and keeps one that reached it after or not yet", () => {
    const changes = [
      change("toilets", true, "2026-11-03T07:00:00Z", "2026-11-03T08:59:59Z"),
      change("water", false, "2026-11-03T08:00:00Z", "2026-11-03T09:30:00Z"),
      change("phone", null, "2026-11-03T08:30:00Z", null),
    ];
    const out = withRecentChanges(released, changes, RELEASE);
    expect(out.facts).toEqual({ toilets: false, water: false });
  });

  it("keeps a change that reached the data at the release's own time, since equal is not earlier", () => {
    const out = withRecentChanges(released, [change("toilets", true, "2026-11-03T08:00:00Z", "2026-11-03T09:00:00Z")], RELEASE);
    expect(out.facts).toMatchObject({ toilets: true });
  });

  it("compares times, so in_data_at with milliseconds or an offset still reads right", () => {
    expect(withRecentChanges(released, [change("toilets", true, "2026-11-03T08:00:00Z", "2026-11-03T08:59:59.500Z")], RELEASE)).toBe(released);
    expect(withRecentChanges(released, [change("toilets", true, "2026-11-03T08:00:00Z", "2026-11-03T20:30:00+11:00")], RELEASE).facts).toMatchObject({ toilets: true });
  });

  it("lays every change over when the data version cannot be read", () => {
    const out = withRecentChanges(released, [change("toilets", true, "2026-11-01T08:00:00Z", "2026-11-01T09:00:00Z")], "opaque");
    expect(out.facts).toMatchObject({ toilets: true });
  });

  it("applies changes to one fact in the order they were accepted, whatever order they come in", () => {
    const changes = [change("phone", "+61 3 5555 0300", "2026-11-03T11:00:00Z"), change("phone", null, "2026-11-03T10:00:00Z")];
    const out = withRecentChanges(released, changes, RELEASE);
    expect(out.facts).toMatchObject({ phone: "+61 3 5555 0300" });
    expect(out.fact_dates).toMatchObject({ phone: "2026-11-03T11:00:00Z" });
  });

  it("works on a record with no fact_dates", () => {
    const plain = { id: PLACE, facts: { toilets: false }, fact_sources: { toilets: "osm" } };
    expect(withRecentChanges(plain, [change("toilets", true, "2026-11-03T10:00:00Z")], RELEASE)).toEqual({
      id: PLACE,
      facts: { toilets: true },
      fact_sources: { toilets: "feedback" },
      fact_dates: { toilets: "2026-11-03T10:00:00Z" },
    });
  });
});

describe("RecentPlace", () => {
  it("carries in_data_at only once the data has the place, so older intakes' places still type", () => {
    expectTypeOf<RecentPlace["in_data_at"]>().toEqualTypeOf<string | undefined>();
    const waiting: RecentPlace = { id: PLACE, location: { lat: -36.1, lon: 146.9 }, kind: null, name: null, standing: "shown", added: "2026-11-03T09:00:00Z", contributor: "ctr_5d1c0e2a9b7f4436" };
    const inData: RecentPlace = { ...waiting, standing: "hidden", in_data_at: "2026-11-03T10:00:00Z" };
    expect(inData.in_data_at).toBe("2026-11-03T10:00:00Z");
    expect("in_data_at" in waiting).toBe(false);
  });
});
