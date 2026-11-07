import { describe, expect, it } from "vitest";
import { isOpeningHours, openingHoursProblem } from "../src/hours.js";

describe("openingHoursProblem", () => {
  // Examples from the OSM opening_hours specification and key pages.
  it.each([
    "24/7",
    "Mo-Fr 08:00-17:00",
    "Mo-Su 06:00-22:00",
    "Mo-Fr 08:00-12:00,13:00-17:00",
    "Mo-Sa 09:00-12:00; We 15:00-18:00",
    "Mo-Sa 09:00-12:00, We 15:00-18:00",
    // Two rules: Monday all day, and Wednesday's hours.
    "Mo, We 08:00-12:00",
    "Sa 16:00-03:00, Su 16:00-23:00",
    "Fr,Sa 22:00-04:00",
    "Mo-Fr 08:00-17:00; PH off",
    "Mo-Fr 08:00-17:00; Sa,Su,PH 09:00-12:00",
    "PH,Sa,Su 09:00-12:00",
    "SH Mo-Fr 10:00-16:00",
    "18:00+",
    "18:00-22:00+",
    "Mo-Fr 22:00-26:00",
    "sunrise-sunset",
    "(sunrise+01:00)-(sunset-00:30)",
    "Su[1] 10:00-12:00",
    "Su[-1] 10:00-12:00",
    "Th[1,3] 09:00-11:00",
    "PH +1 day off",
    "Jan-Mar 10:00-16:00",
    "Dec-Feb off",
    "Oct-Mar Mo-Fr 08:00-16:00; Apr-Sep Mo-Su 07:00-19:00",
    "Dec 25 off",
    "Jan 01-Feb 03 10:00-16:00",
    "Dec 24-26 off",
    "easter off",
    "easter +1 day off",
    "easter-Jun 01 off",
    "Jan Su[1] off",
    "Jan 01-03 off",
    "2026 Jan 01-2026 Mar 31 10:00-16:00",
    "2026-2028 Mo-Fr 08:00-17:00",
    "2026+ Mo-Fr 08:00-17:00",
    "week 01-53/2 Fr 09:00-12:00",
    "Jan-Mar: Mo-Fr 08:00-17:00",
    '"only when the gate is open": Mo-Su 08:00-17:00',
    'Mo-Sa "on appointment"',
    'Mo-Sa 08:00-13:00,14:00-17:00 || "on appointment"',
    'Mo-Sa 08:00-13:00,14:00-17:00 unknown "not on bad weather days!"',
    "Mo-Fr 08:00-09:00 open, Mo-Fr 09:00-16:00 closed",
    "off",
    'closed "for renovation"',
  ])("accepts %s", (value) => {
    expect(openingHoursProblem(value)).toBeNull();
    expect(isOpeningHours(value)).toBe(true);
  });

  it.each([
    ["Mon-Sun  06:00 - 22:00", "two letters"],
    ["Monday to Friday 8am-5pm", "two letters"],
    ["8am-5pm", "24 hour"],
    ["08.00-17.00", "HH:MM"],
    ["0800-1700", "HH:MM"],
    ["Mo-Fr 8:00-17:00", "HH:MM"],
    ["Mo-Fr 08:00 - 17:00", "no spaces around the dash"],
    ["Mo-Fr  08:00-17:00", "single spaces"],
    [" 24/7", "single spaces"],
    ["Mo-Fr 08:00-17:00;", 'at character 18 (";")'],
    ["Mo-Fr 25:00-26:00", "at character"],
    ["Mo-Fr 08:60-17:00", "at character"],
    ["Mo-Fr 08:00", "at the end"],
    ["10:00-16:00/90", "at character"],
    ["Su[6] 10:00-12:00", "at character"],
    ["Feb 32 off", "at character"],
    ["open all hours", "at character"],
    ['Mo "unclosed', "at character"],
    // The specification allows these, but opening_hours.js cannot read them.
    ["Apr 01+ Mo-Fr 08:00-17:00", "at character"],
    ["Jul 01 +Su 10:00-12:00", "at character"],
    ["Dec 25 +1 day off", "at character"],
  ])("refuses %s", (value, reason) => {
    const problem = openingHoursProblem(value);
    expect(problem).toMatch(/^not OSM opening_hours syntax/);
    expect(problem).toContain(reason);
    expect(isOpeningHours(value)).toBe(false);
  });

  it("names where the value stopped fitting", () => {
    expect(openingHoursProblem("Mo-Fr 08:00-17:00; Sat 09:00-12:00")).toBe(
      'not OSM opening_hours syntax at character 22 ("t 09:00-12:0"): write weekdays as two letters: Mo Tu We Th Fr Sa Su',
    );
  });

  it("refuses an empty value and anything that is not text", () => {
    expect(openingHoursProblem("")).toBe("empty");
    expect(isOpeningHours(42)).toBe(false);
  });
});
