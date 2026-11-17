import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, createScheduled, type Env } from "../src/index.js";
import { MEMORY_TTL_MS, PAGE_SIZE } from "../src/reputation.js";
import { SITEVERIFY_URL } from "../src/humancheck.js";
import type { KVLike } from "../src/ratelimit.js";
import { fakeD1 } from "./fake-d1.js";
import { listableKv } from "./fake-kv.js";

const NOW = Date.parse("2026-11-17T09:00:00Z");
const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const LIST_URL = "https://admin.api.example.org/v1/integrations/0123456789abcdef/content";
const CREDENTIALS = "list-user:list-password";
const LISTED = "203.0.113.7";
const CLEAR = "198.51.100.20";
const PACKAGE = "com.example.app";
const WEB_HOST = "places.example.org";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** The blocklist's pages, as the integration serves them, and the requests it was sent. */
interface Blocklist {
  pages: string[];
  status: number;
  asked: { url: string; authorization: string | null }[];
}

/** An excerpt in the integration's plain text format: one address or range per line. */
const EXCERPT = ["203.0.113.7", "192.0.2.0/24", "2001:db8:dead::/48", "2001:db8::1"].join("\n");

/** The list, GitHub, Turnstile and Play Integrity. A Play Integrity token `ok:<hash>` decodes to a sound verdict for the body with that hash. */
function fakeServices(list: Blocklist) {
  const writes: Record<string, unknown>[] = [];
  const asked: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    asked.push(url);
    if (url === SITEVERIFY_URL) {
      const sent = JSON.parse(String(init?.body)) as { response: string };
      return new Response(JSON.stringify({ success: true, hostname: WEB_HOST, "error-codes": [], cdata: sent.response }), { status: 200 });
    }
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 360000 }), { status: 200 });
    if (url === `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`) {
      const token = (JSON.parse(String(init?.body)) as { integrity_token: string }).integrity_token;
      if (!token.startsWith("ok:")) return new Response("{}", { status: 400 });
      return new Response(
        JSON.stringify({
          tokenPayloadExternal: {
            requestDetails: { requestPackageName: PACKAGE, requestHash: token.slice(3), timestampMillis: String(NOW) },
            appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: PACKAGE, certificateSha256Digest: ["cert-a"] },
            deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
          },
        }),
        { status: 200 },
      );
    }
    if (url.startsWith(LIST_URL)) {
      list.asked.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (list.status !== 200) return new Response("oops", { status: list.status });
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      const text = list.pages[page - 1];
      return text === undefined ? new Response(null, { status: 204 }) : new Response(text, { status: 200 });
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
  return { fetch, writes, asked };
}

function env(appKey: Record<string, unknown> = {}, extra: Partial<Env> = {}): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 100, ...appKey } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "2",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: listableKv(),
    CROWDSEC_BLOCKLIST_URL: LIST_URL,
    CROWDSEC_BLOCKLIST_CREDENTIALS: CREDENTIALS,
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "intake@example.iam.gserviceaccount.com", private_key: privateKey }),
    ...extra,
  };
}

const reportBody = (report: Record<string, unknown> = { kind: "fact", fact: "toilets", value: true }) =>
  JSON.stringify({
    type: "report",
    place: PLACE,
    device: "3b241101-e2bb-4255-8caf-4136c566a962",
    app_version: "1.0.0",
    consent: true,
    report,
  });

const post = (body: string, ip: string, headers: Record<string, string> = {}) =>
  new Request("https://intake.example/v1/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-key": APP_KEY, "cf-connecting-ip": ip, ...headers },
    body,
  });

/** An app key whose installs attest with Play Integrity. */
const ATTESTED = { requires_attestation: true, android: { package: PACKAGE } };
/** A website's key, with a human check. Turnstile, as faked here, passes any token that is the body's hash. */
const WEB = { requires_human_check: true, human_check: { secret: "0x4AAAAAAAtest-secret", hostnames: [WEB_HOST] } };

/** Headers that attest `body` with Play Integrity. */
const attested = (body: string) => ({ "x-attest-platform": "android", "x-attest-token": `ok:${sha(body)}` });

const batch = (items: string[], ip: string, headers: (text: string) => Record<string, string> = () => ({})) => {
  const text = `{"items":[${items.join(",")}]}`;
  return new Request("https://intake.example/v1/feedback/batch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-app-key": APP_KEY, "cf-connecting-ip": ip, ...headers(text) },
    body: text,
  });
};

/** A KV namespace that counts its reads, and fails reads of the stored list when told to. */
function countingKv(): KVLike & { reads: number; failing: boolean } {
  const inner = listableKv();
  const kv = {
    reads: 0,
    failing: false,
    get: async (k: string) => {
      kv.reads += 1;
      if (kv.failing && k.startsWith("reputation:")) throw new Error("KV GET failed: 500");
      return inner.get(k);
    },
    put: (k: string, v: string, o?: { expirationTtl?: number }) => inner.put(k, v, o),
    delete: (k: string) => inner.delete(k),
  };
  return kv;
}

/** The answer an accepted item gets from an intake without D1: its id alone. */
const looksAccepted = async (res: Response) => {
  expect(res.status).toBe(202);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["id"]);
  expect(body.id).toMatch(/^fb_[0-9A-HJKMNP-TV-Z]{26}$/);
};

describe("network reputation", () => {
  let list: Blocklist;
  let services: ReturnType<typeof fakeServices>;
  let clock: number;
  let handle: ReturnType<typeof createHandler>;
  let scheduled: ReturnType<typeof createScheduled>;

  beforeEach(() => {
    list = { pages: [EXCERPT], status: 200, asked: [] };
    services = fakeServices(list);
    clock = NOW;
    handle = createHandler({ fetch: services.fetch, now: () => clock });
    scheduled = createScheduled({ fetch: services.fetch, now: () => clock });
  });

  it("drops a report from a listed network silently when the key is not attested", async () => {
    const e = env();
    await scheduled(e);
    await looksAccepted(await handle(post(reportBody(), LISTED), e));
    expect(services.writes).toEqual([]);
    expect(await e.RATE_LIMIT.get("silent:2026-11-17:network_reputation")).toBe("1");
  });

  it("takes a report from a network that is not listed as before", async () => {
    const e = env();
    await scheduled(e);
    expect((await handle(post(reportBody(), CLEAR), e)).status).toBe(202);
    expect(services.writes).toHaveLength(1);
  });

  it("holds an attested report from a listed network as network_reputation, never dropping it", async () => {
    const e = env(ATTESTED);
    await scheduled(e);
    const body = reportBody();
    const res = await handle(post(body, LISTED, attested(body)), e);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ id: expect.stringMatching(/^fb_/), state: "held", held_reason: "network_reputation" });
    expect(services.writes).toHaveLength(1);
    expect(services.writes[0]).toMatchObject({ attested: "play_integrity", intake: { state: "held", held_reason: "network_reputation" } });
    expect(await e.RATE_LIMIT.get("silent:2026-11-17:network_reputation")).toBeNull();
  });

  it("holds an attested report on an intake with D1, and its progress says so", async () => {
    const store = fakeD1();
    store.db
      .prepare("INSERT INTO place_index (id, cell_lon, cell_lat, facts, fact_sources, fact_dates) VALUES (?, 146, -37, '{\"toilets\":false}', '{}', '{}')")
      .run(PLACE);
    const e = env(ATTESTED, { RECENT_LIST: store });
    await scheduled(e);
    const body = reportBody();
    const answer = (await (await handle(post(body, LISTED, attested(body)), e)).json()) as { id: string };
    expect(answer).toMatchObject({ state: "held", held_reason: "network_reputation" });
    const progress = (await (await handle(new Request(`https://intake.example/v1/feedback/progress?ids=${answer.id}`), e)).json()) as { items: unknown[] };
    expect(progress.items[0]).toMatchObject({ held_reason: "network_reputation" });
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM recent_changes").get() as { n: number }).n).toBe(0);
  });

  it("marks every attested item from a listed network held as network_reputation in the inbox, not only the ones it decides", async () => {
    const e = env(ATTESTED);
    await scheduled(e);
    const bodies = [
      reportBody({ kind: "closed" }),
      reportBody({ kind: "name", value: "Riverside Camp" }),
      JSON.stringify({ type: "check", place: PLACE, device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true, check: { still_there: false, visited: "2026-11-16" } }),
      JSON.stringify({
        type: "review",
        place: PLACE,
        device: "3b241101-e2bb-4255-8caf-4136c566a962",
        contributor: "acct_3f9a8b7c6d5e4f30",
        app_version: "1.0.0",
        consent: true,
        review: { stars: 4, text: "Quiet spot by the river with clean toilets.", visited: "2026-11" },
      }),
    ];
    for (const body of bodies) {
      const res = await handle(post(body, LISTED, attested(body)), e);
      expect(res.status, await res.clone().text()).toBe(202);
    }
    expect(services.writes).toHaveLength(bodies.length);
    for (const written of services.writes) expect(written).toMatchObject({ intake: { state: "held", held_reason: "network_reputation" } });
  });

  it("drops a human-checked report from a listed network silently, without asking Turnstile", async () => {
    const e = env(WEB);
    await scheduled(e);
    const body = reportBody();
    await looksAccepted(await handle(post(body, LISTED, { "x-human-check": sha(body) }), e));
    expect(services.asked).not.toContain(SITEVERIFY_URL);
    expect(services.writes).toEqual([]);
    expect(await e.RATE_LIMIT.get("silent:2026-11-17:network_reputation")).toBe("1");
  });

  it("drops each item of an unattested batch from a listed network, and holds each of an attested one", async () => {
    const store = fakeD1();
    const items = [reportBody(), reportBody({ kind: "fact", fact: "showers", value: true })];
    const e = env({}, { RECENT_LIST: store });
    await scheduled(e);
    const unattested = (await (await handle(batch(items, LISTED), e)).json()) as { items: Record<string, unknown>[] };
    expect(unattested.items.map((i) => i.status)).toEqual([202, 202]);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM inbox_queue").get() as { n: number }).n).toBe(0);
    expect((store.db.prepare("SELECT count FROM silent_drops WHERE reason = 'network_reputation'").get() as { count: number }).count).toBe(2);

    const a = env(ATTESTED, { RECENT_LIST: store });
    const held = (await (await handle(batch(items, LISTED, attested), a)).json()) as { items: Record<string, unknown>[] };
    expect(held.items.map((i) => i.held_reason)).toEqual(["network_reputation", "network_reputation"]);
  });

  it("matches IPv6 addresses and ranges, and an IPv4 range given as IPv4-mapped IPv6", async () => {
    const e = env();
    await scheduled(e);
    for (const ip of ["2001:db8:dead:beef::5", "2001:0db8:0000:0000:0000:0000:0000:0001", "192.0.2.200", "::ffff:192.0.2.9"]) {
      await looksAccepted(await handle(post(reportBody(), ip), e));
    }
    expect(services.writes).toEqual([]);
    for (const ip of ["2001:db8:beef::1", "192.0.3.1", "::ffff:198.51.100.20"]) await handle(post(reportBody(), ip), e);
    expect(services.writes).toHaveLength(3);
  });

  it("fetches the list with the integration's Basic credentials, a page at a time, until a short page", async () => {
    // A full first page: PAGE_SIZE addresses in a row, from 10.0.0.0.
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`).join("\n");
    list.pages = [full, "203.0.113.7"];
    const e = env();
    await scheduled(e);
    expect(list.asked).toEqual([
      { url: `${LIST_URL}?page=1&page_size=${PAGE_SIZE}`, authorization: `Basic ${Buffer.from(CREDENTIALS).toString("base64")}` },
      { url: `${LIST_URL}?page=2&page_size=${PAGE_SIZE}`, authorization: `Basic ${Buffer.from(CREDENTIALS).toString("base64")}` },
    ]);
    await handle(post(reportBody(), "10.1.134.159"), e);
    await handle(post(reportBody(), LISTED), e);
    await handle(post(reportBody(), "10.1.134.160"), e);
    expect(services.writes).toHaveLength(1);
  });

  it("fetches the list once a day, and a new list replaces the old one", async () => {
    const e = env();
    await scheduled(e);
    clock += 23 * 60 * 60 * 1000;
    await scheduled(e);
    expect(list.asked).toHaveLength(1);
    clock += 60 * 60 * 1000;
    list.pages = ["198.51.100.20"];
    await scheduled(e);
    expect(list.asked).toHaveLength(2);
    await handle(post(reportBody(), LISTED), e);
    await looksAccepted(await handle(post(reportBody(), CLEAR), e));
    expect(services.writes).toHaveLength(1);
  });

  it("keeps the last good list through an outage, and tries again an hour later", async () => {
    const e = env();
    await scheduled(e);
    clock += 24 * 60 * 60 * 1000;
    list.status = 503;
    await scheduled(e);
    clock += 30 * 60 * 1000;
    await scheduled(e);
    expect(list.asked).toHaveLength(2);
    await looksAccepted(await handle(post(reportBody(), LISTED), e));
    expect(services.writes).toEqual([]);
    clock += 30 * 60 * 1000;
    list.status = 200;
    await scheduled(e);
    expect(list.asked).toHaveLength(3);
  });

  it("keeps the last good list when a fetch finds no addresses, or throws", async () => {
    const e = env();
    await scheduled(e);
    clock += 24 * 60 * 60 * 1000;
    list.pages = ["<html>maintenance</html>"];
    await scheduled(e);
    clock += 60 * 60 * 1000;
    const throwing = createScheduled({ fetch: async () => Promise.reject(new Error("timed out")), now: () => clock });
    await throwing(e);
    await looksAccepted(await handle(post(reportBody(), LISTED), e));
    expect(services.writes).toEqual([]);
  });

  it("asks no outside service per request, and reads the stored list at most once in a few minutes", async () => {
    const kv = countingKv();
    const e = env({}, { RATE_LIMIT: kv });
    await scheduled(e);
    const before = services.asked.length;
    const reads = kv.reads;
    for (let i = 0; i < 5; i += 1) await handle(post(reportBody(), LISTED), e);
    expect(services.asked.slice(before).filter((url) => url.startsWith(LIST_URL))).toEqual([]);
    // Each request reads its daily counters from KV too; the list itself is read once.
    const listReads = kv.reads - reads;
    clock += MEMORY_TTL_MS;
    await handle(post(reportBody(), LISTED), e);
    expect(listReads).toBeLessThan(kv.reads - reads);
    expect(services.writes).toEqual([]);
  });

  it("holds a report as check_unavailable when the stored list cannot be read", async () => {
    const kv = countingKv();
    const e = env(ATTESTED, { RATE_LIMIT: kv });
    await scheduled(e);
    kv.failing = true;
    const body = reportBody();
    const res = await handle(post(body, CLEAR, attested(body)), e);
    expect(await res.json()).toMatchObject({ state: "held", held_reason: "check_unavailable" });
  });

  it("holds an attested report as check_unavailable until the first list is fetched, and drops no unattested one for it", async () => {
    const attestedEnv = env(ATTESTED);
    const body = reportBody();
    expect(await (await handle(post(body, CLEAR, attested(body)), attestedEnv)).json()).toMatchObject({ state: "held", held_reason: "check_unavailable" });
    const e = env();
    expect((await handle(post(reportBody(), LISTED), e)).status).toBe(202);
    expect(await e.RATE_LIMIT.get("silent:2026-11-17:network_reputation")).toBeNull();
    expect(services.writes).toHaveLength(2);
    await scheduled(attestedEnv);
    const after = await (await handle(post(body, CLEAR, attested(body)), attestedEnv)).json();
    expect(after).not.toHaveProperty("held_reason");
  });

  it("tries a first fetch that failed again within minutes, as there is no list to fall back on", async () => {
    const e = env();
    list.status = 503;
    await scheduled(e);
    clock += 5 * 60 * 1000;
    list.status = 200;
    await scheduled(e);
    expect(list.asked).toHaveLength(2);
    await looksAccepted(await handle(post(reportBody(), LISTED), e));
  });

  it("is off without the integration's credentials or URL: nothing is fetched or dropped", async () => {
    for (const left of ["CROWDSEC_BLOCKLIST_CREDENTIALS", "CROWDSEC_BLOCKLIST_URL"] as const) {
      const e = env();
      delete e[left];
      await scheduled(e);
      await handle(post(reportBody(), LISTED), e);
    }
    expect(list.asked).toEqual([]);
    expect(services.writes).toHaveLength(2);
  });
});
