import { describe, expect, it } from "vitest";
import { RETIRED_FACTS, isFactName, isValidFactValue, validateSubmission, type PlaceFacts } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const TOKEN = "q2Vb7Rk1cW9yZ3hVdm5Pb2pQTlR4Y0FyZ0lCd2pUcEs";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0" };
const RETIRED = "seasonal_closure is retired: send the months in opening_hours with withOpenMonths";

const report = (body: Record<string, unknown>) => validateSubmission({ ...base, consent: true, type: "report", place: PLACE, report: body });
const ownerUpdate = (facts: Record<string, unknown>) =>
  validateSubmission({ ...base, terms_accepted: true, type: "owner_update", place: PLACE, token: TOKEN, update: { facts } });

describe("seasonal_closure, retired for open months in opening_hours", () => {
  it("lists it as retired", () => {
    expect(RETIRED_FACTS).toEqual(["seasonal_closure"]);
  });

  it("refuses a fact report of it", () => {
    for (const value of [true, false]) {
      expect(report({ kind: "fact", fact: "seasonal_closure", value })).toEqual({ ok: false, errors: [`report.fact ${RETIRED}`] });
    }
  });

  it("refuses a doubt about it", () => {
    expect(report({ kind: "doubt", fact: "seasonal_closure" })).toEqual({ ok: false, errors: [`report.fact ${RETIRED}`] });
  });

  it("refuses an owner update that sets it, and takes the other facts as before", () => {
    expect(ownerUpdate({ seasonal_closure: true })).toEqual({ ok: false, errors: [`update.facts.${RETIRED}`] });
    expect(ownerUpdate({ opening_hours: "Apr-Oct" }).ok).toBe(true);
  });

  it("still reads a released value of it", () => {
    const facts: PlaceFacts = { seasonal_closure: true, opening_hours: "Apr-Oct" };
    expect(isFactName("seasonal_closure")).toBe(true);
    expect(isValidFactValue("seasonal_closure", facts.seasonal_closure)).toBe(true);
  });
});
