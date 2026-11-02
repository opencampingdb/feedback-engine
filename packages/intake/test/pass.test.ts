import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHandler, type Env } from "../src/index.js";
import { PASS_TTL_SECONDS, signPass, verifyPass } from "../src/pass.js";
import type { KVLike } from "../src/ratelimit.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP_KEY = "test-app-key-0123456789";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const NOW = Date.parse("2026-11-03T01:00:00Z");
const SECRET = "pass-secret-for-tests";

function fakeKv(): KVLike {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
}

describe("signPass and verifyPass", () => {
  it("round trips, and refuses an expired, altered or foreign pass", async () => {
    const expires = NOW / 1000 + 60;
    const pass = await signPass(SECRET, "example-app", expires);
    expect(pass).toMatch(/^p1\.example-app\.\d{10}\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyPass(SECRET, pass, NOW)).toEqual({ app: "example-app", expires });
    expect(await verifyPass(SECRET, pass, NOW + 60_000)).toBeUndefined();
    expect(await verifyPass(SECRET, pass.replace("example-app", "otherapp00"), NOW)).toBeUndefined();
    expect(await verifyPass("another-secret", pass, NOW)).toBeUndefined();
    expect(await verifyPass(SECRET, "nonsense", NOW)).toBeUndefined();
  });
});

describe("photo pass route", () => {
  // Play Integrity is stubbed: the Google endpoints answer as for a sound device.
  const fetch = async (url: string) => {
    if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "g", expires_in: 3600 }), { status: 200 });
    if (url.includes("decodeIntegrityToken")) return new Response("{}", { status: 400 });
    return new Response("not found", { status: 404 });
  };
  const handle = createHandler({ fetch, now: () => NOW });

  function env(extra: Partial<Env> = {}, requiresAttestation = true): Env {
    return {
      APP_KEYS: JSON.stringify({
        [APP_KEY]: { app: "example-app", daily_limit: 100, ...(requiresAttestation ? { requires_attestation: true, android: { package: "com.example.app" } } : {}) },
      }),
      DEVICE_SALT: "pepper",
      GH_APP_ID: "1",
      GH_APP_PRIVATE_KEY: privateKey,
      GH_INSTALLATION_ID: "2",
      INBOX_REPO: "opencampingdb/inbox",
      RATE_LIMIT: fakeKv(),
      PHOTO_PASS_SECRET: SECRET,
      ...extra,
    };
  }
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://intake.example/v1/photos/pass", { method: "POST", headers: { "x-app-key": APP_KEY, ...headers }, body: JSON.stringify(body) });
  const good = { type: "photo_pass", device: DEVICE, app_version: "1.0.0", time: new Date(NOW).toISOString() };

  it("needs attestation", async () => {
    expect(await (await handle(post(good), env())).json()).toEqual({ error: "attestation_required" });
  });

  it("refuses a request with the wrong clock, and an app key without attestation", async () => {
    expect(await (await handle(post({ ...good, time: new Date(NOW - 10 * 60_000).toISOString() }), env())).json()).toEqual({ error: "clock_skew" });
    expect((await handle(post(good), env({}, false))).status).toBe(403);
  });

  it("answers 404 when the intake has no pass secret", async () => {
    const e = env();
    delete e.PHOTO_PASS_SECRET;
    expect((await handle(post(good), e)).status).toBe(404);
  });

  it("lasts an hour", () => {
    expect(PASS_TTL_SECONDS).toBe(3600);
  });
});
