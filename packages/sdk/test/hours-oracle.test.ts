/**
 * Holds the SDK's opening hours check to opening_hours.js 3.15, the reference
 * implementation the OSM wiki names, over every distinct opening_hours value
 * in the Australian extract (test/fixtures/opening-hours-au.json).
 *
 * The reference runs with an Australian locale: country code `au`, state New
 * South Wales, which it has public holiday data for. It has no Australian
 * school holiday data, so it refuses any value with `SH`. The SDK accepts
 * those values when the rest of the value is valid, so a value the reference
 * refuses only for missing school holidays counts as accepted.
 */

import { readFileSync } from "node:fs";
import OpeningHours from "opening_hours";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openingHoursProblem } from "../src/index.js";

const values: string[] = JSON.parse(readFileSync(new URL("./fixtures/opening-hours-au.json", import.meta.url), "utf8"));

const LOCALE = { lat: -33.87, lon: 151.21, address: { country_code: "au", state: "New South Wales" } };

/** The reference's reason for refusing the value, or null when it accepts it. */
function referenceProblem(value: string): string | null {
  try {
    new OpeningHours(value, LOCALE);
    return null;
  } catch (e) {
    return String(e instanceof Error ? e.message : e).split("\n")[0] ?? "refused";
  }
}

/** True when the reference accepts the value, or refuses it only for want of school holiday data. */
function referenceAccepts(value: string): boolean {
  const problem = referenceProblem(value);
  return problem === null || /no holidays \(SH\) defined/.test(problem);
}

describe("openingHoursProblem against opening_hours.js", () => {
  // opening_hours.js logs each value it can't find school holidays for.
  beforeAll(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it("has the distinct Australian values to check", () => {
    expect(values.length).toBe(1986);
    expect(new Set(values).size).toBe(values.length);
  });

  it("accepts a value exactly when the reference does", () => {
    const disagree = values
      .filter((v) => (openingHoursProblem(v) === null) !== referenceAccepts(v))
      .map((v) => ({ value: v, sdk: openingHoursProblem(v), reference: referenceProblem(v) }));
    expect(disagree).toEqual([]);
  });

  it("counts a value refused only for missing school holiday data as accepted", () => {
    const sh = values.filter((v) => referenceProblem(v) !== null && referenceAccepts(v));
    expect(sh.length).toBe(9);
    for (const v of sh) expect(openingHoursProblem(v)).toBeNull();
  });

  it("finds every Australian value valid, as the reference does", () => {
    expect(values.filter((v) => !referenceAccepts(v))).toEqual([]);
    expect(values.filter((v) => openingHoursProblem(v) !== null)).toEqual([]);
  });
});
