import { FREE_TEXT_FACTS, HUMAN_CHECK_HEADER, isContactFact, type ReportKind } from "@opencampingdb/feedback";
import type { Fetch } from "./github.js";
import { timedFetch } from "./inbox-queue.js";

/**
 * The human check: a Cloudflare Turnstile token showing that a person filled
 * in the form that sent a request. It is a proof of its own, apart from
 * attestation: it says nothing about the device or app, so an item that
 * passes it is weighed as an unattested one (docs/adr/0004-human-check.md).
 */

/** The request header that carries the Turnstile token, as the SDK sends it. */
export { HUMAN_CHECK_HEADER };
export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Longest Turnstile token, as Cloudflare documents it. */
export const MAX_TOKEN_CHARS = 2048;
/** Longest wait for siteverify. */
export const SITEVERIFY_TIMEOUT_MS = 10_000;

/** An app key's human check: its Turnstile widget's secret, and the hostnames the widget may be served from. */
export interface HumanCheckConfig {
  secret: string;
  hostnames: string[];
  /** The widget's `action`, when the form sets one. Checked when given. */
  action?: string;
  /** Lets fact reports set the facts whose value holds free words (`FREE_TEXT_FACTS`). Off by default. */
  free_text_facts?: boolean;
}

/**
 * The report kinds a human-check key may send. A contact report carries no
 * value: it says a phone, website or address is wrong.
 */
export const HUMAN_CHECK_REPORT_KINDS: readonly ReportKind[] = ["fact", "doubt", "contact", "closed", "name", "kind", "wrong_location"];

/**
 * Whether a key that requires a human check may send this submission: a
 * report of one of HUMAN_CHECK_REPORT_KINDS, whose fact report sets no contact
 * or address, and no fact that holds free words unless the key allows them.
 * Every other type, reviews, photos, new places and owner submissions among
 * them, is refused whatever the key's other settings.
 */
export function humanCheckAllows(submission: { type: string; report?: { kind: string; fact?: string } }, config: HumanCheckConfig): boolean {
  if (submission.type !== "report" || !submission.report) return false;
  const { kind, fact } = submission.report;
  if (!(HUMAN_CHECK_REPORT_KINDS as readonly string[]).includes(kind)) return false;
  if (kind !== "fact") return true;
  if (fact === undefined || isContactFact(fact)) return false;
  return config.free_text_facts === true || !(FREE_TEXT_FACTS as readonly string[]).includes(fact);
}

const ACTION = /^[A-Za-z0-9_-]{1,32}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A human check config from an APP_KEYS entry, or undefined when it is not valid. */
export function parseHumanCheck(value: unknown): HumanCheckConfig | undefined {
  const v = value as Partial<HumanCheckConfig> | null;
  if (typeof v !== "object" || v === null) return undefined;
  if (typeof v.secret !== "string" || v.secret.length === 0) return undefined;
  if (!Array.isArray(v.hostnames) || v.hostnames.length === 0 || !v.hostnames.every((h) => typeof h === "string" && HOSTNAME.test(h))) return undefined;
  if (v.action !== undefined && (typeof v.action !== "string" || !ACTION.test(v.action))) return undefined;
  if (v.free_text_facts !== undefined && typeof v.free_text_facts !== "boolean") return undefined;
  return {
    secret: v.secret,
    hostnames: [...v.hostnames],
    ...(v.action !== undefined ? { action: v.action } : {}),
    ...(v.free_text_facts ? { free_text_facts: true } : {}),
  };
}

export type HumanCheckResult =
  | { ok: true }
  | { ok: false; error: "human_check_required" }
  | { ok: false; error: "human_check_failed"; details: string[] }
  | { ok: false; error: "unavailable" };

/** Turnstile error codes that are Cloudflare's fault, not the sender's. */
const CLOUDFLARE_FAULTS = new Set(["internal-error"]);

/**
 * Checks the token in `x-human-check` with Turnstile's siteverify. It passes
 * when Cloudflare says the token is good, it was served from one of the
 * config's hostnames, its `cdata` is the SHA-256 (lower case hex) of the
 * exact body text, and its `action` matches when the config names one. The
 * `cdata` binds the token to this body, so a token cannot carry another
 * request. Turnstile spends each token on its first check.
 */
export async function verifyHumanCheck(input: {
  fetch: Fetch;
  token: string | null;
  bodySha256: string;
  config: HumanCheckConfig;
  /** The client's address, passed on to Cloudflare. */
  remoteip?: string | undefined;
}): Promise<HumanCheckResult> {
  const { token, bodySha256, config } = input;
  if (!token) return { ok: false, error: "human_check_required" };
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, error: "human_check_failed", details: ["token is too long"] };
  let answer: { success?: unknown; hostname?: unknown; cdata?: unknown; action?: unknown; "error-codes"?: unknown };
  try {
    const res = await timedFetch(input.fetch, SITEVERIFY_TIMEOUT_MS)(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: config.secret, response: token, ...(input.remoteip ? { remoteip: input.remoteip } : {}) }),
    });
    if (!res.ok) return { ok: false, error: "unavailable" };
    answer = (await res.json()) as typeof answer;
  } catch {
    return { ok: false, error: "unavailable" };
  }
  const codes = Array.isArray(answer["error-codes"]) ? answer["error-codes"].filter((c): c is string => typeof c === "string") : [];
  if (answer.success !== true) {
    if (codes.some((c) => CLOUDFLARE_FAULTS.has(c))) return { ok: false, error: "unavailable" };
    return { ok: false, error: "human_check_failed", details: codes.length > 0 ? codes : ["token was not accepted"] };
  }
  if (typeof answer.hostname !== "string" || !config.hostnames.includes(answer.hostname.toLowerCase())) {
    return { ok: false, error: "human_check_failed", details: ["token was served from another site"] };
  }
  if (answer.cdata !== bodySha256) return { ok: false, error: "human_check_failed", details: ["token was made for another body"] };
  if (config.action !== undefined && answer.action !== config.action) {
    return { ok: false, error: "human_check_failed", details: ["token was made for another form"] };
  }
  return { ok: true };
}
