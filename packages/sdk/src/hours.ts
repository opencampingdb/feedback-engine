/**
 * Checks an opening hours value against the OSM opening_hours grammar,
 * specification 0.7.4 (wiki.openstreetmap.org/wiki/Key:opening_hours/specification).
 *
 * It checks the opening hours mode of the grammar: the point in time forms
 * (a time on its own, and `10:00-16:00/90`) belong to tags such as
 * `collection_times` and are refused. Spacing is as the grammar writes it:
 * one space between parts, none around the commas inside a list, so
 * `Mo,We 08:00-12:00,13:00-17:00` is one rule and `Mo 08:00-12:00, We 13:00-17:00`
 * is two.
 *
 * Where the specification allows more than opening_hours.js 3.15 (its
 * reference implementation, which the OSM editors and most apps read hours
 * with) can parse, the check follows opening_hours.js, so every value it
 * accepts parses there too: a date takes no `+Su` or `+1 day` offset (only
 * `easter` takes a day offset) and no open end such as `Apr 01+`.
 */

const WDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const EVENTS = ["sunrise", "sunset", "dawn", "dusk"] as const;

class Parser {
  pos = 0;
  /** The furthest character any attempt reached, for the reason given back. */
  furthest = 0;
  constructor(readonly text: string) {}

  private mark(): number {
    if (this.pos > this.furthest) this.furthest = this.pos;
    return this.pos;
  }

  /** Runs `fn`, and puts the position back when it fails. */
  private attempt(fn: () => boolean): boolean {
    const start = this.mark();
    if (fn()) {
      this.mark();
      return true;
    }
    this.mark();
    this.pos = start;
    return false;
  }

  private lit(word: string): boolean {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      this.mark();
      return true;
    }
    return false;
  }

  private oneOf(words: readonly string[]): boolean {
    return words.some((w) => this.lit(w));
  }

  private digits(count: number): number | null {
    const part = this.text.slice(this.pos, this.pos + count);
    if (part.length !== count || !/^\d+$/.test(part)) return null;
    this.pos += count;
    this.mark();
    return Number(part);
  }

  /** An integer greater than zero, not zero padded. */
  private positive(): boolean {
    const m = /^[1-9]\d*/.exec(this.text.slice(this.pos));
    if (!m) return false;
    this.pos += m[0].length;
    this.mark();
    return true;
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

  /** `HH:MM`, hours 00 to `maxHour`. */
  private hourMinutes(maxHour: number): boolean {
    return this.attempt(() => {
      const h = this.digits(2);
      if (h === null || h > maxHour || !this.lit(":")) return false;
      const m = this.digits(2);
      return m !== null && m <= 59;
    });
  }

  private variableTime(): boolean {
    return (
      this.oneOf(EVENTS) ||
      this.attempt(() => this.lit("(") && this.oneOf(EVENTS) && this.plusMinus() && this.hourMinutes(24) && this.lit(")"))
    );
  }

  private time(): boolean {
    return this.hourMinutes(24) || this.variableTime();
  }

  private extendedTime(): boolean {
    return this.hourMinutes(48) || this.variableTime();
  }

  /** A timespan in opening hours mode: `08:00-17:00`, `18:00-22:00+` or `18:00+`. */
  private timespan(): boolean {
    return this.attempt(() => {
      if (!this.time()) return false;
      if (this.lit("+")) return true;
      if (!this.lit("-") || !this.extendedTime()) return false;
      this.lit("+");
      return true;
    });
  }

  private timeSelector(): boolean {
    return this.list(() => this.timespan());
  }

  /** One or more items separated by commas with no space. */
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

  /** ` +2 days` and the like. */
  private dayOffset(): boolean {
    return this.attempt(() => this.lit(" ") && this.plusMinus() && this.positive() && this.lit(" day") && (this.lit("s") || true));
  }

  private weekdayRange(): boolean {
    return this.attempt(() => {
      if (!this.oneOf(WDAYS)) return false;
      if (this.attempt(() => this.lit("-") && this.oneOf(WDAYS))) return true;
      if (this.attempt(() => this.lit("[") && this.list(() => this.nthEntry()) && this.lit("]"))) {
        this.dayOffset();
      }
      return true;
    });
  }

  private holiday(): boolean {
    return this.attempt(() => this.lit("PH") && (this.dayOffset() || true)) || this.lit("SH");
  }

  /** Weekdays, holidays, or both: `Mo-Fr`, `PH`, `PH,Sa,Su`, `Sa,Su,PH` or `PH Mo`. */
  private weekdaySelector(): boolean {
    return this.attempt(() => {
      const holidaysFirst = this.list(() => this.holiday());
      if (holidaysFirst) {
        if (this.attempt(() => this.lit(",") && this.list(() => this.weekdayRange()))) return true;
        this.attempt(() => this.lit(" ") && this.list(() => this.weekdayRange()));
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
      // A year is never followed by `:`, which would make it a time.
      return y !== null && y > 1900 && !this.text.startsWith(":", this.pos);
    });
  }

  private yearRange(): boolean {
    return this.attempt(() => {
      if (!this.year()) return false;
      if (this.lit("+")) return true;
      this.attempt(() => this.lit("-") && this.year() && (this.attempt(() => this.lit("/") && this.positive()) || true));
      return true;
    });
  }

  private daynum(): boolean {
    return this.attempt(() => {
      const d = this.digits(2);
      return d !== null && d >= 1 && d <= 31;
    });
  }

  private yearPrefix(): void {
    this.attempt(() => this.year() && this.lit(" "));
  }

  private dateFrom(): boolean {
    return this.attempt(() => {
      this.yearPrefix();
      if (this.lit("easter")) {
        this.dayOffset();
        return true;
      }
      if (!this.oneOf(MONTHS) || !this.lit(" ")) return false;
      return this.daynum() || this.attempt(() => this.oneOf(WDAYS) && this.lit("[") && (this.lit("-") || true) && this.nth() && this.lit("]"));
    });
  }

  private monthdayRange(): boolean {
    return (
      this.attempt(() => {
        if (!this.dateFrom()) return false;
        this.attempt(() => this.lit("-") && (this.dateFrom() || this.daynum()));
        return true;
      }) ||
      this.attempt(() => {
        this.yearPrefix();
        if (!this.oneOf(MONTHS)) return false;
        this.attempt(() => this.lit("-") && this.oneOf(MONTHS));
        return true;
      })
    );
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
    return this.attempt(() => this.lit("week ") && this.list(week));
  }

  /** Selectors in the grammar's order, one space apart, at least one of them. */
  private selectorSequence(): boolean {
    if (this.lit("24/7")) return true;
    return this.attempt(() => {
      const parts: (() => boolean)[] = [];
      let wide = false;
      if (this.attempt(() => this.comment() && this.lit(":"))) wide = true;
      else {
        for (const sel of [() => this.list(() => this.yearRange()), () => this.list(() => this.monthdayRange()), () => this.weekSelector()]) {
          if (this.attempt(() => (wide ? this.lit(" ") : true) && sel())) wide = true;
        }
        if (wide) this.lit(":");
      }
      let any = wide;
      parts.push(() => this.weekdaySelector(), () => this.timeSelector());
      for (const sel of parts) {
        if (this.attempt(() => (any ? this.lit(" ") : true) && sel())) any = true;
      }
      return any;
    });
  }

  private ruleModifier(): boolean {
    return (
      this.attempt(() => this.oneOf(["open", "closed", "off", "unknown"]) && (this.attempt(() => this.lit(" ") && this.comment()) || true)) ||
      this.comment()
    );
  }

  private ruleSequence(): boolean {
    return this.attempt(() => {
      if (this.selectorSequence()) {
        this.attempt(() => this.lit(" ") && this.ruleModifier());
        return true;
      }
      return this.ruleModifier();
    });
  }

  /** True when the whole text is one opening_hours value. */
  timeDomain(): boolean {
    if (!this.ruleSequence()) return false;
    while (this.attempt(() => this.oneOf(["; ", ", ", " || "]) && this.ruleSequence()));
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
  if (/\d\s+-|-\s+\d/.test(text)) return "write ranges with no spaces around the dash, such as 08:00-17:00";
  if (/ {2}/.test(text) || text !== text.trim()) return "use single spaces and no space at either end";
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
  const at = Math.min(p.furthest, value.length);
  const where = at >= value.length ? "at the end" : `at character ${at + 1} ("${value.slice(at, at + 12)}")`;
  const tip = hint(value);
  return `not OSM opening_hours syntax ${where}${tip ? `: ${tip}` : ""}`;
}

/** True when the value is OSM opening_hours syntax. */
export function isOpeningHours(value: unknown): value is string {
  return typeof value === "string" && openingHoursProblem(value) === null;
}
