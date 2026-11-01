import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { verifyAttestation } from "../src/appattest.js";
import { createHandler, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";
import { APP_ID, makeDevice, type Device } from "./attest-fixtures.js";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const REVIEW_ID = "rev_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const PACKAGE = "app.camporacle";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function fakeKv(): KVLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const hex = (text: string) => createHash("sha256").update(text).digest("hex");

interface Verdict {
  requestHash?: string;
  timestampMillis?: number;
  packageName?: string;
  appRecognitionVerdict?: string;
  deviceRecognitionVerdict?: string[];
}

function fakeServices(verdicts: Map<string, Verdict>) {
  const writes: Record<string, unknown>[] = [];
  const google: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    }
    if (url.includes("/contents/")) {
      const body = JSON.parse(String(init?.body)) as { content: string };
      writes.push(JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as Record<string, unknown>);
      return new Response("{}", { status: 201 });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      google.push("token");
      return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }), { status: 200 });
    }
    if (url === `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`) {
      google.push("decode");
      const token = (JSON.parse(String(init?.body)) as { integrity_token: string }).integrity_token;
      const v = verdicts.get(token);
      if (!v) return new Response("{}", { status: 400 });
      return new Response(
        JSON.stringify({
          tokenPayloadExternal: {
            requestDetails: { requestPackageName: PACKAGE, requestHash: v.requestHash, timestampMillis: String(v.timestampMillis ?? NOW) },
            appIntegrity: {
              appRecognitionVerdict: v.appRecognitionVerdict ?? "PLAY_RECOGNIZED",
              packageName: v.packageName ?? PACKAGE,
              certificateSha256Digest: ["cert-a"],
            },
            deviceIntegrity: { deviceRecognitionVerdict: v.deviceRecognitionVerdict ?? ["MEETS_DEVICE_INTEGRITY"] },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, writes, google };
}

function env(attestKv: KVLike, appKey: Record<string, unknown>): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "camporacle", daily_limit: 100, ...appKey } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "2",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: fakeKv(),
    ATTEST: attestKv,
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "intake@example.iam.gserviceaccount.com", private_key: privateKey }),
  };
}

const request = (path: string, body: string, headers: Record<string, string> = {}) =>
  new Request(`https://intake.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-key": APP_KEY, ...headers },
    body,
  });

const reviewBody = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "review",
    place: PLACE,
    device: "3b241101-e2bb-4255-8caf-4136c566a962",
    contributor: "acct_3f9a8b7c6d5e4f30",
    app_version: "1.0.0",
    consent: true,
    review: { stars: 5, text: "Flat sites and clean drop toilets", visited: "2026-10", visited_nearby: true },
    ...extra,
  });

const IOS = { requires_attestation: true, ios: { app_id: APP_ID } };

describe("App Attest", () => {
  let device: Device;
  let kv: ReturnType<typeof fakeKv>;
  let services: ReturnType<typeof fakeServices>;
  let handle: ReturnType<typeof createHandler>;

  beforeEach(() => {
    device = makeDevice(NOW);
    kv = fakeKv();
    services = fakeServices(new Map());
    handle = createHandler({ fetch: services.fetch, now: () => NOW, appAttestRoot: device.rootPem });
  });

  async function registered(options: Parameters<Device["attest"]>[1] = {}): Promise<Response> {
    const res = await handle(request("/v1/attest/challenge", ""), env(kv, IOS));
    const { challenge } = (await res.json()) as { challenge: string };
    return handle(
      request("/v1/attest/register", JSON.stringify({ key_id: device.keyId, challenge, attestation: b64(device.attest(challenge, options)) })),
      env(kv, IOS),
    );
  }

  const send = (body: string, counter: number, options: Parameters<Device["assert"]>[2] = {}) =>
    handle(
      request("/v1/feedback", body, {
        "x-attest-platform": "ios",
        "x-attest-key-id": device.keyId,
        "x-attest-assertion": b64(device.assert(body, counter, options)),
      }),
      env(kv, IOS),
    );

  it("registers a key and accepts assertions over the body", async () => {
    expect((await registered({ category: 4 })).status).toBe(201);
    const res = await send(reviewBody(), 1, { category: 4 });
    expect(res.status).toBe(202);
    const stored = services.writes[0]!;
    expect(stored).toMatchObject({ attested: "app_attest", review: { visited_nearby: true } });
    expect(stored.attest_key).toMatch(/^ak_[0-9a-f]{16}$/);
    expect(stored.contributor).toMatch(/^ctr_[0-9a-f]{16}$/);
    expect(JSON.parse(kv.data.get(`aa:${device.keyId}`)!)).toMatchObject({ app: "camporacle", counter: 1 });
  });

  it("refuses a replayed or older assertion", async () => {
    await registered();
    const body = reviewBody();
    expect((await send(body, 1)).status).toBe(202);
    const replay = await send(body, 1);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "attestation_invalid" });
  });

  it("refuses an assertion over another body", async () => {
    await registered();
    const res = await handle(
      request("/v1/feedback", reviewBody(), {
        "x-attest-platform": "ios",
        "x-attest-key-id": device.keyId,
        "x-attest-assertion": b64(device.assert(reviewBody({ app_version: "9.9.9" }), 1)),
      }),
      env(kv, IOS),
    );
    expect(res.status).toBe(401);
  });

  it("asks for attestation when the headers are missing, and refuses an unknown key", async () => {
    const missing = await handle(request("/v1/feedback", reviewBody()), env(kv, IOS));
    expect(await missing.json()).toEqual({ error: "attestation_required" });
    const unknown = await send(reviewBody(), 1);
    expect(await unknown.json()).toEqual({ error: "attestation_invalid" });
  });

  it("uses a challenge once", async () => {
    const res = await handle(request("/v1/attest/challenge", ""), env(kv, IOS));
    const { challenge } = (await res.json()) as { challenge: string };
    const body = JSON.stringify({ key_id: device.keyId, challenge, attestation: b64(device.attest(challenge)) });
    expect((await handle(request("/v1/attest/register", body), env(kv, IOS))).status).toBe(201);
    const again = await handle(request("/v1/attest/register", body), env(kv, IOS));
    expect(again.status).toBe(401);
  });

  it.each([
    ["another app", { appId: "ZZZZZ99999.other.app" }, "another app"],
    ["a used key", { counter: 3 }, "counter"],
    ["the development environment", { aaguid: "appattestdevelop" }, "environment"],
    ["a development build", { category: 3 }, "category"],
  ])("refuses an attestation for %s", async (_, options, reason) => {
    const res = await registered(options);
    expect(res.status).toBe(401);
    expect(JSON.stringify(await res.json())).toContain(reason);
  });

  it("refuses an attestation made for another challenge", async () => {
    await expect(
      verifyAttestation({ attestation: device.attest("other"), keyId: device.keyId, challenge: "mine", config: { app_id: APP_ID }, now: NOW, rootPem: device.rootPem }),
    ).rejects.toThrow("nonce");
  });

  it("refuses a chain that does not lead to the root", async () => {
    const stranger = makeDevice(NOW);
    await expect(
      verifyAttestation({ attestation: device.attest("c"), keyId: device.keyId, challenge: "c", config: { app_id: APP_ID }, now: NOW, rootPem: stranger.rootPem }),
    ).rejects.toThrow("chain");
  });

  it("refuses a key id that is not the certificate's key", async () => {
    const other = makeDevice(NOW);
    await expect(
      verifyAttestation({ attestation: device.attest("c"), keyId: other.keyId, challenge: "c", config: { app_id: APP_ID }, now: NOW, rootPem: device.rootPem }),
    ).rejects.toThrow("key id");
  });

  it("gives an attested install a contributor id when the app sends none", async () => {
    await registered();
    const body = reviewBody({ contributor: undefined });
    expect((await send(body, 1)).status).toBe(202);
    expect(services.writes[0]!.contributor).toMatch(/^ctr_[0-9a-f]{16}$/);
  });
});

describe("Play Integrity", () => {
  const ANDROID = { requires_attestation: true, android: { package: PACKAGE, certificate_sha256: ["cert-a"] } };

  function setup(verdict: (body: string) => Verdict) {
    const verdicts = new Map<string, Verdict>();
    const services = fakeServices(verdicts);
    const handle = createHandler({ fetch: services.fetch, now: () => NOW });
    const send = (body: string, appKey: Record<string, unknown> = ANDROID) => {
      verdicts.set("token-1", verdict(body));
      return handle(request("/v1/feedback", body, { "x-attest-platform": "android", "x-attest-token": "token-1" }), env(fakeKv(), appKey));
    };
    return { send, services };
  }

  it("accepts a token for this body from a recognised app on a sound device", async () => {
    const { send, services } = setup((body) => ({ requestHash: hex(body) }));
    expect((await send(reviewBody())).status).toBe(202);
    expect(services.writes[0]).toMatchObject({ attested: "play_integrity" });
    expect(services.writes[0]!.attest_key).toBeUndefined();
    expect(services.google).toEqual(["token", "decode"]);
  });

  it.each<[string, (body: string) => Verdict]>([
    ["another request", () => ({ requestHash: hex("something else") })],
    ["an old token", (body) => ({ requestHash: hex(body), timestampMillis: NOW - 10 * 60_000 })],
    ["an unrecognised app", (body) => ({ requestHash: hex(body), appRecognitionVerdict: "UNRECOGNIZED_VERSION" })],
    ["a device without integrity", (body) => ({ requestHash: hex(body), deviceRecognitionVerdict: [] })],
  ])("refuses %s", async (_, verdict) => {
    const { send } = setup(verdict);
    const res = await send(reviewBody());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "attestation_invalid" });
  });

  it("refuses an app signed with another certificate", async () => {
    const { send } = setup((body) => ({ requestHash: hex(body) }));
    const res = await send(reviewBody(), { requires_attestation: true, android: { package: PACKAGE, certificate_sha256: ["cert-b"] } });
    expect(res.status).toBe(401);
  });
});

describe("contributors and review reports", () => {
  function setup(appKey: Record<string, unknown> = {}) {
    const services = fakeServices(new Map());
    const handle = createHandler({ fetch: services.fetch, now: () => NOW });
    const e = env(fakeKv(), appKey);
    return { send: (body: string) => handle(request("/v1/feedback", body), e), services };
  }

  it("needs a contributor on a review and a review report", async () => {
    const { send } = setup();
    const res = await send(reviewBody({ contributor: undefined }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "contributor_required" });
  });

  it("needs visited_nearby when the app key asks for it", async () => {
    const { send } = setup({ requires_visited_nearby: true });
    const res = await send(reviewBody({ review: { stars: 3, text: "", visited: "2026-10" } }));
    expect(await res.json()).toEqual({ error: "visited_nearby_required" });
  });

  it("limits each contributor per day, across devices", async () => {
    const { send } = setup({ contributor_daily_limit: 2 });
    const from = (i: number) => reviewBody({ device: `${String(i).padStart(8, "0")}-e2bb-4255-8caf-4136c566a962` });
    expect((await send(from(1))).status).toBe(202);
    expect((await send(from(2))).status).toBe(202);
    expect((await send(from(3))).status).toBe(429);
  });

  it("stores a review report with the hashed contributor", async () => {
    const { send, services } = setup();
    const body = JSON.stringify({
      type: "review_report",
      place: PLACE,
      device: "3b241101-e2bb-4255-8caf-4136c566a962",
      contributor: "acct_3f9a8b7c6d5e4f30",
      app_version: "1.0.0",
      consent: true,
      review_report: { review: REVIEW_ID, reason: "spam_ad" },
    });
    expect((await send(body)).status).toBe(202);
    expect(services.writes[0]).toMatchObject({ type: "review_report", review_report: { review: REVIEW_ID, reason: "spam_ad" } });
    expect(services.writes[0]!.contributor).toMatch(/^ctr_[0-9a-f]{16}$/);
  });

  it("gives the same account different ids in different apps", async () => {
    const { hashContributor } = await import("../src/index.js");
    expect(await hashContributor("pepper", "camporacle", "acct_3f9a8b7c6d5e4f30")).not.toBe(
      await hashContributor("pepper", "otherapp", "acct_3f9a8b7c6d5e4f30"),
    );
  });
});
