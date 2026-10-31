import { describe, expect, it } from "vitest";
import { dayRange, noteText } from "../src/text.js";
import type { Note } from "../src/types.js";

const note: Note = {
  place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA",
  name: "Lake Eppalock Camp",
  osm: { type: "node", id: 123456 },
  lat: -36.85,
  lon: 144.55,
  path: "places/za/ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA.json",
  changes: [
    { field: "fee", value: false, previous: true, source: "feedback", reports: 3, from: "2026-10-02", to: "2026-10-20" },
    { field: "toilets", value: true, previous: false, source: "owner" },
    { field: "status", value: "closed", previous: "open", source: "feedback", reports: 2, from: "2026-09-28", to: "2026-10-03" },
  ],
};

describe("dayRange", () => {
  it("writes days the Australian way", () => {
    expect(dayRange("2026-10-20", "2026-10-20")).toBe("20 October 2026");
    expect(dayRange("2026-10-02", "2026-10-20")).toBe("2 to 20 October 2026");
    expect(dayRange("2026-09-28", "2026-10-03")).toBe("28 September to 3 October 2026");
    expect(dayRange("2025-12-30", "2026-01-02")).toBe("30 December 2025 to 2 January 2026");
  });
});

describe("noteText", () => {
  it("says where the change comes from, what is reported and asks for a check", () => {
    expect(noteText(note)).toBe(
      [
        "Open Camping DB, an open list of places to camp and stop in Australia, has accepted a change to node/123456 (Lake Eppalock Camp):",
        "",
        "- Travellers report there is no fee to stay (fee=no). 3 independent reports, 2 to 20 October 2026.",
        "- The owner reports there are toilets (toilets=yes).",
        "- Travellers report the place has closed permanently (OSM has no single tag for this, a lifecycle prefix such as disused: is common). 2 independent reports, 28 September to 3 October 2026.",
        "",
        "Open Camping DB record: https://github.com/opencampingdb/data/blob/main/places/za/ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA.json",
        "",
        "Please check before editing. Open Camping DB does not edit OpenStreetMap itself.",
      ].join("\n"),
    );
  });

  it("uses no em or en dashes", () => {
    expect(noteText(note)).not.toMatch(/[–—]/);
  });

  it("leaves out the count when the inbox does not show the reports", () => {
    const text = noteText({ ...note, name: null, changes: [{ field: "pets", value: "no", source: "feedback" }] });
    expect(text).toContain("change to node/123456:");
    expect(text).toContain("- Travellers report dogs are not allowed (dog=no).\n");
  });
});
