/**
 * The intake's checks on an item, cheapest first. Each step runs only when the
 * steps before it passed, and an item a check flags is held for a reviewer,
 * never refused:
 *
 * 1. The intake's own rules: the text checks on the name, description and
 *    note, `contactProblem` on each contact and the address (which covers the
 *    phone and email formats), and at most `LIVE_DAILY_LIMIT` live changes per
 *    UTC day for each of the contributor, the client network (`origin`) and
 *    the App Attest key, counted in D1. The app chooses the contributor id,
 *    so the network and key caps hold when an install changes it.
 * 2. URLhaus (abuse.ch), for the links that passed step 1.
 * 3. Llama Guard 3 on Workers AI, for the name, description and note, and only
 *    from a contributor without a track record. Facts, choices from a list and
 *    links never go to it.
 *
 * A check service that is down, answers with an error, or takes longer than
 * `CHECK_TIMEOUT_MS` holds the item as `check_unavailable`. So does a check
 * that isn't set up (no URLhaus key, no AI binding) when the item needs it.
 * An item that passes counts as one live change for its contributor, network
 * and key.
 */

import {
  contactProblem,
  firstProblem,
  isContactFact,
  stripContactDetails,
  tidyName,
  tidyText,
  type ContactFactName,
  type FeedbackSubmission,
} from "@opencampingdb/feedback";
import type { Fetch } from "./github.js";
import type { D1Like } from "./recent.js";

/** Live changes per contributor, per client network and per App Attest key, per UTC day. Past it, items are held as `daily_cap`. */
export const LIVE_DAILY_LIMIT = 50;
/** How long one check service may take before the item is held as `check_unavailable`. */
export const CHECK_TIMEOUT_MS = 2000;
/** A track record: at least this many accepted items, and none taken down. */
export const TRACK_RECORD_ACCEPTED = 5;
/** Days of `live_counts` rows `pruneLiveCounts` keeps, today included. */
export const LIVE_COUNT_DAYS = 2;

export const URLHAUS_URL_ENDPOINT = "https://urlhaus-api.abuse.ch/v1/url/";
export const URLHAUS_HOST_ENDPOINT = "https://urlhaus-api.abuse.ch/v1/host/";
export const GUARD_MODEL = "@cf/meta/llama-guard-3-8b";

/** Why the checks held an item. */
export type HeldReason = "text_check" | "link_check" | "daily_cap" | "ai_check" | "check_unavailable";

/** The live change an item that passed took from each of its daily caps, to give back if it is not recorded after all. */
export interface LiveSlot {
  day: string;
  /** The `live_counts` keys counted: the contributor, `org_` and the hashed network, and the `ak_` attest key. */
  keys: string[];
}

export type CheckResult = { pass: true; slot: LiveSlot } | { held: HeldReason };

/** Who sent the item, and what has become of what they sent before. */
export interface CheckContributor {
  /** The hashed contributor id (`ctr_` and 16 hex), or the hashed install standing in for one. */
  id: string;
  /** Items of theirs that were accepted. */
  accepted: number;
  /** Items of theirs that were later taken down. */
  taken_down: number;
  /** The hashed client network the item came from, as the inbox stores it. */
  origin?: string | undefined;
  /** The `ak_` App Attest key the item was sent with. */
  attest_key?: string | undefined;
}

/** The part of a Workers AI binding the checks use. */
export interface AiLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface CheckDeps {
  /** The intake's D1 database, with the `live_counts` table. */
  db: D1Like;
  fetch: Fetch;
  /** The abuse.ch auth key (the `URLHAUS_KEY` secret). Without it an item with a link is held. */
  urlhausKey?: string | undefined;
  /** The Workers AI binding. Without it free text from a contributor without a track record is held. */
  ai?: AiLike | undefined;
  now: () => number;
}

/** Contact facts that are links. */
const LINK_FACTS: readonly ContactFactName[] = ["website", "facebook", "instagram", "tiktok", "x"];

/** The free text on an item, as the text checks read it: the name, description and note. */
export function freeText(item: FeedbackSubmission): string[] {
  if (item.type !== "report") return [];
  const report = item.report;
  const texts: string[] = [];
  if (report.name !== undefined) texts.push(tidyName(report.name));
  if (report.kind === "name" && typeof report.value === "string") texts.push(tidyName(report.value));
  if (report.kind === "description" && typeof report.value === "string") texts.push(tidyText(report.value));
  if (report.description !== undefined) texts.push(tidyText(report.description));
  // The intake stores a note with its contact details removed, so they don't count against it.
  if (report.note !== undefined) texts.push(tidyText(stripContactDetails(report.note)));
  return texts.filter((text) => text.length > 0);
}

/**
 * The quoted comments in an opening_hours value an item would set (OSM
 * opening_hours allows free text between double quotes). The cheap text rules
 * read them; Llama Guard never reads fact values (ADR 0002).
 */
export function factComments(item: FeedbackSubmission): string[] {
  if (item.type !== "report") return [];
  const report = item.report;
  const values: unknown[] = [];
  if (report.kind === "fact" && report.fact === "opening_hours") values.push(report.value);
  return values
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => [...v.matchAll(/"([^"]*)"/g)].map((m) => tidyText(m[1]!)))
    .filter((text) => text.length > 0);
}

/** The contact facts and the address an item would set. */
export function contactsOf(item: FeedbackSubmission): [ContactFactName, unknown][] {
  if (item.type !== "report") return [];
  const report = item.report;
  if (report.kind === "fact" && isContactFact(report.fact) && report.value !== undefined) return [[report.fact, report.value]];
  if (report.kind !== "new_place") return [];
  const out: [ContactFactName, unknown][] = Object.entries(report.contacts ?? {}).filter(([, v]) => v !== undefined) as [ContactFactName, unknown][];
  if (report.address !== undefined) out.push(["address", report.address]);
  return out;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

class Unavailable extends Error {}

/** `work`, or `Unavailable` when it fails or takes longer than `ms`. The signal aborts a fetch that runs over. */
async function withTimeout<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Unavailable("timed out"));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } catch (error) {
    throw error instanceof Unavailable ? error : new Unavailable(String(error));
  } finally {
    clearTimeout(timer);
  }
}

/** URLhaus answers `query_status`, spelt `query_staus` in one of its examples. */
const statusOf = (body: Record<string, unknown>) => body.query_status ?? body.query_staus;

async function urlhaus(deps: CheckDeps, key: string, endpoint: string, field: "url" | "host", value: string): Promise<Record<string, unknown>> {
  return withTimeout(CHECK_TIMEOUT_MS, async (signal) => {
    const res = await deps.fetch(endpoint, {
      method: "POST",
      headers: { "auth-key": key, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ [field]: value }).toString(),
      signal,
    });
    if (!res.ok) throw new Unavailable(`URLhaus answered ${res.status}`);
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) throw new Unavailable("URLhaus answered without an object");
    return body as Record<string, unknown>;
  });
}

/** Whether URLhaus knows `link` as a malware address. */
async function urlListed(deps: CheckDeps, key: string, link: string): Promise<boolean> {
  const body = await urlhaus(deps, key, URLHAUS_URL_ENDPOINT, "url", link);
  const status = statusOf(body);
  if (status === "no_results") return false;
  if (status === "ok") return true;
  throw new Unavailable(`URLhaus url query_status ${String(status)}`);
}

/**
 * Whether URLhaus counts the website's host as bad: on SURBL or the Spamhaus
 * DBL, or serving a malware address that is online now. Social pages are on
 * their network's own hosts, so only a website's host is looked up.
 */
async function hostListed(deps: CheckDeps, key: string, host: string): Promise<boolean> {
  const body = await urlhaus(deps, key, URLHAUS_HOST_ENDPOINT, "host", host);
  const status = statusOf(body);
  if (status === "no_results") return false;
  if (status !== "ok") throw new Unavailable(`URLhaus host query_status ${String(status)}`);
  const lists = (typeof body.blacklists === "object" && body.blacklists !== null ? body.blacklists : {}) as Record<string, unknown>;
  if (lists.surbl === "listed") return true;
  if (typeof lists.spamhaus_dbl === "string" && lists.spamhaus_dbl !== "not listed") return true;
  const urls = Array.isArray(body.urls) ? (body.urls as Record<string, unknown>[]) : [];
  return urls.some((u) => typeof u === "object" && u !== null && u.url_status === "online");
}

/**
 * Llama Guard's verdict on `text`: true when it is unsafe. It is asked for a
 * JSON answer (`{ safe, categories }`), and its plain text answer ("safe", or
 * "unsafe" and the categories) is read too.
 */
async function guardUnsafe(ai: AiLike, text: string): Promise<boolean> {
  const out = await withTimeout(CHECK_TIMEOUT_MS, () =>
    ai.run(GUARD_MODEL, {
      messages: [{ role: "user", content: text }],
      temperature: 0,
      max_tokens: 64,
      response_format: { type: "json_object" },
    }),
  );
  const response = typeof out === "object" && out !== null ? (out as { response?: unknown }).response : undefined;
  if (typeof response === "object" && response !== null && typeof (response as { safe?: unknown }).safe === "boolean") {
    return !(response as { safe: boolean }).safe;
  }
  if (typeof response === "string") {
    const verdict = response.trim().toLowerCase();
    if (verdict === "safe" || verdict.startsWith("safe\n")) return false;
    if (verdict.startsWith("unsafe")) return true;
  }
  throw new Unavailable("Llama Guard answered without a verdict");
}

const hasTrackRecord = (c: CheckContributor) => c.accepted >= TRACK_RECORD_ACCEPTED && c.taken_down === 0;

/** The `live_counts` keys an item from `contributor` counts against. */
export function liveKeys(contributor: CheckContributor): string[] {
  return [contributor.id, ...(contributor.origin ? [`org_${contributor.origin}`] : []), ...(contributor.attest_key ? [contributor.attest_key] : [])];
}

const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The highest count among `keys` on `day`. */
async function liveCount(db: D1Like, keys: readonly string[], day: string): Promise<number> {
  const count = await db
    .prepare(`SELECT max(count) AS count FROM live_counts WHERE day = ? AND contributor IN (${marks(keys.length)})`)
    .bind(day, ...keys)
    .first<number | null>("count");
  return count ?? 0;
}

/** Counts one live change on `key`, unless it has reached the cap. False when it has. */
async function countOne(db: D1Like, key: string, day: string): Promise<boolean> {
  const row = await db
    .prepare(
      "INSERT INTO live_counts (contributor, day, count) VALUES (?, ?, 1) ON CONFLICT (contributor, day) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count",
    )
    .bind(key, day, LIVE_DAILY_LIMIT)
    .first<number>("count");
  return row !== null;
}

/**
 * Counts one live change on each key, unless one of them has reached the cap.
 * Then the keys counted so far are given back and the result is null.
 */
async function countLive(db: D1Like, keys: readonly string[], day: string): Promise<LiveSlot | null> {
  const counted: string[] = [];
  for (const key of keys) {
    if (await countOne(db, key, day)) {
      counted.push(key);
      continue;
    }
    if (counted.length > 0) await releaseLive(db, { day, keys: counted });
    return null;
  }
  return { day, keys: counted };
}

/** Gives back the live change `slot` took, when the item that took it was not recorded after all. */
export async function releaseLive(db: D1Like, slot: LiveSlot): Promise<void> {
  if (slot.keys.length === 0) return;
  await db
    .prepare(`UPDATE live_counts SET count = count - 1 WHERE day = ? AND count > 0 AND contributor IN (${marks(slot.keys.length)})`)
    .bind(slot.day, ...slot.keys)
    .run();
}

/** Deletes `live_counts` rows older than `LIVE_COUNT_DAYS`, for the intake's scheduled job. */
export async function pruneLiveCounts(db: D1Like, now: number): Promise<void> {
  const oldest = dayOf(now - (LIVE_COUNT_DAYS - 1) * 24 * 60 * 60 * 1000);
  await db.prepare("DELETE FROM live_counts WHERE day < ?").bind(oldest).run();
}

export interface Checks {
  /**
   * Checks one validated item from `contributor`, cheapest first. An item that
   * passes is counted as one of the contributor's, network's and key's live
   * changes for the day, so call it last, when nothing else would hold the
   * item, and give the slot back with `releaseLive` if the item is not
   * recorded after all.
   */
  check(item: FeedbackSubmission, contributor: CheckContributor): Promise<CheckResult>;
}

/** The checks, with the services they call. */
export function createChecks(deps: CheckDeps): Checks {
  return { check: (item, contributor) => check(deps, item, contributor) };
}

async function check(deps: CheckDeps, item: FeedbackSubmission, contributor: CheckContributor): Promise<CheckResult> {
  const unavailable = { held: "check_unavailable" } as const;

  // 1. The intake's own rules.
  const texts = freeText(item);
  if (firstProblem(...texts, ...factComments(item)) !== null) return { held: "text_check" };
  const contacts = contactsOf(item);
  if (contacts.some(([fact, value]) => contactProblem(fact, value) !== null)) return { held: "link_check" };
  const day = dayOf(deps.now());
  const keys = liveKeys(contributor);
  try {
    if ((await liveCount(deps.db, keys, day)) >= LIVE_DAILY_LIMIT) return { held: "daily_cap" };
  } catch {
    return unavailable;
  }

  // 2. URLhaus, for the links.
  const links = contacts.filter(([fact]) => LINK_FACTS.includes(fact)) as [ContactFactName, string][];
  if (links.length > 0) {
    if (!deps.urlhausKey) return unavailable;
    const key = deps.urlhausKey;
    const lookups = links.flatMap(([fact, link]) => [
      urlListed(deps, key, link),
      ...(fact === "website" ? [hostListed(deps, key, new URL(link).hostname.toLowerCase())] : []),
    ]);
    const answers = await Promise.allSettled(lookups);
    if (answers.some((a) => a.status === "fulfilled" && a.value)) return { held: "link_check" };
    if (answers.some((a) => a.status === "rejected")) return unavailable;
  }

  // 3. Llama Guard, for free text from a contributor without a track record.
  if (texts.length > 0 && !hasTrackRecord(contributor)) {
    if (!deps.ai) return unavailable;
    try {
      if (await guardUnsafe(deps.ai, texts.join("\n\n"))) return { held: "ai_check" };
    } catch {
      return unavailable;
    }
  }

  try {
    const slot = await countLive(deps.db, keys, day);
    return slot ? { pass: true, slot } : { held: "daily_cap" };
  } catch {
    return unavailable;
  }
}
