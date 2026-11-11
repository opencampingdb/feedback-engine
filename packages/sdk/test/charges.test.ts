import { describe, expect, it } from "vitest";
import { FACTS, FEE_RETIRED, chargeConditions, isCharge, parseCharge, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };
const report = (fact: string, value: unknown) =>
  validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact, value } });

describe("parseCharge", () => {
  it.each([
    ["57 AUD/night", { amount: 57, currency: "AUD", per: "night" }],
    ["15 AUD/person/night", { amount: 15, currency: "AUD", unit: "person", per: "night" }],
    ["2.95 USD", { amount: 2.95, currency: "USD" }],
    ["4 AUD / hour", { amount: 4, currency: "AUD", per: "hour" }],
    ["5 AUD/vehicle", { amount: 5, currency: "AUD", unit: "vehicle" }],
    ["0.25 AUD/kWh", { amount: 0.25, currency: "AUD", unit: "kWh" }],
    ["1 EUR/1.5 litre", { amount: 1, currency: "EUR", unit: "1.5 litre" }],
    ["8 AUD/motorcar/day", { amount: 8, currency: "AUD", unit: "motorcar", per: "day" }],
    ["300 JPY", { amount: 300, currency: "JPY" }],
    ["0 AUD", { amount: 0, currency: "AUD" }],
  ])("reads %j", (text, charge) => {
    expect(parseCharge(text)).toEqual(charge);
    expect(isCharge(text)).toBe(true);
  });

  // Values found in Australian OSM data that are out of the wiki's syntax.
  it.each([
    "$14.50AUD",
    "Donation Box",
    "0",
    "$12",
    "$5/n",
    "4.09",
    "0.25 AU/kWh",
    "10 aud",
    "10AUD",
    "57 AUD/night/person",
    "57 AUD/",
    " 57 AUD",
    "12.345 AUD",
    "57 AUD/person/vehicle/night",
    "",
  ])("refuses %j", (text) => {
    expect(parseCharge(text)).toBeNull();
    expect(isCharge(text)).toBe(false);
  });

  it("refuses anything but a string, and values longer than OSM allows", () => {
    expect(parseCharge(57)).toBeNull();
    expect(parseCharge(null)).toBeNull();
    expect(parseCharge(`1 AUD/${"a".repeat(260)}`)).toBeNull();
  });
});

describe("chargeConditions", () => {
  it("reads one exception, with or without parentheses", () => {
    expect(chargeConditions("75 AUD/night @ (Dec-Jan)")).toEqual([{ charge: { amount: 75, currency: "AUD", per: "night" }, condition: "Dec-Jan" }]);
    expect(chargeConditions("75 AUD/night @ Dec-Jan")).toEqual([{ charge: { amount: 75, currency: "AUD", per: "night" }, condition: "Dec-Jan" }]);
  });

  it("reads several exceptions in order, and a condition holding a semicolon inside parentheses", () => {
    expect(chargeConditions("75 AUD/night @ (Dec-Jan); 90 AUD/night @ (Dec 24-Dec 26; Dec 31)")).toEqual([
      { charge: { amount: 75, currency: "AUD", per: "night" }, condition: "Dec-Jan" },
      { charge: { amount: 90, currency: "AUD", per: "night" }, condition: "Dec 24-Dec 26; Dec 31" },
    ]);
    expect(chargeConditions("0 AUD @ (stay < 2 hours)")).toEqual([{ charge: { amount: 0, currency: "AUD" }, condition: "stay < 2 hours" }]);
  });

  it.each(["75 AUD/night", "$75 @ (Dec-Jan)", "75 AUD/night @", "75 AUD/night @ (Dec-Jan", "75 AUD/night @ Dec-Jan)", "75 AUD @ a @ b", "75 AUD/night @ ()", ""])(
    "refuses %j",
    (text) => expect(chargeConditions(text)).toBeNull(),
  );
});

describe("charge reports", () => {
  it("accepts every fact in the wiki's syntax", () => {
    for (const fact of ["charge", "charge_powered"]) {
      expect(report(fact, "57 AUD/night").ok).toBe(true);
      expect(report(fact, "2 AUD/hour").ok).toBe(true);
      expect(report(fact, "$57").ok).toBe(false);
    }
    expect(report("charge_conditional", "75 AUD/night @ (Dec-Jan)").ok).toBe(true);
    expect(report("charge_conditional", "75 AUD/night").ok).toBe(false);
  });

  it("refuses contact details in a condition", () => {
    expect(FACTS.charge_conditional("75 AUD/night @ (call 0412 345 678)")).toBe(false);
    expect(FACTS.charge_conditional("75 AUD/night @ (example.com.au)")).toBe(false);
  });

  it("lets a doubt name a charge", () => {
    expect(validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "doubt", fact: "charge" } }).ok).toBe(true);
  });
});

describe("fee reports", () => {
  it("are refused, saying what to send instead", () => {
    const r = validateSubmission({ ...base, contributor: "acct_3f9a8b7c6d5e4f30", type: "fee", place: PLACE, fee: { amount: 35, site: "powered", paid: "2026-10" } });
    expect(r).toEqual({ ok: false, errors: [FEE_RETIRED] });
    expect(FEE_RETIRED).toContain("charge");
  });

  it("the fee fact is unchanged", () => {
    for (const value of [true, false, "donation"]) expect(report("fee", value).ok).toBe(true);
  });
});
