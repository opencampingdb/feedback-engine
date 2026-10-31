/**
 * Finding and removing contact details (email addresses, phone numbers and
 * links) in free text. The intake strips them before storage, and the apply
 * step refuses reviews that still contain them.
 */

export type ContactDetailKind = "email" | "phone" | "link";

export const REMOVED_MARKER = "[removed]";

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const URL_WITH_SCHEME = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"]+/gi;
// Bare domains such as camp.com.au or example.org/page. Limited to common
// top-level domains so that ordinary text like "Mt.Buller" is left alone.
const BARE_DOMAIN =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|net|org|info|biz|io|app|au|nz|uk|co|me|ly|site|online|xyz)\b(?:\/[^\s<>"]*)?/gi;
// Dates written as 2026-10-30, 2026-10 or 30/10/2026. They are matched before
// phone numbers so that a date, or two dates side by side, never reads as one.
const DATE = String.raw`\b(?:\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?|\d{1,2}[/.]\d{1,2}[/.]\d{2,4})\b`;
// Candidate phone numbers: a digit run of at least 8 characters that may hold
// spaces, dots, dashes and brackets, with an optional leading +.
const PHONE = String.raw`\+?\(?\d[\d\s().-]{6,}\d`;
const DATE_OR_PHONE = new RegExp(`(${DATE})|${PHONE}`, "g");

function isPhone(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "").length;
  return digits >= 8 && digits <= 15;
}

/** Calls `onPhone` for each phone number in `text`, leaving dates alone. */
function replacePhones(text: string, onPhone: (candidate: string) => string): string {
  return text.replace(DATE_OR_PHONE, (match: string, date: string | undefined) =>
    date === undefined && isPhone(match) ? onPhone(match) : match,
  );
}

/** Lists the kinds of contact details found in `text`. Empty when there are none. */
export function findContactDetails(text: string): ContactDetailKind[] {
  const found = new Set<ContactDetailKind>();
  if (text.match(EMAIL)) found.add("email");
  const withoutEmails = text.replace(EMAIL, " ");
  if (withoutEmails.match(URL_WITH_SCHEME) || withoutEmails.match(BARE_DOMAIN)) found.add("link");
  const withoutLinks = withoutEmails.replace(URL_WITH_SCHEME, " ").replace(BARE_DOMAIN, " ");
  replacePhones(withoutLinks, (candidate) => {
    found.add("phone");
    return candidate;
  });
  return [...found];
}

// Times written HH:MM or HH.MM, and HHMM-HHMM ranges, as opening hours often are.
const HOUR = String.raw`(?:[01]?\d|2[0-4])`;
const TIME = new RegExp(String.raw`\b${HOUR}[:.][0-5]\d\b|\b(?:[01]\d|2[0-4])[0-5]\d\s*-\s*(?:[01]\d|2[0-4])[0-5]\d\b`, "g");

/**
 * Lists the kinds of contact details found in opening hours. Times such as
 * 08.00 or 0800-1700 are left out before looking for phone numbers.
 */
export function findContactDetailsInHours(text: string): ContactDetailKind[] {
  const found = new Set<ContactDetailKind>(findContactDetails(text).filter((kind) => kind !== "phone"));
  if (findContactDetails(text.replace(TIME, " ")).includes("phone")) found.add("phone");
  return [...found];
}

/** Replaces every email address, link and phone number in `text` with `[removed]`. */
export function stripContactDetails(text: string): string {
  return text
    .replace(EMAIL, REMOVED_MARKER)
    .replace(URL_WITH_SCHEME, REMOVED_MARKER)
    .replace(BARE_DOMAIN, REMOVED_MARKER)
    .replace(DATE_OR_PHONE, (match: string, date: string | undefined) =>
      date === undefined && isPhone(match) ? REMOVED_MARKER : match,
    );
}
