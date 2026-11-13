import { describe, expect, it } from "vitest";
import { newPlaceStanding, type NewPlaceReport, type NewPlaceStandingInput } from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const ADDED = "2026-11-01T00:00:00Z";
const ADDER = "dev-adder";
const report = (device: string, reason: NewPlaceReport["reason"] = "fake", day = "2026-11-02"): NewPlaceReport => ({ device, reason, day });
const check = (device: string, stillThere = true, nearby = true, day = "2026-11-02") => ({ device, stillThere, nearby, day });
const CONFIRMING = [check("dev-b"), check("dev-c")];
const after = (hours: number) => new Date(Date.parse(ADDED) + hours * HOUR).toISOString();

function place(overrides: Partial<NewPlaceStandingInput> = {}): NewPlaceStandingInput {
  return {
    added: ADDED,
    contributor: { device: ADDER, blocked: false, firstPlace: false },
    checks: [],
    reports: [],
    withdrawnAt: null,
    duplicateOf: null,
    moderator: null,
    now: after(48),
    ...overrides,
  };
}

describe("newPlaceStanding", () => {
  it("shows a new place nobody has checked or reported", () => {
    expect(newPlaceStanding(place())).toBe("shown");
  });

  it("does not count a check from the adder's own network towards confirming, whatever device id it carries", () => {
    const adder = { device: ADDER, source: "net-adder", blocked: false, firstPlace: false };
    const ownNetwork = { ...check("dev-new"), source: "net-adder" };
    const other = { ...check("dev-other"), source: "net-two" };
    const third = { ...check("dev-third"), source: "net-three" };
    expect(newPlaceStanding(place({ contributor: adder, checks: [ownNetwork, other] }))).toBe("shown");
    expect(newPlaceStanding(place({ contributor: adder, checks: [ownNetwork, other, third] }))).toBe("confirmed");
  });

  describe("the adder's delete", () => {
    it.each([1, 23.9, 24])("withdraws the place when deleted %sh after it was added", (hours) => {
      expect(newPlaceStanding(place({ withdrawnAt: after(hours) }))).toBe("withdrawn");
    });

    it("counts a delete after 24 hours as one report, so it alone leaves the place shown", () => {
      expect(newPlaceStanding(place({ withdrawnAt: after(30) }))).toBe("shown");
    });

    it("hides the place when a late delete is joined by a report from another device", () => {
      const reports = [report("dev-b")];
      expect(newPlaceStanding(place({ withdrawnAt: after(30), reports }))).toBe("hidden");
    });

    it("counts a late delete and the adder's own report once", () => {
      const reports = [report(ADDER, "duplicate")];
      expect(newPlaceStanding(place({ withdrawnAt: after(30), reports }))).toBe("shown");
    });
  });

  describe("confirming", () => {
    it("confirms a place with still-there checks from 2 other devices near it", () => {
      expect(newPlaceStanding(place({ checks: CONFIRMING }))).toBe("confirmed");
    });

    it("doesn't confirm with 1 check", () => {
      expect(newPlaceStanding(place({ checks: [check("dev-b")] }))).toBe("shown");
    });

    it("counts checks from the same device once", () => {
      expect(newPlaceStanding(place({ checks: [check("dev-b"), check("dev-b", true, true, "2026-11-03")] }))).toBe("shown");
    });

    it("ignores the adder's own check", () => {
      expect(newPlaceStanding(place({ checks: [check(ADDER), check("dev-b")] }))).toBe("shown");
    });

    it("ignores checks made away from the place", () => {
      expect(newPlaceStanding(place({ checks: [check("dev-b"), check("dev-c", true, false)] }))).toBe("shown");
    });
  });

  describe("reports", () => {
    it("leaves an unconfirmed place shown after 1 report", () => {
      expect(newPlaceStanding(place({ reports: [report("dev-b")] }))).toBe("shown");
    });

    it("hides an unconfirmed place after reports from 2 devices", () => {
      expect(newPlaceStanding(place({ reports: [report("dev-b"), report("dev-c", "offensive")] }))).toBe("hidden");
    });

    it("counts reports from the same device once", () => {
      const reports = [report("dev-b"), report("dev-b", "private_land", "2026-11-03")];
      expect(newPlaceStanding(place({ reports }))).toBe("shown");
    });

    it("keeps a confirmed place after reports from 2 devices", () => {
      const reports = [report("dev-d"), report("dev-e")];
      expect(newPlaceStanding(place({ checks: CONFIRMING, reports }))).toBe("confirmed");
    });

    it("hides a confirmed place after reports from 3 devices", () => {
      const reports = [report("dev-d"), report("dev-e"), report("dev-f")];
      expect(newPlaceStanding(place({ checks: CONFIRMING, reports }))).toBe("hidden");
    });

    it("counts a not-there check as a report", () => {
      const checks = [check("dev-b", false)];
      expect(newPlaceStanding(place({ checks, reports: [report("dev-c")] }))).toBe("hidden");
    });

    it("counts a not-there check and a report from the same device once", () => {
      const checks = [check("dev-b", false)];
      expect(newPlaceStanding(place({ checks, reports: [report("dev-b", "not_there")] }))).toBe("shown");
    });

    it("counts a not-there check made away from the place", () => {
      const checks = [check("dev-b", false, false)];
      expect(newPlaceStanding(place({ checks, reports: [report("dev-c")] }))).toBe("hidden");
    });
  });

  describe("the contributor", () => {
    it("hides every place from a blocked contributor, confirmed or not", () => {
      const contributor = { device: ADDER, blocked: true, firstPlace: false };
      expect(newPlaceStanding(place({ contributor }))).toBe("hidden");
      expect(newPlaceStanding(place({ contributor, checks: CONFIRMING }))).toBe("hidden");
    });

    it("shows a first place from a new contributor straight away", () => {
      expect(newPlaceStanding(place({ contributor: { device: ADDER, blocked: false, firstPlace: true } }))).toBe("shown");
    });
  });

  describe("duplicates", () => {
    const duplicateOf = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";

    it("holds a possible duplicate, even once confirmed", () => {
      expect(newPlaceStanding(place({ duplicateOf }))).toBe("held");
      expect(newPlaceStanding(place({ duplicateOf, checks: CONFIRMING }))).toBe("held");
    });

    it("hides a reported duplicate", () => {
      expect(newPlaceStanding(place({ duplicateOf, reports: [report("dev-b"), report("dev-c")] }))).toBe("hidden");
    });
  });

  describe("a moderator", () => {
    const REPORTED = [report("dev-d", "fake", "2026-11-02"), report("dev-e", "offensive", "2026-11-02")];

    it("hides a place nobody reported", () => {
      expect(newPlaceStanding(place({ moderator: { action: "hide", at: after(30) }, checks: CONFIRMING }))).toBe("hidden");
    });

    it("restores a hidden place and ignores the reports so far", () => {
      expect(newPlaceStanding(place({ reports: REPORTED, moderator: { action: "restore", at: "2026-11-02T12:00:00Z" } }))).toBe("shown");
    });

    it("restores a hidden place as confirmed when it has its checks", () => {
      const reports = [...REPORTED, report("dev-f")];
      const moderator = { action: "restore" as const, at: "2026-11-02T12:00:00Z" };
      expect(newPlaceStanding(place({ checks: CONFIRMING, reports, moderator }))).toBe("confirmed");
    });

    it("ignores not-there checks made before a restore", () => {
      const checks = [check("dev-b", false), check("dev-c", false)];
      expect(newPlaceStanding(place({ checks, moderator: { action: "restore", at: "2026-11-02T12:00:00Z" } }))).toBe("shown");
    });

    it("counts reports made after a restore", () => {
      const reports = [...REPORTED, report("dev-f", "fake", "2026-11-03"), report("dev-g", "fake", "2026-11-04")];
      const moderator = { action: "restore" as const, at: "2026-11-02T12:00:00Z" };
      expect(newPlaceStanding(place({ reports, moderator, now: "2026-11-05T00:00:00Z" }))).toBe("hidden");
    });

    it("restores a place from a blocked contributor", () => {
      const contributor = { device: ADDER, blocked: true, firstPlace: false };
      expect(newPlaceStanding(place({ contributor, moderator: { action: "restore", at: after(30) } }))).toBe("shown");
    });

    it("restores a held duplicate", () => {
      const duplicateOf = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
      expect(newPlaceStanding(place({ duplicateOf, moderator: { action: "restore", at: after(30) } }))).toBe("shown");
    });

    it("can't bring back a place the adder withdrew", () => {
      expect(newPlaceStanding(place({ withdrawnAt: after(2), moderator: { action: "restore", at: after(30) } }))).toBe("withdrawn");
    });
  });

  it("ignores what happens after now", () => {
    const later = { now: "2026-11-02T00:00:00Z" };
    expect(newPlaceStanding(place({ ...later, reports: [report("dev-b"), report("dev-c", "fake", "2026-11-03")] }))).toBe("shown");
    expect(newPlaceStanding(place({ ...later, moderator: { action: "hide", at: "2026-11-02T06:00:00Z" } }))).toBe("shown");
  });
});
