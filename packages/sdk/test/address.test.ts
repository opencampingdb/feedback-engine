import { describe, expect, it } from "vitest";
import { ADDRESS_STATES, FACTS, MAX_ADDRESS_FIELD_LENGTH, addressProblems, isAddress, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = {
  device: "3b241101-e2bb-4255-8caf-4136c566a962",
  app_version: "1.0.0",
  consent: true,
};

const addressReport = (value: unknown) =>
  validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "address", value } });

describe("an address fact", () => {
  it("accepts a street address, as the data's extract writes one", () => {
    const value = { housenumber: "12", street: "Lake Road", suburb: "Lakeside", state: "VIC", postcode: "3999" };
    expect(addressReport(value)).toEqual({ ok: true, value: expect.objectContaining({ report: { kind: "fact", fact: "address", value } }) });
    expect(isAddress(value)).toBe(true);
  });

  it("accepts a rural address that names a place instead of a street", () => {
    expect(isAddress({ place: "Lake Station", suburb: "Lakeside" })).toBe(true);
    expect(isAddress({ street: "Lake Road" })).toBe(true);
    expect(isAddress({ unit: "3", housenumber: "12-14", street: "Lake Road", place: "Lake Station" })).toBe(true);
  });

  it("needs a street or a place", () => {
    expect(isAddress({ postcode: "3999", suburb: "Lakeside" })).toBe(false);
    expect(addressProblems({ postcode: "3999", suburb: "Lakeside" })).toEqual(["address must have a street or a place"]);
    expect(isAddress({})).toBe(false);
  });

  it("takes a state only as its abbreviation, and a four digit postcode", () => {
    expect(ADDRESS_STATES).toEqual(["NSW", "VIC", "QLD", "SA", "WA", "TAS", "NT", "ACT"]);
    for (const state of ADDRESS_STATES) expect(isAddress({ street: "Lake Road", state })).toBe(true);
    expect(addressProblems({ street: "Lake Road", state: "Victoria" })).toEqual([`address.state must be one of ${ADDRESS_STATES.join(", ")}`]);
    expect(addressProblems({ street: "Lake Road", state: "vic" })).toHaveLength(1);
    expect(addressProblems({ street: "Lake Road", postcode: "39" })).toEqual(["address.postcode must be four digits"]);
    expect(isAddress({ street: "Lake Road", postcode: "39990" })).toBe(false);
    expect(isAddress({ street: "Lake Road", postcode: 3999 })).toBe(false);
  });

  it("refuses an empty, long or non-text field, and fields it does not know", () => {
    expect(addressProblems({ street: "" })).toEqual([`address.street must be 1 to ${MAX_ADDRESS_FIELD_LENGTH} characters`]);
    expect(isAddress({ street: "   " })).toBe(false);
    expect(isAddress({ street: "x".repeat(MAX_ADDRESS_FIELD_LENGTH + 1) })).toBe(false);
    expect(isAddress({ street: "Lake Road", housenumber: 12 })).toBe(false);
    expect(addressProblems({ street: "Lake Road", city: "Lakeside" })).toEqual(["unknown field address.city"]);
    expect(isAddress("12 Lake Road")).toBe(false);
    expect(isAddress(null)).toBe(false);
  });

  it("runs the contact detail and text checks over every field", () => {
    expect(addressProblems({ street: "Lake Road", suburb: "ring 0412 345 678" })).toEqual([
      "address.suburb must not hold an email address, phone number or link",
    ]);
    expect(isAddress({ street: "www.lakeroad.com.au" })).toBe(false);
    expect(isAddress({ place: "jo@example.com" })).toBe(false);
    expect(isAddress({ unit: "0412345678", street: "Lake Road" })).toBe(false);
    expect(addressProblems({ street: "Shit Creek Road" })).toEqual(["address.street must pass the text checks (rude)"]);
    expect(isAddress({ street: "Lake Road", suburb: "click here" })).toBe(false);
  });

  it("is checked by FACTS like every other fact", () => {
    expect(FACTS.address({ street: "Lake Road" })).toBe(true);
    expect(FACTS.address({ suburb: "Lakeside" })).toBe(false);
  });

  it("says what is wrong with an address on a fact report", () => {
    expect(addressReport({ suburb: "Lakeside", state: "Victoria" })).toEqual({
      ok: false,
      errors: ["report.value must have a street or a place", `report.value.state must be one of ${ADDRESS_STATES.join(", ")}`],
    });
  });

  it("stores each field trimmed", () => {
    const r = addressReport({ housenumber: " 12 ", street: "Lake Road  " });
    expect(r).toMatchObject({ ok: true, value: { report: { value: { housenumber: "12", street: "Lake Road" } } } });
  });
});

describe("an address on a new place", () => {
  const newPlace = (report: Record<string, unknown>) =>
    validateSubmission({ ...base, type: "report", place: null, location: { lat: -36.8, lon: 144.5 }, report: { kind: "new_place", ...report } });

  it("accepts an address beside the contacts", () => {
    const address = { housenumber: "12", street: "Lake Road", suburb: "Lakeside", state: "VIC", postcode: "3999" };
    expect(newPlace({ address, contacts: { phone: "03 5555 0100" } })).toMatchObject({ ok: true, value: { report: { kind: "new_place", address } } });
  });

  it("refuses a bad address with the reason", () => {
    expect(newPlace({ address: { suburb: "Lakeside" } })).toEqual({ ok: false, errors: ["report.address must have a street or a place"] });
    expect(newPlace({ address: "12 Lake Road" })).toEqual({ ok: false, errors: ["report.address must be an object"] });
  });

  it("refuses an address on any other report", () => {
    expect(validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "closed", address: { street: "Lake Road" } } })).toEqual({
      ok: false,
      errors: ["report.address is only allowed when report.kind is new_place"],
    });
  });
});
