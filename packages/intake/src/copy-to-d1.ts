/**
 * Copies the recent list from Workers KV, where it was kept before the move
 * to D1, into the D1 tables, with the statements the intake writes them
 * with. Each skips a row already there, so a copy never doubles a row.
 */
import type { NewPlaceCheck, NewPlaceReport } from "@opencampingdb/feedback";
import { getKvBlocked, kvKey, kvPages, readKey, type KvEvidenceMetadata, type ListableKV } from "./recent-kv.js";
import {
  blockStatements,
  chunks,
  evidenceStatement,
  placeStatement,
  type D1Like,
  type D1Statement,
  type Evidence,
  type StoredPlace,
} from "./recent.js";

/** What one copy wrote, or found already there. */
export interface CopyCount {
  places: number;
  evidence: number;
  blocked: number;
}

/** Statements per D1 batch, so no one batch grows past what a call allows. */
const BATCH_SIZE = 50;
/** Place values read from KV at the same time. */
const READS_AT_ONCE = 20;

interface KeptEvidence {
  place: string;
  feedbackId: string;
  evidence: Evidence;
}

/** Evidence as D1 keeps it, from the letter in its KV key and the key's metadata. */
function toEvidence(letter: "c" | "r" | "w", metadata: KvEvidenceMetadata): Evidence {
  if (letter === "c") return { kind: "check", check: metadata as NewPlaceCheck };
  if (letter === "r") return { kind: "removal_report", report: metadata as NewPlaceReport };
  return { kind: "withdraw", at: (metadata as { day: string }).day };
}

/** When evidence was sent. */
function sentAt(evidence: Evidence): string {
  if (evidence.kind === "check") return evidence.check.day;
  if (evidence.kind === "removal_report") return evidence.report.day;
  return evidence.at;
}

/**
 * Reads the new places and the evidence on them from `kv`, listing the `np:`
 * keys in a single pass, and writes them into `db`. Evidence on a place that
 * has already left KV is not copied, as the KV recent list never served it.
 *
 * The first copy, before the new intake goes live, is run without `since`
 * and copies everything, the block list too. The copy after the deploy is
 * run with `since` set to when the first one started: it copies only the
 * places added and the evidence sent from then on, and leaves the block list
 * alone. D1 is the recent list by then, so a place the apply run has removed
 * from it, or a contributor it has taken off the block list, stays that way.
 */
export async function copyToD1(kv: ListableKV, db: D1Like, options: { since?: string } = {}): Promise<CopyCount> {
  const since = options.since === undefined ? undefined : Date.parse(options.since);
  if (since !== undefined && Number.isNaN(since)) throw new Error(`since is not a time: ${options.since}`);
  const fromThen = (time: string) => since === undefined || Date.parse(time) >= since;

  const ids: string[] = [];
  const evidence: KeptEvidence[] = [];
  for await (const keys of kvPages(kv)) {
    for (const { name, metadata } of keys) {
      const { place, evidence: letter, feedbackId } = readKey(name);
      if (!letter) ids.push(place);
      else if (feedbackId && metadata !== undefined && metadata !== null) {
        evidence.push({ place, feedbackId, evidence: toEvidence(letter, metadata as KvEvidenceMetadata) });
      }
    }
  }

  // The value holds what the metadata leaves out: the registered key and a long name.
  const places: StoredPlace[] = [];
  for (const part of chunks(ids, READS_AT_ONCE)) {
    const texts = await Promise.all(part.map((id) => kv.get(kvKey(id))));
    for (const text of texts) if (text !== null) places.push(JSON.parse(text) as StoredPlace);
  }
  const present = new Set(places.map((p) => p.id));
  const copied = places.filter((p) => fromThen(p.added));
  const kept = evidence.filter((e) => present.has(e.place) && fromThen(sentAt(e.evidence)));
  const blocked = since === undefined ? [...(await getKvBlocked(kv))] : [];

  const statements: D1Statement[] = [
    ...copied.map((p) => placeStatement(db, p)),
    ...kept.map((e) => evidenceStatement(db, e.place, e.feedbackId, e.evidence)),
    ...blockStatements(db, blocked),
  ];
  for (const part of chunks(statements, BATCH_SIZE)) await db.batch(part);
  return { places: copied.length, evidence: kept.length, blocked: blocked.length };
}
