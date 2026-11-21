import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHandler, type BucketLike, type Env, type RateLimiterLike } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_KEY = "test-app-key-0123456789";
const OWNER_CHECK_KEY = "photo-service-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const TOKEN = "T".repeat(43);
const NOW = Date.parse("2026-11-03T01:00:00Z");
const OWNER_CHECK_URL = "https://intake.opencampingdb.example/v1/owner/check";

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

function fakeKv(): KVLike {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
}

const bucket = (): BucketLike => ({ put: async () => undefined, delete: async () => undefined });

/** The inbox repository on GitHub: installation tokens, owner records to read, and files the intake writes. */
function fakeGitHub(owners: Record<string, Record<string, unknown>>, options: { down?: boolean } = {}) {
  const puts: Record<string, unknown>[] = [];
  const reads: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_1", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    if (options.down) return new Response("unavailable", { status: 502 });
    const read = /\/repos\/opencampingdb\/inbox\/contents\/owners\/(ocdb_[0-9A-Z]{26})\.json\?ref=main$/.exec(url);
    if (read && (init?.method ?? "GET") === "GET") {
      reads.push(read[1]!);
      const record = owners[read[1]!];
      if (!record) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(JSON.stringify(record)).toString("base64"), sha: "abc" }), { status: 200 });
    }
    if (url.includes("/contents/") && init?.method === "PUT") {
      const body = JSON.parse(init.body as string) as { content: string };
      puts.push(JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as Record<string, unknown>);
      return new Response("{}", { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, puts, reads };
}

function baseEnv(): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100 }, [OWNER_CHECK_KEY]: { app: "example-photos", daily_limit: 100, owner_check: true } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "12345",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "678",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: fakeKv(),
  };
}

const ownerRecord = (place: string, token: string) => ({ place, claim: "fb_01JBXK3M8Q4R5S6T7V8W9X0YZA", token_sha256: hex(token), approved: "2026-10-01", email: "owner@example.org", name: "Pat Owner" });

const allow: RateLimiterLike = { limit: async () => ({ success: true }) };

describe("the owner check", () => {
  const ask = (handle: ReturnType<typeof createHandler>, env: Env, body: unknown, key = OWNER_CHECK_KEY) =>
    handle(new Request("https://intake.example/v1/owner/check", { method: "POST", headers: { "x-app-key": key, "cf-connecting-ip": "203.0.113.5" }, body: JSON.stringify(body) }), env);
  const checkEnv = (): Env => ({ ...baseEnv(), PER_IP: allow });

  it("is only for app keys with owner_check, and only with a rate limit binding", async () => {
    const gh = fakeGitHub({ [PLACE]: ownerRecord(PLACE, TOKEN) });
    const handle = createHandler({ fetch: gh.fetch, now: () => NOW });
    const refused = await ask(handle, checkEnv(), { place: PLACE, token: TOKEN }, APP_KEY);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "owner_check_not_allowed_for_app_key" });
    const unlimited = await ask(handle, baseEnv(), { place: PLACE, token: TOKEN });
    expect(unlimited.status).toBe(503);
    expect(unlimited.headers.get("retry-after")).toBe("60");
    expect(await unlimited.json()).toEqual({ error: "owner_check_unavailable" });
    expect(gh.reads).toEqual([]);
  });

  it("keeps each answer for a minute, and reuses the installation token", async () => {
    let clock = NOW;
    const gh = fakeGitHub({ [PLACE]: ownerRecord(PLACE, TOKEN) });
    let tokens = 0;
    const fetch = async (url: string, init?: RequestInit) => (url.endsWith("/access_tokens") && tokens++, gh.fetch(url, init));
    const handle = createHandler({ fetch, now: () => clock });
    const env = checkEnv();
    await ask(handle, env, { place: PLACE, token: TOKEN });
    await ask(handle, env, { place: PLACE, token: TOKEN });
    expect(gh.reads).toEqual([PLACE]);
    await ask(handle, env, { place: PLACE, token: "U".repeat(43) });
    clock += 61_000;
    expect(await (await ask(handle, env, { place: PLACE, token: TOKEN })).json()).toEqual({ owner: true });
    expect(gh.reads).toEqual([PLACE, PLACE, PLACE]);
    expect(tokens).toBe(1);
  });

  it("says whether a token is the place's approved owner's, and nothing about the owner", async () => {
    const gh = fakeGitHub({ [PLACE]: ownerRecord(PLACE, TOKEN) });
    const handle = createHandler({ fetch: gh.fetch, now: () => NOW });
    const env = checkEnv();
    const yes = await ask(handle, env, { place: PLACE, token: TOKEN });
    expect(yes.status).toBe(200);
    expect(await yes.json()).toEqual({ owner: true });
    expect(await (await ask(handle, env, { place: PLACE, token: "U".repeat(43) })).json()).toEqual({ owner: false });
    expect(await (await ask(handle, env, { place: OTHER, token: TOKEN })).json()).toEqual({ owner: false });
    expect(gh.puts).toEqual([]);
  });

  it("needs an app key, a place id and a token", async () => {
    const gh = fakeGitHub({});
    const handle = createHandler({ fetch: gh.fetch, now: () => NOW });
    expect((await ask(handle, checkEnv(), { place: PLACE, token: TOKEN }, "nope")).status).toBe(401);
    expect((await ask(handle, checkEnv(), { place: "nope", token: TOKEN })).status).toBe(400);
    expect((await ask(handle, checkEnv(), { place: PLACE, token: "short" })).status).toBe(400);
    expect(gh.reads).toEqual([]);
  });

  it("answers 503 when the owner records can't be read", async () => {
    const handle = createHandler({ fetch: fakeGitHub({}, { down: true }).fetch, now: () => NOW });
    const res = await ask(handle, checkEnv(), { place: PLACE, token: TOKEN });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("is rate limited per app key", async () => {
    const keys: string[] = [];
    const limiter: RateLimiterLike = { limit: async ({ key }) => (keys.push(key), { success: keys.length <= 1 }) };
    const handle = createHandler({ fetch: fakeGitHub({ [PLACE]: ownerRecord(PLACE, TOKEN) }).fetch, now: () => NOW });
    const env = { ...baseEnv(), PER_IP: limiter };
    expect((await ask(handle, env, { place: PLACE, token: TOKEN })).status).toBe(200);
    expect((await ask(handle, env, { place: PLACE, token: TOKEN })).status).toBe(429);
    expect(new Set(keys).size).toBe(1);
  });
});

describe("an owner's hero photo at the photo intake", () => {
  function setup(check: (body: Record<string, unknown>, key: string | null) => Response | Promise<Response>) {
    const gh = fakeGitHub({});
    const asked: Record<string, unknown>[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      if (url === OWNER_CHECK_URL) {
        const body = JSON.parse(init!.body as string) as Record<string, unknown>;
        asked.push(body);
        return check(body, new Headers(init!.headers).get("x-app-key"));
      }
      return gh.fetch(url, init);
    };
    const handle = createHandler({ fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
    const env: Env = { ...baseEnv(), PHOTOS_PENDING: bucket(), OWNER_CHECK_URL, OWNER_CHECK_KEY };
    const send = (hero: Record<string, unknown>, target: Env = env, from: { device?: string; ip?: string } = {}) =>
      handle(
        new Request("https://photos-intake.example/v1/feedback", {
          method: "POST",
          headers: { "x-app-key": APP_KEY, ...(from.ip ? { "cf-connecting-ip": from.ip } : {}) },
          body: JSON.stringify({ type: "photo_hero", place: PLACE, token: TOKEN, photo_hero: hero, device: from.device ?? DEVICE, app_version: "1", consent: true }),
        }),
        target,
      );
    return { gh, asked, send, env };
  }
  const owner = (yes: boolean) => () => new Response(JSON.stringify({ owner: yes }), { status: 200 });

  it("checks the token with the owner check, then stores the choice without the token", async () => {
    const t = setup((_body, key) => (key === OWNER_CHECK_KEY ? owner(true)() : new Response("{}", { status: 401 })));
    const res = await t.send({ commons: "Lake Eppalock camp 2019.jpg" });
    expect(res.status).toBe(202);
    expect(t.asked).toEqual([{ place: PLACE, token: TOKEN }]);
    expect(t.gh.puts).toHaveLength(1);
    expect(t.gh.puts[0]).toMatchObject({ type: "photo_hero", place: PLACE, photo_hero: { commons: "Lake Eppalock camp 2019.jpg" }, owner_checked: true });
    expect(JSON.stringify(t.gh.puts[0])).not.toContain(TOKEN);
  });

  it("takes the owner's token as the proof on an app key that requires attestation", async () => {
    const t = setup(owner(true));
    const attested = { ...t.env, APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100, requires_attestation: true, ios: { app_id: "ABCDE12345.com.example.app" } } }) };
    const res = await t.send({ photo: PHOTO }, attested);
    expect(res.status).toBe(202);
    expect(t.asked).toEqual([{ place: PLACE, token: TOKEN }]);
    expect(t.gh.puts).toHaveLength(1);
  });

  it("takes at most 20 hero choices a day from a device, refusals included, before asking the owner check", async () => {
    const t = setup(owner(false));
    const answers: number[] = [];
    for (let i = 0; i < 21; i++) answers.push((await t.send({ none: true })).status);
    expect(answers.slice(0, 20).every((s) => s === 403)).toBe(true);
    expect(answers[20]).toBe(429);
    expect(t.asked).toHaveLength(20);
    // Another device on another network still gets through.
    expect((await t.send({ none: true }, t.env, { device: "9b241101-e2bb-4255-8caf-4136c566a962", ip: "198.51.100.9" })).status).toBe(403);
  });

  it("takes at most 20 hero choices a day from a client network, across devices", async () => {
    const t = setup(owner(false));
    const answers: number[] = [];
    for (let i = 0; i < 21; i++) {
      const device = `3b241101-e2bb-4255-8caf-${String(i).padStart(12, "0")}`;
      answers.push((await t.send({ none: true }, t.env, { device, ip: "203.0.113.5" })).status);
    }
    expect(answers[19]).toBe(403);
    expect(answers[20]).toBe(429);
    expect(t.asked).toHaveLength(20);
  });

  it("gives the day's count back when the owner check can't be reached", async () => {
    let up = false;
    const t = setup(() => (up ? owner(true)() : new Response("{}", { status: 500 })));
    for (let i = 0; i < 25; i++) expect((await t.send({ none: true })).status).toBe(503);
    up = true;
    expect((await t.send({ none: true })).status).toBe(202);
  });

  it("refuses a token that is not the place's owner's, and stores nothing", async () => {
    const t = setup(owner(false));
    const res = await t.send({ photo: PHOTO });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "not_owner" });
    expect(t.gh.puts).toEqual([]);
  });

  it("answers 503 and stores nothing when the owner check can't be reached or fails", async () => {
    for (const check of [() => Promise.reject(new Error("offline")), () => new Response("{}", { status: 500 }), () => new Response("not json", { status: 200 })]) {
      const t = setup(check);
      const res = await t.send({ none: true });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "owner_check_unavailable" });
      expect(res.headers.get("retry-after")).toBe("60");
      expect(t.gh.puts).toEqual([]);
    }
  });

  it("is not taken without the owner check set up, or without a photo service", async () => {
    const t = setup(owner(true));
    const { OWNER_CHECK_URL: _u, ...noCheck } = t.env;
    expect(await (await t.send({ none: true }, noCheck as Env)).json()).toEqual({ error: "photo_hero_not_served_here" });
    const { PHOTOS_PENDING: _p, ...noPhotos } = t.env;
    expect(await (await t.send({ none: true }, noPhotos as Env)).json()).toEqual({ error: "photos_not_served_here" });
    expect(t.asked).toEqual([]);
  });
});
