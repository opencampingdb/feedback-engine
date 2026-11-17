import { parseCharge, sourceLinkProblem, type FactName, type PlaceAddress } from "@opencampingdb/feedback";
import { escapeRegExp, visibleText } from "./pages.js";
import { allowedUrl, httpsTransport, readCapped, USER_AGENT, type Transport, type TransportResponse } from "./proof.js";

/**
 * Source links: a fact report may name a page that shows its value
 * (`report.source`), on a `.gov.au` host or the place's own website on record.
 * The apply run fetches the page and, when the value appears on it, counts
 * the page as a second source for the value (kind `source_link`).
 *
 * "Appears" is read conservatively, per fact:
 *
 * - A yes or no fact: the page names the fact in wording that says the value
 *   (`toilets`, or `no toilets`, `toilets are not available`), and names it
 *   nowhere in wording that says otherwise or leaves it open (`toilets are
 *   closed`). A page that never names the fact confirms neither value.
 * - A fact with a list of choices (`pets`, `fee`, `toilet_type`): wording for
 *   the reported choice, and none for any other choice. Facts and choices with
 *   no wording here (`access`, `entry`, `pets: seasonal`, opening hours and
 *   others) are never confirmed.
 * - A charge: the amount in Australian dollars, as `$25` or `$25.00`.
 * - A stay: the number with its unit, as `7 nights`, `7 days` or `2 weeks`.
 * - The operator, an email or a link: the text itself, ignoring case and
 *   spacing. A phone: its digits, written with 0 or +61. An address: the house
 *   number, the street or place, and the suburb or postcode, each on the page.
 *
 * Only what a visitor reads counts: scripts, styles and comments are dropped,
 * and links and emails are also found in the page's own links. A page that
 * cannot be fetched, answers other than 2xx, is not HTML or plain text, or
 * redirects to a host the rule does not allow never confirms anything.
 */

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

/** A page as the checks read it: its visible text, lower case with spacing collapsed, and its whole source in lower case. */
interface PageText {
  text: string;
  html: string;
}

/** A page's text for the checks: what a visitor reads (`visibleText`) and its whole source, both in lower case. */
export function pageTextOf(html: string): PageText {
  return { text: visibleText(html).toLowerCase(), html: html.toLowerCase() };
}

/** `text` as a pattern that matches it ignoring spacing, between word boundaries. */
const literal = (text: string) => `\\b${text.trim().toLowerCase().split(/\s+/).map(escapeRegExp).join("\\s+")}\\b`;
const found = (pattern: string, text: string) => new RegExp(pattern, "i").test(text);

// Yes or no facts. Each names the fact in words that mean yes. Before them, `no`, `not`, `without`,
// `nil` or `zero` turns a mention into a no; after them, `not available`, `not permitted` and the
// like do. `closed` or `unavailable` after a mention leaves it open, so it confirms neither value.
const NEGATION_BEFORE = /\b(no|not|without|nil|zero)\s+(\w+\s+){0,2}$/;
const NEGATION_AFTER = /^\s*(is|are)?\s*(not\s+(available|provided|permitted|allowed|suitable)|prohibited|banned|none)\b/;
const OPEN_AFTER = /^\s*(is|are)?\s*(temporarily\s+)?(closed|unavailable|out of order|out of service)\b/;

const YES_NO: Partial<Record<FactName, readonly string[]>> = {
  toilets: ["toilets?", "drop toilets?", "flush toilets?", "pit toilets?"],
  showers: ["showers?"],
  hot_water: ["hot water", "hot showers?"],
  drinking_water: ["drinking water", "potable water", "treated water"],
  power: ["powered sites?", "power(ed)? sites? available", "mains power"],
  dump_station: ["dump (point|station)s?", "waste dump", "sullage point"],
  campfires: ["campfires?", "camp fires?", "fire pits?", "fireplaces?"],
  generators: ["generators?"],
  bbq: ["barbecues?", "bbqs?"],
  picnic_tables: ["picnic tables?"],
  laundry: ["laundry", "laundries"],
  kitchen: ["camp kitchens?"],
  playground: ["playgrounds?"],
  wifi: ["wi-?fi"],
  bins: ["rubbish bins?", "garbage bins?", "bins"],
  swimming: ["swimming"],
  fishing: ["fishing"],
  boat_ramp_nearby: ["boat ramps?"],
  wheelchair: ["wheelchair accessible", "wheelchair access"],
  tents: ["tent sites?", "tent camping", "tents"],
};

/** Words that say each choice of a fact with a list of choices. A choice with none here is never confirmed. */
const CHOICES: Partial<Record<FactName, Record<string, readonly string[]>>> = {
  pets: {
    yes: ["(dogs?|pets?) (are )?(allowed|permitted|welcome)", "(pet|dog)[- ]friendly"],
    no: ["no (dogs?|pets?)", "(dogs?|pets?|domestic animals) (are )?(not (allowed|permitted)|prohibited|banned)"],
    leashed: ["on an? (lead|leash)", "on[- ]leash", "leashed"],
  },
  fee: {
    false: ["free camp(ing|ground|site)?s?", "no (camping )?fees?", "free of charge", "no charge"],
    true: ["(camping )?fees? (apply|applies)", "fees? (is |are )?payable", "camping fees?"],
    donation: ["donations?"],
  },
  toilet_type: {
    flush: ["flush(ing)? toilets?"],
    pit: ["pit toilets?", "drop toilets?", "long[- ]drop"],
    chemical: ["chemical toilets?"],
    dry: ["composting toilets?"],
  },
  booking_required: {
    true: ["bookings? (are |is )?(required|essential|mandatory)", "must (be )?book(ed)?"],
    false: ["bookings? (are |is )?not (required|needed|taken|accepted)", "no bookings?", "first come,? first served"],
  },
};

type Mention = "yes" | "no" | "open";

/** How each mention of a yes or no fact reads: yes, no, or left open. */
function yesNoMentions(patterns: readonly string[], text: string): Mention[] {
  const mentions: Mention[] = [];
  const re = new RegExp(`\\b(${patterns.join("|")})\\b`, "gi");
  for (const m of text.matchAll(re)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    if (NEGATION_BEFORE.test(before) || NEGATION_AFTER.test(after)) mentions.push("no");
    else if (OPEN_AFTER.test(after)) mentions.push("open");
    else mentions.push("yes");
  }
  return mentions;
}

/** How many times each choice's words are on the page, leaving out words for a choice that a no turns around. */
function choiceMentions(choices: Record<string, readonly string[]>, text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [choice, patterns] of Object.entries(choices)) {
    let n = 0;
    for (const m of text.matchAll(new RegExp(`\\b(${patterns.join("|")})\\b`, "gi"))) {
      const before = text.slice(Math.max(0, m.index - 40), m.index);
      if (!/^(no|false)$/.test(choice) && NEGATION_BEFORE.test(before)) continue;
      n++;
    }
    counts.set(choice, n);
  }
  return counts;
}

const nationalDigits = (text: string) => {
  const digits = text.replace(/[^\d+]/g, "");
  return digits.startsWith("+61") ? `0${digits.slice(3).replace(/^0/, "")}` : digits;
};

/** A link as the checks compare it: no scheme, no `www.`, no final slash, lower case. */
const bareLink = (url: string) =>
  url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");

function amountPattern(amount: number): string {
  const whole = Number.isInteger(amount);
  const text = whole ? `${amount}(\\.00)?` : escapeRegExp(amount.toFixed(2));
  return `(\\$\\s?${text}(?![\\d.])|\\b${text}\\s?aud\\b)`;
}

const STAY_UNITS: Record<string, string> = { h: "hours?|hrs?", d: "days?|nights?", w: "weeks?" };

/** Whether `page` shows `value` for `fact`, read as the module comment says. */
export function pageConfirmsValue(fact: FactName, value: unknown, page: PageText): boolean {
  const { text, html } = page;
  const yesNo = YES_NO[fact];
  if (yesNo !== undefined && typeof value === "boolean") {
    const mentions = yesNoMentions(yesNo, text);
    const wanted: Mention = value ? "yes" : "no";
    return mentions.includes(wanted) && mentions.every((m) => m === wanted);
  }
  const choices = CHOICES[fact];
  if (choices !== undefined) {
    const key = String(value);
    if (choices[key] === undefined) return false;
    const counts = choiceMentions(choices, text);
    return (counts.get(key) ?? 0) > 0 && [...counts].every(([choice, n]) => choice === key || n === 0);
  }
  if (typeof value === "string") {
    switch (fact) {
      case "charge":
      case "charge_powered": {
        const charge = parseCharge(value);
        return charge !== null && charge.currency === "AUD" && found(amountPattern(charge.amount), text);
      }
      case "max_stay": {
        const m = /^(\d+)([hdw])$/.exec(value);
        return m !== null && found(`\\b${m[1]}[\\s-]*(${STAY_UNITS[m[2]!]})\\b`, text);
      }
      case "operator":
        return found(literal(value.replace(/&/g, "and")), text.replace(/&/g, "and"));
      case "email":
        return new RegExp(`(^|[^\\w.+-])${escapeRegExp(value.toLowerCase())}($|[^\\w.-])`).test(html);
      case "phone":
      case "phone_2": {
        const wanted = nationalDigits(value);
        const candidates = [...text.matchAll(/\+?\d[\d\s().-]{6,}\d/g), ...html.matchAll(/tel:([+\d\s().-]+)/g)].map((m) => m[1] ?? m[0]);
        return wanted.length >= 6 && candidates.some((c) => nationalDigits(c) === wanted);
      }
      case "website":
      case "facebook":
      case "instagram":
      case "tiktok":
      case "x": {
        const link = bareLink(value);
        return new RegExp(`(https?://)?(www\\.)?${escapeRegExp(link)}/?(?=$|["'<\\s?#])`).test(html);
      }
      default:
        return false;
    }
  }
  if (fact === "address" && typeof value === "object" && value !== null) {
    const a = value as PlaceAddress;
    const where = a.street ?? a.place;
    if (where === undefined || (a.suburb === undefined && a.postcode === undefined)) return false;
    return [a.housenumber, where, a.suburb, a.postcode].every((part) => part === undefined || found(literal(part), text));
  }
  return false;
}

/** Whether any value of `fact` could ever be confirmed by a page, so a run only fetches pages that can count. */
export function readableFact(fact: string): boolean {
  return (
    fact in YES_NO ||
    fact in CHOICES ||
    ["charge", "charge_powered", "max_stay", "operator", "email", "phone", "phone_2", "website", "facebook", "instagram", "tiktok", "x", "address"].includes(fact)
  );
}

/**
 * Fetches a source link's page: https on a public host, every redirect
 * checked again against the host rule for `website`, a timeout and a size
 * cap. The page, or null when it cannot be used. Never throws.
 */
export async function fetchSourcePage(source: string, website: unknown, transport: Transport = httpsTransport): Promise<PageText | null> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  const headers = { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9" };
  for (let hop = 0; ; hop++) {
    if (!allowedUrl(url) || sourceLinkProblem(url.href, website) !== null) return null;
    let res: TransportResponse;
    try {
      res = await transport(url, { headers, timeoutMs: TIMEOUT_MS });
    } catch {
      return null;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= MAX_REDIRECTS) return null;
      try {
        url = new URL(res.headers.location, url);
      } catch {
        return null;
      }
      continue;
    }
    if (res.status < 200 || res.status >= 300) return null;
    const type = (res.headers["content-type"] ?? "").toLowerCase();
    if (!/^text\/(html|plain)\b/.test(type) && !/^application\/xhtml\+xml\b/.test(type)) return null;
    try {
      return pageTextOf(await readCapped(res.body, MAX_BYTES));
    } catch {
      return null;
    }
  }
}

/** A fact report with a source link, as `confirmSourceLinks` reads it. */
export interface LinkedReport {
  id: string;
  fact: string;
  value: unknown;
  source: string;
  /** The website on record for the report's place, if any. */
  website: unknown;
}

/**
 * The ids of the reports whose source link shows their value. Each page is
 * fetched once, at most `concurrency` at a time, and none is started after
 * `ms`: a report whose page was not read is not confirmed, and the next run
 * tries again.
 */
export async function confirmSourceLinks(
  reports: readonly LinkedReport[],
  options: { transport?: Transport; ms: number; concurrency: number },
): Promise<Set<string>> {
  const confirmed = new Set<string>();
  const usable = reports.filter((r) => readableFact(r.fact) && sourceLinkProblem(r.source, r.website) === null);
  const pages = new Map<string, Promise<PageText | null>>();
  const deadline = Date.now() + options.ms;
  let next = 0;
  await Promise.all(
    Array.from({ length: options.concurrency }, async () => {
      while (next < usable.length && Date.now() < deadline) {
        const report = usable[next++]!;
        const key = `${report.source}\u0000${String(report.website)}`;
        if (!pages.has(key)) pages.set(key, fetchSourcePage(report.source, report.website, options.transport));
        const page = await pages.get(key)!;
        if (page !== null && pageConfirmsValue(report.fact as FactName, report.value, page)) confirmed.add(report.id);
      }
    }),
  );
  return confirmed;
}
