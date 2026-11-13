import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, createScheduled, PASS_DEVICE_DAILY_LIMIT, REGISTER_ORIGIN_DAILY_LIMIT, type Env } from "../src/index.js";
import {
  ATTEST_KEY_DAILY_LIMIT,
  DEVICE_DAILY_LIMIT,
  ORIGIN_DAILY_LIMIT,
  OWNER_ORIGIN_DAILY_LIMIT,
  PHOTO_CONTRIBUTOR_DAILY_LIMIT,
  PLACE_EDIT_DAILY_LIMIT,
  type KVLike,
} from "../src/ratelimit.js";
import { NEW_PLACE_DAILY_LIMIT } from "../src/recent.js";
import { APP_ID, makeDevice } from "./attest-fixtures.js";
import { fakeD1 } from "./fake-d1.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const NOW = Date.parse("2026-11-07T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** A KV namespace that fails the test when the daily counters touch it: they live in D1. */
function unusedKv(): KVLike {
  const fail = async (): Promise<never> => {
    throw new Error("the daily counters must not use KV");
  };
  return { get: fail, put: fail, delete: fail };
}

/** An in-memory KV, for the App Attest key store. */
function memoryKv(): KVLike {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
}

/** GitHub: an installation token, and the contents API for a file written at once. */
function fakeGitHub() {
  const fetch = async (url: string) => {
    if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    if (url.includes("/contents/")) return new Response("{}", { status: 201 });
    return new Response("not found", { status: 404 });
  };
  return { fetch };
}

/** A minimal JPEG: SOI, a SOF0 frame header, padding and EOI. */
const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 3, 0, 4, 0x03, ...new Array(9).fill(0), ...new Array(50).fill(7), 0xff, 0xd9]);
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const device = (i: number) => `${String(i).padStart(8, "0")}-e2bb-4255-8caf-4136c566a962`;

const review = (extra: Record<string, unknown> = {}) => ({
  type: "review",
  place: PLACE,
  device: DEVICE,
  contributor: "acct_3f9a8b7c6d5e4f30",
  app_version: "1.0.0",
  consent: true,
  review: { stars: 4, text: "Quiet and shady.", visited: "2026-10" },
  ...extra,
});

describe("daily counters in D1", () => {
  let clock: number;
  let store: ReturnType<typeof fakeD1>;
  let handle: ReturnType<typeof createHandler>;
  let attestKv: KVLike;

  function env(appKey: Record<string, unknown> = {}): Env {
    return {
      APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100_000, ...appKey } }),
      DEVICE_SALT: "pepper",
      GH_APP_ID: "1",
      GH_APP_PRIVATE_KEY: privateKey,
      GH_INSTALLATION_ID: "2",
      INBOX_REPO: "opencampingdb/inbox",
      RATE_LIMIT: unusedKv(),
      RECENT_LIST: store,
      ATTEST: attestKv,
      PHOTOS_PENDING: { put: async () => undefined, delete: async () => undefined },
      PHOTO_PASS_SECRET: "pass-secret",
    };
  }

  const request = (path: string, body: string, headers: Record<string, string> = {}) =>
    new Request(`https://intake.example${path}`, { method: "POST", headers: { "content-type": "application/json", "x-app-key": APP_KEY, ...headers }, body });

  function upload(contributor = "acct_3f9a8b7c6d5e4f30") {
    const full = jpeg();
    const meta = {
      type: "photo",
      place: PLACE,
      device: DEVICE,
      contributor,
      app_version: "1.0.0",
      consent: true,
      photo: { full_sha256: sha(full), full_bytes: full.length, thumb_sha256: sha(full), thumb_bytes: full.length },
    };
    return new Request("https://intake.example/v1/photos", {
      method: "POST",
      headers: { "x-app-key": APP_KEY, "x-photo-meta": Buffer.from(JSON.stringify(meta)).toString("base64url") },
      body: new Uint8Array([...full, ...full]),
    });
  }

  /** What `rate_counts` holds, by key. */
  const rows = () => store.db.prepare("SELECT key, day, count FROM rate_counts ORDER BY key").all() as { key: string; day: string; count: number }[];

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://intake.example/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-key": APP_KEY, ...headers },
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    clock = NOW;
    store = fakeD1();
    attestKv = memoryKv();
    handle = createHandler({ fetch: fakeGitHub().fetch, now: () => clock });
  });

  it(`limits each device to ${DEVICE_DAILY_LIMIT} a day, and lets it send again the next day`, async () => {
    const e = env();
    for (let i = 0; i < DEVICE_DAILY_LIMIT; i++) expect((await handle(post(review({ contributor: `acct_${String(i).padStart(16, "0")}` })), e)).status).toBe(202);
    const over = await handle(post(review({ contributor: "acct_another_one_0000" })), e);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(Number(over.headers.get("retry-after"))).toBe(12 * 60 * 60);
    expect((await handle(post(review({ device: device(1), contributor: "acct_another_one_0000" })), e)).status).toBe(202);
    clock += DAY;
    expect((await handle(post(review({ contributor: "acct_another_one_0000" })), e)).status).toBe(202);
  });

  it("limits each contributor per day, across devices", async () => {
    const e = env({ contributor_daily_limit: 2 });
    expect((await handle(post(review({ device: device(1) })), e)).status).toBe(202);
    expect((await handle(post(review({ device: device(2) })), e)).status).toBe(202);
    expect((await handle(post(review({ device: device(3) })), e)).status).toBe(429);
    clock += DAY;
    expect((await handle(post(review({ device: device(3) })), e)).status).toBe(202);
  });

  it(`limits each attested App Attest key to ${ATTEST_KEY_DAILY_LIMIT} a day`, async () => {
    const key = makeDevice(NOW);
    handle = createHandler({ fetch: fakeGitHub().fetch, now: () => clock, appAttestRoot: key.rootPem });
    const e = env({ requires_attestation: true, ios: { app_id: APP_ID } });
    const { challenge } = (await (await handle(request("/v1/attest/challenge", ""), e)).json()) as { challenge: string };
    const registered = await handle(request("/v1/attest/register", JSON.stringify({ key_id: key.keyId, challenge, attestation: b64(key.attest(challenge)) })), e);
    expect(registered.status).toBe(201);
    const send = (i: number) => {
      const body = JSON.stringify(review({ device: device(i), contributor: `acct_${String(i).padStart(16, "0")}`, review: { stars: 4, text: "", visited: "2026-10" } }));
      return handle(request("/v1/feedback", body, { "x-attest-platform": "ios", "x-attest-key-id": key.keyId, "x-attest-assertion": b64(key.assert(body, i + 1)) }), e);
    };
    for (let i = 0; i < ATTEST_KEY_DAILY_LIMIT; i++) expect((await send(i)).status).toBe(202);
    expect((await send(ATTEST_KEY_DAILY_LIMIT)).status).toBe(429);
  });

  it(`limits each client network to ${ORIGIN_DAILY_LIMIT} items and ${OWNER_ORIGIN_DAILY_LIMIT} owner submissions a day`, async () => {
    const e = env();
    const from = (ip: string, i: number) => post(review({ device: device(i), contributor: `acct_${String(i).padStart(16, "0")}` }), { "cf-connecting-ip": ip });
    for (let i = 0; i < ORIGIN_DAILY_LIMIT; i++) expect((await handle(from(`203.0.113.${i % 250}`, i), e)).status).toBe(202);
    expect((await handle(from("203.0.113.251", ORIGIN_DAILY_LIMIT), e)).status).toBe(429);
    expect((await handle(from("198.51.100.7", ORIGIN_DAILY_LIMIT + 1), e)).status).toBe(202);
    const claim = (i: number) =>
      post(
        {
          type: "owner_claim",
          place: PLACE,
          device: device(1000 + i),
          app_version: "1.0.0",
          terms_accepted: true,
          owner: { name: "Jo Bloggs", email: "jo@example.com" },
          claim: { proof_url: "https://riverbend.example/about" },
        },
        { "cf-connecting-ip": "2001:db8:1::5" },
      );
    for (let i = 0; i < OWNER_ORIGIN_DAILY_LIMIT; i++) expect((await handle(claim(i), e)).status).toBe(202);
    expect((await handle(claim(OWNER_ORIGIN_DAILY_LIMIT), e)).status).toBe(429);
  });

  it("limits each app to its daily limit, with owner submissions counted apart", async () => {
    const e = env({ daily_limit: 2, owner_daily_limit: 1 });
    for (let i = 0; i < 2; i++) expect((await handle(post(review({ device: device(i), contributor: `acct_${String(i).padStart(16, "0")}` })), e)).status).toBe(202);
    expect((await handle(post(review({ device: device(2), contributor: "acct_another_one_0000" })), e)).status).toBe(429);
    const claim = {
      type: "owner_claim",
      place: PLACE,
      device: device(10),
      app_version: "1.0.0",
      terms_accepted: true,
      owner: { name: "Jo Bloggs", email: "jo@example.com" },
      claim: { proof_url: "https://riverbend.example/about" },
    };
    expect((await handle(post(claim), e)).status).toBe(202);
    expect((await handle(post({ ...claim, device: device(11) }), e)).status).toBe(429);
  });

  it(`limits each contributor to ${NEW_PLACE_DAILY_LIMIT} new places a day`, async () => {
    const e = env();
    const newPlace = (i: number) => ({
      type: "report",
      place: null,
      location: { lat: -36.12345 + i / 100, lon: 146.88765 },
      device: device(i),
      contributor: "acct_3f9a8b7c6d5e4f30",
      app_version: "1.0.0",
      consent: true,
      report: { kind: "new_place", place_kind: "free_camp", note: "Gravel pit off the highway, room for three vans" },
    });
    for (let i = 0; i < NEW_PLACE_DAILY_LIMIT; i++) expect((await handle(post(newPlace(i)), e)).status).toBe(202);
    expect((await handle(post(newPlace(NEW_PLACE_DAILY_LIMIT)), e)).status).toBe(429);
  });

  /** Puts PLACE in the place index, as a release would. */
  const indexPlace = (id = PLACE) =>
    store.db.prepare("INSERT INTO place_index (id, cell_lon, cell_lat, facts, fact_sources, fact_dates) VALUES (?, 146, -37, '{}', '{}', '{}')").run(id);

  it("counts every report about a place against the app's daily budget", async () => {
    indexPlace();
    const e = env({ daily_limit: 3 });
    const fact = review({ type: "report", review: undefined, report: { kind: "fact", fact: "toilets", value: true } });
    for (let i = 0; i < 3; i++) expect((await handle(post(fact), e)).status).toBe(202);
    expect((await handle(post(fact), e)).status).toBe(429);
    expect(rows().find((r) => r.key.startsWith("a:"))?.count).toBe(3);
  });

  it("gives no editing allowance for a place the intake does not know", async () => {
    const e = env();
    const unknown = review({ type: "report", place: "ocdb_01JC0000000000000000000AAA", review: undefined, report: { kind: "fact", fact: "toilets", value: true } });
    for (let i = 0; i < 3; i++) expect((await handle(post(unknown), e)).status).toBe(202);
    expect(rows().find((r) => r.key.startsWith("d:"))?.count).toBe(3);
  });

  it("counts a device's reports about one place in a day once, up to the place edit limit", async () => {
    indexPlace();
    const e = env();
    const fact = review({ type: "report", review: undefined, report: { kind: "fact", fact: "toilets", value: true } });
    for (let i = 0; i < PLACE_EDIT_DAILY_LIMIT; i++) expect((await handle(post(fact), e)).status).toBe(202);
    // The whole edit used one item of the device's and the contributor's day.
    expect(rows().filter((r) => r.key.startsWith("d:") || r.key.startsWith("c:")).map((r) => r.count)).toEqual([1, 1]);
    expect((await handle(post(fact), e)).status).toBe(429);
    expect((await handle(post(review()), e)).status).toBe(202);
    clock += DAY;
    expect((await handle(post(fact), e)).status).toBe(202);
  });

  it(`limits each contributor to ${PHOTO_CONTRIBUTOR_DAILY_LIMIT} photos a day`, async () => {
    const e = env();
    for (let i = 0; i < PHOTO_CONTRIBUTOR_DAILY_LIMIT; i++) expect((await handle(upload(), e)).status).toBe(202);
    expect((await handle(upload(), e)).status).toBe(429);
    expect((await handle(upload("acct_another_one_0000"), e)).status).toBe(202);
  });

  it(`limits photo passes to ${PASS_DEVICE_DAILY_LIMIT} a day for each device`, async () => {
    const e = env({ photo_pass_unattested: true });
    const pass = () => request("/v1/photos/pass", JSON.stringify({ type: "photo_pass", device: DEVICE, app_version: "1.0.0", time: new Date(clock).toISOString() }));
    for (let i = 0; i < PASS_DEVICE_DAILY_LIMIT; i++) expect((await handle(pass(), e)).status).toBe(200);
    expect((await handle(pass(), e)).status).toBe(429);
    clock += DAY;
    expect((await handle(pass(), e)).status).toBe(200);
  });

  it(`limits key registrations to ${REGISTER_ORIGIN_DAILY_LIMIT} a day for each client network`, async () => {
    const e = env({ requires_attestation: true, ios: { app_id: APP_ID } });
    const register = (ip: string) =>
      handle(request("/v1/attest/register", JSON.stringify({ key_id: `${"A".repeat(43)}=`, challenge: "unused", attestation: b64(new Uint8Array([1])) }), { "cf-connecting-ip": ip }), e);
    for (let i = 0; i < REGISTER_ORIGIN_DAILY_LIMIT; i++) expect((await register("203.0.113.7")).status).toBe(401);
    expect((await register("203.0.113.9")).status).toBe(429);
    expect((await register("198.51.100.1")).status).toBe(401);
  });

  it("takes many items from different devices in the same second, and counts every one", async () => {
    const e = env();
    const sent = await Promise.all(
      Array.from({ length: 50 }, (_, i) => handle(post(review({ device: device(i), contributor: `acct_${String(i).padStart(16, "0")}` })), e)),
    );
    expect(sent.map((r) => r.status)).toEqual(new Array(50).fill(202));
    expect(rows().find((r) => r.key === "a:2026-11-07:example-app")?.count).toBe(50);
  });

  it("leaves no count behind when one counter cannot be written", async () => {
    // The database refuses every write to the contributor's counter.
    const failing = {
      ...store,
      prepare: (sql: string) => {
        const statement = store.prepare(sql);
        return {
          ...statement,
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            if (typeof values[0] !== "string" || !values[0].startsWith("c:")) return bound;
            const fail = async (): Promise<never> => {
              throw new Error("D1_ERROR: storage busy");
            };
            return { ...bound, first: fail, run: fail, all: fail };
          },
        };
      },
    };
    const res = await handle(post(review(), { "cf-connecting-ip": "203.0.113.5" }), { ...env(), RECENT_LIST: failing });
    expect(res.status).toBe(503);
    expect(rows().filter((r) => r.count !== 0)).toEqual([]);
  });

  describe("when the daily counters cannot be reached", () => {
    /** The database, with every statement on the daily counters failing. */
    const countsDown = () => ({
      ...store,
      prepare: (sql: string) => {
        if (!sql.includes("rate_counts")) return store.prepare(sql);
        const fail = async (): Promise<never> => {
          throw new Error("D1_ERROR: storage busy");
        };
        const statement = { bind: () => statement, first: fail, run: fail, all: fail };
        return statement;
      },
    });
    const ip = { "cf-connecting-ip": "203.0.113.5" };

    it("answers a photo upload 503 with a retry-after", async () => {
      const sent = upload();
      sent.headers.set("cf-connecting-ip", ip["cf-connecting-ip"]);
      const res = await handle(sent, { ...env(), RECENT_LIST: countsDown() });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
    });

    it("answers a photo pass 503 with a retry-after", async () => {
      const e = { ...env({ photo_pass_unattested: true }), RECENT_LIST: countsDown() };
      const pass = request("/v1/photos/pass", JSON.stringify({ type: "photo_pass", device: DEVICE, app_version: "1.0.0", time: new Date(clock).toISOString() }), ip);
      const res = await handle(pass, e);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
    });

    it("answers a key registration 503 with a retry-after", async () => {
      const e = { ...env({ requires_attestation: true, ios: { app_id: APP_ID } }), RECENT_LIST: countsDown() };
      const body = JSON.stringify({ key_id: `${"A".repeat(43)}=`, challenge: "unused", attestation: b64(new Uint8Array([1])) });
      const res = await handle(request("/v1/attest/register", body, ip), e);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("60");
    });
  });

  it("deletes the counters from before yesterday in the scheduled job", async () => {
    const e = env();
    expect((await handle(post(review()), e)).status).toBe(202);
    clock += DAY;
    expect((await handle(post(review()), e)).status).toBe(202);
    clock += DAY;
    const scheduled = createScheduled({ fetch: fakeGitHub().fetch, now: () => clock });
    await scheduled(e);
    // Today is 2026-11-09: the counters from yesterday stay, the ones from the day before go.
    expect([...new Set(rows().map((r) => r.day))]).toEqual(["2026-11-08"]);
  });
});
