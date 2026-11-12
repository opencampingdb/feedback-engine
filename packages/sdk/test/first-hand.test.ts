import { describe, expect, it } from "vitest";
import { FIRST_HAND, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = {
  device: "3b241101-e2bb-4255-8caf-4136c566a962",
  app_version: "1.0.0",
  consent: true,
};
const report = (body: Record<string, unknown>) => validateSubmission({ ...base, type: "report", place: PLACE, report: body });

describe("first-hand reports", () => {
  it("lists the two ways a report is first-hand", () => {
    expect(FIRST_HAND).toEqual(["seen_nearby", "says_so"]);
  });

  it("keeps first_hand on a fact report", () => {
    expect(report({ kind: "fact", fact: "toilets", value: true, first_hand: "seen_nearby" })).toEqual({
      ok: true,
      value: { ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "toilets", value: true, first_hand: "seen_nearby" } },
    });
    expect(report({ kind: "fact", fact: "pets", value: "yes", first_hand: "says_so" })).toMatchObject({
      ok: true,
      value: { report: { first_hand: "says_so" } },
    });
  });

  it("keeps first_hand on a doubt", () => {
    expect(report({ kind: "doubt", fact: "toilets", first_hand: "says_so" })).toMatchObject({
      ok: true,
      value: { report: { kind: "doubt", fact: "toilets", first_hand: "says_so" } },
    });
  });

  it("leaves first_hand out when the report has none", () => {
    const r = report({ kind: "fact", fact: "toilets", value: true });
    expect(r.ok && r.value.type === "report" && "first_hand" in r.value.report).toBe(false);
  });

  it("refuses any other value, a location among them", () => {
    const errors = ["report.first_hand must be seen_nearby or says_so, or left out"];
    for (const first_hand of [true, "nearby", "", null, { lat: -33.8, lon: 151.2 }]) {
      expect(report({ kind: "fact", fact: "toilets", value: true, first_hand })).toEqual({ ok: false, errors });
    }
  });

  it("keeps first_hand on every report of what a person on site sees", () => {
    const bodies: Record<string, unknown>[] = [
      { kind: "fact", fact: "toilets", value: true },
      { kind: "doubt", fact: "toilets" },
      { kind: "name", value: "Lake Camp" },
      { kind: "closed" },
      { kind: "reopened" },
      { kind: "kind", place_kind: "free_camp" },
    ];
    for (const body of bodies) {
      expect(report({ ...body, first_hand: "seen_nearby" })).toMatchObject({ ok: true, value: { report: { ...body, first_hand: "seen_nearby" } } });
    }
    const moved = validateSubmission({
      ...base,
      type: "report",
      place: PLACE,
      location: { lat: -33.8, lon: 151.2 },
      report: { kind: "wrong_location", first_hand: "says_so" },
    });
    expect(moved).toMatchObject({ ok: true, value: { report: { kind: "wrong_location", first_hand: "says_so" } } });
  });

  it("refuses first_hand on other report kinds", () => {
    const errors = ["report.first_hand is only allowed when report.kind is fact, doubt, name, closed, reopened, kind or wrong_location"];
    expect(report({ kind: "contact", fact: "website", reason: "spam", first_hand: "says_so" })).toEqual({ ok: false, errors });
    expect(report({ kind: "other", note: "Gate locked", first_hand: "seen_nearby" })).toEqual({ ok: false, errors });
    expect(report({ kind: "commons_mismatch", file: "Pool.jpg", first_hand: "seen_nearby" })).toEqual({ ok: false, errors });
    expect(report({ kind: "description", value: "A quiet camp", first_hand: "seen_nearby" })).toEqual({ ok: false, errors });
  });
});
