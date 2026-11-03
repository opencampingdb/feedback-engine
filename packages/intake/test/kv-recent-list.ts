import { newPlaceStanding, type NewPlaceCheck, type NewPlaceReport } from "@opencampingdb/feedback";
import { BLOCKED_KEY, getKvBlocked, getKvPlace, kvKey, kvPages, readKey, type KvEvidenceMetadata, type ListableKV } from "../src/recent-kv.js";
import type { Bbox, RecentPlace, StoredPlace } from "../src/recent.js";
import type { FakeKv } from "./fake-kv.js";

/**
 * The recent list as the intake wrote and read it in Workers KV before the
 * move to D1, so tests can fill a KV recent list and check the copy answers
 * the same as KV did.
 */

/** A check, removal report or withdraw on a KV place, each kept under its own key. */
export type KvEvidence =
  | { type: "check"; check: NewPlaceCheck }
  | { type: "report"; report: NewPlaceReport }
  | { type: "withdraw"; at: string };

/**
 * The listed part of a place, kept in its key's metadata so the list needs no
 * get for each place. A name too long for the metadata stays in the value
 * alone, and `long_name` says to read it from there.
 */
type KvPlaceMetadata = Omit<StoredPlace, "id" | "attest_key"> & { long_name?: true };
/** Workers KV refuses metadata longer than this, as JSON in UTF-8. */
const MAX_METADATA_BYTES = 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const EVIDENCE_KEY = { check: "c", report: "r", withdraw: "w" } as const;

/** Writes a new place as the KV recent list did. */
export async function addKvPlace(kv: FakeKv, place: StoredPlace): Promise<void> {
  const { id: _, attest_key: __, ...listed } = place;
  const metadata: KvPlaceMetadata = bytes(listed) <= MAX_METADATA_BYTES ? listed : { ...listed, name: null, long_name: true };
  await kv.put(kvKey(place.id), JSON.stringify(place), { metadata });
}

/** Writes one check, removal report or withdraw under a key of its own, named by the feedback item's id. */
export async function addKvEvidence(kv: FakeKv, place: string, feedbackId: string, evidence: KvEvidence): Promise<void> {
  const metadata: KvEvidenceMetadata =
    evidence.type === "check" ? evidence.check : evidence.type === "report" ? evidence.report : { day: evidence.at };
  await kv.put(`${kvKey(place)}:${EVIDENCE_KEY[evidence.type]}:${feedbackId}`, "", { metadata });
}

/** Replaces the KV block list. */
export async function setKvBlocked(kv: FakeKv, contributors: readonly string[]): Promise<void> {
  await kv.put(BLOCKED_KEY, JSON.stringify([...new Set(contributors)]));
}

/** The recent list as the intake read it from KV. */
export async function listPlacesFromKv(kv: ListableKV, now: string, bbox?: Bbox): Promise<RecentPlace[]> {
  const places = new Map<string, { metadata?: KvPlaceMetadata; checks: NewPlaceCheck[]; reports: NewPlaceReport[]; withdrawn: string[] }>();
  const entry = (id: string) => {
    let found = places.get(id);
    if (!found) places.set(id, (found = { checks: [], reports: [], withdrawn: [] }));
    return found;
  };
  for await (const keys of kvPages(kv)) {
    for (const { name, metadata } of keys) {
      if (metadata === undefined) continue;
      const read = readKey(name);
      const place = entry(read.place);
      if (read.evidence === undefined) place.metadata = metadata as KvPlaceMetadata;
      else if (read.evidence === "c") place.checks.push(metadata as NewPlaceCheck);
      else if (read.evidence === "r") place.reports.push(metadata as NewPlaceReport);
      else place.withdrawn.push((metadata as { day: string }).day);
    }
  }
  const blocked = await getKvBlocked(kv);
  const out: RecentPlace[] = [];
  for (const [id, { metadata, checks, reports, withdrawn }] of places) {
    if (!metadata) continue;
    if (bbox) {
      const [west, south, east, north] = bbox;
      const { lat, lon } = metadata.location;
      if (lat < south || lat > north || lon < west || lon > east) continue;
    }
    const standing = newPlaceStanding({
      added: metadata.added,
      contributor: { device: metadata.device, blocked: blocked.has(metadata.contributor), firstPlace: false },
      checks,
      reports,
      withdrawnAt: withdrawn.sort()[0] ?? null,
      duplicateOf: null,
      moderator: null,
      now,
    });
    if (standing !== "shown" && standing !== "confirmed") continue;
    const { location, kind, added, contributor } = metadata;
    const name = metadata.long_name ? ((await getKvPlace(kv, id))?.name ?? null) : (metadata.name ?? null);
    out.push({ id, location, kind, name, standing, added, contributor });
  }
  return out;
}
