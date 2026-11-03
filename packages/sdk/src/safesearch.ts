import type { SafeSearchRatings } from "./types.js";

/** What happens to an uploaded photo, from its SafeSearch ratings. */
export type SafeSearchVerdict = "refuse" | "hold" | "pass";

/**
 * Refused at once: very likely adult or violent. Held for a person even from a
 * trusted contributor: likely adult or violent, or very likely racy. Anything
 * else goes through the usual rules.
 */
export function safeSearchVerdict(ratings: SafeSearchRatings | "unchecked"): SafeSearchVerdict {
  if (ratings === "unchecked") return "hold";
  if (ratings.adult === "VERY_LIKELY" || ratings.violence === "VERY_LIKELY") return "refuse";
  if (ratings.adult === "LIKELY" || ratings.violence === "LIKELY" || ratings.racy === "VERY_LIKELY") return "hold";
  return "pass";
}
