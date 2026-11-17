/**
 * The AI reviewer's second stage: a held case the first model (Workers AI)
 * is unsure of is asked of Claude Haiku 5.5 on Anthropic's API, while the
 * month's spending is under the cap. Spending is metered from each answer's
 * reported token usage and kept per calendar month (UTC) in the intake's D1
 * table `ai_spend`, so a new month starts from nothing. Off without
 * ANTHROPIC_API_KEY. A call that fails or takes too long, and spending that
 * can't be read or written, leave the case for a person.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Fetch } from "./github.js";
import type { D1Like } from "./recent.js";

/** The second model, on Anthropic's API. SECOND_MODEL_PRICES are this model's. */
export const SECOND_REVIEW_MODEL = "claude-haiku-5-5";
/** The monthly spending cap in US dollars when SECOND_REVIEW_CAP_USD is not set. */
export const DEFAULT_SECOND_REVIEW_CAP_USD = 20;
/** Most tokens one answer may use, its thinking included. */
export const SECOND_MAX_TOKENS = 2048;

/**
 * Claude Haiku 5.5's prices, in billionths of a US dollar per token. From
 * Anthropic's pricing page, https://platform.claude.com/docs/en/about-claude/pricing,
 * as of 17 November 2026: per million tokens, for a prompt of up to 100,000
 * tokens, input $0.10, 5 minute cache writes $0.125, 1 hour cache writes
 * $0.20, cache reads $0.01 and output $0.50, and five times each for a longer
 * prompt. A prompt's length counts its input, cache read and cache write
 * tokens. US-only inference costs 1.1 times as much.
 */
export const SECOND_MODEL_PRICES = {
  longPromptOver: 100_000,
  usOnly: 1.1,
  standard: { input: 100, cacheWrite5m: 125, cacheWrite1h: 200, cacheRead: 10, output: 500 },
  long: { input: 500, cacheWrite5m: 625, cacheWrite1h: 1000, cacheRead: 50, output: 2500 },
} as const;

/** What a second stage needs: the API key, the fetch it calls the API with, and the cap. */
export interface SecondStage {
  apiKey: string;
  fetch: Fetch;
  /** The monthly spending cap, in US dollars. */
  capUsd: number;
  /** How long one answer may take before it counts as a failed call. */
  timeoutMs: number;
}

/** The second model's call failed, or took longer than the stage allows. */
export class SecondModelUnavailable extends Error {}

/** A token usage block as the Messages API reports it. */
export type UsageBlock = Pick<Anthropic.Usage, "input_tokens" | "output_tokens"> & Partial<Pick<Anthropic.Usage, "cache_creation_input_tokens" | "cache_read_input_tokens" | "cache_creation" | "inference_geo">>;

/**
 * What one answer cost, in billionths of a US dollar, rounded up. Cache
 * writes the block doesn't split by duration are priced as 1 hour writes,
 * the dearer kind.
 */
export function costOf(usage: UsageBlock): number {
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const fiveMinutes = Math.min(written, usage.cache_creation?.ephemeral_5m_input_tokens ?? 0);
  const prompt = usage.input_tokens + read + written;
  const p = prompt > SECOND_MODEL_PRICES.longPromptOver ? SECOND_MODEL_PRICES.long : SECOND_MODEL_PRICES.standard;
  const cost =
    usage.input_tokens * p.input +
    read * p.cacheRead +
    fiveMinutes * p.cacheWrite5m +
    (written - fiveMinutes) * p.cacheWrite1h +
    usage.output_tokens * p.output;
  return Math.ceil(usage.inference_geo === "us" ? cost * SECOND_MODEL_PRICES.usOnly : cost);
}

/** The calendar month (UTC) spending counts against: `YYYY-MM`. */
export function monthOf(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/** The month's spending so far, in billionths of a US dollar. Throws when it can't be read. */
export async function monthSpend(db: D1Like, month: string): Promise<number> {
  const spent = await db.prepare("SELECT nano_usd FROM ai_spend WHERE month = ?").bind(month).first<number>("nano_usd");
  return typeof spent === "number" ? spent : 0;
}

/** Adds `nanoUsd` to the month's spending. Throws when it can't be written. */
export async function addSpend(db: D1Like, month: string, nanoUsd: number): Promise<void> {
  await db
    .prepare("INSERT INTO ai_spend (month, nano_usd) VALUES (?, ?) ON CONFLICT (month) DO UPDATE SET nano_usd = ai_spend.nano_usd + excluded.nano_usd")
    .bind(month, nanoUsd)
    .run();
}

/** The cap in billionths of a US dollar, from SECOND_REVIEW_CAP_USD: DEFAULT_SECOND_REVIEW_CAP_USD when it is not a number of 0 or more. */
export function capOf(text: string | undefined): number {
  const usd = text === undefined || text.trim() === "" ? NaN : Number(text);
  return Number.isFinite(usd) && usd >= 0 ? usd : DEFAULT_SECOND_REVIEW_CAP_USD;
}

/** The second model's answer, and what it cost. */
export interface SecondAnswer {
  /** Parsed JSON from the answer's text, or null when there is none to read. */
  answer: Record<string, unknown> | null;
  nanoUsd: number;
}

/**
 * Asks the second model, with the same system prompt and case as the first,
 * for an answer held to `schema` by structured outputs (which needs
 * `additionalProperties: false`, added here). Throws
 * SecondModelUnavailable when the call fails or takes longer than
 * `stage.timeoutMs`. An answer that was refused or cut short has no answer
 * to read, and still costs what its usage says.
 */
export async function askSecondModel(stage: SecondStage, system: string, user: string, schema: Record<string, unknown>): Promise<SecondAnswer> {
  const client = new Anthropic({
    apiKey: stage.apiKey,
    fetch: stage.fetch as unknown as typeof fetch,
    maxRetries: 0,
    timeout: stage.timeoutMs,
  });
  let message: Anthropic.Message;
  try {
    message = await client.messages.create({
      model: SECOND_REVIEW_MODEL,
      max_tokens: SECOND_MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low", format: { type: "json_schema", schema: { ...schema, additionalProperties: false } } },
    });
  } catch (error) {
    throw new SecondModelUnavailable(error instanceof Error ? error.message : String(error));
  }
  const nanoUsd = costOf(message.usage);
  if (message.stop_reason !== "end_turn") return { answer: null, nanoUsd };
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  try {
    const parsed: unknown = JSON.parse(text);
    return { answer: typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null, nanoUsd };
  } catch {
    return { answer: null, nanoUsd };
  }
}
