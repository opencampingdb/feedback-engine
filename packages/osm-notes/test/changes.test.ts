import { describe, expect, it } from "vitest";
import { noteChanges } from "../src/changes.js";
import type { Place } from "../src/types.js";

const before: Place = {
  id: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
  name: "Lake Eppalock Camp",
  kind: "free_camp",
  location: { lat: -36.85, lon: 144.55 },
  osm: { type: "node", id: 123456, version: 7 },
  facts: { fee: true, toilets: false },
  status: "open",
  fact_sources: { fee: "osm", toilets: "osm" },
};

const after = (patch: Partial<Place>): Place => ({ ...structuredClone(before), ...patch });

describe("noteChanges", () => {
  it("takes facts that changed and now come from feedback or the owner", () => {
    const next = after({
      facts: { fee: false, toilets: true },
      fact_sources: { fee: "feedback", toilets: "owner" },
    });
    expect(noteChanges(before, next)).toEqual([
      { field: "fee", value: false, previous: true, source: "feedback" },
      { field: "toilets", value: true, previous: false, source: "owner" },
    ]);
  });

  it("never echoes a change that came from OSM", () => {
    const next = after({ facts: { fee: false, toilets: false }, fact_sources: { fee: "osm", toilets: "osm" } });
    expect(noteChanges(before, next)).toEqual([]);
  });

  it("never sends contributed values", () => {
    const next = after({ facts: { fee: false, toilets: false }, fact_sources: { fee: "contributed", toilets: "osm" } });
    expect(noteChanges(before, next)).toEqual([]);
  });

  it("skips a value that did not change, even when its source did", () => {
    const next = after({ fact_sources: { fee: "feedback", toilets: "osm" } });
    expect(noteChanges(before, next)).toEqual([]);
  });

  it("sends nothing for a place that is not in OSM", () => {
    const local = { ...before, osm: null };
    const next = { ...local, facts: { fee: false }, fact_sources: { fee: "feedback" as const } };
    expect(noteChanges(local, next)).toEqual([]);
  });

  it("sends nothing for a merged tombstone or a new record", () => {
    const next = after({ status: "merged", merged_into: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB", facts: { fee: false }, fact_sources: { fee: "feedback" } });
    expect(noteChanges(before, next)).toEqual([]);
    expect(noteChanges(null, after({ facts: { fee: false }, fact_sources: { fee: "feedback" } }))).toEqual([]);
  });

  it("leaves out booking details, description, location, temporary closures and access unknown", () => {
    const next = after({
      facts: { fee: true, toilets: false, booking_url: "https://example.org", booking_required: true, access: "unknown" },
      fact_sources: { fee: "osm", toilets: "osm", booking_url: "owner", booking_required: "owner", access: "feedback", description: "owner", location: "feedback", status: "owner" },
      location: { lat: -36.9, lon: 144.6 },
      status: "temporarily_closed",
    });
    expect(noteChanges(before, next)).toEqual([]);
  });

  it("takes a permanent closure and a new name from feedback", () => {
    const next = after({
      name: "Eppalock Foreshore Camp",
      status: "closed",
      fact_sources: { fee: "osm", toilets: "osm", name: "feedback", status: "feedback" },
    });
    expect(noteChanges(before, next)).toEqual([
      { field: "name", value: "Eppalock Foreshore Camp", previous: "Lake Eppalock Camp", source: "feedback" },
      { field: "status", value: "closed", previous: "open", source: "feedback" },
    ]);
  });

  it("skips a contributed closure", () => {
    const next = after({ status: "closed", fact_sources: { fee: "osm", toilets: "osm", status: "contributed" } });
    expect(noteChanges(before, next)).toEqual([]);
  });

  it("never sends a text value that holds contact details, but still sends website and phone", () => {
    const next = after({
      name: "Call 0412 345 678 Camp",
      facts: { fee: true, toilets: false, opening_hours: "Ring 0412 345 678", website: "https://camp.example.org", phone: "+61 3 5432 1098" },
      fact_sources: { fee: "osm", toilets: "osm", name: "owner", opening_hours: "feedback", website: "owner", phone: "owner" },
    });
    expect(noteChanges(before, next)).toEqual([
      { field: "phone", value: "+61 3 5432 1098", previous: null, source: "owner" },
      { field: "website", value: "https://camp.example.org", previous: null, source: "owner" },
    ]);
  });

  it("sends opening hours written as HHMM ranges", () => {
    const next = after({
      facts: { fee: true, toilets: false, opening_hours: "Mo-Fr 0800-1700" },
      fact_sources: { fee: "osm", toilets: "osm", opening_hours: "feedback" },
    });
    expect(noteChanges(before, next)).toEqual([{ field: "opening_hours", value: "Mo-Fr 0800-1700", previous: null, source: "feedback" }]);
  });

  it("sends plain opening hours", () => {
    const next = after({
      facts: { fee: true, toilets: false, opening_hours: "Mo-Su 07:00-19:00" },
      fact_sources: { fee: "osm", toilets: "osm", opening_hours: "feedback" },
    });
    expect(noteChanges(before, next)).toEqual([{ field: "opening_hours", value: "Mo-Su 07:00-19:00", previous: null, source: "feedback" }]);
  });
});
