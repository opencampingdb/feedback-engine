import { describe, expect, it } from "vitest";
import { isMonthRange, monthsInRange, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = {
  device: "3b241101-e2bb-4255-8caf-4136c566a962",
  app_version: "1.0.0",
  consent: true,
};
const fact = (value: unknown) => validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "pets_months", value } });

describe("pets_months", () => {
  it("takes an OSM month range, which may wrap the year end", () => {
    expect(fact("May-Sep")).toMatchObject({ ok: true, value: { report: { kind: "fact", fact: "pets_months", value: "May-Sep" } } });
    expect(fact("Dec-Feb").ok).toBe(true);
  });

  it("refuses anything that is not one range of two different months", () => {
    for (const value of ["may-sep", "May - Sep", "May", "May-May", "May-Sept", "Jan-Mar,Oct-Dec", "", 5, true]) {
      expect(fact(value)).toEqual({ ok: false, errors: ["report.value is not a valid value for pets_months"] });
    }
  });

  it("can be doubted, as other facts", () => {
    expect(validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "doubt", fact: "pets_months" } }).ok).toBe(true);
  });

  it("says which months a range covers", () => {
    expect(isMonthRange("Oct-Mar")).toBe(true);
    expect(isMonthRange("Oct")).toBe(false);
    expect(monthsInRange("May-Sep")).toEqual([5, 6, 7, 8, 9]);
    expect(monthsInRange("Dec-Feb")).toEqual([12, 1, 2]);
    expect(monthsInRange("nonsense")).toEqual([]);
  });
});
