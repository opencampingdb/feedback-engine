import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, parseAppKeys, type Env } from "../src/index.js";
import { SITEVERIFY_URL, verifyHumanCheck, type HumanCheckConfig } from "../src/humancheck.js";
import type { KVLike } from "../src/ratelimit.js";

const NOW = Date.parse("2026-11-17T09:00:00Z");
const APP_KEY = "test-web-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const SECRET = "0x4AAAAAAAtest-secret";
const HOST = "places.example.org";
const CHECK: HumanCheckConfig = { secret: SECRET, hostnames: [HOST] };

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const hex = (text: string) => createHash("sha256").update(text).digest("hex");

function memoryKv(): KVLike {
  const data = new Map<string, string>();
  return {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
}

/** What Turnstile says about each token, and the requests it was sent. */
interface Turnstile {
  answers: Map<string, Record<string, unknown>>;
  asked: Record<string, unknown>[];
  status: number;
}

function fakeServices(turnstile: Turnstile) {
  const writes: Record<string, unknown>[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url === SITEVERIFY_URL) {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      turnstile.asked.push(sent);
      if (turnstile.status !== 200) return new Response("oops", { status: turnstile.status });
      const answer = turnstile.answers.get(String(sent.response)) ?? { success: false, "error-codes": ["invalid-input-response"] };
      return new Response(JSON.stringify(answer), { status: 200 });
    }
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    }
    if (url.includes("/contents/")) {
      const body = JSON.parse(String(init?.body)) as { content: string };
      writes.push(JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as Record<string, unknown>);
      return new Response("{}", { status: 201 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, writes };
}

function env(appKey: Record<string, unknown>): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-web", daily_limit: 100, ...appKey } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "2",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: memoryKv(),
  };
}

const WEB = { requires_human_check: true, human_check: CHECK };

const reportBody = (report: Record<string, unknown> = { kind: "fact", fact: "toilets", value: true }) =>
  JSON.stringify({
    type: "report",
    place: PLACE,
    device: "3b241101-e2bb-4255-8caf-4136c566a962",
    app_version: "1.0.0",
    consent: true,
    report,
  });

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://intake.example/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-key": APP_KEY, "cf-connecting-ip": "203.0.113.7", ...headers },
    body,
  });

/** Turnstile's answer for a good token made for `body`. */
const good = (body: string, extra: Record<string, unknown> = {}) => ({
  success: true,
  challenge_ts: "2026-11-17T08:59:30Z",
  hostname: HOST,
  "error-codes": [],
  cdata: hex(body),
  ...extra,
});

describe("human check", () => {
  let turnstile: Turnstile;
  let services: ReturnType<typeof fakeServices>;
  let handle: ReturnType<typeof createHandler>;

  beforeEach(() => {
    turnstile = { answers: new Map(), asked: [], status: 200 };
    services = fakeServices(turnstile);
    handle = createHandler({ fetch: services.fetch, now: () => NOW });
  });

  it("takes a report whose token was made for its body, and marks it human checked, not attested", async () => {
    const body = reportBody();
    turnstile.answers.set("tok-1", good(body));
    const res = await handle(post(body, { "x-human-check": "tok-1" }), env(WEB));
    expect(res.status).toBe(202);
    expect(turnstile.asked).toEqual([{ secret: SECRET, response: "tok-1", remoteip: "203.0.113.7" }]);
    const stored = services.writes[0]!;
    expect(stored.human_checked).toBe(true);
    expect(stored.attested).toBeUndefined();
    expect(stored.attest_key).toBeUndefined();
  });

  it("refuses a report without a token, and never asks Turnstile", async () => {
    const res = await handle(post(reportBody()), env(WEB));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "human_check_required" });
    expect(turnstile.asked).toEqual([]);
    expect(services.writes).toEqual([]);
  });

  it("refuses a token made for another body", async () => {
    const body = reportBody();
    turnstile.answers.set("tok-1", good(reportBody({ kind: "closed" })));
    const res = await handle(post(body, { "x-human-check": "tok-1" }), env(WEB));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "human_check_failed", details: ["token was made for another body"] });
    expect(services.writes).toEqual([]);
  });

  it("refuses a token Turnstile does not accept, with its error codes", async () => {
    turnstile.answers.set("tok-1", { success: false, "error-codes": ["timeout-or-duplicate"] });
    const res = await handle(post(reportBody(), { "x-human-check": "tok-1" }), env(WEB));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "human_check_failed", details: ["timeout-or-duplicate"] });
  });

  it("refuses a token served from a site the key does not name", async () => {
    const body = reportBody();
    turnstile.answers.set("tok-1", good(body, { hostname: "elsewhere.example.net" }));
    const res = await handle(post(body, { "x-human-check": "tok-1" }), env(WEB));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("human_check_failed");
  });

  it("checks the action when the key names one", async () => {
    const body = reportBody();
    turnstile.answers.set("tok-1", good(body, { action: "signup" }));
    turnstile.answers.set("tok-2", good(body, { action: "feedback" }));
    const keyed = env({ ...WEB, human_check: { ...CHECK, action: "feedback" } });
    expect((await handle(post(body, { "x-human-check": "tok-1" }), keyed)).status).toBe(401);
    expect((await handle(post(body, { "x-human-check": "tok-2" }), keyed)).status).toBe(202);
  });

  it("answers 503 when Turnstile cannot be reached or reports its own fault, so the client tries again", async () => {
    turnstile.status = 500;
    const res = await handle(post(reportBody(), { "x-human-check": "tok-1" }), env(WEB));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    turnstile.status = 200;
    turnstile.answers.set("tok-2", { success: false, "error-codes": ["internal-error"] });
    expect((await handle(post(reportBody(), { "x-human-check": "tok-2" }), env(WEB))).status).toBe(503);
  });

  it("refuses what a human-check key may never send, before the human check", async () => {
    const refused = [
      { kind: "reopened" },
      { kind: "fact", fact: "phone", value: "0412345678" },
      { kind: "fact", fact: "website", value: "https://example.org" },
      { kind: "fact", fact: "operator", value: "Example Shire" },
      { kind: "fact", fact: "opening_hours", value: "Mo-Fr 08:00-17:00" },
    ];
    for (const report of refused) {
      const res = await handle(post(reportBody(report), { "x-human-check": "tok-1" }), env(WEB));
      expect(res.status, JSON.stringify(report)).toBe(403);
      expect(await res.json()).toEqual({ error: "type_not_allowed_for_app_key" });
    }
    const review = JSON.stringify({
      type: "review",
      place: PLACE,
      device: "3b241101-e2bb-4255-8caf-4136c566a962",
      contributor: "acct_3f9a8b7c6d5e4f30",
      app_version: "1.0.0",
      consent: true,
      review: { stars: 5, text: "Flat sites", visited: "2026-10" },
    });
    expect((await handle(post(review, { "x-human-check": "tok-1" }), env(WEB))).status).toBe(403);
    expect(turnstile.asked).toEqual([]);
  });

  it("takes each of the allowed report kinds", async () => {
    const reports = [
      { kind: "fact", fact: "toilets", value: true },
      { kind: "fact", fact: "max_stay", value: "3d" },
      { kind: "doubt", fact: "pets" },
      { kind: "contact", fact: "phone", reason: "wrong" },
      { kind: "contact", fact: "address", reason: "wrong" },
      { kind: "closed" },
      { kind: "name", value: "Riverside Camp" },
      { kind: "kind", place_kind: "free_camp" },
      { kind: "wrong_location", location: { lat: -27.47, lon: 153.02 } },
    ];
    for (const [i, report] of reports.entries()) {
      const body = reportBody(report);
      turnstile.answers.set(`tok-${i}`, good(body));
      const res = await handle(post(body, { "x-human-check": `tok-${i}` }), env(WEB));
      expect(res.status, JSON.stringify(report)).toBe(202);
    }
  });

  it("lets report_kinds narrow the set, and free_text_facts open the facts with free words", async () => {
    const closed = reportBody({ kind: "closed" });
    turnstile.answers.set("tok-c", good(closed));
    expect((await handle(post(closed, { "x-human-check": "tok-c" }), env({ ...WEB, report_kinds: ["fact"] }))).status).toBe(403);
    const hours = reportBody({ kind: "fact", fact: "opening_hours", value: "Mo-Fr 08:00-17:00" });
    turnstile.answers.set("tok-h", good(hours));
    expect((await handle(post(hours, { "x-human-check": "tok-h" }), env({ ...WEB, human_check: { ...CHECK, free_text_facts: true } }))).status).toBe(202);
    const phone = reportBody({ kind: "fact", fact: "phone", value: "0412345678" });
    expect((await handle(post(phone, { "x-human-check": "tok-p" }), env({ ...WEB, human_check: { ...CHECK, free_text_facts: true } }))).status).toBe(403);
  });

  it("lets the browser send the human check header", async () => {
    const res = await handle(
      new Request("https://intake.example/v1/feedback", { method: "OPTIONS", headers: { origin: "https://places.example.org" } }),
      { ...env(WEB), ALLOWED_ORIGINS: "https://places.example.org" },
    );
    expect(res.headers.get("access-control-allow-headers")).toContain("x-human-check");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://places.example.org");
  });
});

describe("app keys with a human check", () => {
  const parse = (entry: Record<string, unknown>) => parseAppKeys(JSON.stringify({ [APP_KEY]: { app: "example-web", daily_limit: 10, ...entry } })).get(APP_KEY);

  it("keeps a key with its widget and report kinds", () => {
    expect(parse(WEB)).toEqual({ app: "example-web", daily_limit: 10, ...WEB });
    expect(parse({ ...WEB, report_kinds: ["fact", "closed"] })?.report_kinds).toEqual(["fact", "closed"]);
  });

  it("drops a key that needs a human check but names no widget, or a bad one", () => {
    expect(parse({ requires_human_check: true })).toBeUndefined();
    expect(parse({ requires_human_check: true, human_check: { secret: "", hostnames: [HOST] } })).toBeUndefined();
    expect(parse({ requires_human_check: true, human_check: { secret: SECRET, hostnames: [] } })).toBeUndefined();
    expect(parse({ requires_human_check: true, human_check: { secret: SECRET, hostnames: ["https://x.example"] } })).toBeUndefined();
    expect(parse({ requires_human_check: true, human_check: { ...CHECK, action: "has space" } })).toBeUndefined();
  });

  it("drops a key that mixes a human check with attestation", () => {
    expect(parse({ ...WEB, requires_attestation: true, android: { package: "com.example.app" } })).toBeUndefined();
  });

  it("drops a key with an unknown report kind", () => {
    expect(parse({ report_kinds: ["fact", "everything"] })).toBeUndefined();
    expect(parse({ report_kinds: [] })).toBeUndefined();
  });
});

describe("verifyHumanCheck", () => {
  const answering = (answer: unknown, status = 200) => async () => new Response(JSON.stringify(answer), { status });

  it("treats a hostname in another case as the same site", async () => {
    const result = await verifyHumanCheck({ fetch: answering(good("b", { hostname: "Places.Example.ORG" })), token: "t", bodySha256: hex("b"), config: CHECK });
    expect(result).toEqual({ ok: true });
  });

  it("refuses a token longer than Turnstile makes, without asking", async () => {
    let asked = false;
    const result = await verifyHumanCheck({
      fetch: async () => {
        asked = true;
        return new Response("{}");
      },
      token: "x".repeat(2049),
      bodySha256: hex("b"),
      config: CHECK,
    });
    expect(result).toEqual({ ok: false, error: "human_check_failed", details: ["token is too long"] });
    expect(asked).toBe(false);
  });

  it("is unavailable when the answer is not JSON or the request throws", async () => {
    expect(await verifyHumanCheck({ fetch: async () => new Response("<html>"), token: "t", bodySha256: "x", config: CHECK })).toEqual({
      ok: false,
      error: "unavailable",
    });
    const thrown = async (): Promise<Response> => {
      throw new Error("offline");
    };
    expect(await verifyHumanCheck({ fetch: thrown, token: "t", bodySha256: "x", config: CHECK })).toEqual({ ok: false, error: "unavailable" });
  });
});
