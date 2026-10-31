import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_KEY = "owner-page-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const TOKEN = "q2Vb7Rk1cW9yZ3hVdm5Pb2pQTlR4Y0FyZ0lCd2pUcEs";
const NOW = Date.parse("2026-10-31T09:00:00Z");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

function fakeKv(): KVLike {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v) };
}

function fakeGitHub() {
  const puts: { path: string; stored: Record<string, unknown>; raw: string }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    }
    const body = JSON.parse(String(init?.body)) as { content: string };
    const raw = Buffer.from(body.content, "base64").toString("utf8");
    puts.push({ path: url.split("/contents/")[1]!, stored: JSON.parse(raw) as Record<string, unknown>, raw });
    return new Response("{}", { status: 201 });
  };
  return { fetch, puts };
}

function env(): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "owner-page", daily_limit: 1000 } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "2",
    INBOX_REPO: "opencampingdb/inbox",
    ALLOWED_ORIGINS: "*",
    RATE_LIMIT: fakeKv(),
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://intake.example/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-key": APP_KEY, ...headers },
    body: JSON.stringify(body),
  });

const owner = { name: "Jo Bloggs", email: "jo@example.com" };
const claim = {
  type: "owner_claim",
  place: PLACE,
  device: DEVICE,
  app_version: "1.0.0",
  terms_accepted: true,
  owner,
  claim: { proof_url: "https://riverbend.example/about" },
};
const listing = {
  ...claim,
  type: "owner_listing",
  place: null,
  location: { lat: -36.85, lon: 144.55 },
  listing: { name: "Riverbend Farm Stay", facts: { booking_url: "https://riverbend.example/book" } },
};
const update = {
  type: "owner_update",
  place: PLACE,
  device: DEVICE,
  app_version: "1.0.0",
  terms_accepted: true,
  token: TOKEN,
  update: { facts: { power: true } },
};

describe("owner submissions", () => {
  let gh: ReturnType<typeof fakeGitHub>;
  let handle: ReturnType<typeof createHandler>;
  let e: Env;
  let n: number;

  beforeEach(() => {
    gh = fakeGitHub();
    e = env();
    n = 0;
    // Distinct random bytes on every call, so ids, codes and tokens differ.
    handle = createHandler({
      fetch: gh.fetch,
      now: () => NOW,
      randomBytes: (size) => new Uint8Array(size).map((_, i) => (i * 7 + ++n) % 256),
    });
  });

  it("answers a claim with an id, a code and a token, and stores only the token hash", async () => {
    const res = await handle(post(claim), e);
    expect(res.status).toBe(202);
    const answer = (await res.json()) as { id: string; code: string; token: string };
    expect(answer.id).toMatch(/^fb_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(answer.code).toMatch(/^OCDB-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(answer.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const { path, stored, raw } = gh.puts[0]!;
    expect(path).toBe(`pending/2026-10-31/${answer.id}.json`);
    expect(stored).toMatchObject({
      id: answer.id,
      type: "owner_claim",
      place: PLACE,
      app: "owner-page",
      terms_accepted: true,
      owner,
      claim: { proof_url: "https://riverbend.example/about" },
      code: answer.code,
      token_sha256: sha256(answer.token),
    });
    expect(raw).not.toContain(answer.token);
    expect(raw).not.toContain(DEVICE);
    expect(stored.token).toBeUndefined();
  });

  it("answers a listing the same way", async () => {
    const res = await handle(post(listing), e);
    expect(res.status).toBe(202);
    const answer = (await res.json()) as { code: string; token: string };
    expect(gh.puts[0]!.stored).toMatchObject({
      type: "owner_listing",
      place: null,
      location: { lat: -36.85, lon: 144.55 },
      listing: { name: "Riverbend Farm Stay" },
      code: answer.code,
      token_sha256: sha256(answer.token),
    });
  });

  it("gives every claim a different token", async () => {
    const a = (await (await handle(post(claim), e)).json()) as { token: string };
    const b = (await (await handle(post(claim), e)).json()) as { token: string };
    expect(a.token).not.toBe(b.token);
  });

  it("answers an update with only an id and stores the hash of its token, never the token", async () => {
    const res = await handle(post(update), e);
    expect(res.status).toBe(202);
    expect(Object.keys((await res.json()) as object)).toEqual(["id"]);
    const { stored, raw } = gh.puts[0]!;
    expect(stored).toMatchObject({ type: "owner_update", token_sha256: sha256(TOKEN), update: { facts: { power: true } } });
    expect(stored.token).toBeUndefined();
    expect(raw).not.toContain(TOKEN);
  });

  it("needs terms_accepted and does not ask for consent", async () => {
    expect((await handle(post({ ...claim, terms_accepted: false }), e)).status).toBe(400);
    expect((await handle(post(claim), e)).status).toBe(202);
  });

  it("refuses an owner description holding contact details", async () => {
    const res = await handle(post({ ...update, update: { description: "Ring 0412 345 678 to book" } }), e);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details: string[] }).details.join()).toContain("update.description");
  });

  it("limits each device to 5 owner submissions a day, apart from other feedback", async () => {
    for (let i = 0; i < 5; i++) expect((await handle(post(update), e)).status).toBe(202);
    expect((await handle(post(claim), e)).status).toBe(429);
    const check = {
      type: "check",
      place: PLACE,
      device: DEVICE,
      app_version: "1.0.0",
      consent: true,
      check: { visited: "2026-10-30", still_there: true },
    };
    expect((await handle(post(check), e)).status).toBe(202);
  });

  it("keeps owner submissions apart from the app's feedback limit", async () => {
    e = { ...e, APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "owner-page", daily_limit: 2, owner_daily_limit: 3 } }) };
    const device = (i: number) => `${String(i).padStart(8, "0")}-e2bb-4255-8caf-4136c566a962`;
    const check = (i: number) => ({
      type: "check",
      place: PLACE,
      device: device(i),
      app_version: "1.0.0",
      consent: true,
      check: { visited: "2026-10-30", still_there: true },
    });
    for (let i = 0; i < 2; i++) expect((await handle(post(check(i)), e)).status).toBe(202);
    expect((await handle(post(check(2)), e)).status).toBe(429);
    for (let i = 10; i < 13; i++) expect((await handle(post({ ...claim, device: device(i) }), e)).status).toBe(202);
    expect((await handle(post({ ...claim, device: device(13) }), e)).status).toBe(429);
  });

  it("refuses report, review and check with 403 for a key limited to owner submissions", async () => {
    e = { ...e, APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "owner-page", daily_limit: 1000, kinds: ["owner"] } }) };
    const base = { place: PLACE, device: DEVICE, app_version: "1.0.0", consent: true };
    for (const body of [
      { ...base, type: "report", report: { kind: "closed" } },
      { ...base, type: "review", review: { stars: 4, text: "Quiet and shady.", visited: "2026-10" } },
      { ...base, type: "check", check: { visited: "2026-10-30", still_there: true } },
    ]) {
      const res = await handle(post(body), e);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "type_not_allowed_for_app_key" });
    }
    expect((await handle(post(claim), e)).status).toBe(202);
    expect(gh.puts).toHaveLength(1);
  });

  it("limits each client network to 10 owner submissions a day, whatever device ids it sends", async () => {
    const from = (i: number) =>
      post({ ...claim, device: `${String(i).padStart(8, "0")}-e2bb-4255-8caf-4136c566a962` }, { "cf-connecting-ip": "2001:db8:1::5" });
    for (let i = 0; i < 10; i++) expect((await handle(from(i), e)).status).toBe(202);
    expect((await handle(from(10), e)).status).toBe(429);
  });
});
