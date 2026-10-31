import { describe, expect, it } from "vitest";
import { findContactDetails, stripContactDetails, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = {
  device: "3b241101-e2bb-4255-8caf-4136c566a962",
  app_version: "1.0.0",
  consent: true,
};

describe("validateSubmission", () => {
  it("accepts a fact report", () => {
    const r = validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "power", value: true } });
    expect(r.ok).toBe(true);
  });

  it("accepts a new place with a location and no place id", () => {
    const r = validateSubmission({
      ...base,
      type: "report",
      place: null,
      location: { lat: -36.8512345678, lon: 144.55 },
      report: { kind: "new_place", note: "Free camp by the river" },
    });
    expect(r).toMatchObject({ ok: true, value: { location: { lat: -36.851235, lon: 144.55 } } });
  });

  it("requires consent: true", () => {
    const r = validateSubmission({ ...base, consent: false, type: "check", place: PLACE, check: { visited: "2026-10-01", still_there: true } });
    expect(r).toEqual({ ok: false, errors: ["consent must be true"] });
  });

  it.each([
    [{ type: "report", place: PLACE, report: { kind: "fact", fact: "power", value: "yes" } }, "report.value"],
    [{ type: "report", place: PLACE, report: { kind: "fact", fact: "colour", value: true } }, "report.fact"],
    [{ type: "report", place: null, report: { kind: "closed" } }, "place is required"],
    [{ type: "report", place: null, report: { kind: "new_place" } }, "location is required"],
    [{ type: "report", place: PLACE, location: { lat: 1, lon: 1 }, report: { kind: "closed" } }, "location is only allowed"],
    [{ type: "review", place: PLACE, review: { stars: 0, text: "", visited: "2026-10" } }, "review.stars"],
    [{ type: "review", place: PLACE, review: { stars: 3, text: "x".repeat(2001), visited: "2026-10" } }, "review.text"],
    [{ type: "review", place: PLACE, review: { stars: 3, text: "", visited: "2026-13" } }, "review.visited"],
    [{ type: "check", place: PLACE, check: { visited: "2026-02-30", still_there: true } }, "check.visited"],
    [{ type: "check", place: "camp1", check: { visited: "2026-02-03", still_there: true } }, "place must be"],
    [{ type: "check", place: PLACE, check: { visited: "2026-02-03", still_there: true }, review: {} }, "review is not allowed"],
    [{ type: "check", place: PLACE, check: { visited: "2026-02-03", still_there: true }, email: "a@b.co" }, "unknown field email"],
    [{ type: "rant", place: PLACE }, "type must be"],
  ])("refuses %j", (body, message) => {
    const r = validateSubmission({ ...base, ...body });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" | ")).toContain(message);
  });

  it("refuses opening hours that hold contact details, and accepts plain opening hours", () => {
    const hours = (value: string) =>
      validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "opening_hours", value } });
    for (const value of ["Ring 0412 345 678", "see camp.example.com.au", "jo@example.com"]) {
      expect(hours(value)).toMatchObject({ ok: false, errors: ["report.value is not a valid value for opening_hours"] });
    }
    expect(hours("Mo-Fr 08:00-17:00; Sa 09:00-12:00").ok).toBe(true);
    expect(hours("24/7").ok).toBe(true);
  });

  it("accepts opening hours written with dots or as HHMM ranges, and still refuses phone numbers and links", () => {
    const hours = (value: string) =>
      validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "opening_hours", value } });
    for (const value of ["08.00-17.00", "08.00 - 17.00", "0800-1700", "Mo-Fr 0800-1700"]) expect(hours(value).ok).toBe(true);
    for (const value of ["0412 345 678", "0412-345-678", "1300 123 456", "https://camp.example.org/hours"]) {
      expect(hours(value).ok).toBe(false);
    }
  });

  it("refuses a device that is not a UUID", () => {
    const r = validateSubmission({ ...base, device: "abc", type: "check", place: PLACE, check: { visited: "2026-10-01", still_there: true } });
    expect(r.ok).toBe(false);
  });
});

describe("contact details", () => {
  it.each([
    ["Email me at jo.bloggs@example.com.au", ["email"]],
    ["Book at https://camp.example.org/book", ["link"]],
    ["see www.riverbend.net", ["link"]],
    ["bookings on riverbendcamp.com.au", ["link"]],
    ["Call 0412 345 678 for keys", ["phone"]],
    ["Ring (02) 6123 4567", ["phone"]],
    ["Phone +61 2 6123 4567", ["phone"]],
    ["Stayed 2026-10-30, about 12 km out of Mt.Buller", []],
    ["Price was $25 a night for 2 people", []],
  ])("finds contact details in %j", (text, kinds) => {
    expect(findContactDetails(text).sort()).toEqual([...kinds].sort());
  });

  it("strips every kind", () => {
    expect(stripContactDetails("Call 0412 345 678 or jo@example.com, see https://x.example.org/a")).toBe(
      "Call [removed] or [removed], see [removed]",
    );
  });

  it.each(["Stayed 2026-10-30", "Visited 2026-10", "From 2026-10-30 2026-11-02", "2026-10-30 2026-11"])(
    "does not treat the date in %j as a phone number",
    (text) => {
      expect(findContactDetails(text)).toEqual([]);
      expect(stripContactDetails(text)).toBe(text);
    },
  );

  it("still finds a phone number next to a date", () => {
    expect(findContactDetails("Stayed 2026-10-30, ring 0412345678")).toEqual(["phone"]);
    expect(stripContactDetails("Stayed 2026-10-30, ring 0412345678")).toBe("Stayed 2026-10-30, ring [removed]");
  });

  it("leaves dates and prices alone", () => {
    const text = "Visited 30/10/2026, paid $30 for 2 nights";
    expect(stripContactDetails(text)).toBe(text);
  });
});
