/**
 * Copies the recent list from Workers KV, where it was kept before the move
 * to D1, into the D1 tables. Every row is written with INSERT OR IGNORE, so
 * running the copy again, or after the new intake has started writing to D1,
 * adds only what is missing and never doubles a row.
 */
import type { NewPlaceCheck, NewPlaceReport } from "@opencampingdb/feedback";
import { getBlocked, key, pages, PREFIX, type ListableKV } from "./recent-kv.js";
import { evidenceStatement, placeStatement, type D1Like, type D1Statement, type Evidence, type StoredPlace } from "./recent.js";

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

const chunks = <T>(items: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

interface KeptEvidence {
  place: string;
  feedbackId: string;
  evidence: Evidence;
}

/** An evidence key, `np:<place>:<c|r|w>:<feedback id>`, as D1 evidence. Undefined for anything else. */
function readEvidence(name: string, metadata: unknown): KeptEvidence | undefined {
  const [place, kind, ...rest] = name.slice(PREFIX.length).split(":");
  const feedbackId = rest.join(":");
  if (!place || !feedbackId || metadata === undefined || metadata === null) return undefined;
  if (kind === "c") return { place, feedbackId, evidence: { kind: "check", check: metadata as NewPlaceCheck } };
  if (kind === "r") return { place, feedbackId, evidence: { kind: "removal_report", report: metadata as NewPlaceReport } };
  if (kind === "w") return { place, feedbackId, evidence: { kind: "withdraw", at: (metadata as { day: string }).day } };
  return undefined;
}

/**
 * Reads every new place, the evidence on it and the block list from `kv`,
 * listing the `np:` keys in a single pass, and writes them into `db`.
 * Evidence on a place that has already left KV is not copied, as the KV
 * recent list never served it. The block list is added to what D1 holds, so
 * a list the apply run has since sent to D1 is kept.
 */
export async function copyToD1(kv: ListableKV, db: D1Like): Promise<CopyCount> {
  const ids: string[] = [];
  const evidence: KeptEvidence[] = [];
  for await (const keys of pages(kv)) {
    for (const { name, metadata } of keys) {
      const rest = name.slice(PREFIX.length);
      if (!rest.includes(":")) ids.push(rest);
      else {
        const read = readEvidence(name, metadata);
        if (read) evidence.push(read);
      }
    }
  }

  // The value holds what the metadata leaves out: the attestation key and a long name.
  const places: StoredPlace[] = [];
  for (const part of chunks(ids, READS_AT_ONCE)) {
    const texts = await Promise.all(part.map((id) => kv.get(key(id))));
    for (const text of texts) if (text !== null) places.push(JSON.parse(text) as StoredPlace);
  }
  const present = new Set(places.map((p) => p.id));
  const kept = evidence.filter((e) => present.has(e.place));
  const blocked = [...(await getBlocked(kv))];

  const statements: D1Statement[] = [
    ...places.map((p) => placeStatement(db, p)),
    ...kept.map((e) => evidenceStatement(db, e.place, e.feedbackId, e.evidence)),
    ...blocked.map((c) => db.prepare("INSERT OR IGNORE INTO blocked_contributors (contributor) VALUES (?)").bind(c)),
  ];
  for (const part of chunks(statements, BATCH_SIZE)) await db.batch(part);
  return { places: places.length, evidence: kept.length, blocked: blocked.length };
}
