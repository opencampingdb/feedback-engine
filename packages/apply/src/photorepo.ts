/**
 * An app's photo repository: `photos/<place id>.ndjson` lines written by the
 * apply rules, and `moderation/` lists. This keeps the app's two buckets in
 * step with it and checks its lines. The serving bucket holds exactly the
 * visible photos (not hidden, not from a blocked contributor), plus
 * `records/<place id>.ndjson` with each place's visible lines for the photo
 * server's records route. The pending bucket holds uploads and `kept/` copies
 * of hidden photos, so a photo shown again needs no new upload.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DataRepo } from "./io.js";

export const KEPT = "kept/";
export const RECORDS = "records/";
const SIZES = ["full", "thumb"] as const;

export interface Buckets {
  serving: string;
  pending: string;
}

export interface SyncState {
  visible: ReadonlySet<string>;
  other: ReadonlySet<string>;
  removed: ReadonlySet<string>;
  /** Keys in the serving bucket. */
  serving: ReadonlySet<string>;
  /** Keys in the pending bucket. */
  pending: ReadonlySet<string>;
}

export interface SyncPlan {
  /** [from bucket, from key, to bucket, to key], in order. */
  copies: [string, string, string, string][];
  /** Bucket to keys, deleted after every copy. */
  deletes: Record<string, string[]>;
  /** Keys of visible photos with no file to copy. */
  missing: string[];
}

/** The photo id in a bucket key: `pho_…/full.jpg` or `kept/pho_…/full.jpg`. */
const photoId = (key: string) => (key.startsWith(KEPT) ? key.slice(KEPT.length) : key).split("/", 1)[0]!;

/** What to copy and delete so the buckets match the records. Records files are left to `recordFiles`. */
export function planSync(state: SyncState, buckets: Buckets): SyncPlan {
  const out: SyncPlan = { copies: [], deletes: {}, missing: [] };
  const remove = (bucket: string, key: string) => {
    const list = (out.deletes[bucket] ??= []);
    if (!list.includes(key)) list.push(key);
  };
  for (const id of [...state.visible].filter((v) => !state.removed.has(v)).sort()) {
    for (const size of SIZES) {
      const key = `${id}/${size}.jpg`;
      if (state.serving.has(key)) continue;
      if (state.pending.has(key)) out.copies.push([buckets.pending, key, buckets.serving, key]);
      else if (state.pending.has(KEPT + key)) out.copies.push([buckets.pending, KEPT + key, buckets.serving, key]);
      else out.missing.push(key);
    }
  }
  for (const key of [...state.serving].sort()) {
    if (key.startsWith(RECORDS)) continue;
    const id = photoId(key);
    if (state.visible.has(id) && !state.removed.has(id)) continue;
    if (state.other.has(id) && !state.removed.has(id) && !state.pending.has(KEPT + key) && !state.pending.has(key)) {
      out.copies.push([buckets.serving, key, buckets.pending, KEPT + key]);
    }
    remove(buckets.serving, key);
  }
  for (const key of [...state.pending].sort()) {
    if (state.removed.has(photoId(key))) remove(buckets.pending, key);
  }
  return out;
}

interface RawLine {
  text: string;
  photo: { id: string; place: string; contributor?: string; hidden?: string; licence?: string };
}

/** Every photo file's lines, by place, as written. */
async function rawLines(root: string): Promise<Map<string, RawLine[]>> {
  const out = new Map<string, RawLine[]>();
  let names: string[] = [];
  try {
    names = (await readdir(join(root, "photos"))).filter((n) => n.endsWith(".ndjson")).sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const text = await readFile(join(root, "photos", name), "utf8");
    out.set(
      name.slice(0, -".ndjson".length),
      text
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => ({ text: line, photo: JSON.parse(line) as RawLine["photo"] })),
    );
  }
  return out;
}

const isVisible = (photo: RawLine["photo"], blocked: ReadonlySet<string>) =>
  photo.hidden === undefined && !(photo.contributor !== undefined && blocked.has(photo.contributor));

/** Visible and not visible photo ids in the repository. */
export async function photoStates(root: string): Promise<{ visible: Set<string>; other: Set<string> }> {
  const blocked = await new DataRepo(root).blocked();
  const visible = new Set<string>();
  const other = new Set<string>();
  for (const lines of (await rawLines(root)).values()) {
    for (const { photo } of lines) (isVisible(photo, blocked) ? visible : other).add(photo.id);
  }
  return { visible, other };
}

/** Each place with visible photos, and its records file: the visible lines as written. */
export async function recordFiles(root: string): Promise<Map<string, string>> {
  const blocked = await new DataRepo(root).blocked();
  const out = new Map<string, string>();
  for (const [place, lines] of await rawLines(root)) {
    const shown = lines.filter((l) => isVisible(l.photo, blocked));
    if (shown.length > 0) out.set(place, shown.map((l) => `${l.text}\n`).join(""));
  }
  return out;
}

/** Problems with the photo lines: each must be for a known place, carry the licence, be sorted by id and not be on the removed list. */
export async function checkPhotos(root: string, options: { places: ReadonlySet<string>; licence: string }): Promise<string[]> {
  const removed = new Set((await new DataRepo(root).removedPhotos()).map((e) => e.photo));
  const errors: string[] = [];
  for (const [place, lines] of await rawLines(root)) {
    const file = `photos/${place}.ndjson`;
    if (!options.places.has(place)) errors.push(`${file}: no such place ${place}`);
    let previous = "";
    lines.forEach(({ photo }, i) => {
      const at = `${file} line ${i + 1}`;
      if (photo.licence !== options.licence) errors.push(`${at}: licence must be ${options.licence}`);
      if (photo.id <= previous) errors.push(`${at}: lines must be sorted by id`);
      if (removed.has(photo.id)) errors.push(`${at}: photo ${photo.id} is on moderation/removed_photos.json`);
      previous = photo.id;
    });
  }
  return errors;
}
