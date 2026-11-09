import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replacePhoto, ReplaceError, REPLACED_TTL_SECONDS, type PhotoStores } from "../../apply/src/photo-replace.js";
import { dumpPhotoLine } from "../../apply/src/serialise.js";
import type { Photo } from "../../apply/src/types.js";
import { createHandler, KEY_TTL_MS, type CacheLike, type Ctx, type Env, type KVLike } from "../src/index.js";

const KEY = "example-app-photo-key-0001";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const NOW = Date.parse("2026-11-09T01:00:00Z");
const buckets = { serving: "example-serving", pending: "example-pending" };

/** A minimal JPEG of the given size, with `fill` bytes after the frame header. */
function jpeg(width: number, height: number, fill: number): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...sof, ...new Array(50).fill(fill), 0xff, 0xd9]);
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** R2, as a map of bucket to key to bytes, behind both the replace tool and the photo server. */
function fakeR2() {
  const objects = new Map<string, Map<string, Uint8Array>>();
  const of = (bucket: string) => objects.get(bucket) ?? objects.set(bucket, new Map()).get(bucket)!;
  const stores: PhotoStores = {
    exists: async (bucket, key) => of(bucket).has(key),
    put: async (bucket, key, body) => void of(bucket).set(key, typeof body === "string" ? new TextEncoder().encode(body) : body),
  };
  const serving = {
    get: async (key: string) => {
      const bytes = of(buckets.serving).get(key);
      return bytes ? { body: new Response(new Uint8Array(bytes)).body!, httpEtag: `"${sha(bytes).slice(0, 8)}"`, size: bytes.length } : null;
    },
  };
  return { of, stores, serving };
}

function fakeKv(): KVLike & { ttl: Map<string, number> } {
  const data = new Map<string, string>();
  const ttl = new Map<string, number>();
  return {
    ttl,
    get: async (k) => data.get(k) ?? null,
    put: async (k, v, o) => {
      data.set(k, v);
      if (o?.expirationTtl) ttl.set(k, o.expirationTtl);
    },
    list: async ({ prefix }) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

function fakeCache(): CacheLike {
  const store = new Map<string, Response>();
  return { match: async (r) => store.get(r.url)?.clone(), put: async (r, res) => void store.set(r.url, res) };
}

const ctx = (): Ctx & { done: () => Promise<void> } => {
  const waits: Promise<unknown>[] = [];
  return { waitUntil: (p) => void waits.push(p), done: async () => void (await Promise.all(waits)) };
};
const get = (path: string) => new Request(`https://photos.example${path}`, { headers: { "x-app-key": KEY } });

describe("replacing a photo's files", () => {
  let root: string;
  let line: Photo;
  const oldFull = jpeg(1600, 1200, 1);
  const oldThumb = jpeg(400, 300, 1);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "replace-"));
    line = {
      id: PHOTO,
      place: PLACE,
      contributor: "ctr_0123456789abcdef",
      created: "2026-10-01T00:00:00Z",
      app: "example-app",
      licence: "CC-BY-4.0",
      width: 1600,
      height: 1200,
      sha256: sha(oldFull),
    };
    const other: Photo = { ...line, id: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZC", sha256: "c".repeat(64) };
    await mkdir(join(root, "photos"), { recursive: true });
    await writeFile(join(root, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine(line)}\n${dumpPhotoLine(other)}\n`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("serves the new files under the same id, cache or not, and keeps every field but the hash and size", async () => {
    const r2 = fakeR2();
    for (const [key, bytes] of [[`${PHOTO}/full.jpg`, oldFull], [`${PHOTO}/thumb.jpg`, oldThumb]] as const) {
      r2.of(buckets.serving).set(key, bytes);
      r2.of(buckets.pending).set(key, bytes);
    }
    const state = fakeKv();
    let clock = NOW;
    const env: Env = { PHOTOS: r2.serving, PHOTO_KEYS: JSON.stringify({ [KEY]: { app: "example-app", daily_limit: 1000 } }), STATE: state };
    const handle = createHandler({ now: () => clock, cache: fakeCache, shard: 1 });
    // Served and cached before the replacement.
    const c = ctx();
    expect(new Uint8Array(await (await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, c)).arrayBuffer())).toEqual(oldFull);
    await c.done();

    const full = jpeg(1600, 900, 9);
    const thumb = jpeg(400, 225, 9);
    const result = await replacePhoto({
      root,
      photo: PHOTO,
      full,
      thumb,
      buckets,
      stores: r2.stores,
      state: (k, v, ttl) => state.put(k, v, { expirationTtl: ttl }),
      now: new Date(NOW),
    });
    expect(result.wrote.sort()).toEqual(
      [
        `${buckets.pending}/${PHOTO}/full.jpg`,
        `${buckets.pending}/${PHOTO}/thumb.jpg`,
        `${buckets.serving}/${PHOTO}/full.jpg`,
        `${buckets.serving}/${PHOTO}/thumb.jpg`,
        `${buckets.serving}/records/${PLACE}.ndjson`,
      ].sort(),
    );
    expect(result.after).toEqual({ ...line, sha256: sha(full), width: 1600, height: 900 });
    const lines = (await readFile(join(root, "photos", `${PLACE}.ndjson`), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Photo);
    expect(lines[0]).toEqual({ ...line, sha256: sha(full), width: 1600, height: 900 });
    expect(lines[1]!.sha256).toBe("c".repeat(64));
    expect([...state.ttl].filter(([k]) => k.startsWith("replaced"))).toEqual([
      [`replaced:${PHOTO}`, REPLACED_TTL_SECONDS],
      [`replaced-place:${PLACE}`, REPLACED_TTL_SECONDS],
    ]);

    // Within KEY_TTL_MS the server reads the replacement, and the old cache entry is no longer used.
    clock += KEY_TTL_MS;
    expect(new Uint8Array(await (await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).arrayBuffer())).toEqual(full);
    expect(new Uint8Array(await (await handle(get(`/v1/photos/${PHOTO}/thumb.jpg`), env, ctx())).arrayBuffer())).toEqual(thumb);
    const records = await (await handle(get(`/v1/places/${PLACE}/photos.ndjson`), env, ctx())).text();
    expect(JSON.parse(records.split("\n")[0]!)).toEqual({ ...line, sha256: sha(full), width: 1600, height: 900 });
  });

  it("replaces the kept copy of a hidden photo, so showing it again brings the new files", async () => {
    await writeFile(join(root, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine({ ...line, hidden: "reported" })}\n`);
    const r2 = fakeR2();
    r2.of(buckets.pending).set(`kept/${PHOTO}/full.jpg`, oldFull);
    r2.of(buckets.pending).set(`kept/${PHOTO}/thumb.jpg`, oldThumb);
    const result = await replacePhoto({ root, photo: PHOTO, full: jpeg(10, 10, 9), thumb: jpeg(5, 5, 9), buckets, stores: r2.stores, state: async () => undefined, now: new Date(NOW) });
    expect(result.wrote).toEqual([`${buckets.pending}/kept/${PHOTO}/full.jpg`, `${buckets.pending}/kept/${PHOTO}/thumb.jpg`]);
    expect(r2.of(buckets.pending).get(`kept/${PHOTO}/full.jpg`)).toEqual(jpeg(10, 10, 9));
  });

  it("writes nothing when the files are not JPEGs, the photo has no line or no files, or it was removed", async () => {
    const r2 = fakeR2();
    const run = (photo: string, full = jpeg(10, 10, 9)) =>
      replacePhoto({ root, photo, full, thumb: jpeg(5, 5, 9), buckets, stores: r2.stores, state: async () => undefined, now: new Date(NOW) });
    await expect(run(PHOTO, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).rejects.toBeInstanceOf(ReplaceError);
    await expect(run("pho_01JBXK3M8Q4R5S6T7V8W9X0YZZ")).rejects.toThrow(/no photo line/);
    await expect(run(PHOTO)).rejects.toThrow(/no files/);
    await mkdir(join(root, "moderation"), { recursive: true });
    await writeFile(join(root, "moderation", "removed_photos.json"), JSON.stringify({ photos: [{ photo: PHOTO, removed: "2026-11-01T00:00:00Z", reason: "moderator" }] }));
    await expect(run(PHOTO)).rejects.toThrow(/removed_photos/);
    expect(r2.of(buckets.serving).size + r2.of(buckets.pending).size).toBe(0);
  });
});
