import { describe, expect, it } from "vitest";
import { NEW_PLACE_REPORT_REASONS, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = {
  device: "3b241101-e2bb-4255-8caf-4136c566a962",
  app_version: "1.0.0",
  consent: true,
};

describe("reports that a new place should come down", () => {
  it("lists the reasons a new place can be reported for", () => {
    expect(NEW_PLACE_REPORT_REASONS).toEqual(["not_there", "fake", "offensive", "private_land", "duplicate"]);
  });

  it("accepts a remove report with each reason", () => {
    for (const reason of NEW_PLACE_REPORT_REASONS) {
      const r = validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "remove", reason } });
      expect(r).toMatchObject({ ok: true, value: { report: { kind: "remove", reason } } });
    }
  });

  it("refuses a remove report without a known reason", () => {
    expect(validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "remove" } })).toEqual({
      ok: false,
      errors: ["report.reason must be one of not_there, fake, offensive, private_land, duplicate"],
    });
    expect(validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "remove", reason: "spam_ad" } }).ok).toBe(false);
  });

  it("refuses a reason on any other report", () => {
    expect(validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "closed", reason: "fake" } })).toEqual({
      ok: false,
      errors: ["report.reason is only allowed when report.kind is remove"],
    });
  });

  it("needs the place a remove report is about", () => {
    const r = validateSubmission({ ...base, type: "report", place: null, location: { lat: -36.8, lon: 144.5 }, report: { kind: "remove", reason: "fake" } });
    expect(r.ok).toBe(false);
  });
});

describe("contact facts on a new place", () => {
  const newPlace = (report: Record<string, unknown>) =>
    validateSubmission({ ...base, type: "report", place: null, location: { lat: -36.8, lon: 144.5 }, report: { kind: "new_place", ...report } });

  it("accepts a phone, website and email on a new place", () => {
    const contacts = { phone: "03 5555 0100", website: "https://camp.example.org", email: "stay@camp.example.org" };
    expect(newPlace({ contacts })).toMatchObject({ ok: true, value: { report: { kind: "new_place", contacts } } });
    expect(newPlace({ contacts: { phone: "+61 3 5555 0100" } })).toMatchObject({ ok: true, value: { report: { contacts: { phone: "+61 3 5555 0100" } } } });
  });

  it("checks each contact as a fact report checks it", () => {
    expect(newPlace({ contacts: { website: "http://camp.example.org" } })).toEqual({
      ok: false,
      errors: ["report.contacts.website is not a valid value for website"],
    });
    expect(newPlace({ contacts: { phone: "ring me" } }).ok).toBe(false);
    expect(newPlace({ contacts: { email: "not an email" } }).ok).toBe(false);
  });

  it("refuses other facts and an empty set of contacts", () => {
    expect(newPlace({ contacts: { power: true } })).toEqual({ ok: false, errors: ["report.contacts may hold only phone, website and email"] });
    expect(newPlace({ contacts: {} })).toEqual({ ok: false, errors: ["report.contacts must hold at least one of phone, website and email"] });
    expect(newPlace({ contacts: "03 5555 0100" }).ok).toBe(false);
  });

  it("refuses contacts on any other report", () => {
    const r = validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "other", note: "Phone below", contacts: { phone: "03 5555 0100" } } });
    expect(r).toEqual({ ok: false, errors: ["report.contacts is only allowed when report.kind is new_place"] });
  });
});
