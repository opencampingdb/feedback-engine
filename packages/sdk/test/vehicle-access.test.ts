import { describe, expect, it } from "vitest";
import { VEHICLE_ACCESS_VALUES, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };
const report = (report: Record<string, unknown>) => validateSubmission({ ...base, type: "report", place: PLACE, report });

describe("vehicle_access", () => {
  it("says who may use a place, starting with heavy vehicles only", () => {
    expect(VEHICLE_ACCESS_VALUES).toEqual(["heavy_vehicles_only"]);
    expect(report({ kind: "fact", fact: "vehicle_access", value: "heavy_vehicles_only" })).toMatchObject({
      ok: true,
      value: { report: { kind: "fact", fact: "vehicle_access", value: "heavy_vehicles_only" } },
    });
  });

  it("refuses any other value", () => {
    for (const value of ["cars_only", "hgv", true, ""]) {
      expect(report({ kind: "fact", fact: "vehicle_access", value })).toEqual({ ok: false, errors: ["report.value is not a valid value for vehicle_access"] });
    }
  });

  it("can be doubted, which is how a traveller clears it", () => {
    expect(report({ kind: "doubt", fact: "vehicle_access" }).ok).toBe(true);
  });
});
