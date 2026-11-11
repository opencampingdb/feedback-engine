/**
 * Checks an opening hours value against the OSM opening_hours grammar,
 * specification 0.7.4 (wiki.openstreetmap.org/wiki/Key:opening_hours/specification),
 * as opening_hours.js 3.15 reads it. opening_hours.js is the reference
 * implementation the OSM wiki names, and the OSM editors and most apps read
 * hours with it.
 *
 * Every value the check accepts parses in opening_hours.js, and it accepts
 * every Australian value in OSM that opening_hours.js accepts (a test holds
 * it to that). Like opening_hours.js, it takes any number of spaces between
 * the parts of a value, or none where a word does not run into another word:
 * `Mo-Fr 08:00 - 17:00`, `Mo-Fr 08:00-17:00;Sa 09:00-12:00` and
 * `Sa, Su closed` are accepted. A comma joins list items where the next item
 * fits the list, and otherwise starts a new rule, so
 * `Mo-Fr 08:00-17:00,Sa 09:00-12:00` is two rules. A date takes a day list
 * in its month (`Dec 25,26`), a day of one or two digits (`Jan 1`), and a
 * date given as an nth weekday takes a day offset
 * (`Apr Su[1]-Oct Su[1] -1 day`).
 *
 * It checks the opening hours mode of the grammar: the point in time forms
 * (a time on its own, and `10:00-16:00/90`) belong to tags such as
 * `collection_times` and are refused. A plain date takes no `+Su` or
 * `+1 day` offset and no open end such as `Apr 01+`, as in opening_hours.js.
 * A comma rule separator follows only times, a modifier or a comment, as in
 * opening_hours.js. It does not take forms opening_hours.js reads leniently,
 * most of them with a warning: weekday and month names in other forms
 * (`Mon`, `monday`, `apr`), `am` and `pm`, times such as `8:00` or `08.00`,
 * a rule separator at the end, and selectors out of the grammar's order.
 */

import { isMonthRange } from "./validate.js";

const WDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** The last day of each month, with Feb 29 allowed. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const EVENTS = ["sunrise", "sunset", "dawn", "dusk"] as const;
/** Minutes in a day. */
const DAY = 24 * 60;

class Parser {
  pos = 0;
  /** The furthest character any attempt reached, for the reason given back. */
  furthest = 0;
  /** The month of the last date read as a day or same month day range, which a following `,DD` continues, or null. */
  private dayListMonth: number | null = null;
  /** The day of the last plain date read, where a bare end day such as the `26` of `Dec 25-26` starts. */
  private lastDay = 1;
  /** Whether the last date read had a year in front of it. */
  private lastHadYear = false;
  /** Whether the last date read was an nth weekday such as `Apr Su[1]`. */
  private lastNthWeekday = false;
  /** Whether the last date range read was one nth weekday date, which ends a list. */
  private endsList = false;
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private mark(): number {
    if (this.pos > this.furthest) this.furthest = this.pos;
    return this.pos;
  }

  /** Runs `fn`, and puts the position back when it fails. */
  private attempt(fn: () => boolean): boolean {
    const start = this.mark();
    const month = this.dayListMonth;
    if (fn()) {
      this.mark();
      return true;
    }
    this.mark();
    this.pos = start;
    this.dayListMonth = month;
    return false;
  }

  /** Skips spaces, which may stand between any two parts of a value. */
  private ws(): void {
    while (this.text[this.pos] === " ") this.pos++;
  }

  /** The next part, after any spaces. A word does not match the start of a longer word. */
  private lit(word: string): boolean {
    const start = this.pos;
    this.ws();
    if (this.text.startsWith(word, this.pos)) {
      const end = this.pos + word.length;
      if (!(/[A-Za-z]$/.test(word) && /[A-Za-z]/.test(this.text[end] ?? ""))) {
        this.pos = end;
        this.mark();
        return true;
      }
    }
    this.pos = start;
    return false;
  }

  private oneOf(words: readonly string[]): boolean {
    return words.some((w) => this.lit(w));
  }

  /** The index in `words` of the next part, or -1. */
  private indexOf(words: readonly string[]): number {
    return words.findIndex((w) => this.lit(w));
  }

  /** A run of `min` to `max` digits that is not followed by another digit, after any spaces. */
  private number(min: number, max: number): number | null {
    const start = this.pos;
    this.ws();
    const m = /^\d+/.exec(this.text.slice(this.pos));
    if (!m || m[0].length < min || m[0].length > max) {
      this.pos = start;
      return null;
    }
    this.pos += m[0].length;
    this.mark();
    return Number(m[0]);
  }

  private digits(count: number): number | null {
    return this.number(count, count);
  }

  /** An integer from 1 to `max`, not zero padded. */
  private positive(max = Infinity): boolean {
    return this.attempt(() => {
      this.ws();
      if (this.text[this.pos] === "0") return false;
      const n = this.number(1, 9);
      return n !== null && n <= max;
    });
  }

  private comment(): boolean {
    return this.attempt(() => {
      if (!this.lit('"')) return false;
      const end = this.text.indexOf('"', this.pos);
      if (end <= this.pos) return false;
      this.pos = end + 1;
      return true;
    });
  }

  private plusMinus(): boolean {
    return this.lit("+") || this.lit("-");
  }

  /** `HH:MM`, up to `max` minutes after midnight, as minutes after midnight, or null. */
  private hourMinutes(max: number): number | null {
    let minutes: number | null = null;
    this.attempt(() => {
      const h = this.digits(2);
      if (h === null || !this.lit(":")) return false;
      const m = this.digits(2);
      if (m === null || m > 59 || h * 60 + m > max) return false;
      minutes = h * 60 + m;
      return true;
    });
    return minutes;
  }

  private variableTime(): boolean {
    return (
      this.oneOf(EVENTS) ||
      this.attempt(() => this.lit("(") && this.oneOf(EVENTS) && this.plusMinus() && this.hourMinutes(DAY) !== null && this.lit(")"))
    );
  }

  /** A time a timespan starts at, before 24:00: minutes after midnight, -1 for sunrise and the like, or null. */
  private time(): number | null {
    const at = this.hourMinutes(DAY - 1);
    if (at !== null) return at;
    return this.variableTime() ? -1 : null;
  }

  /** A time a timespan ends at, up to 48:00: minutes after midnight, -1 for sunrise and the like, or null. */
  private extendedTime(): number | null {
    const at = this.hourMinutes(2 * DAY);
    if (at !== null) return at;
    return this.variableTime() ? -1 : null;
  }

  /**
   * A timespan in opening hours mode: `08:00-17:00`, `18:00-22:00+` or
   * `18:00+`. As in opening_hours.js, an open end runs on from the end time
   * for up to ten hours and may not pass a second midnight: `20:00-02:00+`
   * is accepted, `20:00-18:00+` and `10:00-41:00+` are not.
   */
  private timespan(): boolean {
    return this.attempt(() => {
      const from = this.time();
      if (from === null) return false;
      if (this.lit("+")) return true;
      if (!this.lit("-")) return false;
      const to = this.extendedTime();
      if (to === null) return false;
      if (this.lit("+") && from >= 0 && to >= 0) {
        if (to < from ? to >= 17 * 60 : to > 40 * 60) return false;
      }
      return true;
    });
  }

  private timeSelector(): boolean {
    return this.list(() => this.timespan());
  }

  /** One or more items separated by commas. */
  private list(item: () => boolean): boolean {
    if (!item()) return false;
    while (this.attempt(() => this.lit(",") && item()));
    return true;
  }

  private nth(): boolean {
    return this.oneOf(["1", "2", "3", "4", "5"]);
  }

  private nthEntry(): boolean {
    return this.attempt(() => this.lit("-") && this.nth()) || this.attempt(() => this.nth() && (this.attempt(() => this.lit("-") && this.nth()) || true));
  }

  /**
   * `+2 days`, `-1 day` and the like, of at most `max` days: opening_hours.js
   * takes 1 from a holiday, 6 from an nth weekday and under 200 from easter.
   */
  private dayOffset(max: number): boolean {
    return this.attempt(() => this.plusMinus() && this.positive(max) && (this.lit("days") || this.lit("day")));
  }

  private weekdayRange(): boolean {
    return this.attempt(() => {
      if (!this.oneOf(WDAYS)) return false;
      if (this.attempt(() => this.lit("-") && this.oneOf(WDAYS))) return true;
      if (this.attempt(() => this.lit("[") && this.list(() => this.nthEntry()) && this.lit("]"))) {
        this.dayOffset(6);
      }
      return true;
    });
  }

  private holiday(): boolean {
    return this.attempt(() => this.lit("PH") && (this.dayOffset(1) || true)) || this.lit("SH");
  }

  /** Weekdays, holidays, or both: `Mo-Fr`, `PH`, `PH,Sa,Su`, `Sa,Su,PH` or `PH Mo`. */
  private weekdaySelector(): boolean {
    return this.attempt(() => {
      const holidaysFirst = this.list(() => this.holiday());
      if (holidaysFirst) {
        if (this.attempt(() => this.lit(",") && this.list(() => this.weekdayRange()))) return true;
        this.list(() => this.weekdayRange());
        return true;
      }
      if (!this.list(() => this.weekdayRange())) return false;
      this.attempt(() => this.lit(",") && this.list(() => this.holiday()));
      return true;
    });
  }

  private year(): boolean {
    return this.attempt(() => {
      const y = this.digits(4);
      // A year is never followed by `:`, which would make it a time, or straight by a letter.
      return y !== null && y > 1900 && !/[A-Za-z]/.test(this.text[this.pos] ?? "") && !this.lit(":");
    });
  }

  /** A year selector. A single year in front of a month belongs to the date or month range instead. */
  private yearRange(): boolean {
    return this.attempt(() => {
      if (!this.year()) return false;
      if (this.lit("+")) return true;
      if (this.attempt(() => this.lit("-") && this.year() && (this.attempt(() => this.lit("/") && this.positive()) || true))) return true;
      const at = this.pos;
      const month = this.indexOf(MONTHS) >= 0;
      this.pos = at;
      return !month;
    });
  }

  /**
   * A day of `month` (0 for January), one or two digits, from `from` on. Not
   * when a `:` and minutes follow, which make it the hour of a time, as in
   * `Mar 07:00-18:00`. A `:` and a time, as in `Mar 07: 10:00-12:00`, end a
   * date.
   */
  private daynum(month: number, from = 1): number | null {
    let day: number | null = null;
    this.attempt(() => {
      const d = this.number(1, 2);
      if (d === null || d < from || d > MONTH_DAYS[month]! || /^ *: *\d{2}(?! *:)/.test(this.text.slice(this.pos))) return false;
      day = d;
      return true;
    });
    return day;
  }

  /** A year in front of a date or month: true when there is one. */
  private yearPrefix(): boolean {
    return this.attempt(() => this.year());
  }

  /**
   * A date: `Dec 25`, `Apr Su[1]` (which may take a day offset) or `easter`
   * (which may take one too). Gives the month of a plain day, or -1.
   */
  private dateFrom(): number | null {
    let month: number | null = null;
    this.attempt(() => {
      this.lastHadYear = this.yearPrefix();
      this.lastNthWeekday = false;
      if (this.lit("easter")) {
        this.dayOffset(199);
        month = -1;
        return true;
      }
      const m = this.indexOf(MONTHS);
      if (m < 0) return false;
      const day = this.daynum(m);
      if (day !== null) {
        this.lastDay = day;
        month = m;
        return true;
      }
      if (!this.attempt(() => this.oneOf(WDAYS) && this.lit("[") && (this.lit("-") || true) && this.nth() && this.lit("]"))) return false;
      this.dayOffset(6);
      this.lastNthWeekday = true;
      month = -1;
      return true;
    });
    return month;
  }

  /** A date range, or a month range such as `Apr-Oct` or `Jan`. */
  private monthdayRange(): boolean {
    return (
      this.attempt(() => {
        const from = this.dateFrom();
        if (from === null) return false;
        const hadYear = this.lastHadYear;
        this.endsList = this.lastNthWeekday;
        this.dayListMonth = from >= 0 ? from : null;
        this.attempt(() => {
          if (!this.lit("-")) return false;
          // As in opening_hours.js, the end date has a year when, and only when, the start date has one.
          if (this.attempt(() => this.dateFrom() !== null && this.lastHadYear === hadYear)) {
            this.dayListMonth = null;
            this.endsList = false;
            return true;
          }
          return from >= 0 && this.daynum(from, this.lastDay) !== null;
        });
        return true;
      }) ||
      this.attempt(() => {
        this.yearPrefix();
        if (!this.oneOf(MONTHS)) return false;
        this.attempt(() => this.lit("-") && this.oneOf(MONTHS));
        this.dayListMonth = null;
        this.endsList = false;
        return true;
      })
    );
  }

  /** Days that carry on a date's month in a list, such as the `26` and `28-30` of `Dec 25,26,28-30`. */
  private dayListItem(): boolean {
    return this.attempt(() => {
      const month = this.dayListMonth;
      if (month === null) return false;
      const from = this.daynum(month);
      if (from === null) return false;
      this.attempt(() => this.lit("-") && this.daynum(month, from) !== null);
      return true;
    });
  }

  /**
   * Dates and month ranges in a list. As in opening_hours.js, `easter` does
   * not follow a month range in it, and nothing follows a lone nth weekday
   * date such as `Apr Su[1]`.
   */
  private monthdaySelector(): boolean {
    this.dayListMonth = null;
    const item = (): boolean => {
      const start = this.pos;
      if (!this.monthdayRange()) return false;
      monthOnly = /^ *(\d{4} +)?[A-Z][a-z]{2}( *- *[A-Z][a-z]{2})?$/.test(this.text.slice(start, this.pos));
      return true;
    };
    let monthOnly = false;
    if (!item()) return false;
    while (this.attempt(() => !this.endsList && this.lit(",") && (this.dayListItem() || (!(monthOnly && /^ *(\d{4} *)?easter/.test(this.text.slice(this.pos))) && item()))));
    return true;
  }

  private weekSelector(): boolean {
    const weeknum = (): boolean =>
      this.attempt(() => {
        const w = this.digits(2);
        return w !== null && w >= 1 && w <= 53;
      });
    const week = (): boolean =>
      this.attempt(() => {
        if (!weeknum()) return false;
        this.attempt(() => this.lit("-") && weeknum() && (this.attempt(() => this.lit("/") && this.positive()) || true));
        return true;
      });
    return this.attempt(() => this.lit("week") && this.list(week));
  }

  /**
   * Selectors in the grammar's order, at least one of them. After a wide
   * selector's `:`, a weekday or time selector or a rule modifier must follow.
   */
  private selectorSequence(): boolean {
    if (this.lit("24/7")) return true;
    return this.attempt(() => {
      let wide = false;
      let colon = false;
      if (this.attempt(() => this.comment() && this.lit(":"))) wide = colon = true;
      else {
        if (this.list(() => this.yearRange())) wide = true;
        if (this.monthdaySelector()) wide = true;
        if (this.weekSelector()) wide = true;
        if (wide && this.lit(":")) colon = true;
      }
      let small = false;
      if (this.weekdaySelector()) small = true;
      this.endsInTimes = this.timeSelector();
      if (this.endsInTimes) small = true;
      if (colon && !small) {
        const at = this.pos;
        const modifier = this.ruleModifier();
        this.pos = at;
        return modifier;
      }
      return wide || small;
    });
  }

  private ruleModifier(): boolean {
    return (
      this.attempt(() => this.oneOf(["open", "closed", "off", "unknown"]) && (this.comment() || true)) ||
      this.comment()
    );
  }

  /**
   * Whether the rule just read ends in times, a modifier or a comment, which
   * a `,` can follow as a rule separator. After weekdays, dates or `24/7` a
   * comma would carry on a list, and opening_hours.js refuses a new rule there.
   */
  private commaMayFollow = false;
  /** Whether the selector sequence just read ends in a time selector. */
  private endsInTimes = false;

  private ruleSequence(): boolean {
    return this.attempt(() => {
      this.endsInTimes = false;
      if (this.selectorSequence()) {
        const times = this.endsInTimes;
        this.commaMayFollow = this.ruleModifier() || times;
        return true;
      }
      this.commaMayFollow = true;
      return this.ruleModifier();
    });
  }

  /** True when the whole text is one opening_hours value. */
  timeDomain(): boolean {
    if (!this.ruleSequence()) return false;
    while (this.attempt(() => (this.lit(";") || this.lit("||") || (this.commaMayFollow && this.lit(","))) && this.ruleSequence()));
    this.ws();
    return this.pos === this.text.length;
  }
}

/** A hint for a mistake travellers often make, or null. */
function hint(text: string): string | null {
  if (/\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(day)?\b/i.test(text)) return "write weekdays as two letters: Mo Tu We Th Fr Sa Su";
  if (/\d\s*(am|pm)\b/i.test(text)) return "write times in 24 hour form, such as 08:00-17:00";
  if (/\b\d{1,2}\.\d{2}\b/.test(text) || /\b\d{4}\s*-\s*\d{4}\b/.test(text) || /\b\d:\d{2}\b/.test(text)) {
    return "write times as HH:MM, such as 08:00-17:00";
  }
  return null;
}

/**
 * Why this value isn't OSM opening_hours syntax, or null when it is.
 * Apps can show the reason, which names the first character that didn't fit
 * and, for common mistakes, how to write it.
 */
export function openingHoursProblem(value: string): string | null {
  if (value.length === 0) return "empty";
  const p = new Parser(value);
  if (p.timeDomain()) return null;
  let at = Math.min(p.furthest, value.length);
  while (value[at] === " ") at++;
  const where = at >= value.length ? "at the end" : `at character ${at + 1} ("${value.slice(at, at + 12)}")`;
  const tip = hint(value);
  return `not OSM opening_hours syntax ${where}${tip ? `: ${tip}` : ""}`;
}

/** True when the value is OSM opening_hours syntax. */
export function isOpeningHours(value: unknown): value is string {
  return typeof value === "string" && openingHoursProblem(value) === null;
}

const MONTH = `(${MONTHS.join("|")})`;
const WDAY = `(?:${WDAYS.join("|")})`;
const WEEKDAYS = `${WDAY}(?:-${WDAY})?(?:,${WDAY}(?:-${WDAY})?)*`;
const TIMESPAN = "\\d{2}:\\d{2}-\\d{2}:\\d{2}";
const TIMES = `${TIMESPAN}(?:,${TIMESPAN})*`;
/** A month range (`Apr-Oct`) or a date range (`Apr 01-Oct 31`), with its months and days. */
const MONTHS_PART = `(?:${MONTH}-${MONTH}|${MONTH} (\\d{1,2})-${MONTH} (\\d{1,2}))`;
/**
 * One month or date range, then optionally plain weekdays and plain clock
 * times that apply in it. Anything else (holidays, nth weekdays, sunrise,
 * open ends, modifiers, comments) does not match.
 */
const OPEN_MONTHS = new RegExp(`^${MONTHS_PART}(?::? (?:${WEEKDAYS}(?: ${TIMES})?|${TIMES}))?$`);
/** One month or date range on its own that is closed. */
const CLOSED_MONTHS = new RegExp(`^${MONTHS_PART} (?:closed|off)$`);
/** A month or date range at the start of a value, with its optional colon and the space after it. */
const LEADING_MONTHS = new RegExp(`^${MONTHS_PART}:? ?`);

/** Whether `day` is the last day of `month` (0 for January), with Feb 28 and Feb 29 both the last of February. */
function isLastDay(month: number, day: number): boolean {
  return month === 1 ? day === 28 || day === 29 : day === MONTH_DAYS[month];
}

/**
 * The first and last month (0 for January) of the month range or the date
 * range of whole months a match of MONTHS_PART holds, or null when its dates
 * are not whole months or both ends are the same month.
 */
function wholeMonths(m: RegExpExecArray): [number, number] | null {
  const index = (name: string | undefined): number => MONTHS.indexOf(name as (typeof MONTHS)[number]);
  let first: number;
  let last: number;
  if (m[1] !== undefined) {
    first = index(m[1]);
    last = index(m[2]);
  } else {
    first = index(m[3]);
    last = index(m[5]);
    if (Number(m[4]) !== 1 || !isLastDay(last, Number(m[6]))) return null;
  }
  return first === last ? null : [first, last];
}

/**
 * The months an opening hours value says the place is open, as one month
 * range such as `Apr-Oct` or `Dec-Feb` (read it with `monthsInRange`), or
 * null when the value does not say so with certainty.
 *
 * It reads one rule: a range of two different months, alone or followed by
 * weekdays such as `Mo-Fr` or `Sa,Su` and clock times such as `08:00-17:00`
 * that apply in it. A date range of whole months counts as that month range:
 * `Feb 01-Nov 30` is `Feb-Nov`, with Feb 28 or Feb 29 as the end of
 * February. A month range on its own that is `closed` or `off` gives the
 * months around it: `Feb-Apr closed` is `May-Jan`, and it answers null when
 * that leaves one month or none.
 *
 * Anything else answers null: times only, sunrise and sunset, week numbers,
 * years, dates that are not whole months, holidays, more than one month
 * range or rule, `unknown`, `closed` or `off` with anything more, comments,
 * and values that are not OSM opening_hours syntax.
 */
export function openMonths(openingHours: string): string | null {
  if (openingHoursProblem(openingHours) !== null) return null;
  const open = OPEN_MONTHS.exec(openingHours);
  if (open) {
    const months = wholeMonths(open);
    return months && `${MONTHS[months[0]]}-${MONTHS[months[1]]}`;
  }
  const closed = CLOSED_MONTHS.exec(openingHours);
  const months = closed && wholeMonths(closed);
  if (!months) return null;
  const first = (months[1] + 1) % 12;
  const last = (months[0] + 11) % 12;
  // Closed all year but one month, or all year.
  if (first === last || (months[0] - months[1] + 12) % 12 === 1) return null;
  return `${MONTHS[first]}-${MONTHS[last]}`;
}

/** Plain weekdays, plain clock times, or weekdays then clock times: the weekly part `openMonths` reads after a month range. */
const WEEKLY = new RegExp(`^(?:${WEEKDAYS}(?: ${TIMES})?|${TIMES})$`);

/**
 * The opening hours value with one month range, such as `Apr-Oct` or
 * `Dec-Feb`, in front of its weekly hours, replacing any month range already
 * there, so `openMonths` reads the range back. Apps write a place's open
 * months from a From and To month pair with it.
 *
 * `withOpenMonths("", "Apr-Oct")` is `Apr-Oct`,
 * `withOpenMonths("Mo-Su 08:00-18:00", "Apr-Oct")` is `Apr-Oct Mo-Su 08:00-18:00`
 * and `withOpenMonths("Apr-Oct Mo-Fr 09:00-17:00", "May-Sep")` is
 * `May-Sep Mo-Fr 09:00-17:00`. Months `openMonths` reads in another form, a
 * date range of whole months or closed months, are replaced the same way:
 * `withOpenMonths("Feb-Apr closed", "May-Jan")` is `May-Jan`.
 *
 * It throws a RangeError, and changes nothing, when `range` is not one month
 * range of two different months (`isMonthRange`), or when the value is not
 * empty, plain weekdays and clock times, or one month range followed by them:
 * more than one rule, sunrise and sunset, holidays, open ends, modifiers,
 * comments and anything that is not OSM opening_hours syntax. Ask the
 * traveller to edit such a value by hand.
 */
export function withOpenMonths(openingHours: string, range: string): string {
  if (!isMonthRange(range)) throw new RangeError(`not a month range of two different months: ${JSON.stringify(range)}`);
  const weekly = openMonths(openingHours) === null ? openingHours : withoutOpenMonths(openingHours);
  if (weekly === "") return range;
  if (!WEEKLY.test(weekly) || openingHoursProblem(weekly) !== null) {
    throw new RangeError(`can't put a month range in front of these opening hours: ${JSON.stringify(openingHours)}`);
  }
  return `${range} ${weekly}`;
}

/**
 * The opening hours value without the month or date range `openMonths`
 * reads at its start, and its optional colon: the weekly hours, or "" when
 * the value was the range alone or closed months alone. A value
 * `openMonths` answers null for comes back unchanged.
 *
 * `withoutOpenMonths("Apr-Oct Mo-Su 08:00-18:00")` is `Mo-Su 08:00-18:00`,
 * `withoutOpenMonths("Feb 01-Nov 30 Sa,Su")` is `Sa,Su`, and
 * `withoutOpenMonths("Dec-Feb")` and `withoutOpenMonths("Feb-Apr closed")`
 * are "".
 */
export function withoutOpenMonths(openingHours: string): string {
  if (openMonths(openingHours) === null) return openingHours;
  if (CLOSED_MONTHS.test(openingHours)) return "";
  return openingHours.replace(LEADING_MONTHS, "");
}
