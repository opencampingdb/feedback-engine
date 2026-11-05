import { describe, expect, it } from "vitest";
import { HELD_REASONS, REPORT_KINDS, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };
const report = (report: Record<string, unknown>, place: string | null = PLACE) => validateSubmission({ ...base, type: "report", place, report });

describe("commons_mismatch reports", () => {
  it("names the place and the Commons file that is not of it", () => {
    expect(REPORT_KINDS).toContain("commons_mismatch");
    expect(report({ kind: "commons_mismatch", file: "Brunswick River and Pool Precinct 6.jpg", note: "This is the town pool" })).toEqual({
      ok: true,
      value: { ...base, type: "report", place: PLACE, report: { kind: "commons_mismatch", file: "Brunswick River and Pool Precinct 6.jpg", note: "This is the town pool" } },
    });
  });

  it("needs a file name of 1 to 255 characters on one line, and the place", () => {
    const errors = ["report.file must be the Commons file name, 1 to 255 characters on one line"];
    for (const file of [undefined, "", " ", "a".repeat(256), "Two\nlines.jpg", 7]) expect(report({ kind: "commons_mismatch", file })).toEqual({ ok: false, errors });
    expect(report({ kind: "commons_mismatch", file: "Pool.jpg" }, null)).toEqual({ ok: false, errors: ["place is required unless report.kind is new_place"] });
  });

  it("refuses a file on any other kind, and a fact, value or reason on this one", () => {
    expect(report({ kind: "closed", file: "Pool.jpg" })).toEqual({ ok: false, errors: ["report.file is only allowed when report.kind is commons_mismatch"] });
    expect(report({ kind: "commons_mismatch", file: "Pool.jpg", reason: "wrong" }).ok).toBe(false);
    expect(report({ kind: "commons_mismatch", file: "Pool.jpg", fact: "toilets", value: true }).ok).toBe(false);
  });

  it("is answered held with its own code", () => {
    expect(HELD_REASONS).toContain("commons_report");
  });
});
