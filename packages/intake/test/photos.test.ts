import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { jpegSize } from "../src/jpeg.js";
import { createHandler, hashContributor, withheldKey, type BucketLike, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const NOW = Date.parse("2026-11-03T01:00:00Z");

function fakeKv(): KVLike {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

function fakeBucket(): BucketLike & { objects: Map<string, { bytes: Uint8Array; meta: unknown }> } {
  const objects = new Map<string, { bytes: Uint8Array; meta: unknown }>();
  return {
    objects,
    put: async (key, value, options) => void objects.set(key, { bytes: new Uint8Array(value), meta: options }),
    delete: async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}

function fakeGitHub(putStatus = 201) {
  const puts: { url: string; content: Record<string, unknown> }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_1", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    }
    if (url.includes("/contents/")) {
      const body = JSON.parse(init!.body as string) as { content: string };
      puts.push({ url, content: JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as Record<string, unknown> });
      return new Response("{}", { status: putStatus });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, puts };
}

/** A minimal JPEG: SOI, an APP0 segment, then a SOF0 frame header of the given size. */
function jpeg(width: number, height: number, padding = 100): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(padding).fill(7), 0xff, 0xd9]);
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function env(bucket = fakeBucket(), kv = fakeKv()): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100 } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "12345",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "678",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: kv,
    PHOTOS_PENDING: bucket,
  };
}

function upload(full: Uint8Array, thumb: Uint8Array, change: (meta: Record<string, unknown>) => void = () => undefined) {
  const meta: Record<string, unknown> = {
    type: "photo",
    place: PLACE,
    device: DEVICE,
    contributor: CONTRIBUTOR,
    app_version: "1.0.0",
    consent: true,
    photo: { full_sha256: sha(full), full_bytes: full.length, thumb_sha256: sha(thumb), thumb_bytes: thumb.length },
  };
  change(meta);
  return new Request("https://intake.example/v1/photos", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-app-key": APP_KEY,
      "x-photo-meta": Buffer.from(JSON.stringify(meta)).toString("base64url"),
    },
    body: new Uint8Array([...full, ...thumb]),
  });
}

describe("jpegSize", () => {
  it("reads the frame header after other segments", () => {
    expect(jpegSize(jpeg(1600, 1200))).toEqual({ width: 1600, height: 1200 });
  });

  it("refuses other files and a JPEG without a frame header", () => {
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeUndefined();
  });
});

describe("photo upload", () => {
  let gh: ReturnType<typeof fakeGitHub>;
  let handle: ReturnType<typeof createHandler>;

  beforeEach(() => {
    gh = fakeGitHub();
    handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
  });

  it("puts both files in the pending bucket and the item in the inbox", async () => {
    const bucket = fakeBucket();
    const full = jpeg(1600, 1200);
    const thumb = jpeg(400, 300, 10);
    const res = await handle(upload(full, thumb), env(bucket));
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^pho_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(bucket.objects.get(`${id}/full.jpg`)!.bytes).toEqual(full);
    expect(bucket.objects.get(`${id}/thumb.jpg`)!.bytes).toEqual(thumb);
    expect(bucket.objects.get(`${id}/full.jpg`)!.meta).toMatchObject({ httpMetadata: { contentType: "image/jpeg" } });
    const fb = id.replace("pho_", "fb_");
    expect(gh.puts[0]!.url).toContain(`/contents/pending/2026-11-03/${fb}.json`);
    expect(gh.puts[0]!.content).toMatchObject({
      id: fb,
      type: "photo",
      place: PLACE,
      app: "example-app",
      contributor: await hashContributor("pepper", "example-app", CONTRIBUTOR),
      photo: { full_sha256: sha(full), full_bytes: full.length, thumb_sha256: sha(thumb), width: 1600, height: 1200 },
    });
    expect(JSON.stringify(gh.puts[0]!.content)).not.toContain(CONTRIBUTOR);
  });

  it("refuses files that are not JPEGs, or do not match their SHA-256 or sizes", async () => {
    const full = jpeg(1600, 1200);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    expect((await handle(upload(png, jpeg(4, 3)), env())).status).toBe(400);
    const wrongSha = await handle(upload(full, jpeg(4, 3), (m) => ((m.photo as Record<string, unknown>).full_sha256 = "0".repeat(64))), env());
    expect(await wrongSha.json()).toEqual({ error: "sha256_mismatch" });
    const wrongSize = await handle(upload(full, jpeg(4, 3), (m) => ((m.photo as Record<string, unknown>).thumb_bytes = 5)), env());
    expect(wrongSize.status).toBe(400);
  });

  it("needs a contributor and a photo meta", async () => {
    const res = await handle(upload(jpeg(4, 3), jpeg(4, 3), (m) => delete m.contributor), env());
    expect(await res.json()).toMatchObject({ error: "invalid", details: ["contributor is required for a photo"] });
    const review = await handle(upload(jpeg(4, 3), jpeg(4, 3), (m) => (m.type = "check")), env());
    expect(review.status).toBe(400);
  });

  it("refuses a photo meta sent to /v1/feedback", async () => {
    const full = jpeg(4, 3);
    const meta = { type: "photo", place: PLACE, device: DEVICE, contributor: CONTRIBUTOR, app_version: "1", consent: true, photo: { full_sha256: sha(full), full_bytes: full.length, thumb_sha256: sha(full), thumb_bytes: full.length } };
    const res = await handle(
      new Request("https://intake.example/v1/feedback", { method: "POST", headers: { "x-app-key": APP_KEY }, body: JSON.stringify(meta) }),
      env(),
    );
    expect(await res.json()).toEqual({ error: "invalid", details: ["photos are sent to /v1/photos"] });
  });

  it("limits each contributor to 10 photos a day", async () => {
    const e = env();
    for (let i = 0; i < 10; i++) expect((await handle(upload(jpeg(4, 3), jpeg(4, 3)), e)).status).toBe(202);
    expect((await handle(upload(jpeg(4, 3), jpeg(4, 3)), e)).status).toBe(429);
  });

  it("needs attestation when the app key requires it, over the meta text", async () => {
    const e = env();
    e.APP_KEYS = JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100, requires_attestation: true, android: { package: "com.example.app" } } });
    const res = await handle(upload(jpeg(4, 3), jpeg(4, 3)), e);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "attestation_required" });
  });

  it("removes the files again when the inbox write fails", async () => {
    gh = fakeGitHub(500);
    handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
    const bucket = fakeBucket();
    const res = await handle(upload(jpeg(4, 3), jpeg(4, 3)), env(bucket));
    expect(res.status).toBe(503);
    expect(bucket.objects.size).toBe(0);
  });

  it("answers 404 when the intake has no photo bucket", async () => {
    const e = env();
    delete e.PHOTOS_PENDING;
    expect((await handle(upload(jpeg(4, 3), jpeg(4, 3)), e)).status).toBe(404);
  });
});

describe("photo reports and erasure", () => {
  it("stores a photo report and an erasure with the hashed contributor", async () => {
    const gh = fakeGitHub();
    const handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
    const send = (body: unknown) =>
      handle(new Request("https://intake.example/v1/feedback", { method: "POST", headers: { "x-app-key": APP_KEY }, body: JSON.stringify(body) }), env());
    const base = { device: DEVICE, contributor: CONTRIBUTOR, app_version: "1", consent: true };
    expect((await send({ ...base, type: "photo_report", place: PLACE, photo_report: { photo: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB", reason: "offensive" } })).status).toBe(202);
    expect((await send({ ...base, type: "photo_erasure", place: null })).status).toBe(202);
    expect(gh.puts[0]!.content).toMatchObject({ type: "photo_report", photo_report: { reason: "offensive" } });
    expect(gh.puts[1]!.content).toMatchObject({ type: "photo_erasure", place: null, contributor: await hashContributor("pepper", "example-app", CONTRIBUTOR) });
    const { contributor: _c, ...noContributor } = base;
    expect((await send({ ...noContributor, type: "photo_report", place: PLACE, photo_report: { photo: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB", reason: "offensive" } })).status).toBe(400);
  });

  it("turns photo reports, erasures and passes away from an intake with no photo bucket", async () => {
    const gh = fakeGitHub();
    const handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
    const { PHOTOS_PENDING: _bucket, ...noPhotos } = env();
    const post = (path: string, body: unknown) =>
      handle(new Request(`https://intake.example${path}`, { method: "POST", headers: { "x-app-key": APP_KEY }, body: JSON.stringify(body) }), {
        ...noPhotos,
        PHOTO_PASS_SECRET: "pass-secret",
      });
    const base = { device: DEVICE, contributor: CONTRIBUTOR, app_version: "1", consent: true };
    const report = await post("/v1/feedback", { ...base, type: "photo_report", place: PLACE, photo_report: { photo: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB", reason: "offensive" } });
    expect(report.status).toBe(404);
    expect(await report.json()).toEqual({ error: "photos_not_served_here" });
    expect((await post("/v1/feedback", { ...base, type: "photo_erasure", place: null })).status).toBe(404);
    expect((await post("/v1/photos/pass", { type: "photo_pass", device: DEVICE, app_version: "1", time: new Date(NOW).toISOString() })).status).toBe(404);
    expect(gh.puts).toHaveLength(0);
  });

  it("withholds a photo reported as illegal in the photo server's state, and only then", async () => {
    const gh = fakeGitHub();
    const handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
    const state = fakeKv();
    const records = `${JSON.stringify({ id: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB", place: PLACE, contributor: "ctr_00000000000000aa" })}\n`;
    const served = { get: async (key: string) => (key === `records/${PLACE}.ndjson` ? { text: async () => records } : null) };
    const e = { ...env(), PHOTO_STATE: state, PHOTOS_SERVED: served };
    const send = (reason: string) =>
      handle(
        new Request("https://intake.example/v1/feedback", {
          method: "POST",
          headers: { "x-app-key": APP_KEY },
          body: JSON.stringify({ device: DEVICE, contributor: CONTRIBUTOR, app_version: "1", consent: true, type: "photo_report", place: PLACE, photo_report: { photo: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB", reason } }),
        }),
        e,
      );
    expect((await send("offensive")).status).toBe(202);
    expect(await state.get(withheldKey("pho_01JBXK3M8Q4R5S6T7V8W9X0YZB"))).toBeNull();
    expect((await send("illegal")).status).toBe(202);
    expect(JSON.parse((await state.get(withheldKey("pho_01JBXK3M8Q4R5S6T7V8W9X0YZB")))!)).toMatchObject({ feedback: expect.stringMatching(/^fb_/) });
    expect(gh.puts[1]!.content).toMatchObject({ type: "photo_report", photo_report: { reason: "illegal" } });
  });
});

describe("report reasons that withhold a photo at once", () => {
  const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB";
  const OTHER_PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZC";
  /** The serving bucket's records: PHOTO is served for PLACE, sent by `lineContributor`. */
  const servedBy = (lineContributor: string) => {
    const records = `${JSON.stringify({ id: PHOTO, place: PLACE, contributor: lineContributor })}\n`;
    return { get: async (key: string) => (key === `records/${PLACE}.ndjson` ? { text: async () => records } : null) };
  };
  function setup(reasons?: string, served: Env["PHOTOS_SERVED"] | null = servedBy("ctr_00000000000000aa")) {
    const gh = fakeGitHub();
    const handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
    const state = fakeKv();
    const puts: { key: string; options?: unknown }[] = [];
    const recordingState: KVLike = { ...state, put: async (k, v, o) => (puts.push({ key: k, options: o }), state.put(k, v, o)) };
    const e: Env = {
      ...env(),
      PHOTO_STATE: recordingState,
      ...(served ? { PHOTOS_SERVED: served } : {}),
      ...(reasons !== undefined ? { PHOTO_WITHHOLD_REASONS: reasons } : {}),
    };
    const send = (reason: string, place = PLACE) =>
      handle(
        new Request("https://intake.example/v1/feedback", {
          method: "POST",
          headers: { "x-app-key": APP_KEY },
          body: JSON.stringify({ device: DEVICE, contributor: CONTRIBUTOR, app_version: "1", consent: true, type: "photo_report", place, photo_report: { photo: PHOTO, reason } }),
        }),
        e,
      );
    return { gh, state, puts, send };
  }

  it("does not withhold a photo reported under a place it is not served for", async () => {
    const t = setup();
    expect((await t.send("illegal", OTHER_PLACE)).status).toBe(202);
    expect(await t.state.get(withheldKey(PHOTO))).toBeNull();
    expect(t.gh.puts[0]!.content.withheld).toBeUndefined();
  });

  it("does not withhold a contributor's report of their own photo", async () => {
    const t = setup(undefined, servedBy(await hashContributor("pepper", "example-app", CONTRIBUTOR)));
    expect((await t.send("illegal")).status).toBe(202);
    expect(await t.state.get(withheldKey(PHOTO))).toBeNull();
  });

  it("withholds for a limited time when the intake cannot read the served records", async () => {
    const t = setup(undefined, null);
    expect((await t.send("illegal")).status).toBe(202);
    expect(await t.state.get(withheldKey(PHOTO))).not.toBeNull();
    expect(t.puts[0]!.options).toEqual({ expirationTtl: 7 * 24 * 60 * 60 });
  });

  it("withholds on the first report for a configured reason, and says so on the stored item", async () => {
    const t = setup("personal_details, copyright, not_a_reason");
    expect((await t.send("personal_details")).status).toBe(202);
    expect(JSON.parse((await t.state.get(withheldKey(PHOTO)))!)).toMatchObject({ feedback: expect.stringMatching(/^fb_/), reason: "personal_details" });
    expect(t.gh.puts[0]!.content).toMatchObject({ type: "photo_report", withheld: true, photo_report: { reason: "personal_details" } });
  });

  it("keeps illegal on the list whatever is configured, and leaves other reasons to the reports threshold", async () => {
    const t = setup("personal_details");
    expect((await t.send("offensive")).status).toBe(202);
    expect(await t.state.get(withheldKey(PHOTO))).toBeNull();
    expect(t.gh.puts[0]!.content.withheld).toBeUndefined();
    expect((await t.send("illegal")).status).toBe(202);
    expect(await t.state.get(withheldKey(PHOTO))).not.toBeNull();
    expect(t.gh.puts[1]!.content).toMatchObject({ withheld: true });
  });

  it("withholds nothing for personal_details when the list leaves it out", async () => {
    const t = setup();
    expect((await t.send("personal_details")).status).toBe(202);
    expect(await t.state.get(withheldKey(PHOTO))).toBeNull();
  });
});

describe("an owner removing one photo", () => {
  const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB";
  async function setup(lineContributor?: string) {
    const gh = fakeGitHub();
    const handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
    const state = fakeKv();
    const puts: { key: string; options?: unknown }[] = [];
    const recordingState: KVLike = { ...state, put: async (k, v, o) => (puts.push({ key: k, options: o }), state.put(k, v, o)) };
    const records = lineContributor === undefined ? "" : `${JSON.stringify({ id: PHOTO, place: PLACE, contributor: lineContributor })}\n`;
    const served = { get: async (key: string) => (key === `records/${PLACE}.ndjson` && records ? { text: async () => records } : null) };
    const e: Env = { ...env(), PHOTO_STATE: recordingState, PHOTOS_SERVED: served };
    const send = (body: Record<string, unknown> = {}) =>
      handle(
        new Request("https://intake.example/v1/feedback", {
          method: "POST",
          headers: { "x-app-key": APP_KEY },
          body: JSON.stringify({ device: DEVICE, contributor: CONTRIBUTOR, app_version: "1", consent: true, type: "photo_removal", place: PLACE, photo_removal: { photo: PHOTO }, ...body }),
        }),
        e,
      );
    return { gh, state, puts, send, e, handle };
  }

  it("withholds the contributor's own served photo at once, for a limited time, and stores the removal", async () => {
    const t = await setup(await hashContributor("pepper", "example-app", CONTRIBUTOR));
    expect((await t.send()).status).toBe(202);
    expect(JSON.parse((await t.state.get(withheldKey(PHOTO)))!)).toMatchObject({ reason: "removed_by_contributor" });
    expect(t.puts[0]!.options).toEqual({ expirationTtl: 30 * 24 * 60 * 60 });
    expect(t.gh.puts[0]!.content).toMatchObject({
      type: "photo_removal",
      place: PLACE,
      withheld: true,
      photo_removal: { photo: PHOTO },
      contributor: await hashContributor("pepper", "example-app", CONTRIBUTOR),
    });
  });

  it("refuses another contributor's photo and withholds nothing", async () => {
    const t = await setup("ctr_0123456789abcdef");
    const res = await t.send();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_your_photo" });
    expect(await t.state.get(withheldKey(PHOTO))).toBeNull();
    expect(t.gh.puts).toHaveLength(0);
  });

  it("stores a removal it can't confirm for the apply run, withholding nothing", async () => {
    const t = await setup();
    expect((await t.send()).status).toBe(202);
    expect(await t.state.get(withheldKey(PHOTO))).toBeNull();
    expect(t.gh.puts[0]!.content.withheld).toBeUndefined();
  });

  it("needs a contributor and a photo service", async () => {
    const t = await setup();
    const res = await t.handle(
      new Request("https://intake.example/v1/feedback", {
        method: "POST",
        headers: { "x-app-key": APP_KEY },
        body: JSON.stringify({ device: DEVICE, app_version: "1", consent: true, type: "photo_removal", place: PLACE, photo_removal: { photo: PHOTO } }),
      }),
      t.e,
    );
    expect(res.status).toBe(400);
    const { PHOTOS_PENDING: _p, ...noPhotos } = t.e;
    const elsewhere = await t.handle(
      new Request("https://intake.example/v1/feedback", {
        method: "POST",
        headers: { "x-app-key": APP_KEY },
        body: JSON.stringify({ device: DEVICE, contributor: CONTRIBUTOR, app_version: "1", consent: true, type: "photo_removal", place: PLACE, photo_removal: { photo: PHOTO } }),
      }),
      noPhotos as Env,
    );
    expect(await elsewhere.json()).toEqual({ error: "photos_not_served_here" });
  });
});

describe("erasing a contributor's photos", () => {
  const TOKEN = "operator-token-0123456789abcdef";
  function setup(extra: { [K in keyof Env]?: Env[K] | undefined } = {}) {
    const gh = fakeGitHub();
    const handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
    const state = fakeKv();
    const ttls = new Map<string, number | undefined>();
    const recording: KVLike = { ...state, put: async (k, v, o) => (ttls.set(k, o?.expirationTtl), state.put(k, v, o)) };
    const e = { ...env(), PHOTO_STATE: recording, PHOTO_OPERATOR_TOKEN: TOKEN, ...extra } as Env;
    const erase = (body: unknown, token: string | null = TOKEN) =>
      handle(
        new Request("https://intake.example/v1/photos/erase", {
          method: "POST",
          headers: { "x-app-key": APP_KEY, ...(token !== null ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        }),
        e,
      );
    return { gh, state, ttls, erase, handle, e };
  }

  it("stores an operator erasure and withholds every photo from the contributor at once", async () => {
    const t = setup();
    const res = await t.erase({ contributor: CONTRIBUTOR });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    const hashed = await hashContributor("pepper", "example-app", CONTRIBUTOR);
    expect(t.gh.puts[0]!.content).toMatchObject({ id, type: "photo_erasure", place: null, contributor: hashed, operator: true, withheld: true, app: "example-app" });
    expect(JSON.stringify(t.gh.puts[0]!.content)).not.toContain(CONTRIBUTOR);
    expect(JSON.parse((await t.state.get(`withheld-contributor:${hashed}`))!)).toMatchObject({ feedback: id, reason: "erased" });
    expect(t.ttls.get(`withheld-contributor:${hashed}`)).toBe(30 * 24 * 60 * 60);
    // Erasing again, or a contributor with no photos, succeeds too.
    expect((await t.erase({ contributor: CONTRIBUTOR })).status).toBe(202);
  });

  it("refuses a request without the operator token, with a wrong one, or with a bad body", async () => {
    const t = setup();
    expect((await t.erase({ contributor: CONTRIBUTOR }, null)).status).toBe(401);
    expect((await t.erase({ contributor: CONTRIBUTOR }, "wrong-token")).status).toBe(401);
    expect((await t.erase({ contributor: "short" })).status).toBe(400);
    expect((await t.erase({ contributor: CONTRIBUTOR, extra: 1 })).status).toBe(400);
    expect(t.gh.puts).toHaveLength(0);
    expect(await t.state.get(`withheld-contributor:${await hashContributor("pepper", "example-app", CONTRIBUTOR)}`)).toBeNull();
  });

  it("is not there without an operator token or a photo bucket, and needs an app key", async () => {
    expect((await setup({ PHOTO_OPERATOR_TOKEN: undefined }).erase({ contributor: CONTRIBUTOR })).status).toBe(404);
    expect((await setup({ PHOTOS_PENDING: undefined }).erase({ contributor: CONTRIBUTOR })).status).toBe(404);
    const t = setup();
    const res = await t.handle(
      new Request("https://intake.example/v1/photos/erase", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ contributor: CONTRIBUTOR }) }),
      t.e,
    );
    expect(res.status).toBe(401);
  });

  it("withholds every photo from the contributor on an erasure an install sends too", async () => {
    const t = setup();
    const res = await t.handle(
      new Request("https://intake.example/v1/feedback", {
        method: "POST",
        headers: { "x-app-key": APP_KEY },
        body: JSON.stringify({ device: DEVICE, contributor: CONTRIBUTOR, app_version: "1", consent: true, type: "photo_erasure", place: null }),
      }),
      t.e,
    );
    expect(res.status).toBe(202);
    const hashed = await hashContributor("pepper", "example-app", CONTRIBUTOR);
    expect(await t.state.get(`withheld-contributor:${hashed}`)).not.toBeNull();
    expect(t.gh.puts[0]!.content).toMatchObject({ type: "photo_erasure", withheld: true });
    expect(t.gh.puts[0]!.content.operator).toBeUndefined();
  });
});

describe("minimum app version for photo uploads", () => {
  let gh: ReturnType<typeof fakeGitHub>;
  let handle: ReturnType<typeof createHandler>;
  beforeEach(() => {
    gh = fakeGitHub();
    handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
  });
  const send = (version: string, minimum = "1.5.0") =>
    handle(upload(jpeg(4, 3), jpeg(4, 3), (m) => (m.app_version = version)), { ...env(), PHOTO_MIN_APP_VERSION: minimum });

  it("refuses an upload from below the minimum with its own reason, storing and counting nothing", async () => {
    for (const version of ["1.4.9", "1.4", "0.9.0 (12)", "dev"]) {
      const res = await send(version);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "app_update_required", minimum: "1.5.0" });
    }
    expect(gh.puts).toHaveLength(0);
  });

  it("takes an upload at or above the minimum", async () => {
    for (const version of ["1.5.0", "1.5", "1.5.0 (61)", "1.10.0", "2"]) expect((await send(version)).status).toBe(202);
  });

  it("compares build numbers when the minimum has one and the versions are equal", async () => {
    for (const version of ["1.0.0 (35)", "1.0.0", "1.0.0+35", "0.9.9 (99)"]) {
      const res = await send(version, "1.0.0 (36)");
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "app_update_required", minimum: "1.0.0 (36)" });
    }
    for (const version of ["1.0.0 (36)", "1.0.0 (40)", "1.0.0+36", "1.0.1", "1.0.1 (2)"]) expect((await send(version, "1.0.0 (36)")).status).toBe(202);
  });

  it("ignores build numbers when the minimum has none", async () => {
    for (const version of ["1.5.0 (1)", "1.5.0"]) expect((await send(version, "1.5.0")).status).toBe(202);
  });

  it("takes every version when the minimum is unset or not a version", async () => {
    expect((await handle(upload(jpeg(4, 3), jpeg(4, 3), (m) => (m.app_version = "0.1")), env())).status).toBe(202);
    expect((await send("0.1", "latest")).status).toBe(202);
  });
});

describe("SafeSearch on uploads", () => {
  const ACCOUNT = JSON.stringify({ client_email: "intake@example.iam.gserviceaccount.com", private_key: privateKey });

  /** GitHub plus Google: a token, then SafeSearch answering with `ratings` (or `status`). */
  function withVision(ratings: Record<string, string> | undefined, status = 200) {
    const gh = fakeGitHub();
    const vision: { auth: string | null; image: string }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }));
      if (url === "https://vision.googleapis.com/v1/images:annotate") {
        const body = JSON.parse(init!.body as string) as { requests: { image: { content: string }; features: { type: string }[] }[] };
        vision.push({ auth: new Headers(init!.headers).get("authorization"), image: body.requests[0]!.image.content });
        expect(body.requests[0]!.features).toEqual([{ type: "SAFE_SEARCH_DETECTION" }]);
        return new Response(JSON.stringify({ responses: [ratings ? { safeSearchAnnotation: ratings } : {}] }), { status });
      }
      return gh.fetch(url, init);
    };
    const handle = createHandler({ fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
    return { gh, vision, handle };
  }

  const calm = { adult: "VERY_UNLIKELY", violence: "UNLIKELY", racy: "POSSIBLE", medical: "VERY_UNLIKELY", spoof: "UNLIKELY" };
  const on = (bucket = fakeBucket()) => ({ ...env(bucket), SAFESEARCH: "on", GOOGLE_SERVICE_ACCOUNT: ACCOUNT });

  it("sends the full size file and stores the ratings", async () => {
    const { gh, vision, handle } = withVision(calm);
    const full = jpeg(1600, 1200);
    expect((await handle(upload(full, jpeg(400, 300, 10)), on())).status).toBe(202);
    expect(vision).toEqual([{ auth: "Bearer ya29.test", image: Buffer.from(full).toString("base64") }]);
    expect(gh.puts[0]!.content).toMatchObject({ photo: { safesearch: calm } });
  });

  it("refuses a very likely adult or violent photo and keeps nothing", async () => {
    for (const worst of [{ adult: "VERY_LIKELY" }, { violence: "VERY_LIKELY" }]) {
      const { gh, handle } = withVision({ ...calm, ...worst });
      const bucket = fakeBucket();
      const res = await handle(upload(jpeg(1600, 1200), jpeg(400, 300, 10)), on(bucket));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "photo_not_allowed" });
      expect(bucket.objects.size).toBe(0);
      expect(gh.puts).toHaveLength(0);
    }
  });

  it("stores the photo as unchecked when Google fails, so a person looks", async () => {
    const { gh, handle } = withVision(undefined, 500);
    expect((await handle(upload(jpeg(1600, 1200), jpeg(400, 300, 10)), on())).status).toBe(202);
    expect(gh.puts[0]!.content).toMatchObject({ photo: { safesearch: "unchecked" } });
  });

  it("doesn't ask Google when SAFESEARCH is off", async () => {
    const { gh, vision, handle } = withVision(calm);
    expect((await handle(upload(jpeg(1600, 1200), jpeg(400, 300, 10)), { ...env(), GOOGLE_SERVICE_ACCOUNT: ACCOUNT })).status).toBe(202);
    expect(vision).toHaveLength(0);
    expect((gh.puts[0]!.content as { photo: Record<string, unknown> }).photo.safesearch).toBeUndefined();
  });
});
