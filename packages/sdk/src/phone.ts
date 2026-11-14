/**
 * Phone numbers written the standard Australian way, so every app shows and
 * sends them alike. Apps run `formatPhone` on a phone field when it loses
 * focus and before sending; an intake runs `formatSubmissionPhones` on what
 * arrives, so a number from any app is stored the same way.
 */

import type { OwnerFacts, Submission } from "./types.js";

/** Characters people type inside a phone number besides digits: spaces, dashes, dots and brackets. */
const PUNCTUATION = /[\s\-.()]/g;
const ONLY_PHONE_CHARACTERS = /^\+?[\d\s\-.()]+$/;

function group(digits: string, sizes: number[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const size of sizes) {
    parts.push(digits.slice(at, at + size));
    at += size;
  }
  return parts.join(" ");
}

/**
 * The nine digits after the trunk 0 (or after +61) of a landline or mobile,
 * grouped: a landline as area code then 4 and 4 ("7 4564 2000"), a mobile as
 * 3, 3 and 3 ("412 345 678"). Null for anything else.
 */
function national(nine: string): string | null {
  if (!/^\d{9}$/.test(nine)) return null;
  if (/^[2378]/.test(nine)) return group(nine, [1, 4, 4]);
  if (/^[45]/.test(nine)) return group(nine, [3, 3, 3]);
  return null;
}

/**
 * A phone number as it should read in Australia:
 *
 * - landlines "02 6123 4567", or "+61 2 6123 4567" when written with +61
 * - mobiles "0412 345 678", or "+61 412 345 678"
 * - "1300 123 456", "1800 123 456" and "13 12 34"
 *
 * Domestic numbers stay domestic and +61 numbers stay +61: no country code is
 * added or taken away. A trunk 0 written after +61 ("+61 07 ...") is dropped,
 * as it is never dialled. Anything else (an overseas number, one too short or
 * too long, or text that is not only digits, spaces, dashes, dots, brackets
 * and a leading +) comes back with its spacing tidied and nothing more.
 */
export function formatPhone(text: string): string {
  const tidied = text.replace(/\s+/g, " ").trim();
  if (!ONLY_PHONE_CHARACTERS.test(tidied)) return tidied;
  const plus = tidied.startsWith("+");
  const digits = tidied.replace(PUNCTUATION, "").replace(/^\+/, "");
  if (plus) {
    if (!digits.startsWith("61")) return tidied;
    const rest = digits.slice(2).replace(/^0/, "");
    const grouped = national(rest);
    return grouped === null ? tidied : `+61 ${grouped}`;
  }
  if (/^0\d{9}$/.test(digits)) {
    const grouped = national(digits.slice(1));
    // The trunk 0 joins the first group: "02 6123 4567", "0412 345 678".
    return grouped === null ? tidied : `0${grouped}`;
  }
  if (/^1[38]00\d{6}$/.test(digits)) return group(digits, [4, 3, 3]);
  if (/^13\d{4}$/.test(digits)) return group(digits, [2, 2, 2]);
  return tidied;
}

const PHONE_FACTS = ["phone", "phone_2"] as const;

function formattedFacts<T extends Partial<OwnerFacts> | undefined>(facts: T): T {
  if (!facts) return facts;
  let out: Record<string, unknown> | null = null;
  for (const name of PHONE_FACTS) {
    const value = (facts as Record<string, unknown>)[name];
    if (typeof value !== "string") continue;
    const formatted = formatPhone(value);
    if (formatted === value) continue;
    out ??= { ...facts };
    out[name] = formatted;
  }
  return (out ?? facts) as T;
}

/**
 * A submission with every phone number in it run through `formatPhone`: a
 * `phone` or `phone_2` fact report's value, a new place's `contacts.phone`,
 * and an owner's listing or update facts. Everything else is returned as it
 * is, and the submission passed in is not changed.
 */
export function formatSubmissionPhones<S extends Submission>(submission: S): S {
  if (submission.type === "report") {
    const report = submission.report;
    let next = report;
    if (report.kind === "fact" && (report.fact === "phone" || report.fact === "phone_2") && typeof report.value === "string") {
      const value = formatPhone(report.value);
      if (value !== report.value) next = { ...next, value };
    }
    if (report.contacts && typeof report.contacts.phone === "string") {
      const phone = formatPhone(report.contacts.phone);
      if (phone !== report.contacts.phone) next = { ...next, contacts: { ...report.contacts, phone } };
    }
    return next === report ? submission : { ...submission, report: next };
  }
  if (submission.type === "owner_listing") {
    const facts = formattedFacts(submission.listing.facts);
    return facts === submission.listing.facts ? submission : { ...submission, listing: { ...submission.listing, facts } };
  }
  if (submission.type === "owner_update") {
    const facts = formattedFacts(submission.update.facts);
    return facts === submission.update.facts ? submission : { ...submission, update: { ...submission.update, facts } };
  }
  return submission;
}
