import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { jpegSize } from "../src/jpeg.js";
import { createHandler, hashContributor, type BucketLike, type Env } from "../src/index.js";
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
});
