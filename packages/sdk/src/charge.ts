/**
 * Charges as OpenStreetMap writes them (wiki Key:charge):
 * `<amount> <currency>[/<unit>][/<time unit>]`, such as `57 AUD/night`,
 * `15 AUD/person/night`, `2 AUD/hour` or `5 AUD/vehicle`. The currency is an
 * ISO 4217 code, the time unit is written out in full, and spaces may stand
 * around a slash (`4 AUD / hour`).
 *
 * `charge:conditional` adds exceptions in OSM's conditional restrictions
 * syntax: `<charge> @ <condition>[; <charge> @ <condition>]`, such as
 * `75 AUD/night @ (Dec-Jan)`. A condition holding a semicolon is wrapped in
 * parentheses. When several conditions match, the last one wins.
 *
 * Values from OSM are kept as OSM has them, so a place may hold a charge
 * these functions cannot read: `parseCharge` returns null for it, and an app
 * shows the text as it is.
 */

/** Longest value OSM allows for a tag. */
export const MAX_CHARGE_LENGTH = 255;

/** Time units a charge may end with, written out in full as the OSM wiki asks. */
export const CHARGE_TIME_UNITS = ["minute", "hour", "day", "night", "week", "month", "year"] as const;
export type ChargeTimeUnit = (typeof CHARGE_TIME_UNITS)[number];

/** One charge read from its OSM text. */
export interface Charge {
  /** The amount, such as 57 or 2.95. */
  amount: number;
  /** The ISO 4217 currency code, such as `AUD`. */
  currency: string;
  /** What the charge is for, such as `person`, `vehicle` or `kWh`, when it says. */
  unit?: string;
  /** How long the charge covers, such as `night`, when it says. */
  per?: ChargeTimeUnit;
}

/** One exception of a `charge_conditional` value: the charge, and the condition as written. */
export interface ChargeCondition {
  charge: Charge;
  /** The condition, without the parentheses around it, such as `Dec-Jan`. */
  condition: string;
}

const AMOUNT = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
// A unit is a word, or a quantity and a word (`1.5 litre`).
const UNIT = /^(?:\d+(?:\.\d+)? )?[A-Za-z][A-Za-z0-9_]*$/;
const TIME_UNITS: ReadonlySet<string> = new Set(CHARGE_TIME_UNITS);

/** The charge `text` states, or null when it is not in OSM's charge syntax. */
export function parseCharge(text: unknown): Charge | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_CHARGE_LENGTH || text !== text.trim()) return null;
  const parts = text.split(/ ?\/ ?/);
  if (parts.length > 3) return null;
  const head = parts[0]!.split(" ");
  if (head.length !== 2 || !AMOUNT.test(head[0]!) || !CURRENCY.test(head[1]!)) return null;
  const charge: Charge = { amount: Number(head[0]), currency: head[1]! };
  const rest = parts.slice(1);
  if (rest.some((part) => part.length === 0)) return null;
  const last = rest[rest.length - 1];
  if (last !== undefined && TIME_UNITS.has(last)) {
    charge.per = last as ChargeTimeUnit;
    rest.pop();
  }
  if (rest.length > 1) return null;
  if (rest.length === 1) {
    if (!UNIT.test(rest[0]!) || TIME_UNITS.has(rest[0]!)) return null;
    charge.unit = rest[0]!;
  }
  return charge;
}

/** Whether `value` is a charge in OSM's syntax. */
export const isCharge = (value: unknown): value is string => parseCharge(value) !== null;

/** Splits `text` at the semicolons that are not inside parentheses, or returns null when its parentheses do not balance. */
function splitOutsideParentheses(text: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return null;
    else if (c === ";" && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0) return null;
  parts.push(text.slice(start));
  return parts;
}

/**
 * The exceptions a `charge_conditional` value states, in order, or null when
 * it is not in OSM's conditional syntax with a charge on each side of `@`.
 */
export function chargeConditions(text: unknown): ChargeCondition[] | null {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_CHARGE_LENGTH || text !== text.trim()) return null;
  const pairs = splitOutsideParentheses(text);
  if (pairs === null) return null;
  const out: ChargeCondition[] = [];
  for (const pair of pairs) {
    const at = pair.indexOf("@");
    if (at < 0 || pair.indexOf("@", at + 1) >= 0) return null;
    const charge = parseCharge(pair.slice(0, at).trim());
    let condition = pair.slice(at + 1).trim();
    const wrapped = condition.startsWith("(") && condition.endsWith(")") && splitOutsideParentheses(condition.slice(1, -1)) !== null;
    if (wrapped) condition = condition.slice(1, -1).trim();
    else if (/[()]/.test(condition)) return null;
    if (charge === null || condition.length === 0 || (!wrapped && condition.includes(";"))) return null;
    out.push({ charge, condition });
  }
  return out;
}

/** Whether `value` is a `charge_conditional` value in OSM's syntax. */
export const isChargeConditional = (value: unknown): value is string => chargeConditions(value) !== null;
