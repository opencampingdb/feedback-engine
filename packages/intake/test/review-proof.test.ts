import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signContributorProof } from "@opencampingdb/feedback";
import { createHandler, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const NOW = Date.parse("2026-11-03T01:00:00Z");
const SECONDS = NOW / 1000;

function fakeKv(): KVLike {
  const data = new Map<string, string>();
  return { get: async (k) => data.get(k) ?? null, put: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k) };
}

async function setup(withKey: boolean) {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = Buffer.from(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))).toString("base64");
  const puts: Record<string, unknown>[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_1", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    }
    if (url.includes("/contents/")) {
      const body = JSON.parse(init!.body as string) as { content: string };
      puts.push(JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as Record<string, unknown>);
      return new Response("{}", { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };
  let tick = 0;
  const handle = createHandler({ fetch, now: () => NOW + tick++, randomBytes: (n) => new Uint8Array(n).fill(tick) });
  const env: Env = {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100, ...(withKey ? { contributor_proof_key: publicKey } : {}) } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "12345",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "678",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: fakeKv(),
  };
  const post = (extra: Record<string, unknown> = {}) =>
    handle(
      new Request("https://intake.example/v1/feedback", {
        method: "POST",
        headers: { "x-app-key": APP_KEY },
        body: JSON.stringify({
          type: "review",
          place: PLACE,
          device: DEVICE,
          contributor: CONTRIBUTOR,
          app_version: "1.0.0",
          consent: true,
          review: { stars: 4, text: "Quiet spot by the river with shade.", visited: "2026-10", visited_nearby: true },
          ...extra,
        }),
      }),
      env,
    );
  const sign = (claims: Record<string, unknown> = {}) =>
    signContributorProof(pair.privateKey, {
      app: "example-app",
      contributor: CONTRIBUTOR,
      action: "review",
      photo: "*",
      issued: SECONDS,
      expires: SECONDS + 600,
      ...claims,
    } as Parameters<typeof signContributorProof>[1]);
  return { post, sign, puts };
}

describe("a contributor proof with a review", () => {
  it("takes a review without a proof, as before, and does not mark it proved", async () => {
    for (const withKey of [false, true]) {
      const t = await setup(withKey);
      expect((await t.post()).status).toBe(202);
      expect(t.puts[0]!.type).toBe("review");
      expect(t.puts[0]!.proved).toBeUndefined();
    }
  });

  it("marks a review proved when its proof checks out, and never stores the proof", async () => {
    const t = await setup(true);
    const proof = await t.sign();
    expect((await t.post({ contributor_proof: proof })).status).toBe(202);
    expect(t.puts[0]!.proved).toBe(true);
    expect(JSON.stringify(t.puts[0])).not.toContain(proof.split(".")[1]!);
    expect(t.puts[0]!.contributor_proof).toBeUndefined();
  });

  it("takes a review whose proof does not check out, unproved", async () => {
    const t = await setup(true);
    for (const claims of [{ contributor: "acct_someone_else_000" }, { action: "review_erasure" }, { issued: SECONDS - 1200, expires: SECONDS - 600 }]) {
      expect((await t.post({ contributor_proof: await t.sign(claims) })).status).toBe(202);
    }
    expect(t.puts.map((p) => p.proved)).toEqual([undefined, undefined, undefined]);
  });

  it("takes a review with a proof on a key without a proof key, unproved", async () => {
    const t = await setup(false);
    expect((await t.post({ contributor_proof: await t.sign() })).status).toBe(202);
    expect(t.puts[0]!.proved).toBeUndefined();
  });
});
