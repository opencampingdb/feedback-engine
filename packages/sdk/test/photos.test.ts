import { describe, expect, it } from "vitest";
import {
  createFeedbackClient,
  createPhotoClient,
  FeedbackValidationError,
  isJpeg,
  sha256Hex,
  sha256HexBytes,
  validateSubmission,
  type FetchLike,
  type PhotoFetchLike,
  type StorageAdapter,
} from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };
const files = { full_sha256: "a".repeat(64), full_bytes: 400_000, thumb_sha256: "b".repeat(64), thumb_bytes: 40_000 };

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

const jpeg = (size: number, fill = 1) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};

const decodeMeta = (header: string) =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));

describe("photo validation", () => {
  it("accepts a photo meta with a contributor", () => {
    const r = validateSubmission({ ...base, contributor: CONTRIBUTOR, type: "photo", place: PLACE, photo: files });
    expect(r).toMatchObject({ ok: true, value: { type: "photo", photo: files } });
  });

  it("needs a contributor, a place and sizes within the limits", () => {
    const r = validateSubmission({
      ...base,
      type: "photo",
      place: null,
      photo: { ...files, full_bytes: 1_500_001, thumb_bytes: 0, thumb_sha256: "B".repeat(64), extra: 1 },
    });
    expect((r as { errors: string[] }).errors).toEqual([
      "contributor is required for a photo",
      "place is required for a photo",
      "unknown field photo.extra",
      "photo.thumb_sha256 must be a lower case hex SHA-256",
      "photo.full_bytes must be a whole number from 1 to 1500000",
      "photo.thumb_bytes must be a whole number from 1 to 200000",
    ]);
  });

  it("accepts a photo report and refuses an unknown reason or photo id", () => {
    const ok = validateSubmission({ ...base, type: "photo_report", place: PLACE, photo_report: { photo: PHOTO, reason: "not_this_place" } });
    expect(ok).toMatchObject({ ok: true, value: { photo_report: { photo: PHOTO, reason: "not_this_place" } } });
    const bad = validateSubmission({ ...base, type: "photo_report", place: PLACE, photo_report: { photo: "rev_1", reason: "ugly" } });
    expect((bad as { errors: string[] }).errors).toHaveLength(2);
  });

  it("takes an erasure with a contributor and no place", () => {
    expect(validateSubmission({ ...base, contributor: CONTRIBUTOR, type: "photo_erasure", place: null })).toMatchObject({ ok: true });
    expect((validateSubmission({ ...base, type: "photo_erasure", place: PLACE }) as { errors: string[] }).errors).toEqual([
      "contributor is required for a photo_erasure",
      "place must be null for a photo_erasure",
    ]);
  });
});

describe("sha256HexBytes", () => {
  it("matches sha256Hex on the same bytes", () => {
    expect(sha256HexBytes(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
});

describe("photo client", () => {
  function setup(status = 202, answer: unknown = { id: PHOTO }, attest?: (r: { body: string; bodySha256: string }) => Promise<Record<string, string>>) {
    const uploads: { url: string; headers: Record<string, string>; body: Uint8Array }[] = [];
    const posts: { body: string }[] = [];
    const fetchPhoto: PhotoFetchLike = async (url, init) => {
      uploads.push({ url, headers: init.headers, body: init.body });
      return { status, json: async () => answer, headers: { get: () => null } };
    };
    const fetch: FetchLike = async (_url, init) => {
      posts.push({ body: init.body });
      return { status: 202, json: async () => ({ id: "fb_1" }), headers: { get: () => null } };
    };
    const client = createPhotoClient({
      endpoint: "https://intake.example/",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: memoryStorage(),
      fetch,
      fetchPhoto,
      ...(attest ? { attest } : {}),
    });
    return { client, uploads, posts };
  }

  it("sends the meta in a header and both files as the body", async () => {
    const seen: string[] = [];
    const { client, uploads } = setup(202, { id: PHOTO }, async ({ body }) => {
      seen.push(body);
      return { "x-attest-platform": "android", "x-attest-token": "t" };
    });
    const full = jpeg(1000);
    const thumb = jpeg(100, 2);
    const result = await client.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: full.buffer, thumb });
    expect(result).toEqual({ status: "sent", id: PHOTO });
    const upload = uploads[0]!;
    expect(upload.url).toBe("https://intake.example/v1/photos");
    expect(upload.headers["x-attest-token"]).toBe("t");
    expect(upload.headers["content-type"]).toBe("application/octet-stream");
    expect(upload.body).toEqual(new Uint8Array([...full, ...thumb]));
    const meta = decodeMeta(upload.headers["x-photo-meta"]!);
    expect(meta).toMatchObject({
      type: "photo",
      place: PLACE,
      contributor: CONTRIBUTOR,
      photo: { full_sha256: sha256HexBytes(full), full_bytes: 1000, thumb_sha256: sha256HexBytes(thumb), thumb_bytes: 100 },
    });
    // The attestation covers the exact meta text in the header.
    expect(JSON.parse(seen[0]!)).toEqual(meta);
  });

  it("refuses files that are not JPEGs or are too big, before sending", async () => {
    const { client, uploads } = setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]);
    await expect(client.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: png, thumb: jpeg(200_001) })).rejects.toThrow(
      FeedbackValidationError,
    );
    expect(uploads).toHaveLength(0);
  });

  it("reports a refusal with the intake's reason", async () => {
    const { client } = setup(429, { error: "rate_limited" });
    expect(await client.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: jpeg(10), thumb: jpeg(10) })).toEqual({
      status: "rejected",
      httpStatus: 429,
      error: "rate_limited",
    });
  });

  it("answers offline when the intake cannot be reached, and queues nothing", async () => {
    const client = createPhotoClient({
      endpoint: "https://intake.example",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: memoryStorage(),
      fetchPhoto: async () => {
        throw new TypeError("offline");
      },
    });
    expect(await client.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: jpeg(10), thumb: jpeg(10) })).toEqual({ status: "offline" });
    expect(await client.pending()).toBe(0);
  });

  it("sends a photo report and an erasure through the queue", async () => {
    const { client, posts } = setup();
    await client.reportPhoto({ place: PLACE, photo: PHOTO, reason: "offensive", contributor: CONTRIBUTOR, consent: true });
    await client.erasePhotos({ contributor: CONTRIBUTOR, consent: true });
    expect(JSON.parse(posts[0]!.body)).toMatchObject({ type: "photo_report", photo_report: { photo: PHOTO, reason: "offensive" } });
    expect(JSON.parse(posts[1]!.body)).toMatchObject({ type: "photo_erasure", place: null, contributor: CONTRIBUTOR });
  });

  it("answers a photo report and an erasure by their refs, which it never sends", async () => {
    const answers: unknown[] = [];
    const posts: string[] = [];
    const client = createPhotoClient({
      endpoint: "https://intake.example",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: memoryStorage(),
      fetch: async (_url, init) => {
        posts.push(init.body);
        return { status: 202, json: async () => ({ id: "fb_1" }), headers: { get: () => null } };
      },
      onAnswered: (a) => void answers.push(a),
    });
    await client.reportPhoto({ place: PLACE, photo: PHOTO, reason: "offensive", contributor: CONTRIBUTOR, consent: true, ref: "pr" });
    await client.erasePhotos({ contributor: CONTRIBUTOR, consent: true, ref: "er" });
    expect(posts.every((b) => !("ref" in JSON.parse(b)))).toBe(true);
    expect(answers).toEqual([
      { ref: "pr", type: "photo_report", outcome: { kind: "sent", id: "fb_1" } },
      { ref: "er", type: "photo_erasure", outcome: { kind: "sent", id: "fb_1" } },
    ]);
  });

  it("keeps photos out of the feedback client, and its queue apart from feedback's", async () => {
    const storage = memoryStorage();
    const offline = async (): Promise<never> => {
      throw new Error("offline");
    };
    const options = { endpoint: "https://intake.example", appKey: "key-1", appVersion: "1.0.0", storage, fetch: offline };
    const feedback = createFeedbackClient(options) as unknown as Record<string, unknown>;
    expect(["photo", "photoPass", "reportPhoto", "erasePhotos"].filter((m) => m in feedback)).toEqual([]);
    await createPhotoClient(options).reportPhoto({ place: PLACE, photo: PHOTO, reason: "illegal", contributor: CONTRIBUTOR, consent: true });
    expect(await storage.getItem("ocdb.photos.queue")).toContain("photo_report");
    expect(await storage.getItem("ocdb.feedback.queue")).toBeNull();
  });

  it("knows a JPEG by its first bytes", () => {
    expect(isJpeg(jpeg(4))).toBe(true);
    expect(isJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });
});

describe("photo pass client", () => {
  it("asks for a pass with attestation, and reuses it until five minutes before it expires", async () => {
    let clock = Date.parse("2026-11-03T01:00:00Z");
    const posts: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      posts.push({ url, body: init.body, headers: init.headers });
      const expires = new Date(clock + 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
      return { status: 200, json: async () => ({ pass: `p1.example-app.${posts.length}`, expires }), headers: { get: () => null } };
    };
    const client = createPhotoClient({
      endpoint: "https://intake.example",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: memoryStorage(),
      fetch,
      now: () => clock,
      attest: async () => ({ "x-attest-platform": "ios" }),
    });
    const [a, b] = await Promise.all([client.photoPass(), client.photoPass()]);
    expect(a).toMatchObject({ status: "ok", pass: "p1.example-app.1" });
    expect(b).toEqual(a);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://intake.example/v1/photos/pass");
    expect(posts[0]!.headers["x-attest-platform"]).toBe("ios");
    expect(JSON.parse(posts[0]!.body)).toMatchObject({ type: "photo_pass", app_version: "1.2.3", time: "2026-11-03T01:00:00.000Z" });
    clock += 54 * 60_000;
    expect(await client.photoPass()).toMatchObject({ pass: "p1.example-app.1" });
    clock += 2 * 60_000;
    expect(await client.photoPass()).toMatchObject({ pass: "p1.example-app.2" });
    expect(await client.photoPass({ renew: true })).toMatchObject({ pass: "p1.example-app.3" });
  });

  it("answers offline when the intake cannot be reached", async () => {
    const client = createPhotoClient({
      endpoint: "https://intake.example",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: memoryStorage(),
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    expect(await client.photoPass()).toEqual({ status: "offline" });
  });
});
