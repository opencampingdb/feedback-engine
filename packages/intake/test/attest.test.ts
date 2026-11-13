import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyAttestation } from "../src/appattest.js";
import { ATTEST_ORIGIN_DAILY_LIMIT, createHandler, type Env } from "../src/index.js";
import { verifyPass } from "../src/pass.js";
import type { KVLike } from "../src/ratelimit.js";
import { APP_ID, makeDevice, type Device } from "./attest-fixtures.js";

const NOW = Date.parse("2026-11-02T09:00:00Z");
const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const REVIEW_ID = "rev_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const PACKAGE = "com.example.app";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

type KvOperation = "get" | "put" | "delete";

/** An in-memory KV. Set `failing` to an operation to make it throw, as a storage error would. */
function fakeKv(): KVLike & { data: Map<string, string>; failing: KvOperation | undefined } {
  const data = new Map<string, string>();
  const kv = {
    data,
    failing: undefined as KvOperation | undefined,
    get: async (k: string) => {
      if (kv.failing === "get") throw new Error("KV get failed");
      return data.get(k) ?? null;
    },
    put: async (k: string, v: string) => {
      if (kv.failing === "put") throw new Error("KV put failed");
      data.set(k, v);
    },
    delete: async (k: string) => {
      if (kv.failing === "delete") throw new Error("KV delete failed");
      data.delete(k);
    },
  };
  return kv;
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
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100, ...appKey } }),
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
    expect(JSON.parse(kv.data.get(`aa:${device.keyId}`)!)).toMatchObject({ app: "example-app", counter: 1 });
  });

  it("gives an attested install a photo pass the photo server accepts", async () => {
    expect((await registered()).status).toBe(201);
    const body = JSON.stringify({ type: "photo_pass", device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", time: new Date(NOW).toISOString() });
    const res = await handle(
      request("/v1/photos/pass", body, {
        "x-attest-platform": "ios",
        "x-attest-key-id": device.keyId,
        "x-attest-assertion": b64(device.assert(body, 1)),
      }),
      { ...env(kv, IOS), PHOTO_PASS_SECRET: "pass-secret", PHOTOS_PENDING: { put: async () => undefined, delete: async () => undefined } },
    );
    expect(res.status).toBe(200);
    const { pass, expires } = (await res.json()) as { pass: string; expires: string };
    expect(expires).toBe("2026-11-02T10:00:00Z");
    expect(await verifyPass("pass-secret", pass, NOW)).toEqual({ app: "example-app", expires: NOW / 1000 + 3600, install: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });

  it("asks for attestation when the headers are missing, with no reason", async () => {
    const missing = await handle(request("/v1/feedback", reviewBody()), env(kv, IOS));
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: "attestation_required" });
  });

  it("uses a challenge once", async () => {
    const res = await handle(request("/v1/attest/challenge", ""), env(kv, IOS));
    const { challenge } = (await res.json()) as { challenge: string };
    const body = JSON.stringify({ key_id: device.keyId, challenge, attestation: b64(device.attest(challenge)) });
    expect((await handle(request("/v1/attest/register", body), env(kv, IOS))).status).toBe(201);
    const again = await handle(request("/v1/attest/register", body), env(kv, IOS));
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ error: "attestation_invalid", reason: "malformed", details: ["unknown or used challenge"] });
  });

  it(`limits challenges to ${ATTEST_ORIGIN_DAILY_LIMIT} a day for each client network, before one is stored`, async () => {
    const e = env(kv, IOS);
    const ask = (ip: string) => handle(request("/v1/attest/challenge", "", { "cf-connecting-ip": ip }), e);
    for (let i = 0; i < ATTEST_ORIGIN_DAILY_LIMIT; i++) expect((await ask("203.0.113.7")).status).toBe(200);
    const stored = kv.data.size;
    const over = await ask("203.0.113.9");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(kv.data.size).toBe(stored);
    expect((await ask("198.51.100.1")).status).toBe(200);
  });

  it("answers 503 unavailable when a challenge cannot be stored", async () => {
    kv.failing = "put";
    const res = await handle(request("/v1/attest/challenge", ""), env(kv, IOS));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
  });

  it("limits key registrations to 500 a day for each client network", async () => {
    const e = env(kv, IOS);
    const register = (ip: string) =>
      handle(
        request("/v1/attest/register", JSON.stringify({ key_id: device.keyId, challenge: "unused", attestation: b64(new Uint8Array([1])) }), { "cf-connecting-ip": ip }),
        e,
      );
    for (let i = 0; i < 500; i++) expect((await register("203.0.113.7")).status).toBe(401);
    const over = await register("203.0.113.9");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect((await register("198.51.100.1")).status).toBe(401);
  });

  it("reads a launch validation category sent as little-endian bytes, as iOS 27 does", async () => {
    expect((await registered({ category: new Uint8Array([2, 0, 0, 0]) })).status).toBe(201);
    const res = await send(reviewBody(), 1, { category: new Uint8Array([2, 0, 0, 0]) });
    expect(res.status).toBe(202);
  });

  it.each([
    ["the attested data flag and the extensions flag", 0xc1],
    ["the attested data flag without the extensions flag", 0x41],
  ])("accepts an assertion whose flags carry %s, as iOS 27 sends", async (_, flagsByte) => {
    expect((await registered({ category: new Uint8Array([2, 0, 0, 0]) })).status).toBe(201);
    const res = await send(reviewBody(), 1, { category: new Uint8Array([2, 0, 0, 0]), flags: flagsByte });
    expect(res.status).toBe(202);
  });

  it("says how long the authenticator data was and its flags when an assertion's data cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await registered()).status).toBe(201);
    const res = await send(reviewBody(), 1, { category: new Uint8Array([2, 0, 0, 0]), flags: 0x80, trailing: new Uint8Array([0xff]) });
    warn.mockRestore();
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason: string; details: string[] };
    expect(body.reason).toBe("malformed");
    expect(body.details.join(" ")).toMatch(/\d+ bytes, flags 0x80/);
  });

  it.each([
    ["a development build sent as bytes", { category: new Uint8Array([3, 0, 0, 0]) }, "category 3,0,0,0", "category_not_accepted"],
    ["another app", { appId: "ZZZZZ99999.other.app" }, "another app", "wrong_app"],
    ["a used key", { counter: 3 }, "counter", "counter_not_increased"],
    ["the development environment", { aaguid: "appattestdevelop" }, "environment", "category_not_accepted"],
    ["a development build", { category: 3 }, "category", "category_not_accepted"],
  ])("refuses a key registration for %s", async (_, options, details, reason) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await registered(options);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string; details: string[] };
    expect(body).toMatchObject({ error: "attestation_invalid", reason });
    expect(body.details.join(" ")).toContain(details);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.map(String).join(" ");
    expect(line).toContain(reason);
    expect(line).toContain("/v1/attest/register");
    expect(line).not.toContain(device.keyId);
    warn.mockRestore();
  });

  it("refuses a key registration that is not CBOR as malformed", async () => {
    const res = await handle(request("/v1/attest/challenge", ""), env(kv, IOS));
    const { challenge } = (await res.json()) as { challenge: string };
    const refused = await handle(
      request("/v1/attest/register", JSON.stringify({ key_id: device.keyId, challenge, attestation: b64(new Uint8Array([0xff, 1, 2])) })),
      env(kv, IOS),
    );
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ error: "attestation_invalid", reason: "malformed", details: [expect.any(String)] });
  });

  it("answers 503 unavailable when the key cannot be stored, and the install can register afterwards", async () => {
    const res = await handle(request("/v1/attest/challenge", ""), env(kv, IOS));
    const { challenge } = (await res.json()) as { challenge: string };
    kv.failing = "put";
    const failed = await handle(
      request("/v1/attest/register", JSON.stringify({ key_id: device.keyId, challenge, attestation: b64(device.attest(challenge)) })),
      env(kv, IOS),
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "unavailable" });
    kv.failing = undefined;
    expect((await registered()).status).toBe(201);
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

  describe("refusals", () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    /** The one log line for the refusal, checked for anything that identifies the install. */
    function logged(): string {
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0]!.map(String).join(" ");
      expect(line).not.toContain(device.keyId);
      expect(line).not.toContain("3b241101-e2bb-4255-8caf-4136c566a962");
      return line;
    }

    async function refused(res: Response, reason: string): Promise<void> {
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string; reason: string; details: string[] };
      expect(body).toMatchObject({ error: "attestation_invalid", reason });
      expect(body.details.length).toBeGreaterThan(0);
      const line = logged();
      expect(line).toContain(reason);
      expect(line).toContain("example-app");
      expect(line).toContain("/v1/feedback");
    }

    it("names an unknown key", async () => {
      await refused(await send(reviewBody(), 1), "unknown_key");
    });

    it("names a key stored for another app key", async () => {
      await registered();
      const record = JSON.parse(kv.data.get(`aa:${device.keyId}`)!) as Record<string, unknown>;
      kv.data.set(`aa:${device.keyId}`, JSON.stringify({ ...record, app: "other-app" }));
      await refused(await send(reviewBody(), 1), "wrong_app");
    });

    it("names a key registered under another environment or app id", async () => {
      await registered();
      const record = JSON.parse(kv.data.get(`aa:${device.keyId}`)!) as Record<string, unknown>;
      expect(record).toMatchObject({ environment: "production", app_id: APP_ID });
      kv.data.set(`aa:${device.keyId}`, JSON.stringify({ ...record, environment: "development" }));
      await refused(await send(reviewBody(), 1), "wrong_app");
    });

    it("names an assertion signed over another body", async () => {
      await registered();
      const res = await handle(
        request("/v1/feedback", reviewBody(), {
          "x-attest-platform": "ios",
          "x-attest-key-id": device.keyId,
          "x-attest-assertion": b64(device.assert(reviewBody({ app_version: "9.9.9" }), 1)),
        }),
        env(kv, IOS),
      );
      await refused(res, "bad_signature");
    });

    it("names a replayed assertion, and keeps the counter strict", async () => {
      await registered();
      const body = reviewBody();
      expect((await send(body, 2)).status).toBe(202);
      await refused(await send(body, 2), "counter_not_increased");
      warn.mockClear();
      await refused(await send(body, 1), "counter_not_increased");
    });

    it("names a launch category not accepted in this environment", async () => {
      await registered();
      await refused(await send(reviewBody(), 1, { category: 3 }), "category_not_accepted");
    });

    it("names an assertion that is not CBOR", async () => {
      await registered();
      const res = await handle(
        request("/v1/feedback", reviewBody(), {
          "x-attest-platform": "ios",
          "x-attest-key-id": device.keyId,
          "x-attest-assertion": b64(new Uint8Array([0xff, 0x00, 0x13])),
        }),
        env(kv, IOS),
      );
      await refused(res, "malformed");
    });
  });

  it("answers 503 unavailable when the counter cannot be stored, and the key still works afterwards", async () => {
    await registered();
    kv.failing = "put";
    const failed = await send(reviewBody(), 1);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "unavailable" });
    kv.failing = undefined;
    expect((await send(reviewBody(), 1)).status).toBe(202);
  });

  it("answers 503 unavailable when the key cannot be read, and the key still works afterwards", async () => {
    await registered();
    kv.failing = "get";
    const failed = await send(reviewBody(), 1);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("retry-after")).toBe("60");
    expect(await failed.json()).toEqual({ error: "unavailable" });
    kv.failing = undefined;
    expect((await send(reviewBody(), 1)).status).toBe(202);
  });

  it("answers 503 unavailable when a key registration cannot read the key store, and the install can register afterwards", async () => {
    const res = await handle(request("/v1/attest/challenge", ""), env(kv, IOS));
    const { challenge } = (await res.json()) as { challenge: string };
    kv.failing = "get";
    const failed = await handle(
      request("/v1/attest/register", JSON.stringify({ key_id: device.keyId, challenge, attestation: b64(device.attest(challenge)) })),
      env(kv, IOS),
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "unavailable" });
    kv.failing = undefined;
    expect((await registered()).status).toBe(201);
  });

  it("answers 503 unavailable when a used challenge cannot be deleted, and the install can register afterwards", async () => {
    const res = await handle(request("/v1/attest/challenge", ""), env(kv, IOS));
    const { challenge } = (await res.json()) as { challenge: string };
    kv.failing = "delete";
    const failed = await handle(
      request("/v1/attest/register", JSON.stringify({ key_id: device.keyId, challenge, attestation: b64(device.attest(challenge)) })),
      env(kv, IOS),
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: "unavailable" });
    kv.failing = undefined;
    expect((await registered()).status).toBe(201);
  });

  it("answers a key record that names no environment as an unknown key, and leaves it as it is, so the install registers again", async () => {
    await registered();
    const { app, public_key, counter } = JSON.parse(kv.data.get(`aa:${device.keyId}`)!) as Record<string, unknown>;
    const legacy = JSON.stringify({ app, public_key, counter });
    kv.data.set(`aa:${device.keyId}`, legacy);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await send(reviewBody(), 1);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "attestation_invalid", reason: "unknown_key" });
    } finally {
      warn.mockRestore();
    }
    expect(kv.data.get(`aa:${device.keyId}`)).toBe(legacy);
    expect(services.writes).toEqual([]);
  });

  it("registers a key under any spelling of its 32 bytes, names the record by the standard padded form, and takes assertions under either spelling", async () => {
    const bare = device.keyId.replace(/=+$/, "");
    const urlSafe = bare.replace(/\+/g, "-").replace(/\//g, "_");
    const { challenge } = (await (await handle(request("/v1/attest/challenge", ""), env(kv, IOS))).json()) as { challenge: string };
    const res = await handle(request("/v1/attest/register", JSON.stringify({ key_id: urlSafe, challenge, attestation: b64(device.attest(challenge)) })), env(kv, IOS));
    expect(res.status).toBe(201);
    expect([...kv.data.keys()].filter((k) => k.startsWith("aa:"))).toEqual([`aa:${device.keyId}`]);
    const sendAs = (keyId: string, body: string, counter: number) =>
      handle(request("/v1/feedback", body, { "x-attest-platform": "ios", "x-attest-key-id": keyId, "x-attest-assertion": b64(device.assert(body, counter)) }), env(kv, IOS));
    expect((await sendAs(bare, reviewBody(), 1)).status).toBe(202);
    expect((await sendAs(device.keyId, reviewBody({ review: { stars: 4, text: "Shady sites by the river", visited: "2026-10", visited_nearby: true } }), 2)).status).toBe(202);
    expect(JSON.parse(kv.data.get(`aa:${device.keyId}`)!)).toMatchObject({ counter: 2 });
    // One key, one attested-key hash, whatever the spelling.
    expect(services.writes.map((w) => w.attest_key)).toEqual([services.writes[0]!.attest_key, services.writes[0]!.attest_key]);
  });

  it("refuses a key id that does not decode to 32 bytes", async () => {
    for (const keyId of [`${"A".repeat(40)}`, `${"A".repeat(46)}==`, ` ${device.keyId}`]) {
      const { challenge } = (await (await handle(request("/v1/attest/challenge", ""), env(kv, IOS))).json()) as { challenge: string };
      const res = await handle(request("/v1/attest/register", JSON.stringify({ key_id: keyId, challenge, attestation: b64(device.attest(challenge)) })), env(kv, IOS));
      expect(res.status).toBe(400);
    }
    expect([...kv.data.keys()].filter((k) => k.startsWith("aa:"))).toEqual([]);
  });

  it("keeps one record for one key when registrations under several spellings arrive together", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { challenge } = (await (await handle(request("/v1/attest/challenge", ""), env(kv, IOS))).json()) as { challenge: string };
      const attestation = b64(device.attest(challenge));
      const bare = device.keyId.replace(/=+$/, "");
      await Promise.all(
        [device.keyId, bare, `${bare}==`].map((keyId) => handle(request("/v1/attest/register", JSON.stringify({ key_id: keyId, challenge, attestation })), env(kv, IOS))),
      );
      expect([...kv.data.keys()].filter((k) => k.startsWith("aa:"))).toEqual([`aa:${device.keyId}`]);
      // An assertion is taken once, under any spelling of the key id: the spellings share one counter.
      const body = reviewBody();
      const assertion = b64(device.assert(body, 1));
      const sendAs = (keyId: string) =>
        handle(request("/v1/feedback", body, { "x-attest-platform": "ios", "x-attest-key-id": keyId, "x-attest-assertion": assertion }), env(kv, IOS));
      expect((await sendAs(device.keyId)).status).toBe(202);
      const again = await sendAs(bare);
      expect(again.status).toBe(401);
      expect(await again.json()).toMatchObject({ reason: "counter_not_increased" });
      expect(services.writes).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses an assertion whose stored key record cannot be read as an unknown key", async () => {
    await registered();
    kv.data.set(`aa:${device.keyId}`, "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await send(reviewBody(), 1);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ error: "attestation_invalid", reason: "unknown_key", details: [expect.any(String)] });
    } finally {
      warn.mockRestore();
    }
  });

  it("lets a fault inside the intake through rather than answering a reason that drops the key, and the key still works afterwards", async () => {
    await registered();
    const verify = vi.spyOn(crypto.subtle, "verify").mockRejectedValueOnce(new TypeError("a programming fault"));
    try {
      await expect(send(reviewBody(), 1)).rejects.toThrow(TypeError);
    } finally {
      verify.mockRestore();
    }
    expect((await send(reviewBody(), 1)).status).toBe(202);
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
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

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

  it(`asks Google about at most ${ATTEST_ORIGIN_DAILY_LIMIT} unreadable tokens a day from one client network`, async () => {
    const services = fakeServices(new Map());
    const handle = createHandler({ fetch: services.fetch, now: () => NOW });
    const e = env(fakeKv(), ANDROID);
    const send = (ip: string, token: string) =>
      handle(request("/v1/feedback", reviewBody(), { "x-attest-platform": "android", "x-attest-token": token, "cf-connecting-ip": ip }), e);
    for (let i = 0; i < ATTEST_ORIGIN_DAILY_LIMIT; i++) expect((await send("203.0.113.7", `unreadable-${i}`)).status).toBe(401);
    const decodes = () => services.google.filter((call) => call === "decode").length;
    expect(decodes()).toBe(ATTEST_ORIGIN_DAILY_LIMIT);
    const over = await send("203.0.113.9", "unreadable-over");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(decodes()).toBe(ATTEST_ORIGIN_DAILY_LIMIT);
    // Another network is still asked about.
    expect((await send("198.51.100.1", "unreadable-other")).status).toBe(401);
    expect(decodes()).toBe(ATTEST_ORIGIN_DAILY_LIMIT + 1);
  });

  it("does not count a token Google accepts against the network's failed tokens", async () => {
    const verdicts = new Map<string, Verdict>();
    const services = fakeServices(verdicts);
    const handle = createHandler({ fetch: services.fetch, now: () => NOW });
    const e = env(fakeKv(), { ...ANDROID, daily_limit: 100_000 });
    for (let i = 0; i < ATTEST_ORIGIN_DAILY_LIMIT + 5; i++) {
      const body = reviewBody({ device: `${String(i).padStart(8, "0")}-e2bb-4255-8caf-4136c566a962`, contributor: `acct_${String(i).padStart(16, "0")}` });
      verdicts.set(`good-${i}`, { requestHash: hex(body) });
      const res = await handle(request("/v1/feedback", body, { "x-attest-platform": "android", "x-attest-token": `good-${i}`, "cf-connecting-ip": `203.0.${i % 2}.7` }), e);
      expect(res.status).toBe(202);
    }
  });

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
  ])("refuses %s as integrity_not_met", async (_, verdict) => {
    const { send } = setup(verdict);
    const res = await send(reviewBody());
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "attestation_invalid", reason: "integrity_not_met", details: [expect.any(String)] });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]!.map(String).join(" ");
    expect(line).toContain("integrity_not_met");
    expect(line).not.toContain("token-1");
    expect(line).not.toContain("3b241101-e2bb-4255-8caf-4136c566a962");
  });

  it("refuses an app signed with another certificate", async () => {
    const { send } = setup((body) => ({ requestHash: hex(body) }));
    const res = await send(reviewBody(), { requires_attestation: true, android: { package: PACKAGE, certificate_sha256: ["cert-b"] } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: "integrity_not_met" });
  });

  it("refuses a token Google cannot read as malformed", async () => {
    const verdicts = new Map<string, Verdict>();
    const handle = createHandler({ fetch: fakeServices(verdicts).fetch, now: () => NOW });
    const res = await handle(request("/v1/feedback", reviewBody(), { "x-attest-platform": "android", "x-attest-token": "garbled" }), env(fakeKv(), ANDROID));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "attestation_invalid", reason: "malformed", details: [expect.any(String)] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("answers 503 unavailable when Google fails, which is not a refusal", async () => {
    const { fetch } = fakeServices(new Map());
    const down = async (url: string, init?: RequestInit) =>
      url.includes("playintegrity.googleapis.com") ? new Response("busy", { status: 503 }) : fetch(url, init);
    const handle = createHandler({ fetch: down, now: () => NOW });
    const res = await handle(request("/v1/feedback", reviewBody(), { "x-attest-platform": "android", "x-attest-token": "token-1" }), env(fakeKv(), ANDROID));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(warn).not.toHaveBeenCalled();
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
    expect(await hashContributor("pepper", "example-app", "acct_3f9a8b7c6d5e4f30")).not.toBe(
      await hashContributor("pepper", "otherapp", "acct_3f9a8b7c6d5e4f30"),
    );
  });
});
