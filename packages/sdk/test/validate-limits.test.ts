import { describe, expect, it } from "vitest";
import { FACTS, isPublicHttpsUrl, validateSubmission } from "../src/index.js";

describe("isPublicHttpsUrl and local names", () => {
  it("refuses local names written with a trailing dot", () => {
    expect(["https://localhost./claim", "https://printer.lan./", "https://db.internal./", "https://router.home./", "https://nas.local./"].map(isPublicHttpsUrl)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("still takes a public name, with or without its trailing dot", () => {
    expect([isPublicHttpsUrl("https://example.org/claim"), isPublicHttpsUrl("https://example.org./claim")]).toEqual([true, true]);
  });

  it("refuses a bare name that is only a trailing dot away from one label", () => {
    expect([isPublicHttpsUrl("https://intranet./"), isPublicHttpsUrl("https://10.0.0.1./")]).toEqual([false, false]);
  });
});

describe("phone numbers", () => {
  it("a phone of spaces alone, or with fewer than 6 digits, is not a valid phone", () => {
    expect([FACTS.phone("        "), FACTS.phone("+       "), FACTS.phone_2("          "), FACTS.phone("12 34 5")]).toEqual([false, false, false, false]);
  });

  it("a phone with 6 or more digits, spaced or not, is valid", () => {
    expect([FACTS.phone("123456"), FACTS.phone("+61 2 9876 5432"), FACTS.phone_2("02 9876 5432")]).toEqual([true, true, true]);
  });
});

describe("visits dated in the future", () => {
  const base = { place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA", device: "3f2b8c1e-5a4d-4e6f-9a7b-1c2d3e4f5a6b", app_version: "1.0.0", consent: true };
  const review = (visited: string, now: Date) => validateSubmission({ ...base, type: "review", review: { stars: 5, text: "", visited } }, now);
  const check = (visited: string, now: Date) => validateSubmission({ ...base, type: "check", check: { visited, still_there: true } }, now);

  it("a review or a check dated in the future is refused", () => {
    const now = new Date(Date.UTC(2026, 10, 12));
    const r = review("2031-01", now);
    const c = check("2031-01-01", now);
    expect({ review: r.ok, check: c.ok }).toEqual({ review: false, check: false });
    expect(r.ok ? [] : r.errors).toContain("review.visited must not be in the future");
    expect(c.ok ? [] : c.errors).toContain("check.visited must not be in the future");
  });

  it("this month and today count wherever they have already started (UTC+14)", () => {
    // 11:00 UTC on 30 November is already 1 December in UTC+14.
    const now = new Date(Date.UTC(2026, 10, 30, 11));
    expect(review("2026-12", now).ok).toBe(true);
    expect(check("2026-12-01", now).ok).toBe(true);
    expect(review("2027-01", now).ok).toBe(false);
    expect(check("2026-12-02", now).ok).toBe(false);
    // Earlier in the day it is still 30 November everywhere.
    const early = new Date(Date.UTC(2026, 10, 30, 9));
    expect(review("2026-12", early).ok).toBe(false);
    expect(check("2026-12-01", early).ok).toBe(false);
  });

  it("takes today and this month at 00:30 on the first of a month in UTC+11, while UTC is still on the month before", () => {
    // 00:30 on 1 December at UTC+11 is 13:30 on 30 November in UTC, the intake's clock.
    const now = new Date(Date.UTC(2026, 10, 30, 13, 30));
    expect(check("2026-12-01", now).ok).toBe(true);
    expect(review("2026-12", now).ok).toBe(true);
    expect(check("2026-11-30", now).ok).toBe(true);
    expect(review("2026-11", now).ok).toBe(true);
  });

  it("refuses the next day and the next month at 00:30 on the first of a month in UTC+11", () => {
    const now = new Date(Date.UTC(2026, 10, 30, 13, 30));
    const day = check("2026-12-02", now);
    const month = review("2027-01", now);
    expect(day.ok ? [] : day.errors).toEqual(["check.visited must not be in the future"]);
    expect(month.ok ? [] : month.errors).toEqual(["review.visited must not be in the future"]);
  });

  it("takes the new year at 00:30 on 1 January in UTC+11", () => {
    const now = new Date(Date.UTC(2026, 11, 31, 13, 30));
    expect([check("2027-01-01", now).ok, review("2027-01", now).ok]).toEqual([true, true]);
    expect([check("2027-01-02", now).ok, review("2027-02", now).ok]).toEqual([false, false]);
  });

  it("a visit in the past is still taken", () => {
    const now = new Date(Date.UTC(2026, 10, 12));
    expect([review("2026-11", now).ok, review("2020-01", now).ok, check("2026-11-12", now).ok, check("2024-02-29", now).ok]).toEqual([true, true, true, true]);
  });
});
