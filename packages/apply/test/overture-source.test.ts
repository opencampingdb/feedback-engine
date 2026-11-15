import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { placeProblems } from "../src/data-check.js";
import { decideClear, decideContactReport, decideDoubt, decideFact, protectedSource, type PlaceState, type ReportItem } from "../src/decide.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-15T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

let seq = 0;
function report(day: number, origin: string, body: Record<string, unknown>, attested = false): ReportItem {
  seq += 1;
  return {
    id: `fb_01JH${String(seq).padStart(22, "0")}`,
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

// A gap fill from Overture Maps: the website and phone, dated the day of the Overture run.
const filled: PlaceState = {
  facts: { website: "https://park.example.org", phone: "+61 3 5555 0100", toilets: true },
  fact_sources: { website: "overture", phone: "overture", toilets: "osm" },
  fact_dates: { website: at(-10), phone: at(-10) },
};

// The same place with toilets from Overture too, for the reports a contact cannot take: doubts and fact reports.
const allOverture = { ...filled, fact_sources: { ...filled.fact_sources, toilets: "overture" }, fact_dates: { ...filled.fact_dates, toilets: at(-10) } } as PlaceState;

describe("a value Overture Maps filled in", () => {
  it("has none of the protection an OSM or owner value has", () => {
    expect(protectedSource(filled, "website")).toBeUndefined();
    expect(protectedSource(filled, "toilets")).toBe("OSM");
  });

  it("is taken down by doubts from two sources, one attested", () => {
    const first = report(-2, "net-a", { kind: "doubt", fact: "toilets" });
    const second = report(0, "net-b", { kind: "doubt", fact: "toilets" }, true);
    expect(decideDoubt({ item: second, place: allOverture, earlier: [first] as StoredFeedback[] })).toMatchObject({
      verdict: "live",
      changes: [{ place: PLACE, fact: "toilets", value: null }],
    });
  });

  it("is taken down by contact reports from two sources, one attested", () => {
    const first = report(-1, "net-a", { kind: "contact", fact: "phone", reason: "wrong" }, true);
    const second = report(0, "net-b", { kind: "contact", fact: "phone", reason: "wrong" });
    expect(decideContactReport({ item: second, place: filled, earlier: [first] as StoredFeedback[] })).toMatchObject({
      verdict: "live",
      changes: [{ place: PLACE, fact: "phone", value: null }],
      why: "phone taken down after reports from two sources",
    });
  });

  it("is replaced by a traveller's attested report", () => {
    const item = report(0, "net-a", { kind: "fact", fact: "toilets", value: false }, true);
    expect(decideFact({ item, place: allOverture, earlier: [] })).toEqual({
      verdict: "live",
      changes: [{ place: PLACE, fact: "toilets", value: false }],
      why: "toilets set to false",
    });
  });

  it("is not a traveller's own value, so a clear goes to a person", () => {
    const item = report(0, "net-a", { kind: "clear", fact: "website" }, true);
    expect(decideClear({ item: item as Parameters<typeof decideClear>[0]["item"], place: filled, setter: undefined })).toEqual({
      verdict: "held",
      reason: "not_own_value",
      why: "website was not set by this traveller, so a person decides",
    });
  });
});

describe("the data check on an overture value", () => {
  const NOW = "2026-11-15T00:00:00Z";
  function place(overrides: Partial<Place> = {}): Place {
    return {
      id: PLACE,
      name: "Dummy Flat",
      kind: "caravan_park",
      group: "overnight",
      location: { lat: -36.85, lon: 144.55 },
      osm: { type: "node", id: 123456, version: 7 },
      facts: { website: "https://park.example.org" },
      status: "open",
      rating: null,
      fact_sources: { website: "overture" },
      fact_dates: { website: "2026-11-01T00:00:00Z" },
      updated: "2026-11-01T00:00:00Z",
      ...overrides,
    };
  }

  it("accepts overture as a source, with a fact date", () => {
    expect(placeProblems(place(), { now: NOW })).toEqual([]);
  });

  it("needs a fact date, as other values not from OSM do", () => {
    const { fact_dates: _dates, ...undated } = place();
    expect(placeProblems(undated as Place, { now: NOW })).toEqual([
      "fact_dates must have an entry for every fact_sources entry that is not osm and no other, differ on [website]",
    ]);
  });
});
