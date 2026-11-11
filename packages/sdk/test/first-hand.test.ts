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

  it("refuses first_hand on other report kinds", () => {
    expect(report({ kind: "name", value: "Lake Camp", first_hand: "seen_nearby" })).toEqual({
      ok: false,
      errors: ["report.first_hand is only allowed when report.kind is fact or doubt"],
    });
    expect(report({ kind: "contact", fact: "website", reason: "spam", first_hand: "says_so" })).toEqual({
      ok: false,
      errors: ["report.first_hand is only allowed when report.kind is fact or doubt"],
    });
  });
});
