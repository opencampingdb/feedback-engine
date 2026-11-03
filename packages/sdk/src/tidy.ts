/**
 * What a traveller types, made ready before it is sent: tidied (no shouting,
 * no runs of !!!! or sooooo, one space between words), then checked for rude
 * words, contact details and spam. Apps run these before sending, and an
 * intake can run the same checks on what arrives.
 */

import { findContactDetailsInHours } from "./text.js";

/** Words kept in capitals: states, rig and road terms, and names spelt that way. */
const KEEP_CAPS = new Set([
  "NSW", "VIC", "QLD", "SA", "WA", "NT", "ACT", "TAS", "AU", "NZ",
  "RV", "RVS", "BBQ", "BBQS", "2WD", "4WD", "AWD", "4X4", "LPG", "UHF", "CB", "EV", "GPS", "USB", "TV", "WC", "ATM",
  "NP", "NPWS", "SF", "BIG4", "IGA", "RSL", "CWA", "NRMA", "RACV", "RACQ", "RAA", "RAC", "NBN", "CBD", "OK", "BYO", "ID",
]);

/** Words a place's name keeps lower case after its first word. */
const SMALL_WORDS = new Set(["a", "an", "and", "at", "by", "for", "in", "of", "on", "the", "to"]);

const LETTER = /\p{L}/gu;
const UPPER = /\p{Lu}/gu;

function bare(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function kept(word: string): boolean {
  return KEEP_CAPS.has(bare(word).toUpperCase());
}

/** Whether most of the letters are capitals. A short text of initials isn't shouting. */
function shouting(text: string): boolean {
  const letters = text.match(LETTER)?.length ?? 0;
  const upper = text.match(UPPER)?.length ?? 0;
  return letters >= 6 && upper / letters >= 0.7;
}

/** One word as it should read: lower case, unless it's kept in capitals or holds a number. */
function quiet(word: string): string {
  return kept(word) || /\d/.test(word) ? word.toUpperCase() : word.toLowerCase();
}

/** A shouted word in otherwise ordinary text: four or more capitals and nothing else. */
function shoutedWord(word: string): boolean {
  const b = bare(word);
  return b.length >= 4 && /^\p{Lu}+$/u.test(b) && !kept(word);
}

function capitalise(word: string): string {
  return word.replace(/\p{L}/u, (c) => c.toUpperCase());
}

/** Spacing, invisible characters and repeated punctuation, the same for names and notes. */
function tidySpacing(text: string, oneLine: boolean): string {
  let out = text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‍⁠﻿]/g, "");
  out = oneLine ? out.replace(/\s+/g, " ") : out.replace(/[  ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return out
    .replace(/[!?]{2,}/g, (run) => run.charAt(0))
    .replace(/\.{4,}/g, "...")
    .replace(/([,;:*~_=#+-])\1{2,}/g, "$1")
    .replace(/(\p{Extended_Pictographic})\1{2,}/gu, "$1")
    .replace(/ +([,.!?;:])/g, "$1")
    .trim();
}

/** Letters held too long, as in "sooooo", come back to two. Capitals are left, for numerals like III. */
function shorten(text: string): string {
  return text.replace(/(\p{Ll})\1{2,}/gu, "$1$1");
}

/**
 * A place's name as it should read. A shouted or all lower case name becomes title case ("lake
 * eppalock rest area" reads "Lake Eppalock Rest Area"); a name already in mixed case keeps it, but
 * for a single shouted word.
 */
export function tidyName(name: string): string {
  const text = tidySpacing(name, true);
  const lower = !/\p{Lu}/u.test(text);
  const words = text.split(" ");
  if (shouting(text) || lower) {
    return shorten(
      words
        .map((word, i) => {
          if (kept(word) || /\d/.test(word)) return word.toUpperCase();
          const low = word.toLowerCase();
          if (i > 0 && SMALL_WORDS.has(bare(low))) return low;
          return low.split("-").map(capitalise).join("-");
        })
        .join(" "),
    );
  }
  return shorten(words.map((word) => (shoutedWord(word) ? capitalise(word.toLowerCase()) : word)).join(" "));
}

/**
 * A note, description or review as it should read. Shouted text becomes sentences; a shouted word in
 * ordinary text comes down to lower case.
 */
export function tidyText(text: string): string {
  const tidy = tidySpacing(text, false);
  if (!shouting(tidy)) return shorten(tidy.replace(/[^\s]+/g, (word) => (shoutedWord(word) ? word.toLowerCase() : word)));
  const quietened = tidy.replace(/[^\s]+/g, quiet);
  return shorten(
    quietened
      .replace(/(^|[.!?]\s+|\n)(\P{L}*)(\p{Ll})/gu, (_, before: string, gap: string, c: string) => before + gap + c.toUpperCase())
      .replace(/\bi\b(?=$|[\s'’.,!?;:])/g, "I"),
  );
}

// Rude words and slurs, matched as whole words in folded text (see `fold`). Each letter may repeat, so
// "fuuuck" matches, but "niger" doesn't match a word that needs "gg". An entry ending in * also matches
// longer words that start with it.
const RUDE = [
  "fuck*", "fuk*", "fck*", "fcuk*", "motherfuck*", "cunt", "cunts", "cunty",
  "shit", "shits", "shitty", "shitting", "shite", "shithead", "shitheads", "shithole", "shitholes", "shitbox",
  "bullshit", "horseshit", "dipshit", "bitch", "bitches", "bitchy", "bitching", "bastard", "bastards",
  "arsehole", "arseholes", "asshole", "assholes", "dickhead", "dickheads", "prick", "pricks", "cocksucker",
  "wank", "wanker", "wankers", "wanking", "twat", "twats", "tosser", "tossers", "bollocks",
  "piss", "pissing", "slut", "sluts", "whore", "whores", "dildo",
  "nigger*", "nigga*", "faggot*", "fag", "fags", "retard", "retards", "retarded", "spastic", "spaz",
  "tranny", "trannies", "chink", "chinks", "gook", "gooks", "abo", "abos", "boong*", "coon", "coons", "kike", "paki",
  "poofter", "poofters", "gyppo", "kys", "kill yourself",
];

function rudePattern(entry: string): string {
  const prefix = entry.endsWith("*");
  const word = prefix ? entry.slice(0, -1) : entry;
  const letters = [...word].map((c) => (c === " " ? " +" : `${c}+`)).join("");
  return prefix ? `${letters}[a-z]*` : letters;
}

const RUDE_WORDS = new RegExp(`\\b(?:${RUDE.map(rudePattern).join("|")})\\b`);

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s", "!": "i" };

/**
 * Text folded for matching: lower case without accents, look-alike digits and symbols inside a word
 * read as letters ("sh1t", "@rse"), and spaced-out letters joined ("f u c k").
 */
function fold(text: string): string {
  const plain = text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const words = plain.split(/\s+/).map((token) => {
    const core = token.replace(/^[^a-z0-9@$!]+|[^a-z0-9@$!]+$/g, "");
    if (!/[a-z]/.test(core)) return token;
    return core.replace(/[0134579@$!]/g, (c) => LEET[c] ?? c);
  });
  return words.join(" ").replace(/\b(?:[a-z][ .\-_*]){2,}[a-z]\b/g, (run) => run.replace(/[ .\-_*]/g, ""));
}

const SPAM_PHRASES =
  /\b(?:buy now|click here|order now|limited offer|free money|make money|earn \$|work from home|crypto|bitcoin|forex|casino|viagra|cialis|payday loans?|promo code|discount code|coupon code|follow me|subscribe|dm me|whatsapp|telegram|onlyfans)\b/i;

/** Signs of spam or keyboard mashing: an ad's wording, a word said over and over, or letters that aren't words. */
function spammy(text: string): boolean {
  if (SPAM_PHRASES.test(text)) return true;
  if (/\b(\p{L}{2,})\b(?:\P{L}+\1\b){3,}/iu.test(text)) return true;
  if (/[bcdfghjklmnpqrstvwxz]{7,}/i.test(text)) return true;
  const letters = text.toLowerCase().match(LETTER) ?? [];
  if (letters.length >= 20 && new Set(letters).size <= 4) return true;
  return text.trim().length > 0 && letters.length === 0;
}

export type TextProblem = "rude" | "contact" | "spam";

/** What stops this text being sent, if anything. Check it after tidying. */
export function textProblem(text: string): TextProblem | null {
  if (!text.trim()) return null;
  if (RUDE_WORDS.test(fold(text))) return "rude";
  // Opening hours such as 0800-1700 aren't phone numbers.
  if (findContactDetailsInHours(text).length > 0) return "contact";
  if (spammy(text)) return "spam";
  return null;
}

/** The first problem across several texts. */
export function firstProblem(...texts: (string | undefined)[]): TextProblem | null {
  for (const text of texts) {
    const problem = text === undefined ? null : textProblem(text);
    if (problem) return problem;
  }
  return null;
}
