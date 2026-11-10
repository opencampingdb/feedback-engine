import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signContributorProof } from "@opencampingdb/feedback";
import { createHandler, hashContributor, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_KEY = "test-app-key-0123456789";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const NOW = Date.parse("2026-11-03T01:00:00Z");
const SECONDS = NOW / 1000;

function fakeKv(): KVLike {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
}

function fakeGitHub() {
  const puts: { url: string; content: Record<string, unknown> }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_1", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    }
    if (url.includes("/contents/")) {
      const body = JSON.parse(init!.body as string) as { content: string };
      puts.push({ url, content: JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as Record<string, unknown> });
      return new Response("{}", { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, puts };
}

function env(appEntry: Record<string, unknown> = {}): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100, ...appEntry } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "12345",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "678",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: fakeKv(),
  };
}

const erasure = (extra: Record<string, unknown> = {}) => ({
  device: DEVICE,
  contributor: CONTRIBUTOR,
  app_version: "1",
  consent: true,
  type: "review_erasure",
  place: null,
  ...extra,
});

async function setup(appEntry: Record<string, unknown> = {}) {
  const gh = fakeGitHub();
  const handle = createHandler({ fetch: gh.fetch, now: () => NOW, randomBytes: (n) => new Uint8Array(n) });
  const e = env(appEntry);
  const post = (body: unknown) =>
    handle(new Request("https://intake.example/v1/feedback", { method: "POST", headers: { "x-app-key": APP_KEY }, body: JSON.stringify(body) }), e);
  return { gh, post };
}

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))).toString("base64");
  const sign = (claims: Record<string, unknown> = {}) =>
    signContributorProof(pair.privateKey, {
      app: "example-app",
      contributor: CONTRIBUTOR,
      action: "review_erasure",
      photo: "*",
      issued: SECONDS,
      expires: SECONDS + 600,
      ...claims,
    } as Parameters<typeof signContributorProof>[1]);
  return { publicKey, sign };
}

describe("review erasure at the feedback intake", () => {
  it("stores an erasure with the hashed contributor, on an intake with no photo bucket", async () => {
    const t = await setup();
    const res = await t.post(erasure());
    expect(res.status).toBe(202);
    expect(t.gh.puts).toHaveLength(1);
    expect(t.gh.puts[0]!.content).toMatchObject({
      type: "review_erasure",
      place: null,
      app: "example-app",
      contributor: await hashContributor("pepper", "example-app", CONTRIBUTOR),
    });
  });

  it("refuses an erasure without a contributor", async () => {
    const t = await setup();
    const res = await t.post(erasure({ contributor: undefined }));
    expect(res.status).toBe(400);
    expect(t.gh.puts).toHaveLength(0);
  });

  it("refuses an erasure that names a place", async () => {
    const t = await setup();
    const res = await t.post(erasure({ place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA" }));
    expect(res.status).toBe(400);
  });

  it("with a proof key, refuses an erasure without a proof, or with a proof for another action or contributor", async () => {
    const k = await keyPair();
    const t = await setup({ contributor_proof_key: k.publicKey });
    const missing = await t.post(erasure());
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "proof_required" });
    for (const claims of [{ action: "photo_erasure" }, { contributor: "acct_someone_else_000" }, { photo: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB" }, { issued: SECONDS - 1200, expires: SECONDS - 600 }]) {
      const res = await t.post(erasure({ contributor_proof: await k.sign(claims) }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "proof_invalid" });
    }
    expect(t.gh.puts).toHaveLength(0);
  });

  it("with a proof key, accepts a valid proof and never stores it", async () => {
    const k = await keyPair();
    const t = await setup({ contributor_proof_key: k.publicKey });
    const proof = await k.sign();
    expect((await t.post(erasure({ contributor_proof: proof }))).status).toBe(202);
    expect(t.gh.puts).toHaveLength(1);
    expect(t.gh.puts[0]!.content.contributor_proof).toBeUndefined();
    expect(JSON.stringify(t.gh.puts[0]!.content)).not.toContain(proof.split(".")[1]!);
  });
});
