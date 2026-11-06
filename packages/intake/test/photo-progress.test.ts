import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type BucketLike, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";
import { ulid } from "../src/ulid.js";
import { fakeD1 } from "./fake-d1.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_KEY = "test-app-key-0123456789";
const TOKEN = "places-token-for-the-apply-run";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const NOW = Date.parse("2026-11-03T01:00:00Z");
const ACCOUNT = JSON.stringify({ client_email: "intake@example.iam.gserviceaccount.com", private_key: privateKey });
const CALM = { adult: "VERY_UNLIKELY", violence: "UNLIKELY", racy: "POSSIBLE", medical: "VERY_UNLIKELY", spoof: "UNLIKELY" };

function fakeKv(): KVLike {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
}

function fakeBucket(): BucketLike {
  const objects = new Map<string, Uint8Array>();
  return {
    put: async (key, value) => void objects.set(key, new Uint8Array(value)),
    delete: async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}

function jpeg(width: number, height: number, padding = 100): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, ...new Array(padding).fill(7), 0xff, 0xd9]);
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function upload(): Request {
  const full = jpeg(1600, 1200);
  const thumb = jpeg(400, 300, 10);
  const meta = {
    type: "photo",
    place: PLACE,
    device: "3b241101-e2bb-4255-8caf-4136c566a962",
    contributor: "acct_3f9a8b7c6d5e4f30",
    app_version: "1.0.0",
    consent: true,
    photo: { full_sha256: sha(full), full_bytes: full.length, thumb_sha256: sha(thumb), thumb_bytes: thumb.length },
  };
  return new Request("https://photos-upload.example/v1/photos", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-app-key": APP_KEY, "x-photo-meta": Buffer.from(JSON.stringify(meta)).toString("base64url") },
    body: new Uint8Array([...full, ...thumb]),
  });
}

/** Google answering SafeSearch with `ratings`, or failing when they are undefined. */
function vision(ratings: Record<string, string> | undefined) {
  return async (url: string) => {
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }));
    if (url === "https://vision.googleapis.com/v1/images:annotate") {
      return ratings ? new Response(JSON.stringify({ responses: [{ safeSearchAnnotation: ratings }] })) : new Response("down", { status: 500 });
    }
    return new Response("not found", { status: 404 });
  };
}

let store: ReturnType<typeof fakeD1>;
let e: Env;
let clock: number;
let random: number;
let handle: ReturnType<typeof createHandler>;

beforeEach(() => {
  store = fakeD1();
  clock = NOW;
  random = 0;
  e = {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100 } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "12345",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "678",
    INBOX_REPO: "example/example-app-photos-inbox",
    RATE_LIMIT: fakeKv(),
    PHOTOS_PENDING: fakeBucket(),
    RECENT_LIST: store,
    PLACES_TOKEN: TOKEN,
  };
  handle = createHandler({ fetch: vision(CALM), now: () => clock, randomBytes: (n) => new Uint8Array(n).fill(++random) });
});

const send = async (env: Env = e, h = handle) => {
  const res = await h(upload(), env);
  return { status: res.status, body: (await res.json()) as { id?: string; error?: string } };
};
const ask = async (ids: string[], env: Env = e) => {
  const res = await handle(new Request(`https://photos-upload.example/v1/photos/progress?ids=${ids.join(",")}`), env);
  return { status: res.status, headers: res.headers, body: (await res.json()) as { items?: Record<string, unknown>[] } };
};
const progressOf = async (id: string) => (await ask([id])).body.items![0]!;
const post = (items: unknown, token = TOKEN) =>
  handle(
    new Request("https://photos-upload.example/v1/photos/progress", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ items }),
    }),
    e,
  );
/** A photo id sent on 1 November, before the intake kept rows. */
const OLD = `pho_${ulid(Date.parse("2026-11-01T00:00:00Z"), () => new Uint8Array(16))}`;

describe("photo progress at the photo intake", () => {
  it("keeps a row from upload time under the photo id the upload answered", async () => {
    const { status, body } = await send();
    expect(status).toBe(202);
    expect(await progressOf(body.id!)).toEqual({ id: body.id, state: "received", place: PLACE, received: "2026-11-03T01:00:00Z" });
  });

  it("holds a photo SafeSearch rates likely adult, and one SafeSearch could not check, from upload time", async () => {
    const on = { ...e, SAFESEARCH: "on", GOOGLE_SERVICE_ACCOUNT: ACCOUNT };
    const likely = createHandler({ fetch: vision({ ...CALM, adult: "LIKELY" }), now: () => clock, randomBytes: (n) => new Uint8Array(n).fill(++random) });
    const flagged = (await send(on, likely)).body.id!;
    const down = createHandler({ fetch: vision(undefined), now: () => clock, randomBytes: (n) => new Uint8Array(n).fill(++random) });
    const unchecked = (await send(on, down)).body.id!;
    const calm = (await send(on)).body.id!;
    expect(await progressOf(flagged)).toMatchObject({ state: "held", held_reason: "safesearch" });
    expect(await progressOf(unchecked)).toMatchObject({ state: "held", held_reason: "check_unavailable" });
    expect(await progressOf(calm)).toMatchObject({ state: "received" });
    expect(await progressOf(calm)).not.toHaveProperty("held_reason");
  });

  it("keeps no row and answers no id for a photo SafeSearch refuses at upload", async () => {
    const refusing = createHandler({ fetch: vision({ ...CALM, adult: "VERY_LIKELY" }), now: () => clock, randomBytes: (n) => new Uint8Array(n) });
    const { status, body } = await send({ ...e, SAFESEARCH: "on", GOOGLE_SERVICE_ACCOUNT: ACCOUNT }, refusing);
    expect(status).toBe(422);
    expect(body).toEqual({ error: "photo_not_allowed" });
    expect(store.db.prepare("SELECT count(*) AS n FROM item_progress").get()).toEqual({ n: 0 });
  });

  it("answers unknown for a photo id it keeps nothing for, in the order asked", async () => {
    const id = (await send()).body.id!;
    const { status, headers, body } = await ask([OLD, id]);
    expect(status).toBe(200);
    expect(headers.get("cache-control")).toMatch(/no-store/);
    expect(body.items!.map((i) => [i.id, i.state])).toEqual([
      [OLD, "unknown"],
      [id, "received"],
    ]);
  });

  it("answers 400 for no ids, more than 100, or an id that is not a photo id", async () => {
    const many = Array.from({ length: 101 }, () => OLD);
    for (const ids of [[], many, ["fb_01JBXK3M8Q4R5S6T7V8W9X0YZA"], ["x"]]) expect((await ask(ids)).status).toBe(400);
    expect((await ask(Array.from({ length: 100 }, () => OLD))).status).toBe(200);
  });

  it("answers 404 on an intake without a photo bucket or a D1 database", async () => {
    const { PHOTOS_PENDING: _, ...noPhotos } = e;
    const { RECENT_LIST: __, ...noD1 } = e;
    expect((await ask([OLD], noPhotos)).status).toBe(404);
    expect((await ask([OLD], noD1)).status).toBe(404);
  });

  it("refuses an update from the apply without the token, and updates that are not photo progress", async () => {
    expect((await post([{ id: OLD, state: "accepted" }], "not-the-token")).status).toBe(401);
    const good = { id: OLD, state: "held", held_reason: "first_photo" };
    for (const bad of [
      [],
      Array.from({ length: 501 }, () => good),
      [{ ...good, id: "fb_01JBXK3M8Q4R5S6T7V8W9X0YZA" }],
      [{ ...good, state: "live" }],
      [{ ...good, held_reason: "no_such_reason" }],
      [{ id: OLD, state: "accepted", held_reason: "first_photo" }],
      [{ id: OLD, state: "refused" }],
      [{ id: OLD, state: "in_data" }],
      "x",
    ]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(store.db.prepare("SELECT count(*) AS n FROM item_progress").get()).toEqual({ n: 0 });
  });

  it("follows a photo held for a person, then published, hidden after reports and removed", async () => {
    const id = (await send()).body.id!;
    clock += 3_600_000;
    const held = { id, state: "held", held_reason: "first_photo", reason: "first photo from this contributor, so a person checks it", place: PLACE, decided_at: "2026-11-03T02:00:00Z" };
    expect(await (await post([held])).json()).toEqual({ updated: 1 });
    expect(await progressOf(id)).toEqual({ ...held, received: "2026-11-03T01:00:00Z" });
    // The same state again changes nothing.
    expect(await (await post([held])).json()).toEqual({ updated: 0 });

    await post([{ id, state: "in_data", place: PLACE, decided_at: "2026-11-03T02:00:00Z", in_data_at: "2026-11-03T01:30:00Z" }]);
    expect(await progressOf(id)).toEqual({ id, state: "in_data", place: PLACE, received: "2026-11-03T01:00:00Z", decided_at: "2026-11-03T02:00:00Z", in_data_at: "2026-11-03T01:30:00Z" });

    // Unlike feedback, a published photo can be hidden and removed.
    await post([{ id, state: "held", held_reason: "reported", reason: "hidden after reports, until a person decides", place: PLACE }]);
    expect(await progressOf(id)).toMatchObject({ state: "held", held_reason: "reported" });
    expect(await progressOf(id)).not.toHaveProperty("in_data_at");
    await post([{ id, state: "refused", by: "reviewer", reason: "removed by a reviewer", place: PLACE }]);
    expect(await progressOf(id)).toEqual({ id, state: "refused", by: "reviewer", reason: "removed by a reviewer", place: PLACE, received: "2026-11-03T01:00:00Z" });
  });

  it("takes a photo it has no row for, received at the time in its id", async () => {
    await post([{ id: OLD, state: "refused", by: "rules", reason: "photo has no contributor", place: PLACE }]);
    expect(await progressOf(OLD)).toEqual({ id: OLD, state: "refused", by: "rules", reason: "photo has no contributor", place: PLACE, received: "2026-11-01T00:00:00Z" });
  });

  it("leaves feedback progress to /v1/feedback/progress", async () => {
    const id = (await send()).body.id!;
    const res = await handle(new Request(`https://photos-upload.example/v1/feedback/progress?ids=${id}`), e);
    expect(res.status).toBe(400);
  });
});
