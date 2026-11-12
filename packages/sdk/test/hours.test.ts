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

  // opening_hours.js takes any spacing between the parts of a value, a comma
  // between rules, day lists and day offsets on nth weekday dates, and these
  // are all in OSM's Australian values.
  it.each([
    "Mo-Fr 08:00 - 17:00",
    "Mo - Su 00:00 - 23:59",
    "Mo-Fr 08:30 -16:00; Sa, Su closed",
    "Tu-Sa  09:00-13:00; Su 10:00-14:00",
    " 24/7",
    "Mo-Fr 06:00-19:00;Sa-Su 08:00-16:00",
    "Su06:00-20:00",
    "Su [1] 10:00-15:00",
    "Mo-Fr 08:00-17:00,Sa 08:00-14:00",
    "Mo-Su 09:00-17:00,Dec 24 off",
    "Mo-Sa 10:30-18:00+,PH,Su 09:00-18:00+",
    "Mo-Su 11:30+; Dec 25,26 off",
    "Dec 25-26,28 off",
    "Mo-Su 10:00-16:00; easter -2 days off; Dec 25-26, Jan 1 off",
    "Mo-Su 09:00-17:00; Dec 25 off; easter - 2 days off",
    "Dec 25,easter -2 days off",
    "Oct,Mar 07:00-18:00; Nov,Feb 07:00-19:00",
    "Mar 07: 10:00-12:00",
    "Apr Su[1]-Oct Su[1] -1 day 07:00-19:00",
    "Oct Su[1]-Apr Su[1] -1 day 07:00-19:00 open || 08:00-17:00 open",
    "Dec 1-Feb 28: 05:30-21:30,Mar 1- Nov 30: 05:30-20:00",
    "Feb 29 off",
    "Apr-Oct: off",
    "2026 Dec 25-2027 Jan 01 off",
    "20:00-02:00+",
    "22:00-26:00+",
    "Mo 10:00-12:00, 14:00-16:00 off",
  ])("accepts %s, as opening_hours.js does", (value) => {
    expect(openingHoursProblem(value)).toBeNull();
  });

  // opening_hours.js refuses each of these, so the check does too.
  it.each([
    "Mo-Su, 08:00-22:00",
    "Su, off",
    "24/7, Mo off",
    "Apr Su[1],Oct Su[1] off",
    "Dec 25-Jan 01,05 off",
    "Jan,easter off",
    "Apr 31 off",
    "Apr 30-31 off",
    "Feb 30 off",
    "Dec 0 off",
    "Dec 25,26-24 off",
    "Dec 25 -1 day off",
    "Apr Su[1]-Oct 31 -1 day off",
    "easter -201 days off",
    "PH +2 days off",
    "Su[1] +7 days 10:00-12:00",
    "20:00-18:00+",
    "10:00-41:00+",
    "24:30-26:00",
    "Mo-Fr 08:00-48:30",
    "2026 Dec 25-Jan 01 off",
    "2026Feb 01-Nov 30 off",
    "Apr-Oct:",
    "MoFr 08:00-17:00",
    "PH Mooff",
    "Jan 0101 off",
    "24 /7",
  ])("refuses %s, as opening_hours.js does", (value) => {
    expect(openingHoursProblem(value)).toMatch(/^not OSM opening_hours syntax/);
  });

  it.each([
    ["Mon-Sun  06:00 - 22:00", "two letters"],
    ["Monday to Friday 8am-5pm", "two letters"],
    ["8am-5pm", "24 hour"],
    ["08.00-17.00", "HH:MM"],
    ["0800-1700", "HH:MM"],
    ["Mo-Fr 8:00-17:00", "HH:MM"],
    ["Mo-Fr 08:00-17:00;", "at the end"],
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
      'not OSM opening_hours syntax at character 20 ("Sat 09:00-12"): write weekdays as two letters: Mo Tu We Th Fr Sa Su',
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

  it("reads a date range of whole months as a month range", () => {
    expect(openMonths("Feb 01-Nov 30")).toBe("Feb-Nov");
    expect(openMonths("Apr 01-Oct 31")).toBe("Apr-Oct");
    expect(openMonths("Feb 1-Nov 30 Mo-Fr 08:00-17:00")).toBe("Feb-Nov");
    expect(openMonths("Oct 1-Mar 31: Sa,Su 12:00-19:00")).toBe("Oct-Mar");
    expect(openMonths("Dec 01-Jan 31 07:00-19:00")).toBe("Dec-Jan");
  });

  it("takes Feb 28 or Feb 29 as the end of February", () => {
    expect(openMonths("Dec 01-Feb 28")).toBe("Dec-Feb");
    expect(openMonths("Dec 01-Feb 29 Sa,Su")).toBe("Dec-Feb");
  });

  it("reads a month range on its own that is closed as the months around it", () => {
    expect(openMonths("Feb-Apr closed")).toBe("May-Jan");
    expect(openMonths("Feb-Apr off")).toBe("May-Jan");
    expect(openMonths("Jun-Aug off")).toBe("Sep-May");
    expect(openMonths("Dec-Feb closed")).toBe("Mar-Nov");
    expect(openMonths("Jan-Oct off")).toBe("Nov-Dec");
    expect(openMonths("May 01-Aug 31 off")).toBe("Sep-Apr");
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
    "Feb-Apr off; Mo-Fr 08:00-17:00",
    "Mo-Fr 08:00-17:00; Feb-Apr off",
    // Unknown, comments, and closed months with anything more.
    "Apr-Oct unknown",
    'Apr-Oct "ring ahead"',
    'Feb-Apr closed "for the wet"',
    "Feb-Apr Mo-Fr off",
    "Feb-Apr: off",
    // Closed for all but one month, or all year.
    "Jan-Nov off",
    "Feb-Jan off",
    "Apr-Apr off",
    // Dates that are not whole months.
    "Apr 02-Oct 31",
    "Apr 01-Oct 30",
    "Dec 01-Feb 27",
    "Apr 01-Apr 30",
    "Apr 01-31",
    "2026 Apr 01-2026 Oct 31",
    // Week numbers, years, dates and holidays.
    "week 14-44",
    "2026 Apr-Oct",
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

  it("replaces a date range of whole months or closed months already there with a month range", () => {
    expect(withOpenMonths("Feb 01-Nov 30 Mo-Fr 08:00-17:00", "Mar-Oct")).toBe("Mar-Oct Mo-Fr 08:00-17:00");
    expect(withOpenMonths("Feb-Apr closed", "May-Jan")).toBe("May-Jan");
    expect(withOpenMonths("Feb-Apr off", "Jun-Sep")).toBe("Jun-Sep");
  });

  it.each(["Feb 01-Nov 30 Mo-Fr 08:00-17:00", "Oct 1-Mar 31: Sa,Su 12:00-19:00", "Dec 01-Feb 28", "Feb-Apr closed", "May 01-Aug 31 off"])(
    "writes the months openMonths reads from %j back as the same months",
    (hours) => {
      const range = openMonths(hours)!;
      const written = withOpenMonths(hours, range);
      expect(openMonths(written)).toBe(range);
      expect(withoutOpenMonths(written)).toBe(withoutOpenMonths(hours));
    },
  );

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

  it("takes a date range of whole months off the front of the weekly hours", () => {
    expect(withoutOpenMonths("Feb 01-Nov 30 Mo-Fr 08:00-17:00")).toBe("Mo-Fr 08:00-17:00");
    expect(withoutOpenMonths("Oct 1-Mar 31: Sa,Su 12:00-19:00")).toBe("Sa,Su 12:00-19:00");
    expect(withoutOpenMonths("Dec 01-Feb 29")).toBe("");
  });

  it("gives an empty value for closed months on their own", () => {
    expect(withoutOpenMonths("Feb-Apr closed")).toBe("");
    expect(withoutOpenMonths("May 01-Aug 31 off")).toBe("");
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
