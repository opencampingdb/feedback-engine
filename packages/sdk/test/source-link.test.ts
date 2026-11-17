import { describe, expect, it } from "vitest";
import { sourceLinkProblem, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = {
  device: "3b241101-e2bb-4255-8caf-4136c566a962",
  app_version: "1.0.0",
  consent: true,
};
const report = (body: Record<string, unknown>) => validateSubmission({ ...base, type: "report", place: PLACE, report: body });
const errors = (body: Record<string, unknown>) => {
  const r = report(body);
  return r.ok ? [] : r.errors;
};

describe("source links on fact reports", () => {
  it("keeps an https source link on a fact report", () => {
    const r = report({ kind: "fact", fact: "toilets", value: true, source: "https://www.parks.vic.gov.au/places/example-camp" });
    expect(r).toMatchObject({ ok: true, value: { report: { source: "https://www.parks.vic.gov.au/places/example-camp" } } });
  });

  it("leaves source out when the report has none", () => {
    const r = report({ kind: "fact", fact: "toilets", value: true });
    expect(r.ok && r.value.type === "report" && "source" in r.value.report).toBe(false);
  });

  it("refuses a source that is not https on a public host", () => {
    for (const source of ["http://www.parks.vic.gov.au/camp", "https://localhost/camp", "https://10.0.0.1/camp", "https://user:pw@example.gov.au/", "not a link", 42]) {
      expect(errors({ kind: "fact", fact: "toilets", value: true, source })).toEqual(["report.source must be an https address on a public website, up to 500 characters"]);
    }
    expect(errors({ kind: "fact", fact: "toilets", value: true, source: `https://example.gov.au/${"a".repeat(500)}` })).toHaveLength(1);
  });

  it("allows source only on a fact report", () => {
    expect(errors({ kind: "doubt", fact: "toilets", source: "https://example.gov.au/camp" })).toEqual(["report.source is only allowed when report.kind is fact"]);
    expect(errors({ kind: "closed", source: "https://example.gov.au/camp" })).toEqual(["report.source is only allowed when report.kind is fact"]);
  });
});

describe("sourceLinkProblem", () => {
  it("passes a .gov.au host, whatever the place's website", () => {
    expect(sourceLinkProblem("https://www.parks.nsw.gov.au/camping/example", undefined)).toBeNull();
    expect(sourceLinkProblem("https://parks.nsw.gov.au/camping/example", "https://example.org/")).toBeNull();
  });

  it("passes the host of the place's website on record, with or without www", () => {
    expect(sourceLinkProblem("https://example.org/prices", "https://example.org/")).toBeNull();
    expect(sourceLinkProblem("https://www.example.org/prices", "https://example.org/")).toBeNull();
    expect(sourceLinkProblem("https://EXAMPLE.org./prices", "https://www.example.org/home")).toBeNull();
  });

  it("refuses any other host", () => {
    const why = "must be on a .gov.au host or the place's own website";
    expect(sourceLinkProblem("https://example.org/prices", undefined)).toBe(why);
    expect(sourceLinkProblem("https://camp.example.org/prices", "https://example.org/")).toBe(why);
    expect(sourceLinkProblem("https://example.org.evil.example/prices", "https://example.org/")).toBe(why);
    expect(sourceLinkProblem("https://gov.au.example.org/", undefined)).toBe(why);
    expect(sourceLinkProblem("https://notgov.au/", undefined)).toBe(why);
  });

  it("refuses a source that is not public https", () => {
    expect(sourceLinkProblem("http://example.gov.au/", undefined)).toBe("must be an https address on a public website");
  });
});
