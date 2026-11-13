import { beforeEach, describe, expect, it } from "vitest";
import { signPass } from "../../intake/src/pass.js";
import { createHandler, FLUSH_EVERY, KEY_TTL_MS, STATE_TTL_MS, type BucketLike, type CacheLike, type Ctx, type Env, type KVLike, WITHHELD_PREFIX } from "../src/index.js";

const KEY = "example-app-photo-key-0001";
const OTHER_KEY = "other-app-photo-key-0002";
const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const NOW = Date.parse("2026-11-03T01:00:00Z");

function fakeKv(): KVLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => void data.set(k, v),
    list: async ({ prefix }) => ({ keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  };
}

/** A serving bucket holding `keys`, each with the place and contributor the intake and sync write, unless `bare`. */
function fakeBucket(keys: string[], bare: string[] = []): BucketLike & { reads: number } {
  const bucket = {
    reads: 0,
    get: async (key: string) => {
      bucket.reads += 1;
      if (!keys.includes(key)) return null;
      const customMetadata = bare.includes(key) ? undefined : { place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA", contributor: "ctr_0123456789abcdef" };
      return { body: new Response(new Uint8Array([0xff, 0xd8, 0xff])).body!, httpEtag: '"e1"', size: 3, ...(customMetadata ? { customMetadata } : {}) };
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

  it("serves a place's photo records for five minutes, and an empty list for a place without photos", async () => {
    const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
    const line = `{"id":"${PHOTO}","place":"${PLACE}"}\n`;
    env.PHOTOS = Object.assign(fakeBucket([]), {
      get: async (key: string) =>
        key === `records/${PLACE}.ndjson` ? { body: new Response(line).body!, httpEtag: '"r1"', size: line.length } : null,
    }) as typeof env.PHOTOS;
    const res = await handle(get(`/v1/places/${PLACE}/photos.ndjson`), env, ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.text()).toBe(line);
    const none = await handle(get("/v1/places/ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZC/photos.ndjson"), env, ctx());
    expect(none.status).toBe(200);
    expect(await none.text()).toBe("");
    expect((await handle(get("/v1/places/not-a-place/photos.ndjson"), env, ctx())).status).toBe(404);
    expect((await handle(get(`/v1/places/${PLACE}/photos.ndjson`, "nope"), env, ctx())).status).toBe(401);
  });

  it("stops every photo from an erased contributor within a minute, cached or not, and leaves their lines out of the records", async () => {
    const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
    const MINE = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZC";
    const lines = `{"id":"${PHOTO}","place":"${PLACE}","contributor":"ctr_aaaaaaaaaaaaaaaa"}\n{"id":"${MINE}","place":"${PLACE}","contributor":"ctr_bbbbbbbbbbbbbbbb"}\n`;
    const files: Record<string, { bytes: string; contributor: string }> = {
      [`${PHOTO}/full.jpg`]: { bytes: "\xff\xd8\xff", contributor: "ctr_aaaaaaaaaaaaaaaa" },
      [`${MINE}/full.jpg`]: { bytes: "\xff\xd8\xff", contributor: "ctr_bbbbbbbbbbbbbbbb" },
    };
    env.PHOTOS = Object.assign(fakeBucket([]), {
      get: async (key: string) => {
        if (key === `records/${PLACE}.ndjson`) return { body: new Response(lines).body!, httpEtag: '"r1"', size: lines.length };
        const f = files[key];
        return f ? { body: new Response(f.bytes).body!, httpEtag: '"p1"', size: 3, customMetadata: { place: PLACE, contributor: f.contributor } } : null;
      },
    }) as typeof env.PHOTOS;
    // Served and cached before the erasure.
    const c = ctx();
    const before = await handle(get(`/v1/photos/${MINE}/full.jpg`), env, c);
    await c.done();
    expect(before.status).toBe(200);
    expect(before.headers.get("x-photo-contributor")).toBeNull();
    await handle(get(`/v1/places/${PLACE}/photos.ndjson`), env, c);
    await c.done();

    await env.STATE.put("withheld-contributor:ctr_bbbbbbbbbbbbbbbb", "{}");
    clock += STATE_TTL_MS;
    const cached = await handle(get(`/v1/photos/${MINE}/full.jpg`), env, ctx());
    expect(cached.status).toBe(404);
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(200);
    expect(await (await handle(get(`/v1/places/${PLACE}/photos.ndjson`), env, ctx())).text()).toBe(lines.split("\n")[0] + "\n");
  });

  it("withholds a photo by reading its own key, even while a list of the namespace leaves the key out", async () => {
    // KV as seen on 9 Nov 2026: a new key read by its name, while listing the prefix still lacks it.
    const reads: string[] = [];
    env.STATE = { ...env.STATE, list: async () => ({ keys: [], list_complete: true }), get: async (k: string) => (reads.push(k), env.STATE.data.get(k) ?? null) } as typeof env.STATE;
    const c = ctx();
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, c)).status).toBe(200);
    await c.done();
    env.STATE.data.set(`withheld:${PHOTO}`, '{"reason":"illegal"}');
    clock += KEY_TTL_MS;
    const withheld = await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx());
    expect(withheld.status).toBe(404);
    expect(reads).toContain(`withheld:${PHOTO}`);
  });

  it("reads each photo's keys once per KEY_TTL_MS, however many requests come", async () => {
    const reads: string[] = [];
    const inner = env.STATE.get;
    env.STATE = { ...env.STATE, get: async (k: string) => (reads.push(k), inner(k)) } as typeof env.STATE;
    for (let i = 0; i < 20; i++) await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx());
    expect(reads.filter((k) => k === `withheld:${PHOTO}`)).toHaveLength(1);
    clock += KEY_TTL_MS;
    await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx());
    expect(reads.filter((k) => k === `withheld:${PHOTO}`)).toHaveLength(2);
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

  describe("per-install limit", () => {
    const counting = (allow: number) => {
      const counts = new Map<string, number>();
      return {
        counts,
        limit: async ({ key }: { key: string }) => {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return { success: counts.get(key)! <= allow };
        },
      };
    };
    const withPass = (pass: string, address = "203.0.113.5") =>
      new Request(`https://photos.example/v1/photos/${PHOTO}/thumb.jpg`, { headers: { "x-photo-pass": pass, "cf-connecting-ip": address } });
    const INSTALL_A = "0123456789abcdef";
    const INSTALL_B = "fedcba9876543210";

    beforeEach(() => {
      env.PHOTO_PASS_SECRET = "pass-secret";
    });

    it("counts a pass that names its install per install, with the ceiling per address, and not on PER_IP", async () => {
      const perIp = counting(2);
      const perInstall = counting(3);
      const ceiling = counting(100);
      Object.assign(env, { PER_IP: perIp, PER_INSTALL: perInstall, PER_IP_CEILING: ceiling });
      const a = await signPass("pass-secret", "example-app", NOW / 1000 + 3600, INSTALL_A);
      const b = await signPass("pass-secret", "example-app", NOW / 1000 + 3600, INSTALL_B);
      // Two phones behind one address each get their own 3, past PER_IP's 2 for the address.
      for (let i = 0; i < 3; i++) {
        expect((await handle(withPass(a), env, ctx())).status).toBe(200);
        expect((await handle(withPass(b), env, ctx())).status).toBe(200);
      }
      expect((await handle(withPass(a), env, ctx())).status).toBe(429);
      expect(perIp.counts.size).toBe(0);
      expect([...perInstall.counts.keys()].sort()).toEqual([`example-app:${INSTALL_A}`, `example-app:${INSTALL_B}`]);
      expect(ceiling.counts.get("203.0.113.5")).toBe(6);
    });

    it("stops at the per-address ceiling however many installs share the address", async () => {
      Object.assign(env, { PER_IP: counting(1000), PER_INSTALL: counting(1000), PER_IP_CEILING: counting(2) });
      const pass = (n: number) => signPass("pass-secret", "example-app", NOW / 1000 + 3600, n.toString(16).padStart(16, "0"));
      expect((await handle(withPass(await pass(1)), env, ctx())).status).toBe(200);
      expect((await handle(withPass(await pass(2)), env, ctx())).status).toBe(200);
      expect((await handle(withPass(await pass(3)), env, ctx())).status).toBe(429);
    });

    it("counts a pass from before installs were named, and an app key, per address as before", async () => {
      const perIp = counting(1);
      const perInstall = counting(1000);
      Object.assign(env, { PER_IP: perIp, PER_INSTALL: perInstall, PER_IP_CEILING: counting(1000) });
      const old = await signPass("pass-secret", "example-app", NOW / 1000 + 3600);
      expect((await handle(withPass(old), env, ctx())).status).toBe(200);
      expect((await handle(withPass(old), env, ctx())).status).toBe(429);
      expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`, KEY), env, ctx())).status).toBe(429);
      expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`, KEY).clone(), { ...env, PER_IP: counting(1) }, ctx())).status).toBe(200);
      expect(perInstall.counts.size).toBe(0);
    });

    it("holds per-install passes to PER_IP when the ceiling is not bound", async () => {
      const perIp = counting(1);
      Object.assign(env, { PER_IP: perIp, PER_INSTALL: counting(1000) });
      const pass = await signPass("pass-secret", "example-app", NOW / 1000 + 3600, INSTALL_A);
      expect((await handle(withPass(pass), env, ctx())).status).toBe(200);
      expect((await handle(withPass(pass), env, ctx())).status).toBe(429);
      expect(perIp.counts.get("203.0.113.5")).toBe(2);
    });
  });

  it("stops serving within a minute of the off switch", async () => {
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(200);
    env.STATE.data.set("off", "1");
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(200);
    clock += STATE_TTL_MS;
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(503);
  });

  it("stops a withheld photo within a minute, even when it is in the cache", async () => {
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(200);
    expect(cache.store.size).toBe(1);
    env.STATE.data.set(`${WITHHELD_PREFIX}${PHOTO}`, '{"feedback":"fb_x"}');
    clock += STATE_TTL_MS;
    const withheld = await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx());
    expect(withheld.status).toBe(404);
    expect(withheld.headers.get("cache-control")).toBe("no-store");
    env.STATE.data.delete(`${WITHHELD_PREFIX}${PHOTO}`);
    clock += STATE_TTL_MS;
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`), env, ctx())).status).toBe(200);
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

  it("does not serve a photo whose contributor it cannot tell, and answers it without counting from a brief cache", async () => {
    env.PHOTOS = fakeBucket([`${PHOTO}/full.jpg`, `${PHOTO}/thumb.jpg`], [`${PHOTO}/full.jpg`]);
    for (let i = 0; i < 100; i++) {
      const res = await handle(get(`/v1/photos/${PHOTO}/full.jpg`, OTHER_KEY), env, ctx());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
      expect(res.headers.get("x-photo-contributor")).toBeNull();
    }
    expect(env.PHOTOS.reads).toBe(1);
    expect(cache.store.get(`https://photos.example/v1/photos/${PHOTO}/full.jpg`)?.headers.get("cache-control")).toBe("public, max-age=300");
    // The other app's limit of 2 reads is untouched.
    expect((await handle(get(`/v1/photos/${PHOTO}/thumb.jpg`, OTHER_KEY), env, ctx())).status).toBe(200);
  });

  it("answers a place without a records file with an empty list that costs no read", async () => {
    env.PHOTO_PASS_SECRET = "pass-secret";
    env.PHOTO_KEYS = JSON.stringify({ [KEY]: { app: "example-app", daily_limit: 50 }, [OTHER_KEY]: { app: "other", daily_limit: 2 } });
    const pass = await signPass("pass-secret", "example-app", NOW / 1000 + 3600);
    const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const placeId = (n: number) => `ocdb_${Array.from({ length: 26 }, (_, i) => A[Math.floor(n / 32 ** (25 - i)) % 32]).join("")}`;
    for (let n = 0; n < 1000; n++) {
      const c = ctx();
      const res = await handle(
        new Request(`https://photos.example/v1/places/${placeId(n)}/photos.ndjson`, { headers: { "x-photo-pass": pass, "cf-connecting-ip": "203.0.113.5" } }),
        env,
        c,
      );
      await c.done();
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("");
    }
    expect([...env.STATE.data.keys()].filter((k) => k.startsWith("reads:"))).toEqual([]);
    // Another app's uncached photo is still served under the server's cap of 100.
    expect((await handle(get(`/v1/photos/${PHOTO}/full.jpg`, OTHER_KEY), env, ctx())).status).toBe(200);
    // Another holder of the same app is still within its daily limit of 50.
    const other = await signPass("pass-secret", "example-app", NOW / 1000 + 1800);
    const res = await handle(new Request(`https://photos.example/v1/photos/${PHOTO}/thumb.jpg`, { headers: { "x-photo-pass": other } }), env, ctx());
    expect(res.status).toBe(200);
  });

  it("answers a photo that does not exist without counting it, and caches the answer briefly", async () => {
    const MISSING = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZZ";
    for (let i = 0; i < 5; i++) {
      const res = await handle(get(`/v1/photos/${MISSING}/full.jpg`, OTHER_KEY), env, ctx());
      expect(res.status).toBe(404);
    }
    expect(env.PHOTOS.reads).toBe(1);
    expect(cache.store.get(`https://photos.example/v1/photos/${MISSING}/full.jpg`)?.headers.get("cache-control")).toBe("public, max-age=300");
    // The other app's limit of 2 reads is untouched: both real photos still come from R2.
    for (const size of ["full", "thumb"]) expect((await handle(get(`/v1/photos/${PHOTO}/${size}.jpg`, OTHER_KEY), env, ctx())).status).toBe(200);
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

  it("serves to a good photo pass and refuses a bad or expired one", async () => {
    env.PHOTO_PASS_SECRET = "pass-secret";
    const withPass = (pass: string) =>
      new Request(`https://photos.example/v1/photos/${PHOTO}/thumb.jpg`, { headers: { "x-photo-pass": pass } });
    const pass = await signPass("pass-secret", "example-app", NOW / 1000 + 3600);
    expect((await handle(withPass(pass), env, ctx())).status).toBe(200);
    expect(await (await handle(withPass(pass.slice(0, -2) + "AA"), env, ctx())).json()).toEqual({ error: "invalid_pass" });
    clock += 3600_000;
    expect((await handle(withPass(pass), env, ctx())).status).toBe(401);
    // A pass for an app with no entry in PHOTO_KEYS gets nothing.
    const stranger = await signPass("pass-secret", "stranger", clock / 1000 + 60);
    expect((await handle(withPass(stranger), env, ctx())).status).toBe(401);
  });
});
