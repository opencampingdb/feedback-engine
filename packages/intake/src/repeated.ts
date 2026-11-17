/**
 * The repeated text check: free text nearly the same as text other sources
 * sent in the last 30 days is held as `repeated_text`, so a spam campaign sent
 * from many devices reaches a person instead of the data.
 *
 * Each item's free text (the name, description, note and free words of a fact
 * on a report, or a review's text) is embedded with Workers AI and looked up
 * in Vectorize among the vectors of the last `REPEATED_TEXT_DAYS` from other
 * sources. The text is held when at least `REPEATED_TEXT_SOURCES` other
 * sources sent a text whose cosine similarity is `REPEATED_TEXT_SIMILARITY`
 * or more. Then its own vector is stored with its source and time, whatever
 * the outcome, so texts the rules held still count. A source is the client
 * network the item came from, or its device when the network is not known,
 * as the apply counts sources. Texts shorter than `REPEATED_TEXT_MIN_LENGTH`
 * characters, such as most names, are not checked.
 *
 * The vector ids and times are kept in D1 (`text_vectors`), and the scheduled
 * job deletes the vectors older than the window, since Vectorize keeps them
 * until deleted. No text is stored, only its vector.
 */

import { factFreeText, stripContactDetails, tidyText, type FeedbackSubmission } from "@opencampingdb/feedback";
import { CHECK_TIMEOUT_MS, freeText, withTimeout, type AiLike } from "./checks.js";
import type { D1Like } from "./recent.js";

/** The Workers AI embedding model: 768 numbers per text. The Vectorize index needs 768 dimensions and the cosine metric. */
export const REPEATED_TEXT_MODEL = "@cf/baai/bge-base-en-v1.5";
/** The cosine similarity from which two texts count as the same. */
export const REPEATED_TEXT_SIMILARITY = 0.95;
/** Other sources whose similar texts hold an item. */
export const REPEATED_TEXT_SOURCES = 3;
/** Days a text counts for, and its vector is kept. */
export const REPEATED_TEXT_DAYS = 30;
/** Texts shorter than this many characters are not checked. */
export const REPEATED_TEXT_MIN_LENGTH = 40;
/** Nearest neighbours read per lookup, within Vectorize's limit for indexed metadata. */
export const REPEATED_TEXT_NEIGHBOURS = 50;
/** Vectors deleted per call, and per scheduled run at most `REPEATED_TEXT_PRUNE_BATCHES` times this. */
const PRUNE_BATCH = 100;
const REPEATED_TEXT_PRUNE_BATCHES = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The part of a Vectorize binding the check uses. */
export interface VectorizeLike {
  query(
    vector: number[],
    options: { topK: number; filter?: Record<string, unknown>; returnMetadata?: "none" | "indexed" | "all" },
  ): Promise<{ matches: { id: string; score: number; metadata?: Record<string, unknown> | undefined }[] }>;
  upsert(vectors: { id: string; values: number[]; metadata?: Record<string, unknown> }[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

/**
 * What the check found: `none` when the item has no text to check, `clear`,
 * `repeated_text`, or `check_unavailable` when the embedding or Vectorize
 * failed or ran out of time.
 */
export type RepeatedResult = "none" | "clear" | "repeated_text" | "check_unavailable";

/** The free text the check reads on an item, joined, or an empty string. */
export function repeatedTextOf(submission: FeedbackSubmission): string {
  if (submission.type === "review") return tidyText(stripContactDetails(submission.review.text));
  if (submission.type !== "report") return "";
  const report = submission.report;
  const facts = report.kind === "fact" && typeof report.fact === "string" ? factFreeText(report.fact, report.value) : [];
  return [...freeText(submission), ...facts].join("\n\n");
}

export interface RepeatedDeps {
  ai: AiLike;
  index: VectorizeLike;
  db: D1Like;
  now: () => number;
}

/** One item as the check reads it: its feedback id, its source and its text. */
export interface RepeatedInput {
  id: string;
  source: string;
  text: string;
}

async function embedding(ai: AiLike, text: string): Promise<number[]> {
  const out = await withTimeout(CHECK_TIMEOUT_MS, () => ai.run(REPEATED_TEXT_MODEL, { text: [text] }));
  const data = typeof out === "object" && out !== null ? (out as { data?: unknown }).data : undefined;
  const vector = Array.isArray(data) ? (data[0] as unknown) : undefined;
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every((x) => typeof x === "number")) throw new Error("the embedding model answered without a vector");
  return vector as number[];
}

/**
 * Checks one item's text, and stores its vector. Never throws: a failure is
 * `check_unavailable`, and a text that is too short is `none`.
 */
export async function checkRepeated(deps: RepeatedDeps, input: RepeatedInput): Promise<RepeatedResult> {
  const text = input.text.trim();
  if (text.length < REPEATED_TEXT_MIN_LENGTH) return "none";
  try {
    const at = deps.now();
    const vector = await embedding(deps.ai, text);
    const found = await withTimeout(CHECK_TIMEOUT_MS, () =>
      deps.index.query(vector, {
        topK: REPEATED_TEXT_NEIGHBOURS,
        filter: { at: { $gte: at - REPEATED_TEXT_DAYS * DAY_MS }, source: { $ne: input.source } },
        returnMetadata: "indexed",
      }),
    );
    const sources = new Set(
      found.matches
        .filter((m) => m.score >= REPEATED_TEXT_SIMILARITY && m.metadata?.source !== input.source && typeof m.metadata?.at === "number" && m.metadata.at >= at - REPEATED_TEXT_DAYS * DAY_MS)
        .map((m) => m.metadata!.source),
    );
    await deps.db.prepare("INSERT OR IGNORE INTO text_vectors (id, at) VALUES (?, ?)").bind(input.id, at).run();
    await withTimeout(CHECK_TIMEOUT_MS, () => deps.index.upsert([{ id: input.id, values: vector, metadata: { source: input.source, at } }]));
    return sources.size >= REPEATED_TEXT_SOURCES ? "repeated_text" : "clear";
  } catch {
    return "check_unavailable";
  }
}

/** Deletes the vectors older than `REPEATED_TEXT_DAYS`, and their rows, for the intake's scheduled job. */
export async function pruneTextVectors(db: D1Like, index: VectorizeLike, now: number): Promise<void> {
  const oldest = now - REPEATED_TEXT_DAYS * DAY_MS;
  for (let i = 0; i < REPEATED_TEXT_PRUNE_BATCHES; i++) {
    const { results } = await db.prepare("SELECT id FROM text_vectors WHERE at < ? ORDER BY at LIMIT ?").bind(oldest, PRUNE_BATCH).all<{ id: string }>();
    if (results.length === 0) return;
    const ids = results.map((r) => r.id);
    await index.deleteByIds(ids);
    await db.prepare(`DELETE FROM text_vectors WHERE id IN (${ids.map(() => "?").join(", ")})`).bind(...ids).run();
    if (results.length < PRUNE_BATCH) return;
  }
}
