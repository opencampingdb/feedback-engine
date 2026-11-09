/**
 * Replaces a published photo's files while it keeps its id, place,
 * contributor, created date and licence: for example after blurring a face or
 * a number plate in it. An operator tool, never a public route.
 *
 * The new files go wherever the photo's files are (the serving bucket, the
 * pending upload, the `kept/` copy of a hidden photo), so hiding and showing
 * it later never brings the old files back. Its line in the records
 * repository checkout gets the new `sha256`, `width` and `height`, the
 * place's records file in the serving bucket is written again, and
 * `replaced:<photo id>` and `replaced-place:<place id>` keys in the photo
 * server's state move the photo and its records to new edge cache entries.
 */

import { isJpeg, jpegSize, MAX_PHOTO_BYTES, MAX_THUMB_BYTES, sha256HexBytes } from "@opencampingdb/feedback";
import { DataRepo } from "./io.js";
import { KEPT, RECORDS, recordFiles, type Buckets } from "./photorepo.js";
import type { Photo } from "./types.js";

/** The photo server's state keys for a replaced photo and its place: `replaced:<photo id>` and `replaced-place:<place id>`, each `{ "generation" }`. */
export const replacedKey = (photo: string) => `replaced:${photo}`;
export const replacedPlaceKey = (place: string) => `replaced-place:${place}`;
/**
 * How long a `replaced:` key lasts. Longer than a cached photo's day, so by
 * the time the key goes, no cache entry from before the replacement is left.
 */
export const REPLACED_TTL_SECONDS = 2 * 24 * 60 * 60;


/** The bucket operations the replacement needs. */
export interface PhotoStores {
  exists(bucket: string, key: string): Promise<boolean>;
  /** Writes an object. `metadata` becomes its custom metadata; without it the object has none. */
  put(bucket: string, key: string, body: Uint8Array | string, contentType: string, metadata?: Record<string, string>): Promise<void>;
}

/** Writes one key to the photo server's state namespace, expiring after `ttlSeconds`. */
export type StateWriter = (key: string, value: string, ttlSeconds: number) => Promise<void>;

export interface ReplaceInput {
  /** A checkout of the records repository. Its photo line is changed in place: commit it to `main`. */
  root: string;
  photo: string;
  full: Uint8Array;
  thumb: Uint8Array;
  buckets: Buckets;
  stores: PhotoStores;
  state: StateWriter;
  now: Date;
}

export interface ReplaceResult {
  place: string;
  /** The photo file changed in the checkout, `photos/<place id>.ndjson`. */
  file: string;
  /** Every bucket key written, as `bucket/key`. */
  wrote: string[];
  /** The line before and after. */
  before: Photo;
  after: Photo;
}

export class ReplaceError extends Error {}

/** Replaces the photo's files and updates its line. Throws ReplaceError, before writing anything, when it can't. */
export async function replacePhoto(input: ReplaceInput): Promise<ReplaceResult> {
  const { photo, full, thumb, buckets, stores } = input;
  const size = jpegSize(full);
  const problems: string[] = [];
  if (!isJpeg(full) || !size) problems.push("the full size file is not a JPEG");
  if (!isJpeg(thumb) || !jpegSize(thumb)) problems.push("the thumbnail is not a JPEG");
  if (full.length > MAX_PHOTO_BYTES) problems.push(`the full size file is over ${MAX_PHOTO_BYTES} bytes`);
  if (thumb.length > MAX_THUMB_BYTES) problems.push(`the thumbnail is over ${MAX_THUMB_BYTES} bytes`);
  if (problems.length > 0) throw new ReplaceError(problems.join("; "));

  const repo = new DataRepo(input.root);
  if ((await repo.removedPhotos()).some((r) => r.photo === photo)) throw new ReplaceError(`${photo} is on moderation/removed_photos.json`);
  const before = (await repo.allPhotos()).find((p) => p.id === photo);
  if (!before) throw new ReplaceError(`no photo line for ${photo} in ${input.root}/photos`);

  // Every copy of each file, in whichever bucket holds one.
  const targets: [string, string, Uint8Array][] = [];
  for (const [name, bytes] of [["full", full], ["thumb", thumb]] as const) {
    const key = `${photo}/${name}.jpg`;
    for (const [bucket, at] of [[buckets.serving, key], [buckets.pending, key], [buckets.pending, KEPT + key]] as const) {
      if (await stores.exists(bucket, at)) targets.push([bucket, at, bytes]);
    }
  }
  if (!targets.some(([, key]) => key.endsWith("/full.jpg"))) throw new ReplaceError(`no files for ${photo} in ${buckets.serving} or ${buckets.pending}`);

  const after: Photo = { ...before, sha256: sha256HexBytes(full), width: size!.width, height: size!.height };
  const wrote: string[] = [];
  // The photo server reads the contributor from each file to withhold an erased contributor's photos.
  const metadata = { place: before.place, contributor: before.contributor };
  for (const [bucket, key, bytes] of targets) {
    await stores.put(bucket, key, bytes, "image/jpeg", metadata);
    wrote.push(`${bucket}/${key}`);
  }
  const lines = (await repo.photos(before.place)).map((p) => (p.id === photo ? after : p));
  const file = (await repo.writePhotos(before.place, lines)) ?? `photos/${before.place}.ndjson`;
  // The place's records, as the photo sync writes them, so they carry the new hash at once.
  const records = (await recordFiles(input.root)).get(before.place);
  if (records !== undefined) {
    await stores.put(buckets.serving, `${RECORDS}${before.place}.ndjson`, records, "application/x-ndjson; charset=utf-8");
    wrote.push(`${buckets.serving}/${RECORDS}${before.place}.ndjson`);
  }
  // The generation, in whole seconds, becomes part of the photo server's cache keys.
  const value = JSON.stringify({ generation: Math.floor(input.now.getTime() / 1000), at: input.now.toISOString() });
  await input.state(replacedKey(photo), value, REPLACED_TTL_SECONDS);
  await input.state(replacedPlaceKey(before.place), value, REPLACED_TTL_SECONDS);
  return { place: before.place, file, wrote, before, after };
}
