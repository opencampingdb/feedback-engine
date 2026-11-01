import { findContactDetails, MAX_TEXT_LENGTH } from "@opencampingdb/feedback";

/**
 * Review moderation. A review is refused for any reason this returns. The
 * patterns include every check the data repository's validator runs on review
 * text, so an accepted review never fails the data CI.
 */

const RULES: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, "an email address"],
  // Eight or more digits with only spaces, dots, dashes or brackets between them.
  [/(?<![\w])\+?\d(?:[\s().-]{0,2}\d){7,}/, "a phone number"],
  [/https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|au|io|me)\b/i, "a link"],
  [/(?<![\w.])@[A-Za-z0-9_]{2,}/, "a social media handle"],
  [/\bmy name(?:'s| is)\b/i, "a personal name"],
  [/\b(?:call|text|ring|contact|email|message|dm) me\b/i, "a request for contact"],
];

const ISO_DATE = /\b\d{4}-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?\b/g;

const SIGN_OFF = /(?:^|[.!?\n]\s*)(cheers|regards|thanks|thank you|love|from)[,!\s-]+([A-Za-z]+)[.!]?\s*$/i;

// Common English profanity and slurs. Matched as whole words, with any ending
// (so "fucking" matches "fuck"), after undoing spaced and symbol-swapped
// spellings (see `spellings`).
const PROFANITY = [
  "fuck",
  "motherfuck",
  "shit",
  "bullshit",
  "cunt",
  "bitch",
  "bastard",
  "arsehole",
  "asshole",
  "dickhead",
  "wanker",
  "twat",
  "prick",
  "slut",
  "whore",
  "faggot",
  "nigger",
  "retard",
  "spastic",
  "coon",
  "abo",
];
const ENDINGS = "(?:s|es|ed|er|ers|ing|y|ty|ting)?";
const PROFANITY_PATTERN = new RegExp(`\\b(?:${PROFANITY.join("|")})${ENDINGS}\\b`, "i");

// Characters people swap for letters to get past a word list.
const LOOKALIKES: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "i",
  "€": "e",
};
const MASKS = /[*#%]/;

/**
 * The text as it might have been meant, for the word list: lower case, accents
 * removed, look-alike characters inside words swapped back, letters spelled
 * out with spaces or dots joined ("f u c k", "s.h.i.t"), and runs of one
 * letter shortened ("fuuuck"). Each spelling is checked.
 */
export function spellings(text: string): string[] {
  const plain = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  // Look-alikes count only inside a word that has a letter, so prices and dates stay as they are.
  const swapped = plain.replace(/[a-z0-9@$!|€]+/g, (word) =>
    /[a-z]/.test(word) ? word.replace(/[0-9@$!|€]/g, (c) => LOOKALIKES[c] ?? c) : word,
  );
  const joined = swapped.replace(/\b[a-z](?:[\s._-]+[a-z]\b){2,}/g, (run) => run.replace(/[\s._-]+/g, ""));
  const out = new Set([plain, swapped, joined, joined.replace(/([a-z])\1{2,}/g, "$1"), joined.replace(/([a-z])\1+/g, "$1")]);
  return [...out];
}

/** A masked word such as "f*ck" or "sh#t" that fills in to a word on the list. */
function maskedProfanity(text: string): boolean {
  for (const word of text.toLowerCase().match(/[a-z*#%]+/g) ?? []) {
    if (!MASKS.test(word) || !/[a-z]/.test(word)) continue;
    const pattern = new RegExp(`^${word.replace(/[*#%]/g, "[a-z]")}$`);
    if (PROFANITY.some((stem) => pattern.test(stem) || ENDING_FORMS(stem).some((form) => pattern.test(form)))) return true;
  }
  return false;
}

const ENDING_FORMS = (stem: string) => ["s", "ed", "er", "ing", "y"].map((ending) => stem + ending);

/** Whether any spelling of the text holds a word on the list. */
export function hasProfanity(text: string): boolean {
  return spellings(text).some((spelling) => PROFANITY_PATTERN.test(spelling)) || maskedProfanity(text);
}

// Advertising: prices, calls to book or buy, discounts and promotions.
const ADVERTISING: RegExp[] = [
  /(?:\$|aud\s?)\d+(?:[.,]\d{2})?\s*(?:\/|per|a|an)\s*(?:night|nite|week|day|person|site)/i,
  /\b(?:book|call|order|buy|shop|enquire|inquire)\s+(?:now|today|online|direct(?:ly)?)\b/i,
  /\b\d{1,2}\s?%\s?off\b/i,
  /\b(?:promo|discount|coupon|voucher)\s*codes?\b/i,
  /\b(?:special offer|limited time|best (?:price|rates?) guaranteed|free quote|use code|visit our|check out our|our (?:website|shop|store|page))\b/i,
];

/** Whether the text reads as an advertisement. */
export function isAdvertising(text: string): boolean {
  return ADVERTISING.some((pattern) => pattern.test(text));
}

const CONTACT_REASON = { email: "an email address", phone: "a phone number", link: "a link" } as const;

/** Reasons the review text must be refused. Empty when it passes. */
export function moderateReview(text: string): string[] {
  const reasons = new Set<string>();
  if (text.length > MAX_TEXT_LENGTH) reasons.add(`longer than ${MAX_TEXT_LENGTH.toLocaleString("en-AU")} characters`);
  // Dates such as 2026-10-30 or a visit month such as 2026-10 are not phone
  // numbers. Swap them for a letter before the digit-run check.
  const withoutDates = text.replace(ISO_DATE, "x");
  for (const [pattern, reason] of RULES) if (pattern.test(withoutDates)) reasons.add(reason);
  for (const kind of findContactDetails(text)) reasons.add(CONTACT_REASON[kind]);
  const signOff = SIGN_OFF.exec(text);
  if (signOff && /^[A-Z][a-z]+$/.test(signOff[2] ?? "")) reasons.add("a personal name");
  if (hasProfanity(text)) reasons.add("offensive language");
  if (isAdvertising(text)) reasons.add("advertising");
  return [...reasons];
}
