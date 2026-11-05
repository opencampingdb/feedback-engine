import { describe, expect, it } from "vitest";
import { CONTACT_FACTS, REPORT_KINDS, isDoubtFact, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = {
  device: "3b241101-e2bb-4255-8caf-4136c566a962",
  app_version: "1.0.0",
  consent: true,
};
const doubt = (report: Record<string, unknown>, place: string | null = PLACE) =>
  validateSubmission({ ...base, type: "report", place, report: { kind: "doubt", ...report } });

describe("doubt reports", () => {
  it("lists the doubt kind", () => {
    expect(REPORT_KINDS).toContain("doubt");
  });

  it("accepts a doubt about a fact, with or without a note", () => {
    expect(doubt({ fact: "toilets" })).toEqual({ ok: true, value: { ...base, type: "report", place: PLACE, report: { kind: "doubt", fact: "toilets" } } });
    expect(doubt({ fact: "pets", note: "No dogs sign at the gate" })).toMatchObject({
      ok: true,
      value: { report: { kind: "doubt", fact: "pets", note: "No dogs sign at the gate" } },
    });
    for (const fact of ["fee", "access", "max_stay", "brand", "drinking_water"]) expect(doubt({ fact }).ok).toBe(true);
  });

  it("refuses a contact, the address, booking_url and anything that is not a fact", () => {
    const errors = ["report.fact must be a fact other than a contact or the address (use the contact kind for those)"];
    for (const fact of [...CONTACT_FACTS, "booking_url", "name", "kind", "colour", undefined]) {
      expect(doubt({ fact })).toEqual({ ok: false, errors });
    }
  });

  it("refuses a value or a reason", () => {
    expect(doubt({ fact: "toilets", value: false })).toEqual({ ok: false, errors: ["report.value is not allowed when report.kind is doubt"] });
    expect(doubt({ fact: "toilets", reason: "wrong" })).toEqual({ ok: false, errors: ["report.reason is only allowed when report.kind is remove or contact"] });
  });

  it("needs the place", () => {
    expect(doubt({ fact: "toilets" }, null)).toEqual({ ok: false, errors: ["place is required unless report.kind is new_place"] });
  });

  it("knows which facts a doubt may name", () => {
    expect(isDoubtFact("toilets")).toBe(true);
    expect(isDoubtFact("website")).toBe(false);
    expect(isDoubtFact("address")).toBe(false);
    expect(isDoubtFact("booking_url")).toBe(false);
    expect(isDoubtFact("name")).toBe(false);
  });
});
