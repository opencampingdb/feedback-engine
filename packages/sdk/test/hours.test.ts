import { describe, expect, it } from "vitest";
import { isOpeningHours, openingHoursProblem, openMonths, withOpenMonths, withoutOpenMonths } from "../src/index.js";

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

describe("openMonths", () => {
  it("reads a month range on its own", () => {
    expect(openMonths("Apr-Oct")).toBe("Apr-Oct");
  });

  it("reads a month range that runs across the year end", () => {
    expect(openMonths("Dec-Feb")).toBe("Dec-Feb");
  });

  it("reads a month range followed by the days and times that apply in it", () => {
    expect(openMonths("Apr-Oct Mo-Su 08:00-18:00")).toBe("Apr-Oct");
    expect(openMonths("Apr-Oct: Mo-Fr 08:00-12:00,13:00-17:00")).toBe("Apr-Oct");
    expect(openMonths("Nov-Mar Sa,Su")).toBe("Nov-Mar");
    expect(openMonths("May-Sep 07:00-19:00")).toBe("May-Sep");
  });

  it.each([
    // Times only, and sunrise or sunset, say nothing about the months.
    "Mo-Fr 08:00-17:00",
    "24/7",
    "sunrise-sunset",
    "Apr-Oct sunrise-sunset",
    // More than one month range, or more than one rule.
    "Jan-Mar,Jun-Aug",
    "Apr-Oct Mo-Su 08:00-18:00; Nov-Mar Sa,Su 09:00-12:00",
    "Apr-Oct; PH off",
    "Apr-Oct, Dec 25 off",
    // Closed or unknown, and comments.
    "Apr-Oct off",
    "Apr-Oct closed",
    "Apr-Oct unknown",
    'Apr-Oct "ring ahead"',
    // Week numbers, years, dates and holidays.
    "week 14-44",
    "2026 Apr-Oct",
    "Apr 01-Oct 31",
    "Apr-Oct PH",
    "Apr-Oct Su[1] 10:00-12:00",
    "Apr-Oct 18:00+",
    // A single month, the same month twice, and values that aren't OSM syntax.
    "Jul",
    "Apr-Apr",
    "Apr-Oct:",
    "Apr-Oct 25:00-26:00",
    "apr-oct",
    " Apr-Oct",
    "",
  ])("answers null for %j", (value) => {
    expect(openMonths(value)).toBeNull();
  });
});

describe("withOpenMonths", () => {
  it("writes a month range on its own when there are no hours yet", () => {
    expect(withOpenMonths("", "Apr-Oct")).toBe("Apr-Oct");
  });

  it("puts the month range in front of the weekly hours", () => {
    expect(withOpenMonths("Mo-Su 08:00-18:00", "Apr-Oct")).toBe("Apr-Oct Mo-Su 08:00-18:00");
    expect(withOpenMonths("Sa,Su", "Dec-Feb")).toBe("Dec-Feb Sa,Su");
    expect(withOpenMonths("07:00-19:00", "May-Sep")).toBe("May-Sep 07:00-19:00");
  });

  it("replaces a month range already there", () => {
    expect(withOpenMonths("Apr-Oct Mo-Fr 09:00-17:00", "May-Sep")).toBe("May-Sep Mo-Fr 09:00-17:00");
    expect(withOpenMonths("Apr-Oct: Mo-Fr 09:00-17:00", "Nov-Mar")).toBe("Nov-Mar Mo-Fr 09:00-17:00");
    expect(withOpenMonths("Apr-Oct", "Dec-Feb")).toBe("Dec-Feb");
  });

  it.each(["", "Apr", "Apr-Apr", "apr-oct", "Apr-Oct ", "Jan-Mar,Jun-Aug", "Apr 01-Oct 31"])(
    "throws a RangeError for the range %j",
    (range) => {
      expect(() => withOpenMonths("Mo-Su 08:00-18:00", range)).toThrow(RangeError);
    },
  );

  it.each([
    "Mo-Fr 08:00-17:00; Sa 09:00-12:00",
    "Apr-Oct Mo-Su 08:00-18:00; Nov-Mar Sa,Su 09:00-12:00",
    "sunrise-sunset",
    "Mo-Su sunrise-sunset",
    "Apr-Oct sunrise-sunset",
    '"ring ahead"',
    'Mo-Fr 08:00-17:00 "ring ahead"',
    "PH off",
    "Mo-Fr,PH 08:00-17:00",
    "Mo-Fr off",
    "24/7",
    "18:00+",
    "Su[1] 10:00-12:00",
    "Jan-Mar,Jun-Aug",
    "2026 Apr-Oct",
    "Mo-Su 25:00-26:00",
    "Mon-Sun 08:00-18:00",
    " Mo-Fr 08:00-17:00",
  ])("throws a RangeError for the hours %j", (hours) => {
    expect(() => withOpenMonths(hours, "Apr-Oct")).toThrow(RangeError);
  });

  const weekly = ["", "Mo-Su 08:00-18:00", "Mo-Fr 08:00-12:00,13:00-17:00", "Sa,Su", "Mo,We-Fr", "07:00-19:00"];
  const ranges = ["Apr-Oct", "Dec-Feb", "Jan-Dec", "Nov-Mar"];
  const pairs = weekly.flatMap((h) => ranges.map((r) => [h, r] as const));

  it.each(pairs)("writes %j with %j as hours openMonths reads back", (hours, range) => {
    const written = withOpenMonths(hours, range);
    expect(openingHoursProblem(written)).toBeNull();
    expect(openMonths(written)).toBe(range);
    expect(withoutOpenMonths(written)).toBe(hours);
    expect(withOpenMonths(written, range)).toBe(written);
  });
});

describe("withoutOpenMonths", () => {
  it("takes the month range off the front of the weekly hours", () => {
    expect(withoutOpenMonths("Apr-Oct Mo-Su 08:00-18:00")).toBe("Mo-Su 08:00-18:00");
    expect(withoutOpenMonths("Apr-Oct: Mo-Fr 08:00-12:00,13:00-17:00")).toBe("Mo-Fr 08:00-12:00,13:00-17:00");
    expect(withoutOpenMonths("May-Sep 07:00-19:00")).toBe("07:00-19:00");
  });

  it("gives an empty value for a month range on its own", () => {
    expect(withoutOpenMonths("Dec-Feb")).toBe("");
  });

  it.each([
    "Mo-Fr 08:00-17:00",
    "Apr-Oct sunrise-sunset",
    "Apr-Oct Mo-Su 08:00-18:00; Nov-Mar Sa,Su 09:00-12:00",
    "Apr-Oct; PH off",
    'Apr-Oct "ring ahead"',
    "Jan-Mar,Jun-Aug",
    "Apr-Apr",
    "apr-oct",
    "",
  ])("leaves %j unchanged", (hours) => {
    expect(withoutOpenMonths(hours)).toBe(hours);
  });
});
