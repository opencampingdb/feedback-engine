/**
 * Values the SDK once accepted and opening_hours.js 3.15 refuses, and a short
 * seeded differential run against opening_hours.js, so that "every value the
 * check accepts parses in opening_hours.js" stays true.
 */
import { readFileSync } from "node:fs";
import OpeningHours from "opening_hours";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FACTS, openingHoursProblem } from "../src/index.js";

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
const referenceAccepts = (value: string) => {
  const problem = referenceProblem(value);
  return problem === null || /no holidays \(SH\) defined/.test(problem);
};

const REFUSED: [string, string][] = [
  ["a year range that ends in the year it starts", "2026-2026"],
  ["a year range that runs backwards", "2027-2026 Mo-Fr 08:00-17:00"],
  ["an nth weekday range that runs backwards", "Su[2-1] 13:00-16:00"],
  ["a month with a list of nth weekdays", "Jun Th[1,3] 10:00-12:00"],
  ["a year in front of a month and times", "2027 Feb 08:00-17:00"],
  ["a year inside a month list", "Jan,2027 Nov"],
  ["a week range over the year end", "week 53-01"],
  ["an open end after a sunrise or sunset start", "Mo-Su dusk-18:00+"],
  ["an easter offset that leaves the year", "easter -152 days-easter +1 day"],
  ["a year in front of an easter range", "2027 easter -2 days-easter +1 day"],
  ["a month list, then a day and times", "Dec,Feb 28: 05:30-21:30"],
];

// Close neighbours of the refused values that the reference accepts, so tightening a rule does not refuse them.
const ACCEPTED = [
  "2026-2027",
  "2026-2027 Mo-Fr 08:00-17:00",
  "Su[1-2] 13:00-16:00",
  "Th[1,3] 10:00-12:00",
  "Jun Th[1] 10:00-12:00",
  "2027 Feb",
  "2027 Feb 01-28 08:00-17:00",
  "2027 Jan-Feb 08:00-17:00",
  "2027 easter-2027 easter +1 day",
  "Dec,Feb 01-28: 05:30-21:30",
  "Jan,Jun Th[1,3]",
  "Jun-Jul Th[1,3]",
  "dusk-18:30+",
  "Mo-Su sunrise-18:00+",
  "Jan,Nov",
  "week 01-53",
  "week 50-53",
  "Mo-Su sunrise-18:00",
  "Mo-Su 08:00-dusk",
  "Mo-Su 18:00+",
  "easter -2 days-easter +1 day",
  "easter",
  "Dec 28: 05:30-21:30",
  "Dec 25,Feb 28: 05:30-21:30",
];

const TOKENS = [
  "Mo", "Tu", "We", "Th", "Fr", "Sa", "Su", "PH", "SH", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  "08:00", "17:00", "00:00", "24:00", "26:00", "48:00", "12:30", "23:59", "sunrise", "sunset", "dawn", "dusk", "easter", "week", "24/7",
  "open", "off", "closed", "unknown", '"x"', '"by appointment"', "day", "days", "2026", "2027", "1", "2", "5", "01", "15", "28", "29", "30", "31", "53",
  "-", "-", "-", ",", ",", ";", "; ", " ", " ", " ", ":", "+", "[", "]", "(", ")", "/", "||", " || ", "-1", "[1]", "[-1]", "[1,3]", "+1 day", "-2 days",
];

/** A small seeded generator, so a run repeats exactly. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("openingHoursProblem agrees with opening_hours.js", () => {
  // opening_hours.js logs each value it can't find school holidays for.
  beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterAll(() => vi.restoreAllMocks());

  for (const [what, value] of REFUSED) {
    it(`refuses ${what}: ${value}`, () => {
      expect(referenceProblem(value)).not.toBeNull();
      expect(FACTS.opening_hours(value)).toBe(false);
      expect(openingHoursProblem(value)).not.toBeNull();
    });
  }

  it("accepts the close neighbours the reference accepts", () => {
    expect(ACCEPTED.filter((v) => !referenceAccepts(v))).toEqual([]);
    expect(ACCEPTED.map((v) => [v, openingHoursProblem(v)]).filter(([, problem]) => problem !== null)).toEqual([]);
  });

  it("accepts nothing the reference refuses, over a seeded run of generated and edited values", () => {
    const fixtures: string[] = JSON.parse(readFileSync(new URL("./fixtures/opening-hours-au.json", import.meta.url), "utf8"));
    const random = rng(20261112);
    const pick = <T,>(list: readonly T[]) => list[Math.floor(random() * list.length)]!;
    const refused: string[] = [];
    const tryValue = (value: string) => {
      if (value.length === 0 || value.length > 100) return;
      if (openingHoursProblem(value) === null && !referenceAccepts(value)) refused.push(value);
    };
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 500; i++) {
        let v = "";
        const n = 1 + Math.floor(random() * 9);
        for (let k = 0; k < n; k++) v += pick(TOKENS);
        tryValue(v.trim());
      }
      for (let i = 0; i < 500; i++) {
        let v = pick(fixtures);
        const edits = 1 + Math.floor(random() * 3);
        for (let k = 0; k < edits; k++) {
          const at = Math.floor(random() * (v.length + 1));
          const kind = random();
          if (kind < 0.4) v = v.slice(0, at) + pick(TOKENS) + v.slice(at);
          else if (kind < 0.7) v = v.slice(0, at) + v.slice(at + 1 + Math.floor(random() * 3));
          else v = v.slice(0, at) + pick(TOKENS) + v.slice(at + 1 + Math.floor(random() * 3));
        }
        tryValue(v);
      }
    }
    expect(refused).toEqual([]);
  }, 60_000);
});
