import { describe, expect, it } from "vitest";
import { CONTACT_FACTS, CONTACT_REPORT_REASONS, LINK_SHORTENERS, REPORT_KINDS, contactProblem, isContactFact, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = {
  device: "3b241101-e2bb-4255-8caf-4136c566a962",
  app_version: "1.0.0",
  consent: true,
};
const newPlace = (report: Record<string, unknown>) =>
  validateSubmission({ ...base, type: "report", place: null, location: { lat: -36.8, lon: 144.5 }, report: { kind: "new_place", ...report } });
const contact = (report: Record<string, unknown>, place: string | null = PLACE) =>
  validateSubmission({ ...base, type: "report", place, report: { kind: "contact", ...report } });

describe("a new place's description and fee", () => {
  it("accepts a description and trims it", () => {
    expect(newPlace({ description: "  Flat sites beside the creek.  " })).toMatchObject({ ok: true, value: { report: { description: "Flat sites beside the creek." } } });
  });

  it("refuses an empty, long or contact-carrying description", () => {
    expect(newPlace({ description: "   " })).toEqual({ ok: false, errors: ["report.description must be the description, 1 to 500 characters"] });
    expect(newPlace({ description: "a".repeat(501) }).ok).toBe(false);
    expect(newPlace({ description: 42 }).ok).toBe(false);
    expect(newPlace({ description: "Ring 0412 345 678 to book" })).toEqual({
      ok: false,
      errors: ["report.description must not hold an email address, phone number or link"],
    });
  });

  it("accepts each fee value", () => {
    for (const fee of [true, false, "donation"]) expect(newPlace({ fee })).toMatchObject({ ok: true, value: { report: { fee } } });
  });

  it("refuses a fee that is not a fee value", () => {
    expect(newPlace({ fee: "yes" })).toEqual({ ok: false, errors: ["report.fee is not a valid value for fee"] });
  });

  it("allows a description and a fee only on new_place", () => {
    const other = (report: Record<string, unknown>) => validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "other", ...report } });
    expect(other({ description: "Shady" })).toEqual({ ok: false, errors: ["report.description is only allowed when report.kind is new_place"] });
    expect(other({ fee: true })).toEqual({ ok: false, errors: ["report.fee is only allowed when report.kind is new_place"] });
  });
});

describe("contactProblem", () => {
  it("passes good contacts and an address", () => {
    expect(contactProblem("website", "https://park.example.org/stay")).toBeNull();
    expect(contactProblem("phone", "03 5555 0100")).toBeNull();
    expect(contactProblem("phone_2", "+61 3 5555 0100")).toBeNull();
    expect(contactProblem("email", "stay@park.example.org")).toBeNull();
    expect(contactProblem("facebook", "https://www.facebook.com/lakecamp")).toBeNull();
    expect(contactProblem("facebook", "https://m.facebook.com/lakecamp")).toBeNull();
    expect(contactProblem("facebook", "https://fb.com/lakecamp")).toBeNull();
    expect(contactProblem("instagram", "https://instagram.com/lakecamp")).toBeNull();
    expect(contactProblem("tiktok", "https://www.tiktok.com/@lakecamp")).toBeNull();
    expect(contactProblem("x", "https://x.com/lakecamp")).toBeNull();
    expect(contactProblem("x", "https://twitter.com/lakecamp")).toBeNull();
    expect(contactProblem("address", { street: "Lake Road", suburb: "Lakeside", state: "VIC", postcode: "3999" })).toBeNull();
  });

  it("refuses a link that is not https on a public host", () => {
    expect(contactProblem("website", "http://park.example.org")).toBe("not a valid value for website");
    expect(contactProblem("website", "https://192.168.1.10/")).toBe("must be an https address on a public website");
    expect(contactProblem("website", "https://camp.local/")).toBe("must be an https address on a public website");
    expect(contactProblem("website", "https://park.example.org:8443/")).toBe("must be an https address on a public website");
  });

  it("refuses every link shortener, with its subdomains", () => {
    for (const host of LINK_SHORTENERS) expect(contactProblem("website", `https://${host}/abc123`)).toBe("must not be a link shortener");
    expect(contactProblem("website", "https://www.bit.ly/abc")).toBe("must not be a link shortener");
    expect(contactProblem("facebook", "https://t.co/abc")).toBe("must not be a link shortener");
    expect(contactProblem("website", "https://notbit.ly/abc")).toBeNull();
  });

  it("refuses a social page off its own network's host", () => {
    expect(contactProblem("facebook", "https://park.example.org/fb")).toBe("must be on facebook.com or fb.com");
    expect(contactProblem("facebook", "https://facebook.com.example.org/lakecamp")).toBe("must be on facebook.com or fb.com");
    expect(contactProblem("instagram", "https://www.facebook.com/lakecamp")).toBe("must be on instagram.com");
    expect(contactProblem("tiktok", "https://instagram.com/lakecamp")).toBe("must be on tiktok.com");
    expect(contactProblem("x", "https://tiktok.com/@lakecamp")).toBe("must be on x.com or twitter.com");
  });

  it("refuses a bad phone, email or address", () => {
    expect(contactProblem("phone", "ring me")).toBe("not a valid value for phone");
    expect(contactProblem("email", "not an email")).toBe("not a valid value for email");
    expect(contactProblem("address", { suburb: "Lakeside" })).toBe("address must have a street or a place");
    expect(contactProblem("address", { street: "Fuck Road" })).toMatch(/text checks \(rude\)/);
    expect(contactProblem("address", { street: "Buy now crypto road" })).toMatch(/text checks \(spam\)/);
  });
});

describe("contact reports", () => {
  it("lists the contact kind, facts and reasons", () => {
    expect(REPORT_KINDS).toContain("contact");
    expect(CONTACT_FACTS).toEqual(["website", "phone", "phone_2", "email", "facebook", "instagram", "tiktok", "x", "address"]);
    expect(CONTACT_REPORT_REASONS).toEqual(["wrong", "spam"]);
    expect(isContactFact("website")).toBe(true);
    expect(isContactFact("power")).toBe(false);
  });

  it("accepts a contact report for each contact fact and reason", () => {
    for (const fact of CONTACT_FACTS) {
      for (const reason of CONTACT_REPORT_REASONS) {
        expect(contact({ fact, reason })).toMatchObject({ ok: true, value: { place: PLACE, report: { kind: "contact", fact, reason } } });
      }
    }
  });

  it("refuses a fact that is not a contact, and a missing or unknown reason", () => {
    expect(contact({ fact: "power", reason: "wrong" })).toEqual({
      ok: false,
      errors: ["report.fact must be one of website, phone, phone_2, email, facebook, instagram, tiktok, x, address"],
    });
    expect(contact({ fact: "website" })).toEqual({ ok: false, errors: ["report.reason must be one of wrong, spam"] });
    expect(contact({ fact: "website", reason: "fake" }).ok).toBe(false);
  });

  it("refuses a value on a contact report", () => {
    expect(contact({ fact: "website", reason: "spam", value: "https://park.example.org" })).toEqual({
      ok: false,
      errors: ["report.value is not allowed when report.kind is contact"],
    });
  });

  it("needs the place", () => {
    expect(contact({ fact: "website", reason: "spam" }, null)).toEqual({ ok: false, errors: ["place is required unless report.kind is new_place"] });
  });

  it("refuses a contact reason on a remove report and a remove reason on a contact report", () => {
    expect(validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "remove", reason: "spam" } }).ok).toBe(false);
    expect(contact({ fact: "phone", reason: "fake" }).ok).toBe(false);
  });
});
