/**
 * Google Cloud Vision SafeSearch for uploaded photos. The intake sends the full
 * size JPEG and the thumbnail to `images:annotate` as the service account, with
 * the cloud-vision scope. Google processes online requests in memory and does not keep or train
 * on them (cloud.google.com/vision/docs/data-usage).
 */

import type { Likelihood, SafeSearchRatings } from "@opencampingdb/feedback";
import { toBase64 } from "./bytes.js";
import type { Fetch } from "./github.js";
import { GoogleToken, type ServiceAccount } from "./googleauth.js";

export { safeSearchVerdict as verdict } from "@opencampingdb/feedback";

const SCOPE = "https://www.googleapis.com/auth/cloud-vision";
const ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";
const LIKELIHOODS: readonly Likelihood[] = ["UNKNOWN", "VERY_UNLIKELY", "UNLIKELY", "POSSIBLE", "LIKELY", "VERY_LIKELY"];

const likelihood = (value: unknown): Likelihood => (LIKELIHOODS as readonly unknown[]).includes(value) ? (value as Likelihood) : "UNKNOWN";

/**
 * The worse of two sets of ratings: each kind at the more likely of the two,
 * and `"unchecked"` when either file could not be checked. Its verdict is the
 * worse of the two files' verdicts.
 */
export function worseRatings(a: SafeSearchRatings | "unchecked", b: SafeSearchRatings | "unchecked"): SafeSearchRatings | "unchecked" {
  if (a === "unchecked" || b === "unchecked") return "unchecked";
  const more = (x: Likelihood, y: Likelihood): Likelihood => (LIKELIHOODS.indexOf(x) >= LIKELIHOODS.indexOf(y) ? x : y);
  return {
    adult: more(a.adult, b.adult),
    violence: more(a.violence, b.violence),
    racy: more(a.racy, b.racy),
    medical: more(a.medical, b.medical),
    spoof: more(a.spoof, b.spoof),
  };
}

export class SafeSearch {
  readonly #token: GoogleToken;

  constructor(
    private readonly fetch: Fetch,
    now: () => number,
  ) {
    this.#token = new GoogleToken(fetch, now, SCOPE);
  }

  /** SafeSearch's ratings of `image`, or `"unchecked"` when Google can't be asked or answers with an error. */
  async rate(image: Uint8Array, account: ServiceAccount): Promise<SafeSearchRatings | "unchecked"> {
    try {
      const token = await this.#token.get(account);
      const res = await this.fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ requests: [{ image: { content: toBase64(image) }, features: [{ type: "SAFE_SEARCH_DETECTION" }] }] }),
      });
      if (!res.ok) return "unchecked";
      const body = (await res.json()) as { responses?: { safeSearchAnnotation?: Record<string, unknown>; error?: unknown }[] };
      const first = body.responses?.[0];
      const annotation = first?.safeSearchAnnotation;
      if (!annotation || first?.error) return "unchecked";
      return {
        adult: likelihood(annotation.adult),
        violence: likelihood(annotation.violence),
        racy: likelihood(annotation.racy),
        medical: likelihood(annotation.medical),
        spoof: likelihood(annotation.spoof),
      };
    } catch {
      return "unchecked";
    }
  }
}
