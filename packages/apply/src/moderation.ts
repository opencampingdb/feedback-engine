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
// (so "fucking" matches "fuck").
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
const PROFANITY_PATTERN = new RegExp(`\\b(?:${PROFANITY.join("|")})(?:s|es|ed|er|ers|ing|y|ty|ting)?\\b`, "i");

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
  if (PROFANITY_PATTERN.test(text)) reasons.add("offensive language");
  return [...reasons];
}
