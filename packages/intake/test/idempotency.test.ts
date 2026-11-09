import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type BucketLike, type Env } from "../src/index.js";
import { KEEP_KEYS_DAYS, pruneRequestKeys } from "../src/idempotency.js";
import { fakeD1 } from "./fake-d1.js";
import { listableKv } from "./fake-kv.js";

const NOW = Date.parse("2026-11-09T09:00:00Z");
const APP_KEY = "test-app-key-0123456789";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const PLACE = "ocdb_01JB0000000000000000000001";
const KEY_A = "6f1c2a8e-0b4d-4e5f-9a7b-1c2d3e4f5a6b";
const KEY_B = "7a2d3b9f-1c5e-4f60-8b8c-2d3e4f5a6b7c";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function fakeGitHub() {
  const commits: string[] = [];
  const fetch = async (url: string) => {
    if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    if (url.includes("/contents/")) {
      commits.push(url);
      return new Response("{}", { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, commits };
}

function fakeBucket(): BucketLike & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    put: async (key, value) => void objects.set(key, new Uint8Array(value)),
    delete: async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}

const review = (text = "Quiet and shady.") => ({
  type: "review",
  place: PLACE,
  device: DEVICE,
  contributor: CONTRIBUTOR,
  app_version: "1.0.0",
  consent: true,
  review: { stars: 4, text, visited: "2026-10" },
});

function jpeg(width: number, height: number): Uint8Array {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, ...new Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...sof, ...new Array(40).fill(7), 0xff, 0xd9]);
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("idempotency keys", () => {
  let store: ReturnType<typeof fakeD1>;
  let gh: ReturnType<typeof fakeGitHub>;
  let handle: ReturnType<typeof createHandler>;
  let e: Env;
  const queued = () => store.db.prepare("SELECT content FROM inbox_queue").all() as { content: string }[];
  const counted = () => (store.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM rate_counts").get() as { n: number }).n;

  beforeEach(() => {
    store = fakeD1();
    gh = fakeGitHub();
    e = {
      APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 1000 } }),
      DEVICE_SALT: "pepper",
      GH_APP_ID: "1",
      GH_APP_PRIVATE_KEY: privateKey,
      GH_INSTALLATION_ID: "2",
      INBOX_REPO: "opencampingdb/inbox",
      RATE_LIMIT: listableKv(),
      RECENT_LIST: store,
      PHOTOS_PENDING: fakeBucket(),
    };
    handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: () => crypto.getRandomValues(new Uint8Array(16)) });
  });

  const post = (body: unknown, key?: string, path = "/v1/feedback") =>
    handle(
      new Request(`https://intake.example${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-key": APP_KEY, ...(key ? { "idempotency-key": key } : {}) },
        body: JSON.stringify(body),
      }),
      e,
    );

  it("answers a submission sent again with the first answer, storing and counting it once", async () => {
    const first = await post(review(), KEY_A);
    expect(first.status).toBe(202);
    const answer = await first.json();
    const counts = counted();
    // The answer was lost, so the SDK sends the same item again with the same key.
    const again = await post(review(), KEY_A);
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual(answer);
    expect(queued()).toHaveLength(1);
    expect(counted()).toBe(counts);
    // Another key is another item.
    expect((await post(review("Shady, a bit noisy."), KEY_B)).status).toBe(202);
    expect(queued()).toHaveLength(2);
  });

  it("keeps keys per app, refuses a malformed key, and stores every send without one", async () => {
    expect((await post(review(), "short")).status).toBe(400);
    expect((await post(review())).status).toBe(202);
    expect((await post(review())).status).toBe(202);
    expect(queued()).toHaveLength(2);
    store.db.prepare("INSERT INTO request_keys (app, key, answer, created) VALUES ('other-app', ?, '{\"status\":202,\"body\":{\"id\":\"fb_x\"}}', '2026-11-09T00:00:00Z')").run(KEY_A);
    const mine = await post(review(), KEY_A);
    expect(((await mine.json()) as { id: string }).id).not.toBe("fb_x");
  });

  it("answers the items of a batch already taken as before, and takes only the new ones", async () => {
    const firstItems = [review("One."), review("Two.")];
    const first = (await (await post({ items: firstItems, keys: [KEY_A, KEY_B] }, undefined, "/v1/feedback/batch")).json()) as { items: { id: string }[] };
    expect(queued()).toHaveLength(2);
    const third = "8b3e4c0a-2d6f-4071-9c9d-3e4f5a6b7c8d";
    const res = await post({ items: [...firstItems, review("Three.")], keys: [KEY_A, KEY_B, third] }, undefined, "/v1/feedback/batch");
    expect(res.status).toBe(200);
    const out = (await res.json()) as { items: { status: number; id: string }[] };
    expect(out.items.slice(0, 2)).toEqual(first.items);
    expect(out.items[2]).toMatchObject({ status: 202, id: expect.stringMatching(/^fb_/) });
    expect(queued()).toHaveLength(3);
  });

  it("refuses a batch whose keys don't match its items one for one", async () => {
    const items = [review("One."), review("Two.")];
    for (const keys of [[KEY_A], [KEY_A, KEY_A], [KEY_A, "bad"], "x"]) {
      expect((await post({ items, keys }, undefined, "/v1/feedback/batch")).status).toBe(400);
    }
    expect(queued()).toHaveLength(0);
  });

  it("answers a photo upload sent again with the first photo id, keeping one copy of the files", async () => {
    const full = jpeg(1600, 1200);
    const thumb = jpeg(400, 300);
    const meta = { type: "photo", place: PLACE, device: DEVICE, contributor: CONTRIBUTOR, app_version: "1.0.0", consent: true, photo: { full_sha256: sha(full), full_bytes: full.length, thumb_sha256: sha(thumb), thumb_bytes: thumb.length } };
    const upload = () =>
      handle(
        new Request("https://intake.example/v1/photos", {
          method: "POST",
          headers: { "x-app-key": APP_KEY, "idempotency-key": KEY_A, "x-photo-meta": Buffer.from(JSON.stringify(meta)).toString("base64url") },
          body: new Uint8Array([...full, ...thumb]),
        }),
        e,
      );
    const first = await upload();
    expect(first.status).toBe(202);
    const { id } = (await first.json()) as { id: string };
    const again = await upload();
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ id });
    expect(queued()).toHaveLength(1);
    expect([...(e.PHOTOS_PENDING as ReturnType<typeof fakeBucket>).objects.keys()].sort()).toEqual([`${id}/full.jpg`, `${id}/thumb.jpg`]);
  });

  it("stores the item once when the same key arrives twice at once", async () => {
    const [a, b] = await Promise.all([post(review(), KEY_A), post(review(), KEY_A)]);
    expect([a.status, b.status].sort()).toEqual([202, 503].sort());
    expect(queued()).toHaveLength(1);
    // The SDK's next try gets the first answer.
    expect((await post(review(), KEY_A)).status).toBe(202);
    expect(queued()).toHaveLength(1);
  });

  it("forgets keys older than the SDK keeps an unsent item, plus a day", async () => {
    expect((await post(review(), KEY_A)).status).toBe(202);
    await pruneRequestKeys(store, NOW + KEEP_KEYS_DAYS * 24 * 60 * 60 * 1000 - 60_000);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM request_keys").get()).toEqual({ n: 1 });
    await pruneRequestKeys(store, NOW + (KEEP_KEYS_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM request_keys").get()).toEqual({ n: 0 });
  });
});
