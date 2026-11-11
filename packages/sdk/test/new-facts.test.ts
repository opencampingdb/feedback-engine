import { describe, expect, it } from "vitest";
import { validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = {
  device: "3b241101-e2bb-4255-8caf-4136c566a962",
  app_version: "1.0.0",
  consent: true,
};
const report = (r: object) => validateSubmission({ ...base, type: "report", place: PLACE, report: r });

describe("toilet_type, hot_water, air and operator reports", () => {
  it.each(["flush", "pit", "chemical", "dry"])("accepts toilet_type = %j", (value) => {
    expect(report({ kind: "fact", fact: "toilet_type", value }).ok).toBe(true);
  });

  it.each([
    ["hot_water", true],
    ["hot_water", false],
    ["air", true],
    ["air", false],
    ["operator", "Shire of Example"],
    ["operator", "x".repeat(200)],
    // Already reportable before OSM filled them.
    ["bins", false],
    ["fishing", true],
    ["phone_2", "+61 2 9888 9133"],
  ])("accepts %s = %j", (fact, value) => {
    expect(report({ kind: "fact", fact, value })).toMatchObject({ ok: true, value: { report: { fact, value } } });
  });

  it.each([
    ["toilet_type", "composting"],
    ["toilet_type", "Flush"],
    ["toilet_type", true],
    ["hot_water", "yes"],
    ["air", "free"],
    ["operator", ""],
    ["operator", "   "],
    ["operator", "x".repeat(201)],
    ["operator", 7],
    ["operator", "Call 0412 345 678"],
  ])("refuses %s = %j", (fact, value) => {
    expect(report({ kind: "fact", fact, value }).ok).toBe(false);
  });

  it("trims the operator", () => {
    expect(report({ kind: "fact", fact: "operator", value: "  Example Parks  " })).toMatchObject({
      ok: true,
      value: { report: { fact: "operator", value: "Example Parks" } },
    });
  });

  it("counts the operator's length after trimming", () => {
    expect(report({ kind: "fact", fact: "operator", value: ` ${"x".repeat(200)} ` }).ok).toBe(true);
  });
});

describe("facts no report names", () => {
  it.each([
    ["nearest_beach", { distance_m: 100 }],
    ["nearest_boat_ramp", { distance_m: 3000, name: "Example Ramp" }],
    ["fuels", ["diesel"]],
    ["booking_url", "https://book.example.com"],
  ])("refuses a report of %s", (fact, value) => {
    expect(report({ kind: "fact", fact, value }).ok).toBe(false);
  });

  it.each(["nearest_beach", "nearest_boat_ramp", "fuels"])("refuses a doubt about %s", (fact) => {
    expect(report({ kind: "doubt", fact }).ok).toBe(false);
  });

  it("lets a doubt name the new reportable facts", () => {
    for (const fact of ["toilet_type", "hot_water", "air", "operator"]) {
      expect(report({ kind: "doubt", fact }).ok).toBe(true);
    }
  });
});

describe("owner updates of the new facts", () => {
  const update = (facts: object) =>
    validateSubmission({
      device: base.device,
      app_version: "1.0.0",
      terms_accepted: true,
      type: "owner_update",
      place: PLACE,
      token: "q2Vb7Rk1cW9yZ3hVdm5Pb2pQTlR4Y0FyZ0lCd2pUcEs",
      update: { facts },
    });

  it("sets toilet_type, hot_water, air and a trimmed operator", () => {
    expect(update({ toilet_type: "pit", hot_water: true, air: false, operator: " Example Council " })).toMatchObject({
      ok: true,
      value: { update: { facts: { toilet_type: "pit", hot_water: true, air: false, operator: "Example Council" } } },
    });
  });

  it.each([
    ["nearest_boat_ramp", { distance_m: 3000 }],
    ["nearest_beach", { distance_m: 100 }],
    ["fuels", ["diesel"]],
  ])("refuses %s", (fact, value) => {
    expect(update({ [fact]: value }).ok).toBe(false);
  });
});
