import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";
import { fakeD1 } from "./fake-d1.js";

const NOW = Date.parse("2026-11-17T09:00:00Z");
const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const UNKNOWN = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function memoryKv(): KVLike {
  const data = new Map<string, string>();
  return {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
}

function fakeServices() {
  const writes: Record<string, unknown>[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
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

const baseEnv = (): Env => ({
  APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100 } }),
  DEVICE_SALT: "pepper",
  GH_APP_ID: "1",
  GH_APP_PRIVATE_KEY: privateKey,
  GH_INSTALLATION_ID: "2",
  INBOX_REPO: "opencampingdb/inbox",
  RATE_LIMIT: memoryKv(),
});

const factReport = (report: Record<string, unknown>, place = PLACE) =>
  new Request("https://intake.example/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-key": APP_KEY, "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify({ type: "report", place, device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true, report }),
  });

const NOT_ALLOWED = { error: "source_not_allowed", details: ["report.source must be on a .gov.au host or the place's own website"] };

describe("source links at the intake", () => {
  let services: ReturnType<typeof fakeServices>;
  let handle: ReturnType<typeof createHandler>;
  let store: ReturnType<typeof fakeD1>;
  let env: Env;

  beforeEach(() => {
    services = fakeServices();
    handle = createHandler({ fetch: services.fetch, now: () => NOW });
    store = fakeD1();
    env = { ...baseEnv(), RECENT_LIST: store };
    store.db
      .prepare("INSERT INTO place_index (id, cell_lon, cell_lat, facts, fact_sources, fact_dates) VALUES (?, 146, -37, ?, '{}', '{}')")
      .run(PLACE, JSON.stringify({ toilets: false, website: "https://www.example.org/" }));
  });

  const answer = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

  it("takes a link on a .gov.au host, holding the report for the apply run's check of the page", async () => {
    const res = await answer(await handle(factReport({ kind: "fact", fact: "toilets", value: true, source: "https://www.parks.vic.gov.au/camp" }), env));
    expect(res).toEqual({ status: 202, body: { id: expect.stringMatching(/^fb_/), state: "held", held_reason: "source_link" } });
  });

  it("takes a link on the host of the place's website on record", async () => {
    const res = await answer(await handle(factReport({ kind: "fact", fact: "toilets", value: true, source: "https://example.org/facilities" }), env));
    expect(res.body).toMatchObject({ state: "held", held_reason: "source_link" });
  });

  it("holds a report without a link for a second source, as before", async () => {
    const res = await answer(await handle(factReport({ kind: "fact", fact: "toilets", value: true }), env));
    expect(res.body).toMatchObject({ state: "held", held_reason: "not_attested" });
  });

  it("holds a contact with a link for a person, as any contact without attestation is", async () => {
    const res = await answer(await handle(factReport({ kind: "fact", fact: "phone", value: "+61 3 5555 0100", source: "https://www.parks.vic.gov.au/camp" }), env));
    expect(res.body).toMatchObject({ state: "held", held_reason: "not_attested" });
  });

  it("refuses a link on any other host, with the reason, and stores nothing", async () => {
    for (const source of ["https://camp-reviews.example.net/camp", "https://shop.example.org/camp"]) {
      const res = await answer(await handle(factReport({ kind: "fact", fact: "toilets", value: true, source }), env));
      expect(res).toEqual({ status: 400, body: NOT_ALLOWED });
    }
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM inbox_queue").get() as { n: number }).n).toBe(0);
  });

  it("refuses a link off .gov.au for a place the index does not hold, whose website it cannot know", async () => {
    const res = await answer(await handle(factReport({ kind: "fact", fact: "toilets", value: true, source: "https://example.org/facilities" }, UNKNOWN), env));
    expect(res).toEqual({ status: 400, body: NOT_ALLOWED });
    const gov = await answer(await handle(factReport({ kind: "fact", fact: "toilets", value: true, source: "https://www.parks.vic.gov.au/camp" }, UNKNOWN), env));
    expect(gov.status).toBe(202);
  });

  it("leaves the host to the apply run on an intake without a place index", async () => {
    const res = await handle(factReport({ kind: "fact", fact: "toilets", value: true, source: "https://example.org/facilities" }), baseEnv());
    expect(res.status).toBe(202);
    expect(services.writes[0]).toMatchObject({ report: { source: "https://example.org/facilities" } });
  });
});
