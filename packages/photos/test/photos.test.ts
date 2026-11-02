import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, FLUSH_EVERY, STATE_TTL_MS, type BucketLike, type CacheLike, type Ctx, type Env, type KVLike } from "../src/index.js";

const KEY = "example-app-photo-key-0001";
const OTHER_KEY = "other-app-photo-key-0002";
const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const NOW = Date.parse("2026-11-03T01:00:00Z");

function fakeKv(): KVLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v) };
}

function fakeBucket(keys: string[]): BucketLike & { reads: number } {
  const bucket = {
    reads: 0,
    get: async (key: string) => {
      bucket.reads += 1;
      if (!keys.includes(key)) return null;
      return { body: new Response(new Uint8Array([0xff, 0xd8, 0xff])).body!, httpEtag: '"e1"', size: 3 };
    },
  };
  return bucket;
}

function fakeCache(): CacheLike & { store: Map<string, Response> } {
  const store = new Map<string, Response>();
  return {
    store,
    match: async (r) => store.get(r.url)?.clone(),
    put: async (r, res) => void store.set(r.url, res),
  };
}

function ctx(): Ctx & { done: () => Promise<void> } {
  const waits: Promise<unknown>[] = [];
  return { waitUntil: (p) => void waits.push(p), done: async () => void (await Promise.all(waits)) };
}

const get = (path: string, key = KEY, method = "GET") =>
  new Request(`https://photos.example${path}`, { method, headers: { "x-app-key": key, "cf-connecting-ip": "203.0.113.5" } });

describe("photo server", () => {
  let clock: number;
  let cache: ReturnType<typeof fakeCache>;
  let env: Env & { STATE: ReturnType<typeof fakeKv>; PHOTOS: ReturnType<typeof fakeBucket> };
  let handle: ReturnType<typeof createHandler>;

  beforeEach(() => {
    clock = NOW;
    cache = fakeCache();
    env = {
      PHOTOS: fakeBucket([`${PHOTO}/full.jpg`, `${PHOTO}/thumb.jpg`]),
      PHOTO_KEYS: JSON.stringify({ [KEY]: { app: "example-app", daily_limit: 1000 }, [OTHER_KEY]: { app: "other", daily_limit: 2 } }),
      STATE: fakeKv(),
      DAILY_READ_CAP: "100",
    };
    handle = createHandler({ now: () => clock, cache: () => cache, shard: 3 });
  });

  it("serves a photo with a day's caching, then from the cache", async () => {
    const c = ctx();
    const res = await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, c);
    await c.done();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
    // The cache key has no app key in it.
    expect([...cache.store.keys()]).toEqual([`https://photos.example/v1/photos/${PHOTO}/full.jpg`]);
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(200);
    expect(env.PHOTOS.reads).toBe(1);
  });

  it("needs a known app key", async () => {
    expect((await handle(get(`/v1/photos/${PHOTO}/thumb.jpg`, "nope"), env, ctx())).status).toBe(401);
  });

  it("answers 404 for other paths and missing photos, and 405 for other methods", async () => {
    expect((await handle(get("/v1/photos/rev_1/full.jpg"), env, ctx())).status).toBe(404);
    expect((await handle(get(`/v1/photos/${PHOTO}/huge.jpg`), env, ctx())).status).toBe(404);
    expect((await handle(get("/v1/photos/pho_01JBXK3M8Q4R5S6T7V8W9X0YZC/full.jpg"), env, ctx())).status).toBe(404);
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`, KEY, "POST"), env, ctx())).status).toBe(405);
  });

  it("stops at the per-address limit", async () => {
    env.PER_IP = { limit: async () => ({ success: false }) };
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(429);
  });

  it("stops serving within a minute of the off switch", async () => {
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(200);
    env.STATE.data.set("off", "1");
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(200);
    clock += STATE_TTL_MS;
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(503);
  });

  it("stops an app at its daily limit, counting only reads that reach R2", async () => {
    for (const size of ["full", "thumb"]) expect((await handle(get(`/v1/photos/${PHOTO}/${size}.jpg`, OTHER_KEY), env, ctx())).status).toBe(200);
    cache.store.clear();
    const res = await handle(get(`/v1/photos/${PHOTO}/full.jpg`, OTHER_KEY), env, ctx());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "daily_read_cap" });
    expect(res.headers.get("retry-after")).toBe(String(23 * 3600));
    // The other app is not held up.
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(200);
  });

  it("writes its count to its own shard and reads every shard's count", async () => {
    env.STATE.data.set("reads:2026-11-03:example-app:0", "99");
    clock += 1;
    const c = ctx();
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, c)).status).toBe(200);
    await c.done();
    expect(env.STATE.data.get("reads:2026-11-03:example-app:3")).toBe("1");
    cache.store.clear();
    clock += STATE_TTL_MS;
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(503);
  });

  it("flushes after FLUSH_EVERY reads within the minute", async () => {
    env.DAILY_READ_CAP = "0";
    for (let i = 0; i < FLUSH_EVERY + 1; i++) {
      cache.store.clear();
      const c = ctx();
      await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, c);
      await c.done();
    }
    expect(Number(env.STATE.data.get("reads:2026-11-03:example-app:3"))).toBe(FLUSH_EVERY + 1);
  });
});
