import { describe, expect, it } from "vitest";
import { createFeedbackClient, createPhotoClient, isIdempotencyKey, type FetchLike, type PhotoFetchLike, type StorageAdapter } from "../src/index.js";

/** A clock in December 2026, after every visit date the tests send. */
const T0 = Date.UTC(2026, 11, 1);

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";

function memoryStorage(): StorageAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => void data.set(k, v), removeItem: async (k) => void data.delete(k) };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** An intake whose `replies` answer each call in turn: a status, or "lost" when the answer never arrives. */
function fakeIntake(replies: (number | "lost")[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (reply === "lost") throw new TypeError("Network request failed");
    const body = url.endsWith("/batch")
      ? { items: (JSON.parse(init.body) as { items: unknown[] }).items.map(() => ({ status: 202, id: "fb_1" })) }
      : { id: "fb_1" };
    return { status: reply === 202 && url.endsWith("/batch") ? 200 : reply, json: async () => body, headers: { get: () => null } };
  };
  return { fetch, calls };
}

let clock = T0;
/** Moves the clock past any wait, so the next flush sends what is queued. */
const later = () => void (clock += 24 * 60 * 60 * 1000);
const client = (fetch: FetchLike, storage: StorageAdapter = memoryStorage(), randomUUID?: () => string) =>
  createFeedbackClient({ endpoint: "https://intake.example", appKey: "key-1", appVersion: "1.2.3", storage, fetch, now: () => clock, random: () => 0, ...(randomUUID ? { randomUUID } : {}) });
const check = { place: PLACE, check: { still_there: true, visited: "2026-11-01" }, consent: true } as const;

describe("idempotency keys", () => {
  it("sends the same key again when an item is sent again after a lost answer, across a restart", async () => {
    const storage = memoryStorage();
    const intake = fakeIntake(["lost", 202]);
    await client(intake.fetch, storage).check(check);
    // The app restarts, and the next flush sends the item again.
    later();
    await client(intake.fetch, storage).flush();
    const [first, again] = intake.calls.map((c) => c.headers["idempotency-key"]);
    expect(isIdempotencyKey(first)).toBe(true);
    expect(again).toBe(first);
    // A different item has a key of its own.
    await client(intake.fetch, storage).check({ ...check, place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZC" });
    expect(intake.calls[2]!.headers["idempotency-key"]).not.toBe(first);
  });

  it("sends each item's key beside it in a batch, in order", async () => {
    const intake = fakeIntake(["lost", "lost", 202]);
    const c = client(intake.fetch);
    await c.check(check);
    await c.check({ ...check, place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZC" });
    later();
    await c.flush();
    const batch = intake.calls.find((call) => call.url.endsWith("/batch"))!;
    expect(batch.body.keys).toEqual([intake.calls[0]!.headers["idempotency-key"], intake.calls[1]!.headers["idempotency-key"]]);
  });

  it("gives an item queued by an older SDK a key, and keeps it", async () => {
    const storage = memoryStorage();
    const old = { localId: "1", body: { ...check, type: "check", device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true }, queuedAt: clock, attempts: 0, nextAttemptAt: 0 };
    storage.data.set("ocdb.feedback.queue", JSON.stringify([old]));
    const intake = fakeIntake(["lost", 202]);
    await client(intake.fetch, storage).flush();
    later();
    await client(intake.fetch, storage).flush();
    const [first, again] = intake.calls.map((c) => c.headers["idempotency-key"]);
    expect(isIdempotencyKey(first)).toBe(true);
    expect(again).toBe(first);
  });

  it("makes a key the intake takes when the app's randomUUID gives a short id", async () => {
    let n = 0;
    const intake = fakeIntake([202]);
    const storage = memoryStorage();
    storage.data.set("ocdb.feedback.device", "3b241101-e2bb-4255-8caf-4136c566a962");
    await client(intake.fetch, storage, () => `id-${++n}`).check(check);
    expect(isIdempotencyKey(intake.calls[0]!.headers["idempotency-key"])).toBe(true);
  });

  it("keys photo reports, removals and erasures through the queue, and a photo upload by its content", async () => {
    const posts: Call[] = [];
    const uploads: Record<string, string>[] = [];
    const fetch: FetchLike = async (url, init) => {
      posts.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
      return { status: 202, json: async () => ({ id: "fb_1" }), headers: { get: () => null } };
    };
    const fetchPhoto: PhotoFetchLike = async (_url, init) => {
      uploads.push(init.headers);
      return { status: 202, json: async () => ({ id: PHOTO }), headers: { get: () => null } };
    };
    const photos = createPhotoClient({ endpoint: "https://photos.example", appKey: "key-1", appVersion: "1.2.3", storage: memoryStorage(), fetch, fetchPhoto });
    await photos.reportPhoto({ place: PLACE, photo: PHOTO, reason: "offensive", contributor: CONTRIBUTOR, consent: true });
    await photos.removePhoto({ place: PLACE, photo: PHOTO, contributor: CONTRIBUTOR, consent: true });
    await photos.erasePhotos({ contributor: CONTRIBUTOR, consent: true });
    const keys = posts.map((p) => p.headers["idempotency-key"]);
    expect(keys.every(isIdempotencyKey)).toBe(true);
    expect(new Set(keys).size).toBe(3);

    const jpeg = (fill: number) => {
      const bytes = new Uint8Array(40).fill(fill);
      bytes.set([0xff, 0xd8, 0xff, 0xe0]);
      return bytes;
    };
    const send = (fill: number) => photos.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: jpeg(fill), thumb: jpeg(fill) });
    await send(1);
    await send(1);
    await send(2);
    expect(uploads.map((h) => isIdempotencyKey(h["idempotency-key"]))).toEqual([true, true, true]);
    expect(uploads[1]!["idempotency-key"]).toBe(uploads[0]!["idempotency-key"]);
    expect(uploads[2]!["idempotency-key"]).not.toBe(uploads[0]!["idempotency-key"]);
  });
});
