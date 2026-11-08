import { describe, expect, it } from "vitest";
import { BRANDS, MAX_NAME_LENGTH, SITE_FEATURES, findContactDetails, stripContactDetails, validateSubmission } from "../src/index.js";

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

  it("accepts OSM opening hours, and refuses contact details in their comments", () => {
    const hours = (value: string) =>
      validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "opening_hours", value } });
    expect(hours("Mo-Fr 08:00-17:00; Sa 09:00-12:00").ok).toBe(true);
    expect(hours("24/7").ok).toBe(true);
    expect(hours('Mo-Su 08:00-17:00 "gate locked at night"').ok).toBe(true);
    for (const value of ['Mo-Fr "ring 0412 345 678"', 'Mo-Fr "see camp.example.com.au"', 'Mo-Fr "jo@example.com"']) {
      expect(hours(value)).toMatchObject({ ok: false, errors: ["report.value is not a valid value for opening_hours"] });
    }
  });

  it("refuses opening hours that are not OSM syntax, and says why", () => {
    const hours = (value: string) =>
      validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "opening_hours", value } });
    expect(hours("Mon-Sun  06:00 - 22:00")).toMatchObject({
      ok: false,
      errors: ['report.value is not OSM opening_hours syntax at character 3 ("n-Sun  06:00"): write weekdays as two letters: Mo Tu We Th Fr Sa Su'],
    });
    for (const value of ["08.00-17.00", "0800-1700", "Mo-Fr 0800-1700", "0412 345 678", "https://camp.example.org/hours", "Ring 0412 345 678"]) {
      const r = hours(value);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatch(/^report\.value is not OSM opening_hours syntax/);
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

describe("site features and the name, description and kind reports", () => {
  const report = (r: object) => validateSubmission({ ...base, type: "report", place: PLACE, report: r });

  it.each([
    ["fee", "donation"],
    ["caravans", "offroad"],
    ["pets", "seasonal"],
    ["campfires", true],
    ["crocodiles", false],
    ["sharks", true],
    ["marine_stingers", true],
    ["booking_required", true],
    ["brand", "big4"],
    ["email", "stay@example.com.au"],
    ["phone_2", "+61 2 9888 9133"],
    ["facebook", "https://www.facebook.com/lakebend"],
    ["x", "https://x.com/lakebend"],
  ])("accepts %s = %j", (fact, value) => {
    expect(report({ kind: "fact", fact, value }).ok).toBe(true);
  });

  it.each([
    ["fee", "free"],
    ["caravans", "maybe"],
    ["brand", "Some Park"],
    ["email", "not an email"],
    ["instagram", "http://instagram.com/lakebend"],
    ["booking_url", "https://book.example.com"],
    ["marine_stingers", "in season"],
    // Worked out from OSM at each sync, so no report sets it.
    ["nearest_beach", { distance_m: 100 }],
  ])("refuses %s = %j", (fact, value) => {
    expect(report({ kind: "fact", fact, value }).ok).toBe(false);
  });

  it("accepts a name and a description, trimmed", () => {
    expect(report({ kind: "name", value: " Discovery Parks - Lane Cove " })).toMatchObject({
      ok: true,
      value: { report: { kind: "name", value: "Discovery Parks - Lane Cove" } },
    });
    expect(report({ kind: "description", value: "Shady sites by the river." }).ok).toBe(true);
  });

  it("refuses an empty, long or contact-carrying name or description", () => {
    expect(report({ kind: "name", value: "  " }).ok).toBe(false);
    expect(report({ kind: "name", value: "x".repeat(301) }).ok).toBe(false);
    expect(report({ kind: "description", value: "x".repeat(501) }).ok).toBe(false);
    expect(report({ kind: "description", value: "Call 0412 345 678 to book" }).ok).toBe(false);
    expect(report({ kind: "name", fact: "power", value: "Lake Bend" }).ok).toBe(false);
  });

  it("needs a kind code on a kind report", () => {
    expect(report({ kind: "kind", place_kind: "caravan_park" }).ok).toBe(true);
    expect(report({ kind: "kind" }).ok).toBe(false);
    expect(report({ kind: "kind", place_kind: "Caravan Park" }).ok).toBe(false);
    expect(report({ kind: "closed", place_kind: "caravan_park" }).ok).toBe(false);
  });
});

describe("exports for apps", () => {
  it("exports the site features, brands and name length from the package index", () => {
    expect(SITE_FEATURES).toHaveLength(46);
    expect(SITE_FEATURES).toContain("marine_stingers");
    expect(SITE_FEATURES).toContain("campfires");
    expect(BRANDS).toContain("big4");
    expect(MAX_NAME_LENGTH).toBe(300);
  });
});
