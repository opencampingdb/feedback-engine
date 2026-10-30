import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppJwt, importPrivateKey } from "../src/github.js";
import { createHandler, hashDevice, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const NOW = Date.parse("2026-10-30T12:00:00Z");

function fakeKv(): KVLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => {
      data.set(k, v);
    },
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

function fakeGitHub(options: { putStatus?: number[] } = {}) {
  const calls: Call[] = [];
  const putStatus = [...(options.putStatus ?? [])];
  let tokenCount = 0;
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? "GET", headers, body });
    if (url.endsWith("/access_tokens")) {
      tokenCount += 1;
      return new Response(
        JSON.stringify({ token: `ghs_token_${tokenCount}`, expires_at: new Date(NOW + 60 * 60 * 1000).toISOString() }),
        { status: 201 },
      );
    }
    if (url.includes("/contents/")) {
      return new Response("{}", { status: putStatus.shift() ?? 201 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

function env(kv = fakeKv()): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "camporacle", daily_limit: 3 }, short: { app: "x", daily_limit: 5 } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "12345",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "678",
    INBOX_REPO: "opencampingdb/inbox",
    INBOX_BRANCH: "main",
    ALLOWED_ORIGINS: "https://app.example",
    RATE_LIMIT: kv,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://intake.example/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-key": APP_KEY, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const review = {
  type: "review",
  place: PLACE,
  device: DEVICE,
  app_version: "1.0.0",
  consent: true,
  review: { stars: 4, text: "Lovely spot. Call 0412 345 678 or email jo@example.com", visited: "2026-10" },
};

function decodeContent(call: Call): Record<string, unknown> {
  return JSON.parse(Buffer.from(call.body!.content as string, "base64").toString("utf8")) as Record<string, unknown>;
}

describe("intake", () => {
  let gh: ReturnType<typeof fakeGitHub>;
  let handle: ReturnType<typeof createHandler>;
  let clock: number;

  beforeEach(() => {
    gh = fakeGitHub();
    clock = NOW;
    handle = createHandler({ fetch: gh.fetch, now: () => clock, randomBytes: (n) => new Uint8Array(n) });
  });

  it("accepts a review, strips contact details, hashes the device and writes to pending", async () => {
    const res = await handle(post(review), env());
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^fb_[0-9A-HJKMNP-TV-Z]{26}$/);

    const put = gh.calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe(`https://api.github.com/repos/opencampingdb/inbox/contents/pending/2026-10-30/${id}.json`);
    expect(put.headers.authorization).toBe("Bearer ghs_token_1");
    expect(put.body!.branch).toBe("main");
    const stored = decodeContent(put);
    expect(stored).toEqual({
      id,
      received: "2026-10-30T12:00:00Z",
      app: "camporacle",
      type: "review",
      place: PLACE,
      device: await hashDevice("pepper", DEVICE),
      app_version: "1.0.0",
      consent: true,
      review: { stars: 4, text: "Lovely spot. Call [removed] or email [removed]", visited: "2026-10" },
    });
    expect(stored.device).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(stored)).not.toContain(DEVICE);
  });

  it("asks for an installation token limited to the inbox and contents: write", async () => {
    await handle(post(review), env());
    const tokenCall = gh.calls.find((c) => c.url.endsWith("/access_tokens"))!;
    expect(tokenCall.url).toBe("https://api.github.com/app/installations/678/access_tokens");
    expect(tokenCall.body).toEqual({ repositories: ["inbox"], permissions: { contents: "write" } });
  });

  it("caches the installation token until near expiry", async () => {
    const e = env();
    await handle(post(review), e);
    await handle(post(review), e);
    expect(gh.calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);
    clock += 56 * 60 * 1000; // within 5 minutes of the one hour expiry
    await handle(post(review), e);
    expect(gh.calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("signs a JWT that verifies against the App public key", async () => {
    await handle(post(review), env());
    const jwt = gh.calls.find((c) => c.url.endsWith("/access_tokens"))!.headers.authorization!.replace("Bearer ", "");
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    expect(claims).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: "12345" });
  });

  it("imports a PKCS#8 key as well as PKCS#1", async () => {
    const { privateKey: pkcs8 } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const key = await importPrivateKey(pkcs8.replace(/\n/g, "\\n"));
    expect(await createAppJwt("1", key, NOW)).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("refuses a missing or unknown app key with 401", async () => {
    expect((await handle(post(review, { "x-app-key": "nope" }), env())).status).toBe(401);
    // Keys shorter than 16 characters in APP_KEYS are ignored.
    expect((await handle(post(review, { "x-app-key": "short" }), env())).status).toBe(401);
    expect(gh.calls).toHaveLength(0);
  });

  it("refuses a bad schema with 400 and the reasons", async () => {
    const res = await handle(post({ ...review, review: { stars: 9, text: "", visited: "2026-10" } }), env());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { details: string[] }).details.join()).toContain("review.stars");
  });

  it("refuses a submission without consent with 400", async () => {
    expect((await handle(post({ ...review, consent: false }), env())).status).toBe(400);
  });

  it("refuses bodies that are not JSON or are too large", async () => {
    expect((await handle(post("{nope"), env())).status).toBe(400);
    expect((await handle(post({ ...review, pad: "x".repeat(20_000) }), env())).status).toBe(413);
  });

  it("limits each device to 20 a day", async () => {
    const kv = fakeKv();
    const e = { ...env(kv), APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "camporacle", daily_limit: 1000 } }) };
    for (let i = 0; i < 20; i++) expect((await handle(post(review), e)).status).toBe(202);
    const res = await handle(post(review), e);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBe(12 * 60 * 60);
    // A different device still gets through.
    const other = { ...review, device: "9b241101-e2bb-4255-8caf-4136c566a962" };
    expect((await handle(post(other), e)).status).toBe(202);
    // The next day the device may send again.
    clock += 24 * 60 * 60 * 1000;
    expect((await handle(post(review), e)).status).toBe(202);
  });

  it("limits each app to its daily limit", async () => {
    const e = env();
    for (let i = 0; i < 3; i++) {
      const device = `${i}b241101-e2bb-4255-8caf-4136c566a962`;
      expect((await handle(post({ ...review, device }), e)).status).toBe(202);
    }
    expect((await handle(post({ ...review, device: "7b241101-e2bb-4255-8caf-4136c566a962" }), e)).status).toBe(429);
  });

  it("returns 503 when GitHub refuses the write so the client retries", async () => {
    gh = fakeGitHub({ putStatus: [500] });
    handle = createHandler({ fetch: gh.fetch, now: () => clock });
    const res = await handle(post(review), env());
    expect(res.status).toBe(503);
  });

  it("gets a fresh token and retries once when GitHub answers 401", async () => {
    gh = fakeGitHub({ putStatus: [401, 201] });
    handle = createHandler({ fetch: gh.fetch, now: () => clock });
    expect((await handle(post(review), env())).status).toBe(202);
    expect(gh.calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("answers CORS preflight for allowed origins only", async () => {
    const preflight = (origin: string) =>
      handle(new Request("https://intake.example/v1/feedback", { method: "OPTIONS", headers: { origin } }), env());
    const ok = await preflight("https://app.example");
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(ok.headers.get("access-control-allow-headers")).toContain("x-app-key");
    const other = await preflight("https://evil.example");
    expect(other.headers.get("access-control-allow-origin")).toBeNull();

    const res = await handle(post(review, { origin: "https://app.example" }), env());
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  it("answers 404 for other paths and 405 for other methods", async () => {
    expect((await handle(new Request("https://intake.example/"), env())).status).toBe(404);
    expect((await handle(new Request("https://intake.example/v1/feedback"), env())).status).toBe(405);
  });
});
