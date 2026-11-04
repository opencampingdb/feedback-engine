import { createHash, generateKeyPairSync } from "node:crypto";
import type { HeldReason as SdkHeldReason } from "@opencampingdb/feedback";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { HeldReason } from "../src/decide.js";
import { createHandler, createScheduled, type CacheLike, type Env } from "../src/index.js";
import { insertPlace, type D1Like, type D1Statement } from "../src/recent.js";
import { fakeD1 } from "./fake-d1.js";
import { listableKv } from "./fake-kv.js";

const NOW = Date.parse("2026-11-03T09:00:00Z");
const HOUR = 60 * 60 * 1000;
const APP_KEY = "test-app-key-0123456789";
const PACKAGE = "com.example.app";
const ADDER = "3b241101-e2bb-4255-8caf-4136c566a962";
const TOKEN = "places-token-for-the-apply-run";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/**
 * The recent list as two requests see it when they reach it at the same
 * moment: each read of one new place waits until `n` reads have been asked
 * for, so both read before either writes.
 */
function atOnce(d1: D1Like, n: number): D1Like {
  let waiting: (() => void)[] = [];
  const wait = () =>
    new Promise<void>((resolve) => {
      n -= 1;
      waiting.push(resolve);
      if (n === 0) {
        for (const go of waiting) go();
        waiting = [];
      }
    });
  const wrap = (stmt: D1Statement): D1Statement => ({
    bind: (...values: unknown[]) => wrap(stmt.bind(...values)),
    all: () => stmt.all(),
    run: () => stmt.run(),
    first: async <T,>(column?: string) => {
      if (n > 0) await wait();
      return stmt.first<T>(column);
    },
  });
  return { prepare: (sql: string) => wrap(d1.prepare(sql)), batch: (list) => d1.batch(list) };
}

function fakeCache(): CacheLike & { entries: Map<string, Response> } {
  const entries = new Map<string, Response>();
  return {
    entries,
    match: async (request) => entries.get(request.url)?.clone(),
    put: async (request, response) => void entries.set(request.url, response.clone()),
  };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** GitHub and Play Integrity. A token `ok:<hash>` decodes to a sound verdict for the body with that hash. */
function fakeServices() {
  const writes: Record<string, unknown>[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(NOW + 100 * HOUR).toISOString() }), { status: 201 });
    }
    if (url.includes("/contents/")) {
      const body = JSON.parse(String(init?.body)) as { content: string };
      writes.push(JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as Record<string, unknown>);
      return new Response("{}", { status: 201 });
    }
    if (url.startsWith("https://urlhaus-api.abuse.ch/")) {
      return new Response(JSON.stringify({ query_status: "no_results" }), { status: 200 });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 360000 }), { status: 200 });
    }
    if (url === `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`) {
      const token = (JSON.parse(String(init?.body)) as { integrity_token: string }).integrity_token;
      if (!token.startsWith("ok:")) return new Response("{}", { status: 400 });
      return new Response(
        JSON.stringify({
          tokenPayloadExternal: {
            requestDetails: { requestPackageName: PACKAGE, requestHash: token.slice(3), timestampMillis: String(clock) },
            appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED", packageName: PACKAGE, certificateSha256Digest: ["cert-a"] },
            deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
          },
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, writes };
}

let clock = NOW;

/** Workers AI as Llama Guard: safe, unless the text holds `unsafe:`. `runs` counts its calls. */
const safeAi = {
  runs: 0,
  run: async (_model: string, inputs: Record<string, unknown>) => {
    safeAi.runs += 1;
    const text = JSON.stringify(inputs.messages);
    return { response: { safe: !text.includes("unsafe:"), categories: [] } };
  },
};

function env(store: D1Like, appKey: Record<string, unknown> = {}): Env {
  return {
    APP_KEYS: JSON.stringify({
      [APP_KEY]: { app: "example-app", daily_limit: 1000, requires_attestation: true, android: { package: PACKAGE }, ...appKey },
    }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "2",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: listableKv(),
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "intake@example.iam.gserviceaccount.com", private_key: privateKey }),
    RECENT_LIST: store,
    PLACES_TOKEN: TOKEN,
    AI: safeAi,
  };
}

/** A feedback POST with a sound Play Integrity token for its body. */
function feedback(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  return new Request("https://intake.example/v1/feedback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-key": APP_KEY,
      "x-attest-platform": "android",
      "x-attest-token": `ok:${sha(text)}`,
      ...headers,
    },
    body: text,
  });
}

const newPlace = (extra: { device?: string; contributor?: string | null; note?: string; name?: string; contacts?: Record<string, string> } = {}) => ({
  type: "report",
  place: null,
  location: { lat: -36.12345, lon: 146.88765 },
  device: extra.device ?? ADDER,
  ...(extra.contributor === null ? {} : { contributor: extra.contributor ?? "acct_3f9a8b7c6d5e4f30" }),
  app_version: "1.0.0",
  consent: true,
  report: {
    kind: "new_place",
    place_kind: "free_camp",
    note: extra.note ?? "Gravel pit off the highway, room for three vans",
    ...(extra.name !== undefined ? { name: extra.name } : {}),
    ...(extra.contacts ? { contacts: extra.contacts } : {}),
  },
});

const otherDevice = (i: number) => `${i}c241101-e2bb-4255-8caf-4136c566a962`;

const recent = (query = "") => new Request(`https://intake.example/v1/places/recent${query}`);

interface Listed {
  id: string;
  location: { lat: number; lon: number };
  kind: string | null;
  name: string | null;
  standing: string;
  added: string;
  contributor: string;
}

describe("recent places", () => {
  let services: ReturnType<typeof fakeServices>;
  let handle: ReturnType<typeof createHandler>;
  let store: ReturnType<typeof fakeD1>;
  let e: Env;

  beforeEach(() => {
    clock = NOW;
    services = fakeServices();
    store = fakeD1();
    e = env(store);
    handle = createHandler({ fetch: services.fetch, now: () => clock, randomBytes: () => crypto.getRandomValues(new Uint8Array(16)) });
  });

  async function add(extra: Parameters<typeof newPlace>[0] = {}): Promise<string> {
    const res = await handle(feedback(newPlace(extra)), e);
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    return `ocdb_${id.replace(/^fb_/, "")}`;
  }

  async function list(query = ""): Promise<Listed[]> {
    const res = await handle(recent(query), e);
    expect(res.status).toBe(200);
    return ((await res.json()) as { places: Listed[] }).places;
  }

  it("lists an accepted new place with its id, location, kind, name, standing, time and contributor", async () => {
    const id = await add({ name: "Gravel Pit Rest Area" });
    const places = await list();
    expect(places).toHaveLength(1);
    expect(places[0]).toEqual({
      id,
      location: { lat: -36.12345, lon: 146.88765 },
      kind: "free_camp",
      name: "Gravel Pit Rest Area",
      standing: "shown",
      added: "2026-11-03T09:00:00Z",
      contributor: services.writes[0]!.contributor,
    });
    expect(places[0]!.contributor).toMatch(/^ctr_[0-9a-f]{16}$/);
  });

  it("refuses a contributor's fourth new place in a day, and takes it the next day", async () => {
    for (let i = 0; i < 3; i++) await add({ device: otherDevice(i) });
    const res = await handle(feedback(newPlace({ device: otherDevice(3) })), e);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(await list()).toHaveLength(3);
    clock += 24 * HOUR;
    await add({ device: otherDevice(3) });
  });

  it("never lists the note, and lists the contacts the place is published with", async () => {
    await add({ note: "Behind the old servo, gate code 4471", contacts: { phone: "03 5555 0100", email: "park@example.org" } });
    const res = await handle(recent(), e);
    const text = await res.text();
    expect(text).not.toContain("servo");
    expect(text).not.toContain(ADDER);
    const [place] = (JSON.parse(text) as { places: (Listed & { contacts?: unknown })[] }).places;
    expect(Object.keys(place!).sort()).toEqual(["added", "contacts", "contributor", "id", "kind", "location", "name", "standing"]);
    expect(place!.contacts).toEqual({ phone: "03 5555 0100", email: "park@example.org" });
  });

  it("lists the name tidied, as the data would have it", async () => {
    await add({ name: "lake   eppalock rest area" });
    expect((await list())[0]!.name).toBe("Lake Eppalock Rest Area");
  });

  it("lists a long name in full", async () => {
    // 300 characters of three bytes each.
    const name = Array.from({ length: 300 }, (_, i) => String.fromCodePoint(0x6c34 + (i % 40))).join("");
    const id = await add({ name });
    const places = await list();
    expect(places.map((p) => p.id)).toEqual([id]);
    expect(places[0]!.name).toBe(name);
  });

  it("lists a new place sent without a name with a null name", async () => {
    await add();
    expect((await list())[0]!.name).toBeNull();
  });

  it("is cached at the edge for 30 seconds", async () => {
    const cache = fakeCache();
    handle = createHandler({ fetch: services.fetch, now: () => clock, cache });
    await add();
    const first = await handle(recent(), e);
    expect(first.headers.get("cache-control")).toBe("public, max-age=30");
    await add({ device: otherDevice(1) });
    const second = await handle(recent(), e);
    expect(((await second.json()) as { places: Listed[] }).places).toHaveLength(1);
    expect(second.headers.get("cache-control")).toBe("public, max-age=30");
  });

  it("snaps a bounding box out to whole degrees, so nearby map views share one cached list", async () => {
    const cache = fakeCache();
    handle = createHandler({ fetch: services.fetch, now: () => clock, cache });
    await add();
    const first = await handle(recent("?bbox=146.1,-36.9,146.5,-36.5"), e);
    expect(((await first.json()) as { places: Listed[] }).places).toHaveLength(1);
    // A second place in the same degrees, which the cached answer doesn't hold yet.
    await add({ device: otherDevice(1) });
    const second = await handle(recent("?bbox=146.2,-36.8,146.3,-36.7&zoom=9"), e);
    expect(((await second.json()) as { places: Listed[] }).places).toHaveLength(1);
    clock += 31 * 1000;
    cache.entries.clear();
    expect(((await (await handle(recent("?bbox=146.2,-36.8,146.3,-36.7"), e)).json()) as { places: Listed[] }).places).toHaveLength(2);
    expect([...cache.entries.keys()]).toEqual(["https://intake.example/v1/places/recent?bbox=146,-37,147,-36"]);
  });

  it("adds the caller's CORS header to a cached list", async () => {
    const cache = fakeCache();
    handle = createHandler({ fetch: services.fetch, now: () => clock, cache });
    const withOrigin = { ...e, ALLOWED_ORIGINS: "https://a.example,https://b.example" };
    const from = (origin: string) => new Request("https://intake.example/v1/places/recent", { headers: { origin } });
    expect((await handle(from("https://a.example"), withOrigin)).headers.get("access-control-allow-origin")).toBe("https://a.example");
    expect((await handle(from("https://b.example"), withOrigin)).headers.get("access-control-allow-origin")).toBe("https://b.example");
  });

  it("hides a place reported by two other devices", async () => {
    const id = await add();
    const remove = (i: number) => feedback({ ...newPlace({ device: otherDevice(i), contributor: `acct_reporter_000000${i}` }), place: id, location: undefined, report: { kind: "remove", reason: "fake" } });
    expect((await handle(remove(1), e)).status).toBe(202);
    expect((await list()).map((p) => p.standing)).toEqual(["shown"]);
    expect((await handle(remove(2), e)).status).toBe(202);
    expect(await list()).toEqual([]);
  });

  it("counts a not there check as a report", async () => {
    const id = await add();
    const check = (i: number, stillThere: boolean) =>
      feedback({ type: "check", place: id, device: otherDevice(i), app_version: "1.0.0", consent: true, check: { visited: "2026-11-03", still_there: stillThere } });
    await handle(check(1, false), e);
    await handle(check(2, false), e);
    expect(await list()).toEqual([]);
  });

  it("confirms a place two other devices found still there while nearby", async () => {
    const id = await add();
    const check = (device: string, nearby = true) =>
      feedback({
        type: "check",
        place: id,
        device,
        app_version: "1.0.0",
        consent: true,
        check: { visited: "2026-11-03", still_there: true, ...(nearby ? { nearby: true } : {}) },
      });
    await handle(check(ADDER), e);
    await handle(check(otherDevice(1)), e);
    await handle(check(otherDevice(3), false), e);
    expect((await list())[0]!.standing).toBe("shown");
    await handle(check(otherDevice(2)), e);
    expect((await list())[0]!.standing).toBe("confirmed");
  });

  it("counts both of two checks sent at the same moment", async () => {
    const id = await add();
    const check = (i: number) =>
      feedback({ type: "check", place: id, device: otherDevice(i), app_version: "1.0.0", consent: true, check: { visited: "2026-11-03", still_there: true, nearby: true } });
    const both = { ...e, RECENT_LIST: atOnce(store, 2) };
    const answers = await Promise.all([handle(check(1), both), handle(check(2), both)]);
    expect(answers.map((a) => a.status)).toEqual([202, 202]);
    expect((await list())[0]!.standing).toBe("confirmed");
  });

  it("counts both of two reports sent at the same moment", async () => {
    const id = await add();
    const remove = (i: number) => feedback({ ...newPlace({ device: otherDevice(i), contributor: `acct_reporter_000000${i}` }), place: id, location: undefined, report: { kind: "remove", reason: "fake" } });
    const both = { ...e, RECENT_LIST: atOnce(store, 2) };
    await Promise.all([handle(remove(1), both), handle(remove(2), both)]);
    expect(await list()).toEqual([]);
  });

  it("doesn't confirm a place on still there checks from away from it", async () => {
    const id = await add();
    for (const i of [1, 2, 3]) {
      const res = await handle(
        feedback({ type: "check", place: id, device: otherDevice(i), app_version: "1.0.0", consent: true, check: { visited: "2026-11-03", still_there: true } }),
        e,
      );
      expect(res.status).toBe(202);
    }
    expect((await list())[0]!.standing).toBe("shown");
  });

  it("counts a feedback item sent twice once", async () => {
    const id = await add();
    // The same random bytes at the same moment give both checks one feedback id.
    const same = new Uint8Array(16).fill(7);
    handle = createHandler({ fetch: services.fetch, now: () => clock, randomBytes: () => same });
    const check = (i: number) =>
      feedback({ type: "check", place: id, device: otherDevice(i), app_version: "1.0.0", consent: true, check: { visited: "2026-11-03", still_there: true, nearby: true } });
    expect((await handle(check(1), e)).status).toBe(202);
    expect((await handle(check(2), e)).status).toBe(202);
    expect((await list())[0]!.standing).toBe("shown");
  });

  it("makes no KV list for the recent list", async () => {
    const counted = listableKv();
    const withCounted = { ...e, RATE_LIMIT: counted, ATTEST: counted };
    const id = await handle(feedback(newPlace()), withCounted);
    expect(id.status).toBe(202);
    expect((await handle(recent(), withCounted)).status).toBe(200);
    expect((await handle(recent("?bbox=146,-37,147,-36"), withCounted)).status).toBe(200);
    expect(counted.lists).toBe(0);
  });

  it("answers 404 on every recent list route without a D1 database bound", async () => {
    const { RECENT_LIST: _, ...without } = e;
    const post = (path: string, body: unknown) =>
      new Request(`https://intake.example/v1/places/recent/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
    expect((await handle(recent(), without)).status).toBe(404);
    expect((await handle(post("remove", { ids: ["ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA"] }), without)).status).toBe(404);
    expect((await handle(post("block", { contributors: [] }), without)).status).toBe(404);
    // Feedback still reaches the inbox.
    expect((await handle(feedback(newPlace()), without)).status).toBe(202);
    expect(services.writes).toHaveLength(1);
  });

  describe("withdraw", () => {
    const withdraw = (place: string, device = ADDER) =>
      feedback({ type: "withdraw", place, device, contributor: "acct_3f9a8b7c6d5e4f30", app_version: "1.0.0", consent: true });

    it("takes a place off the list when the same install withdraws it within 24 hours", async () => {
      const id = await add();
      clock += 23 * HOUR;
      const res = await handle(withdraw(id), e);
      expect(res.status).toBe(202);
      expect(await list()).toEqual([]);
      expect(services.writes.at(-1)).toMatchObject({ type: "withdraw", place: id, device: services.writes[0]!.device });
    });

    it("refuses a withdraw after 24 hours", async () => {
      const id = await add();
      clock += 24 * HOUR + 1000;
      const res = await handle(withdraw(id), e);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "withdraw_window_closed" });
      expect(services.writes).toHaveLength(1);
      expect(await list()).toHaveLength(1);
    });

    it("refuses a withdraw from another install", async () => {
      const id = await add();
      const res = await handle(withdraw(id, otherDevice(1)), e);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "not_your_place" });
      expect(services.writes).toHaveLength(1);
      expect(await list()).toHaveLength(1);
    });

    it("refuses a withdraw without attestation", async () => {
      const id = await add();
      const req = withdraw(id);
      req.headers.delete("x-attest-token");
      expect((await handle(req, e)).status).toBe(401);
      expect(await list()).toHaveLength(1);
    });

    it("passes a withdraw for a place the store doesn't hold to the inbox for the apply run", async () => {
      const id = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
      expect((await handle(withdraw(id), e)).status).toBe(202);
      expect(services.writes.at(-1)).toMatchObject({ type: "withdraw", place: id });
    });
  });

  it("leaves out new places that fail the text checks or come without attestation, which still reach the inbox", async () => {
    await add({ note: "Bloody shit road in" });
    await add({ device: otherDevice(1), note: "Nice spot, click here for cheap gear" });
    const unattested = env(store, { requires_attestation: false });
    expect((await handle(feedback(newPlace({ device: otherDevice(2), contributor: "acct_another_00000001" })), unattested)).status).toBe(202);
    expect(services.writes).toHaveLength(3);
    expect(await list()).toEqual([]);
  });

  it("lists a new place whose note had a contact detail, which the inbox strips", async () => {
    const id = await add({ note: "Call 0412 345 678 for the gate" });
    expect((await list()).map((p) => p.id)).toEqual([id]);
    expect(JSON.stringify(services.writes[0])).not.toContain("0412");
  });

  it("limits the list to a bounding box", async () => {
    await add();
    expect(await list("?bbox=146,-37,147,-36")).toHaveLength(1);
    expect(await list("?bbox=150,-34,151,-33")).toEqual([]);
    expect((await handle(recent("?bbox=147,-37,146,-36"), e)).status).toBe(400);
    expect((await handle(recent("?bbox=nope"), e)).status).toBe(400);
  });

  it("lists places in id order, whatever order they were added in", async () => {
    // Places copied from KV keep the time they were added, so ids and times need not run together.
    const at = (id: string, added: string) =>
      insertPlace(store, { id, location: { lat: -36.1, lon: 146.9 }, kind: null, name: null, added, contributor: `ctr_${id}`, device: `dev_${id}` });
    await at("ocdb_03", "2026-11-03T06:00:00Z");
    await at("ocdb_01", "2026-11-03T08:00:00Z");
    await at("ocdb_02", "2026-11-03T07:00:00Z");
    expect((await list()).map((p) => p.id)).toEqual(["ocdb_01", "ocdb_02", "ocdb_03"]);
    expect((await list("?bbox=146,-37,147,-36")).map((p) => p.id)).toEqual(["ocdb_01", "ocdb_02", "ocdb_03"]);
  });

  it("lists every place", async () => {
    for (let i = 0; i < 3; i++) await add({ device: otherDevice(i) });
    await add({ device: otherDevice(3), contributor: "acct_second_person_01" });
    await add({ device: otherDevice(4), contributor: "acct_second_person_01" });
    expect(await list()).toHaveLength(5);
  });

  describe("removal by the apply run", () => {
    const remove = (ids: unknown, token = TOKEN) =>
      new Request("https://intake.example/v1/places/recent/remove", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ ids }),
      });

    it("takes places written into the data off the list", async () => {
      const id = await add();
      const kept = await add({ device: otherDevice(1) });
      const res = await handle(remove([id, "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA"]), e);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: 2 });
      expect((await list()).map((p) => p.id)).toEqual([kept]);
    });

    it("removes the removal reports on a place with it", async () => {
      // Fixed random bytes for each item, so the place can be sent again with the same id after its removal.
      let seed = 1;
      handle = createHandler({ fetch: services.fetch, now: () => clock, randomBytes: (n) => new Uint8Array(n).fill(seed) });
      const id = await add();
      const report = (i: number) =>
        feedback({ ...newPlace({ device: otherDevice(i), contributor: `acct_reporter_000000${i}` }), place: id, location: undefined, report: { kind: "remove", reason: "fake" } });
      seed = 2;
      expect((await handle(report(1), e)).status).toBe(202);
      seed = 3;
      expect((await handle(report(2), e)).status).toBe(202);
      expect(await list()).toEqual([]);
      expect((await handle(remove([id]), e)).status).toBe(200);

      seed = 1;
      expect(await add()).toBe(id);
      // Had the two removal reports outlived the place, they would hide it again.
      expect((await list()).map((p) => p.id)).toEqual([id]);
    });

    it("refuses a wrong token and a bad body", async () => {
      const id = await add();
      expect((await handle(remove([id], "not-the-token"), e)).status).toBe(401);
      expect((await handle(remove(["fb_nope"]), e)).status).toBe(400);
      expect((await handle(remove([]), e)).status).toBe(400);
      expect(await list()).toHaveLength(1);
    });

    it("is not served without a token configured", async () => {
      const { PLACES_TOKEN: _, ...noToken } = e;
      expect((await handle(remove(["ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA"]), noToken)).status).toBe(404);
    });
  });

  describe("block list from the apply run", () => {
    const block = (contributors: unknown, token = TOKEN) =>
      new Request("https://intake.example/v1/places/recent/block", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ contributors }),
      });
    const contributorOf = (i: number) => services.writes[i]!.contributor as string;

    it("takes a blocked contributor's new places off the list, and lists none they add later", async () => {
      await add();
      const kept = await add({ device: otherDevice(1), contributor: "acct_second_person_01" });
      const res = await handle(block([contributorOf(0)]), e);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ blocked: 1 });
      expect((await list()).map((p) => p.id)).toEqual([kept]);
      const later = await handle(feedback(newPlace({ device: otherDevice(2) })), e);
      expect(later.status).toBe(202);
      expect(services.writes).toHaveLength(3);
      expect((await list()).map((p) => p.id)).toEqual([kept]);
    });

    it("keeps a blocked contributor's place off the list when a check or report comes in", async () => {
      const id = await add();
      await handle(block([contributorOf(0)]), e);
      await handle(
        feedback({ type: "check", place: id, device: otherDevice(1), app_version: "1.0.0", consent: true, check: { visited: "2026-11-03", still_there: true, nearby: true } }),
        e,
      );
      expect(await list()).toEqual([]);
    });

    it("replaces the list each time, so a contributor taken off it is listed again", async () => {
      const id = await add();
      await handle(block([contributorOf(0)]), e);
      expect(await list()).toEqual([]);
      expect(await (await handle(block([]), e)).json()).toEqual({ blocked: 0 });
      expect((await list()).map((p) => p.id)).toEqual([id]);
    });

    it("refuses a wrong token and a bad body", async () => {
      await add();
      expect((await handle(block([contributorOf(0)], "not-the-token"), e)).status).toBe(401);
      expect((await handle(block(["acct_3f9a8b7c6d5e4f30"]), e)).status).toBe(400);
      expect((await handle(block("ctr_0123456789abcdef"), e)).status).toBe(400);
      expect(await list()).toHaveLength(1);
    });

    it("lists a signed-out Android install's places under a contributor of its own, which can be blocked", async () => {
      const id = await add({ contributor: null });
      const second = await add({ contributor: null });
      const other = await add({ device: otherDevice(1), contributor: null });
      const places = await list();
      expect(places.map((p) => p.id).sort()).toEqual([id, second, other].sort());
      const [first] = places.filter((p) => p.id === id);
      expect(first!.contributor).toMatch(/^ctr_[0-9a-f]{16}$/);
      expect(first!.contributor).toBe(contributorOf(0));
      expect(contributorOf(1)).toBe(contributorOf(0));
      expect(contributorOf(2)).not.toBe(contributorOf(0));
      expect(JSON.stringify(services.writes)).not.toContain(ADDER);
      await handle(block([contributorOf(0)]), e);
      expect((await list()).map((p) => p.id)).toEqual([other]);
    });

    it("is not served without a token configured", async () => {
      const { PLACES_TOKEN: _, ...noToken } = e;
      expect((await handle(block([]), noToken)).status).toBe(404);
    });
  });
});

describe("send-time decisions", () => {
  const PLACE = "ocdb_01JB0000000000000000000001";
  const ELSEWHERE = "ocdb_01JB0000000000000000000002";
  const UNKNOWN = "ocdb_01JB0000000000000000000009";
  const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";

  let services: ReturnType<typeof fakeServices>;
  let handle: ReturnType<typeof createHandler>;
  let store: ReturnType<typeof fakeD1>;
  let e: Env;

  beforeEach(() => {
    clock = NOW;
    safeAi.runs = 0;
    services = fakeServices();
    store = fakeD1();
    e = { ...env(store), URLHAUS_KEY: "urlhaus-test-key" };
    handle = createHandler({ fetch: services.fetch, now: () => clock, randomBytes: () => crypto.getRandomValues(new Uint8Array(16)) });
    // A released place near the new places above, and one far away.
    index(PLACE, [146, -37], { toilets: false, phone: "03 5555 0100", website: "https://lake.example.org" }, { phone: "feedback", website: "owner" });
    index(ELSEWHERE, [150, -34], { toilets: false });
  });

  function index(id: string, [lon, lat]: [number, number], facts: Record<string, unknown>, sources: Record<string, string> = {}) {
    store.db
      .prepare("INSERT INTO place_index (id, cell_lon, cell_lat, facts, fact_sources, fact_dates) VALUES (?, ?, ?, ?, ?, '{}')")
      .run(id, lon, lat, JSON.stringify(facts), JSON.stringify(sources));
  }

  const report = (place: string, body: Record<string, unknown>, who: { device?: string; contributor?: string | null } = {}) => ({
    type: "report",
    place,
    device: who.device ?? ADDER,
    ...(who.contributor === null ? {} : { contributor: who.contributor ?? CONTRIBUTOR }),
    app_version: "1.0.0",
    consent: true,
    report: body,
  });
  const fact = (place: string, name: string, value: unknown, who: Parameters<typeof report>[2] & { note?: string } = {}) =>
    report(place, { kind: "fact", fact: name, value, ...(who.note ? { note: who.note } : {}) }, who);
  const contact = (place: string, name: string, who: Parameters<typeof report>[2] = {}) => report(place, { kind: "contact", fact: name, reason: "spam" }, who);

  async function send(body: Record<string, unknown>, to: Env = e): Promise<Record<string, unknown>> {
    const res = await handle(feedback(body), to);
    expect(res.status).toBe(202);
    return (await res.json()) as Record<string, unknown>;
  }

  async function listing(query = ""): Promise<{ places: Record<string, unknown>[]; changes: Record<string, unknown>[] }> {
    const res = await handle(recent(query), e);
    expect(res.status).toBe(200);
    return (await res.json()) as { places: Record<string, unknown>[]; changes: Record<string, unknown>[] };
  }

  const held = (reason: string) => ({ state: "held", held_reason: reason });

  it("holds only with the codes the SDK lists, so apps can read every one", () => {
    expectTypeOf<HeldReason>().toEqualTypeOf<SdkHeldReason>();
  });

  it("puts an attested fact live at once, as a recent change, and still writes it to the inbox", async () => {
    const answer = await send(fact(PLACE, "toilets", true));
    expect(answer).toEqual({ id: services.writes[0]!.id, state: "live" });
    expect(services.writes[0]).toMatchObject({ type: "report", place: PLACE, report: { kind: "fact", fact: "toilets", value: true } });
    expect(services.writes[0]).not.toHaveProperty("state");
    // The decision goes into the inbox with the item, for the apply.
    expect(services.writes[0]!.intake).toEqual({ state: "live" });
    expect((await listing()).changes).toEqual([{ place: PLACE, fact: "toilets", value: true, accepted: "2026-11-03T09:00:00Z", in_data_at: null }]);
    // A fact with no free text never goes to the AI, and counts towards the contributor's track record.
    expect(safeAi.runs).toBe(0);
    expect(store.db.prepare("SELECT accepted, taken_down FROM contributor_records").all()).toEqual([{ accepted: 1, taken_down: 0 }]);
  });

  it("answers live, with no recent change, for the value the place already has", async () => {
    expect(await send(fact(PLACE, "toilets", false))).toMatchObject({ state: "live" });
    expect((await listing()).changes).toEqual([]);
  });

  it("decides a later report against the recent change", async () => {
    await send(fact(PLACE, "toilets", true));
    clock += HOUR;
    // The same value from another install: the place already has it.
    expect(await send(fact(PLACE, "toilets", true, { device: otherDevice(1), contributor: "acct_second_person_01" }))).toMatchObject({ state: "live" });
    // A different value from another install within 90 days: a person decides.
    expect(await send(fact(PLACE, "toilets", false, { device: otherDevice(2), contributor: "acct_third_person_01" }))).toMatchObject(
      held("disagreement"),
    );
    expect((await listing()).changes).toEqual([{ place: PLACE, fact: "toilets", value: true, accepted: "2026-11-03T09:00:00Z", in_data_at: null }]);
  });

  it("holds a fact the earlier held report disagrees with", async () => {
    const unattested = env(store, { requires_attestation: false });
    expect(await send(fact(PLACE, "toilets", true, { device: otherDevice(1), contributor: "acct_second_person_01" }), unattested)).toEqual({
      id: services.writes[0]!.id,
      ...held("not_attested"),
    });
    expect(await send(fact(PLACE, "toilets", false), e)).toMatchObject({ state: "live" });
    expect(await send(fact(PLACE, "drinking_water", true, { device: otherDevice(1), contributor: "acct_second_person_01" }), unattested)).toMatchObject(
      held("not_attested"),
    );
    clock += HOUR;
    expect(await send(fact(PLACE, "drinking_water", false))).toMatchObject(held("disagreement"));
    expect((await listing()).changes).toEqual([]);
  });

  it("holds a fact for each reason the rules and checks give", async () => {
    // The owner set the website.
    expect(await send(fact(PLACE, "website", "https://other.example.org"))).toMatchObject(held("owner_value"));
    // A link shortener fails the link rules.
    expect(await send(fact(PLACE, "facebook", "https://bit.ly/3abcdef"))).toMatchObject(held("link_check"));
    // A note that fails the text checks, before any paid check.
    expect(await send(fact(PLACE, "toilets", true, { note: "Bloody shit dunny" }))).toMatchObject(held("text_check"));
    // A note Llama Guard calls unsafe.
    expect(await send(fact(PLACE, "toilets", true, { note: "unsafe: words" }))).toMatchObject(held("ai_check"));
    expect(safeAi.runs).toBe(1);
    // A place the index doesn't have, which is held, never refused.
    expect(await send(fact(UNKNOWN, "toilets", true))).toMatchObject(held("unknown_place"));
    // A check service that isn't set up.
    const { URLHAUS_KEY: _, ...noUrlhaus } = e;
    expect(await send(fact(PLACE, "instagram", "https://www.instagram.com/lakecamp"), noUrlhaus)).toMatchObject(held("check_unavailable"));
    expect((await listing()).changes).toEqual([]);
    expect(services.writes).toHaveLength(6);
    // Each hold goes into the inbox with the item, so the apply never publishes what a check held.
    expect(services.writes.map((w) => w.intake)).toEqual(
      ["owner_value", "link_check", "text_check", "ai_check", "unknown_place", "check_unavailable"].map(held),
    );
  });

  it("stores no decision on items it doesn't decide, and stores a failed decision as check_unavailable", async () => {
    await send(report(PLACE, { kind: "closed" }));
    expect(services.writes[0]).not.toHaveProperty("intake");
    const broken: D1Like = {
      prepare: () => {
        throw new Error("D1 is down");
      },
      batch: async () => {
        throw new Error("D1 is down");
      },
    };
    expect(await send(fact(PLACE, "toilets", true), { ...e, RECENT_LIST: broken })).toMatchObject(held("check_unavailable"));
    expect(services.writes[1]!.intake).toEqual(held("check_unavailable"));
  });

  it("holds a fact past the contributor's 50 live changes for the day", async () => {
    expect(await send(fact(PLACE, "toilets", true))).toMatchObject({ state: "live" });
    const contributor = services.writes[0]!.contributor as string;
    store.db.prepare("UPDATE live_counts SET count = 50 WHERE contributor = ?").run(contributor);
    expect(await send(fact(PLACE, "drinking_water", true))).toMatchObject(held("daily_cap"));
    clock += 24 * HOUR;
    expect(await send(fact(PLACE, "drinking_water", true))).toMatchObject({ state: "live" });
  });

  it("holds everything from a blocked contributor", async () => {
    await send(fact(PLACE, "toilets", true));
    const contributor = services.writes[0]!.contributor as string;
    const block = new Request("https://intake.example/v1/places/recent/block", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ contributors: [contributor] }),
    });
    expect((await handle(block, e)).status).toBe(200);
    expect(await send(fact(PLACE, "drinking_water", true))).toMatchObject(held("blocked"));
    // Their earlier change leaves the list too.
    expect((await listing()).changes).toEqual([]);
  });

  it("skips Llama Guard for a contributor with a track record", async () => {
    await send(fact(PLACE, "toilets", true, { note: "Clean, and open all night" }));
    expect(safeAi.runs).toBe(1);
    const contributor = services.writes[0]!.contributor as string;
    store.db.prepare("UPDATE contributor_records SET accepted = 5 WHERE contributor = ?").run(contributor);
    await send(fact(PLACE, "drinking_water", true, { note: "Tank by the shed" }));
    expect(safeAi.runs).toBe(1);
    store.db.prepare("UPDATE contributor_records SET taken_down = 1 WHERE contributor = ?").run(contributor);
    await send(fact(PLACE, "showers", true, { note: "Cold only" }));
    expect(safeAi.runs).toBe(2);
  });

  it("holds one report of a contact, and takes the contact down on a second source's report", async () => {
    expect(await send(contact(PLACE, "phone"))).toMatchObject(held("unconfirmed"));
    expect((await listing()).changes).toEqual([]);
    clock += HOUR;
    expect(await send(contact(PLACE, "phone", { device: otherDevice(1), contributor: "acct_second_person_01" }))).toMatchObject({ state: "live" });
    expect((await listing()).changes).toEqual([{ place: PLACE, fact: "phone", value: null, accepted: "2026-11-03T10:00:00Z", in_data_at: null }]);
    // Once it is down, a report about it is about a contact the place no longer has.
    expect(await send(contact(PLACE, "phone", { device: otherDevice(2), contributor: "acct_third_person_01" }))).toMatchObject(held("no_value"));
  });

  it("leaves a contact the owner set to a person, and holds a report about a contact the place doesn't have", async () => {
    expect(await send(contact(PLACE, "website"))).toMatchObject(held("owner_value"));
    expect(await send(contact(PLACE, "email"))).toMatchObject(held("no_value"));
  });

  it("holds a signed-out install's fact without attestation, under the install standing in for a contributor", async () => {
    const unattested = env(store, { requires_attestation: false });
    expect(await send(fact(PLACE, "toilets", true, { contributor: null }), unattested)).toMatchObject(held("not_attested"));
    expect(services.writes[0]).not.toHaveProperty("contributor");
  });

  it("counts a signed-out Android install's live changes under its hashed install", async () => {
    expect(await send(fact(PLACE, "toilets", true, { contributor: null }))).toMatchObject({ state: "live" });
    expect(services.writes[0]).not.toHaveProperty("contributor");
    const [record] = store.db.prepare("SELECT contributor, accepted FROM contributor_records").all() as { contributor: string; accepted: number }[];
    expect(record!.contributor).toMatch(/^ctr_[0-9a-f]{16}$/);
    expect(record!.accepted).toBe(1);
    // The same stand-in its new places are listed under.
    await send(newPlace({ contributor: null }));
    expect(services.writes[1]!.contributor).toBe(record!.contributor);
  });

  it("lists a new place with its description, fee and the contacts that pass, and answers live", async () => {
    const body = newPlace({ contacts: { phone: "03 5555 0101", website: "https://bit.ly/3abcdef" } });
    const answer = await send({ ...body, report: { ...body.report, description: "  Flat gravel   by the river ", fee: "donation" } });
    expect(answer).toMatchObject({ state: "live" });
    const [place] = (await listing()).places;
    expect(place).toMatchObject({ description: "Flat gravel by the river", fee: "donation", contacts: { phone: "03 5555 0101" } });
    // The link shortener is left for a person, as the apply leaves it.
    expect(JSON.stringify(place)).not.toContain("bit.ly");
  });

  it("lists a new place without a description that fails the text checks", async () => {
    const body = newPlace();
    expect(await send({ ...body, report: { ...body.report, description: "Shit road in, avoid it", fee: false } })).toMatchObject({ state: "live" });
    const [place] = (await listing()).places;
    expect(place).toMatchObject({ fee: false });
    expect(place).not.toHaveProperty("description");
  });

  it("holds a new place the checks flag, and one without attestation, and doesn't list them", async () => {
    expect(await send(newPlace({ note: "unsafe: words" }))).toMatchObject(held("ai_check"));
    expect(await send(newPlace({ device: otherDevice(1), note: "Bloody shit road in" }))).toMatchObject(held("text_check"));
    const unattested = env(store, { requires_attestation: false });
    expect(await send(newPlace({ device: otherDevice(2), contributor: "acct_another_00000001" }), unattested)).toMatchObject(held("not_attested"));
    expect((await listing()).places).toEqual([]);
  });

  it("lists changes by map area, the latest for each place and fact, until 7 days after they reach the data", async () => {
    await send(fact(PLACE, "toilets", true));
    await send(fact(ELSEWHERE, "toilets", true));
    clock += HOUR;
    await send(fact(PLACE, "toilets", false));
    expect((await listing("?bbox=146.1,-36.9,146.5,-36.5")).changes).toEqual([
      { place: PLACE, fact: "toilets", value: false, accepted: "2026-11-03T10:00:00Z", in_data_at: null },
    ]);
    expect((await listing("?bbox=150,-34,151,-33")).changes.map((c) => c.place)).toEqual([ELSEWHERE]);
    expect((await listing()).changes.map((c) => c.place)).toEqual([PLACE, ELSEWHERE]);
    // The places are listed exactly as before alongside.
    expect((await listing()).places).toEqual([]);

    // As the apply will mark them once they are in the data.
    store.db.prepare("UPDATE recent_changes SET in_data_at = ? WHERE place = ?").run("2026-11-03T11:00:00Z", ELSEWHERE);
    clock = Date.parse("2026-11-10T10:59:00Z");
    expect((await listing()).changes.map((c) => [c.place, c.in_data_at])).toEqual([
      [PLACE, null],
      [ELSEWHERE, "2026-11-03T11:00:00Z"],
    ]);
    clock = Date.parse("2026-11-10T11:01:00Z");
    expect((await listing()).changes.map((c) => c.place)).toEqual([PLACE]);
    await createScheduled({ fetch: services.fetch, now: () => clock })(e);
    expect(store.db.prepare("SELECT place FROM recent_changes ORDER BY place").all()).toEqual([{ place: PLACE }, { place: PLACE }]);
  });

  describe("what the apply tells it", () => {
    const call = (route: "in-data" | "overruled", body: unknown, token = TOKEN) =>
      new Request(`https://intake.example/v1/places/recent/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const answer = async (request: Request, to: Env = e) => {
      const res = await handle(request, to);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const record = () => store.db.prepare("SELECT accepted, taken_down FROM contributor_records").all();
    const evidence = () => store.db.prepare("SELECT feedback_id, state FROM report_evidence ORDER BY received").all();

    it("keeps a change for 7 days from when the apply says the data has it, and keeps the first time it was told", async () => {
      await send(fact(PLACE, "toilets", true));
      const first = services.writes[0]!.id as string;
      await send(fact(ELSEWHERE, "toilets", true));
      clock += HOUR;
      // An id with no recent change is skipped.
      const other = "fb_01JC0000000000000000000099";
      expect(await answer(call("in-data", { ids: [first, other], at: "2026-11-03T09:30:00Z" }))).toEqual({ status: 200, body: { marked: 1 } });
      // Sent again by the next run: the first time stays.
      expect(await answer(call("in-data", { ids: [first], at: "2026-11-03T10:00:00Z" }))).toEqual({ status: 200, body: { marked: 0 } });
      expect((await listing()).changes.map((c) => [c.place, c.in_data_at])).toEqual([
        [PLACE, "2026-11-03T09:30:00Z"],
        [ELSEWHERE, null],
      ]);
      clock = Date.parse("2026-11-10T09:31:00Z");
      await createScheduled({ fetch: services.fetch, now: () => clock })(e);
      expect(store.db.prepare("SELECT place FROM recent_changes").all()).toEqual([{ place: ELSEWHERE }]);
    });

    it("takes a time later than its own clock as now", async () => {
      await send(fact(PLACE, "toilets", true));
      const id = services.writes[0]!.id as string;
      expect((await answer(call("in-data", { ids: [id], at: "2027-01-01T00:00:00Z" }))).status).toBe(200);
      expect((await listing()).changes[0]).toMatchObject({ in_data_at: "2026-11-03T09:00:00Z" });
    });

    it("takes an overruled change off the list at once, counts it against the contributor, and counts it once", async () => {
      await send(fact(PLACE, "toilets", true));
      const earlier = services.writes[0]!.id as string;
      clock += HOUR;
      await send(fact(PLACE, "toilets", false));
      const overruled = services.writes[1]!.id as string;
      expect((await listing()).changes).toMatchObject([{ place: PLACE, fact: "toilets", value: false }]);
      expect(record()).toEqual([{ accepted: 2, taken_down: 0 }]);

      expect(await answer(call("overruled", { ids: [overruled] }))).toEqual({ status: 200, body: { removed: 1 } });
      // The change it replaced is the latest again.
      expect((await listing()).changes).toEqual([{ place: PLACE, fact: "toilets", value: true, accepted: "2026-11-03T09:00:00Z", in_data_at: null }]);
      expect(record()).toEqual([{ accepted: 2, taken_down: 1 }]);
      expect(evidence()).toEqual([
        { feedback_id: earlier, state: "live" },
        { feedback_id: overruled, state: "held" },
      ]);

      // Sent again, as a failed run's items are decided again: nothing more changes.
      expect(await answer(call("overruled", { ids: [overruled] }))).toEqual({ status: 200, body: { removed: 0 } });
      expect(record()).toEqual([{ accepted: 2, taken_down: 1 }]);
      // With a change taken down, five accepted items are no longer a track record, so the AI checks their free text.
      store.db.prepare("UPDATE contributor_records SET accepted = 5").run();
      await send(fact(PLACE, "showers", true, { note: "Hot and clean" }));
      expect(safeAi.runs).toBe(1);
      store.db.prepare("UPDATE contributor_records SET taken_down = 0").run();
      await send(fact(PLACE, "drinking_water", true, { note: "Tank by the shed" }));
      expect(safeAi.runs).toBe(1);
    });

    it("leaves held items and ids it doesn't know as they are", async () => {
      expect(await send(contact(PLACE, "phone"))).toMatchObject(held("unconfirmed"));
      const heldId = services.writes[0]!.id as string;
      expect(await answer(call("overruled", { ids: [heldId, "fb_01JC0000000000000000000099"] }))).toEqual({ status: 200, body: { removed: 0 } });
      expect(evidence()).toEqual([{ feedback_id: heldId, state: "held" }]);
      expect(store.db.prepare("SELECT count(*) AS n FROM contributor_records").get()).toEqual({ n: 0 });
    });

    it("takes 500 ids in one call", async () => {
      await send(fact(PLACE, "toilets", true));
      const id = services.writes[0]!.id as string;
      const many = [id, ...Array.from({ length: 499 }, (_, n) => `fb_01JC${String(n).padStart(22, "0")}`)];
      expect(await answer(call("in-data", { ids: many, at: "2026-11-03T09:00:00Z" }))).toEqual({ status: 200, body: { marked: 1 } });
      expect(await answer(call("overruled", { ids: many }))).toEqual({ status: 200, body: { removed: 1 } });
    });

    it("refuses a wrong token and a bad body, and is not served without a token configured", async () => {
      const id = "fb_01JC0000000000000000000001";
      expect((await answer(call("in-data", { ids: [id], at: "2026-11-03T09:00:00Z" }, "not-the-token"))).status).toBe(401);
      expect((await answer(call("overruled", { ids: [id] }, "not-the-token"))).status).toBe(401);
      expect((await answer(call("in-data", { ids: [id] }))).status).toBe(400);
      expect((await answer(call("in-data", { ids: [id], at: "yesterday" }))).status).toBe(400);
      expect((await answer(call("in-data", { ids: ["ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA"], at: "2026-11-03T09:00:00Z" }))).status).toBe(400);
      expect((await answer(call("overruled", { ids: [] }))).status).toBe(400);
      expect((await answer(call("overruled", { ids: Array.from({ length: 501 }, () => id) }))).status).toBe(400);
      const { PLACES_TOKEN: _, ...noToken } = e;
      expect((await answer(call("overruled", { ids: [id] }), noToken)).status).toBe(404);
      const get = await handle(new Request("https://intake.example/v1/places/recent/overruled"), e);
      expect(get.status).toBe(405);
    });
  });

  it("forgets held evidence after 90 days", async () => {
    expect(await send(contact(PLACE, "phone"))).toMatchObject(held("unconfirmed"));
    clock += 91 * 24 * HOUR;
    await createScheduled({ fetch: services.fetch, now: () => clock })(e);
    expect(store.db.prepare("SELECT count(*) AS n FROM report_evidence").get()).toEqual({ n: 0 });
    expect(await send(contact(PLACE, "phone", { device: otherDevice(1), contributor: "acct_second_person_01" }))).toMatchObject(held("unconfirmed"));
  });

  it("answers held when the decision can't be recorded", async () => {
    const failing: D1Like = {
      prepare: (sql) => store.prepare(sql),
      batch: async () => {
        throw new Error("D1 is down");
      },
    };
    expect(await send(fact(PLACE, "toilets", true), { ...e, RECENT_LIST: failing })).toMatchObject(held("check_unavailable"));
    expect(services.writes).toHaveLength(1);
  });

  it("answers as before, with no state, without a D1 database bound or for items it doesn't decide", async () => {
    const { RECENT_LIST: _, ...without } = e;
    expect(Object.keys(await send(fact(PLACE, "toilets", true), without))).toEqual(["id"]);
    expect(Object.keys(await send(contact(PLACE, "phone"), without))).toEqual(["id"]);
    expect(Object.keys(await send(newPlace(), without))).toEqual(["id"]);
    expect(Object.keys(await send(report(PLACE, { kind: "name", value: "Lake Eppalock Rest Area" })))).toEqual(["id"]);
    expect(Object.keys(await send(report(PLACE, { kind: "closed" })))).toEqual(["id"]);
    expect(services.writes).toHaveLength(5);
  });
});
