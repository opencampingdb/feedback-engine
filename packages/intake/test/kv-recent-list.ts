import { newPlaceStanding, type NewPlaceCheck, type NewPlaceReport } from "@opencampingdb/feedback";
import { getBlocked, getPlace, pages, readKey, type ListableKV, type PlaceMetadata } from "../src/recent-kv.js";
import type { Bbox, RecentPlace } from "../src/recent.js";

/**
 * The recent list as the intake read it from Workers KV before the move to D1,
 * so tests can check the copy answers the same as KV did.
 */
export async function listPlacesFromKv(kv: ListableKV, now: string, bbox?: Bbox): Promise<RecentPlace[]> {
  const places = new Map<string, { metadata?: PlaceMetadata; checks: NewPlaceCheck[]; reports: NewPlaceReport[]; withdrawn: string[] }>();
  const entry = (id: string) => {
    let found = places.get(id);
    if (!found) places.set(id, (found = { checks: [], reports: [], withdrawn: [] }));
    return found;
  };
  for await (const keys of pages(kv)) {
    for (const { name, metadata } of keys) {
      if (metadata === undefined) continue;
      const read = readKey(name);
      const place = entry(read.place);
      if (read.evidence === undefined) place.metadata = metadata as PlaceMetadata;
      else if (read.evidence === "c") place.checks.push(metadata as NewPlaceCheck);
      else if (read.evidence === "r") place.reports.push(metadata as NewPlaceReport);
      else place.withdrawn.push((metadata as { day: string }).day);
    }
  }
  const blocked = await getBlocked(kv);
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
    const name = metadata.long_name ? ((await getPlace(kv, id))?.name ?? null) : (metadata.name ?? null);
    out.push({ id, location, kind, name, standing, added, contributor });
  }
  return out;
}
