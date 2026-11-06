import { NEW_PLACE_DAILY_LIMIT } from "../src/recent.js";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { HeldReason as SdkHeldReason } from "@opencampingdb/feedback";
import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import type { HeldReason } from "../src/decide.js";
import { createHandler, createScheduled, type CacheLike, type Env } from "../src/index.js";
import { insertPlace, type D1Like, type D1Statement } from "../src/recent.js";
import { ulid } from "../src/ulid.js";
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
  // The statement's own fields are kept, so the fake D1 can still run it in a batch.
  const wrap = (stmt: D1Statement): D1Statement => ({
    ...stmt,
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

/** What the intake stored for the inbox, oldest first: items written at once, then the queued ones (inbox-queue.ts). */
function inboxItems(services: ReturnType<typeof fakeServices>, store: ReturnType<typeof fakeD1>): Record<string, unknown>[] {
  const queued = store.db.prepare("SELECT content FROM inbox_queue ORDER BY rowid").all() as { content: string }[];
  return [...services.writes, ...queued.map((row) => JSON.parse(row.content) as Record<string, unknown>)];
}

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

const otherDevice = (i: number) => `${String(i).padStart(2, "0")}c24110-e2bb-4255-8caf-4136c566a962`;

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
  const written = () => inboxItems(services, store);

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
      contributor: written()[0]!.contributor,
    });
    expect(places[0]!.contributor).toMatch(/^ctr_[0-9a-f]{16}$/);
  });

  it("refuses a contributor's new place past the daily limit, and takes it the next day", async () => {
    for (let i = 0; i < NEW_PLACE_DAILY_LIMIT; i++) await add({ device: otherDevice(i) });
    const res = await handle(feedback(newPlace({ device: otherDevice(NEW_PLACE_DAILY_LIMIT) })), e);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "rate_limited" });
    expect(await list()).toHaveLength(NEW_PLACE_DAILY_LIMIT);
    clock += 24 * HOUR;
    await add({ device: otherDevice(NEW_PLACE_DAILY_LIMIT) });
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
    expect(written()).toHaveLength(1);
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
      expect(written().at(-1)).toMatchObject({ type: "withdraw", place: id, device: written()[0]!.device });
    });

    it("refuses a withdraw after 24 hours", async () => {
      const id = await add();
      clock += 24 * HOUR + 1000;
      const res = await handle(withdraw(id), e);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "withdraw_window_closed" });
      expect(written()).toHaveLength(1);
      expect(await list()).toHaveLength(1);
    });

    it("refuses a withdraw from another install", async () => {
      const id = await add();
      const res = await handle(withdraw(id, otherDevice(1)), e);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "not_your_place" });
      expect(written()).toHaveLength(1);
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
      expect(written().at(-1)).toMatchObject({ type: "withdraw", place: id });
    });
  });

  it("leaves out new places that fail the text checks or come without attestation, which still reach the inbox", async () => {
    await add({ note: "Bloody shit road in" });
    await add({ device: otherDevice(1), note: "Nice spot, click here for cheap gear" });
    const unattested = env(store, { requires_attestation: false });
    expect((await handle(feedback(newPlace({ device: otherDevice(2), contributor: "acct_another_00000001" })), unattested)).status).toBe(202);
    expect(written()).toHaveLength(3);
    expect(await list()).toEqual([]);
  });

  it("lists a new place whose note had a contact detail, which the inbox strips", async () => {
    const id = await add({ note: "Call 0412 345 678 for the gate" });
    expect((await list()).map((p) => p.id)).toEqual([id]);
    expect(JSON.stringify(written()[0])).not.toContain("0412");
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

    const DAY = 24 * HOUR;
    const reportRemove = (place: string, i: number) =>
      feedback({ ...newPlace({ device: otherDevice(i), contributor: `acct_reporter_000000${i}` }), place, location: undefined, report: { kind: "remove", reason: "fake" } });
    const withdraw = (place: string) => feedback({ type: "withdraw", place, device: ADDER, contributor: "acct_3f9a8b7c6d5e4f30", app_version: "1.0.0", consent: true });
    const prune = () => createScheduled({ fetch: services.fetch, now: () => clock })(e);
    const rows = (id: string) => ({
      places: store.db.prepare("SELECT count(*) AS n FROM new_places WHERE id = ?").get(id),
      evidence: store.db.prepare("SELECT count(*) AS n FROM evidence WHERE place_id = ?").get(id),
    });

    it("keeps listing places written into the data, marked with in_data_at from the intake's clock", async () => {
      const id = await add();
      const waiting = await add({ device: otherDevice(1) });
      clock += HOUR;
      const res = await handle(remove([id, "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA"]), e);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: 2 });
      const places = (await list()) as (Listed & { in_data_at?: string })[];
      expect(places.map((p) => [p.id, p.standing, p.in_data_at])).toEqual(
        [
          [id, "shown", "2026-11-03T10:00:00Z"],
          [waiting, "shown", undefined],
        ].sort(),
      );
      expect(Object.keys(places.find((p) => p.id === waiting)!)).not.toContain("in_data_at");
    });

    it("keeps the first in_data_at when the apply sends a place again", async () => {
      const id = await add();
      await handle(remove([id]), e);
      clock += 2 * DAY;
      expect((await handle(remove([id]), e)).status).toBe(200);
      expect(((await list()) as (Listed & { in_data_at?: string })[])[0]!.in_data_at).toBe("2026-11-03T09:00:00Z");
    });

    it("lists a place hidden by removal reports after it reached the data as hidden", async () => {
      const id = await add();
      await handle(remove([id]), e);
      expect((await handle(reportRemove(id, 1), e)).status).toBe(202);
      expect((await list()).map((p) => p.standing)).toEqual(["shown"]);
      expect((await handle(reportRemove(id, 2), e)).status).toBe(202);
      expect((await list()).map((p) => [p.id, p.standing])).toEqual([[id, "hidden"]]);
    });

    it("lists a place whose contributor is blocked after it reached the data as hidden", async () => {
      const id = await add();
      await handle(remove([id]), e);
      const contributor = written()[0]!.contributor as string;
      const block = new Request("https://intake.example/v1/places/recent/block", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ contributors: [contributor] }),
      });
      expect((await handle(block, e)).status).toBe(200);
      expect((await list()).map((p) => [p.id, p.standing])).toEqual([[id, "hidden"]]);
    });

    it("lists a place its adder withdraws after it reached the data as withdrawn", async () => {
      const id = await add();
      clock += HOUR;
      await handle(remove([id]), e);
      clock += HOUR;
      expect((await handle(withdraw(id), e)).status).toBe(202);
      expect((await list()).map((p) => [p.id, p.standing])).toEqual([[id, "withdrawn"]]);
    });

    it("still leaves out a hidden place the apply run is not done with", async () => {
      const id = await add();
      await handle(reportRemove(id, 1), e);
      await handle(reportRemove(id, 2), e);
      expect(await list()).toEqual([]);
    });

    it("stops listing a place 7 days after in_data_at, even before the prune", async () => {
      const id = await add();
      await handle(remove([id]), e);
      clock = NOW + 7 * DAY;
      expect((await list()).map((p) => p.id)).toEqual([id]);
      clock = NOW + 7 * DAY + 1000;
      expect(await list()).toEqual([]);
    });

    it("deletes a place and its evidence 7 days after in_data_at", async () => {
      // Fixed random bytes for each item, so the place can be sent again with the same id after it is deleted.
      let seed = 1;
      handle = createHandler({ fetch: services.fetch, now: () => clock, randomBytes: (n) => new Uint8Array(n).fill(seed) });
      const id = await add();
      seed = 2;
      expect((await handle(reportRemove(id, 1), e)).status).toBe(202);
      seed = 3;
      expect((await handle(reportRemove(id, 2), e)).status).toBe(202);
      await handle(remove([id]), e);
      const other = await add({ device: otherDevice(5), contributor: "acct_second_person_01" });

      clock = NOW + 7 * DAY - 1000;
      await prune();
      expect(rows(id)).toEqual({ places: { n: 1 }, evidence: { n: 2 } });
      clock = NOW + 7 * DAY + 1000;
      await prune();
      expect(rows(id)).toEqual({ places: { n: 0 }, evidence: { n: 0 } });
      // A place the apply is not done with stays, however old.
      expect(rows(other).places).toEqual({ n: 1 });

      // The same item sent again at the same moment, so it makes the same id.
      seed = 1;
      clock = NOW;
      expect(await add()).toBe(id);
      // Had the two removal reports outlived the place, they would hide it again.
      expect((await list()).find((p) => p.id === id)?.standing).toBe("shown");
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
    const contributorOf = (i: number) => written()[i]!.contributor as string;

    it("takes a blocked contributor's new places off the list, and lists none they add later", async () => {
      await add();
      const kept = await add({ device: otherDevice(1), contributor: "acct_second_person_01" });
      const res = await handle(block([contributorOf(0)]), e);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ blocked: 1 });
      expect((await list()).map((p) => p.id)).toEqual([kept]);
      const later = await handle(feedback(newPlace({ device: otherDevice(2) })), e);
      expect(later.status).toBe(202);
      expect(written()).toHaveLength(3);
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
      expect(JSON.stringify(written())).not.toContain(ADDER);
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
  const written = () => inboxItems(services, store);

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
    expect(answer).toEqual({ id: written()[0]!.id, state: "live" });
    expect(written()[0]).toMatchObject({ type: "report", place: PLACE, report: { kind: "fact", fact: "toilets", value: true } });
    expect(written()[0]).not.toHaveProperty("state");
    // The decision goes into the inbox with the item, for the apply.
    expect(written()[0]!.intake).toEqual({ state: "live" });
    expect((await listing()).changes).toEqual([{ place: PLACE, fact: "toilets", value: true, accepted: "2026-11-03T09:00:00Z", in_data_at: null }]);
    // A fact with no free text never goes to the AI, and counts towards the contributor's track record.
    expect(safeAi.runs).toBe(0);
    expect(store.db.prepare("SELECT accepted, taken_down FROM contributor_records").all()).toEqual([{ accepted: 1, taken_down: 0 }]);
  });

  it("takes pets_months off with pets that is no longer seasonal, and holds months for a place that is not seasonal", async () => {
    index(UNKNOWN, [146, -37], { pets: "seasonal", pets_months: "May-Sep" });
    expect(await send(fact(UNKNOWN, "pets", "leashed"))).toMatchObject({ state: "live" });
    expect((await listing()).changes).toEqual([
      { place: UNKNOWN, fact: "pets", value: "leashed", accepted: "2026-11-03T09:00:00Z", in_data_at: null },
      { place: UNKNOWN, fact: "pets_months", value: null, accepted: "2026-11-03T09:00:00Z", in_data_at: null },
    ]);
    clock += HOUR;
    expect(await send(fact(UNKNOWN, "pets_months", "Dec-Feb", { device: otherDevice(1), contributor: "acct_second_person_01" }))).toMatchObject(held("not_seasonal"));
  });

  it("answers held for a Commons photo that is not of the place, and keeps the decision with the item for the apply", async () => {
    const answer = await send(report(PLACE, { kind: "commons_mismatch", file: "Lake Pool 6.jpg" }));
    expect(answer).toEqual({ id: written()[0]!.id, ...held("commons_report") });
    expect(written()[0]).toMatchObject({ report: { kind: "commons_mismatch", file: "Lake Pool 6.jpg" }, intake: held("commons_report") });
    expect((await listing()).changes).toEqual([]);
  });

  it("lets one attested report replace a fact the release set by a rule, and doubts take one down", async () => {
    index(UNKNOWN, [146, -37], { vehicle_access: "heavy_vehicles_only", toilets: true }, { vehicle_access: "rule", toilets: "rule" });
    expect(await send(fact(UNKNOWN, "toilets", false))).toMatchObject({ state: "live" });
    expect(await send(report(UNKNOWN, { kind: "doubt", fact: "vehicle_access" }))).toMatchObject(held("single_doubt"));
    clock += HOUR;
    expect(await send(report(UNKNOWN, { kind: "doubt", fact: "vehicle_access" }, { device: otherDevice(1), contributor: "acct_second_person_01" }))).toMatchObject({ state: "live" });
    expect((await listing()).changes).toContainEqual(expect.objectContaining({ place: UNKNOWN, fact: "vehicle_access", value: null }));
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
      id: written()[0]!.id,
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
    expect(written()).toHaveLength(6);
    // Each hold goes into the inbox with the item, so the apply never publishes what a check held.
    expect(written().map((w) => w.intake)).toEqual(
      ["owner_value", "link_check", "text_check", "ai_check", "unknown_place", "check_unavailable"].map(held),
    );
  });

  it("stores no decision on items it doesn't decide, and stores a failed decision as check_unavailable", async () => {
    await send(report(PLACE, { kind: "closed" }));
    expect(written()[0]).not.toHaveProperty("intake");
    // The decision's reads fail, but D1 still takes the item.
    const broken: D1Like = {
      prepare: (sql) => {
        if (sql.includes("contributor_records")) throw new Error("D1 read failed");
        return store.prepare(sql);
      },
      batch: (list) => store.batch(list),
    };
    expect(await send(fact(PLACE, "toilets", true), { ...e, RECENT_LIST: broken })).toMatchObject(held("check_unavailable"));
    expect(written()[1]!.intake).toEqual(held("check_unavailable"));
  });

  it("holds a fact past the contributor's 50 live changes for the day", async () => {
    expect(await send(fact(PLACE, "toilets", true))).toMatchObject({ state: "live" });
    const contributor = written()[0]!.contributor as string;
    store.db.prepare("UPDATE live_counts SET count = 50 WHERE contributor = ?").run(contributor);
    expect(await send(fact(PLACE, "drinking_water", true))).toMatchObject(held("daily_cap"));
    clock += 24 * HOUR;
    expect(await send(fact(PLACE, "drinking_water", true))).toMatchObject({ state: "live" });
  });

  it("holds a fact past 50 live changes for the day from one network, however often the install changes its contributor id", async () => {
    const network = { "cf-connecting-ip": "203.0.113.7" };
    for (let i = 0; i < 50; i++) {
      const res = await handle(feedback(fact(PLACE, "toilets", i % 2 === 0, { device: otherDevice(i % 10), contributor: `acct_rotating_${String(i).padStart(6, "0")}` }), network), e);
      expect(await res.json()).toMatchObject({ state: "live" });
      clock += 1000;
    }
    const res = await handle(feedback(fact(PLACE, "showers", true, { contributor: "acct_rotating_fresh01" }), network), e);
    expect(await res.json()).toMatchObject(held("daily_cap"));
    // Another network is not held by it.
    const other = await handle(feedback(fact(PLACE, "showers", true, { contributor: "acct_rotating_fresh01" }), { "cf-connecting-ip": "198.51.100.7" }), e);
    expect(await other.json()).toMatchObject({ state: "live" });
  });

  it("holds everything from a blocked contributor", async () => {
    await send(fact(PLACE, "toilets", true));
    const contributor = written()[0]!.contributor as string;
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

  it("decides against the index, not a blocked contributor's change", async () => {
    await send(fact(PLACE, "toilets", true));
    const blocked = written()[0]!.contributor as string;
    const block = new Request("https://intake.example/v1/places/recent/block", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ contributors: [blocked] }),
    });
    expect((await handle(block, e)).status).toBe(200);
    clock += HOUR;
    // The index still has false, so true from someone else is a change of its own.
    expect(await send(fact(PLACE, "toilets", true, { device: otherDevice(1), contributor: "acct_second_person_01" }))).toMatchObject({ state: "live" });
    expect((await listing()).changes).toEqual([{ place: PLACE, fact: "toilets", value: true, accepted: "2026-11-03T10:00:00Z", in_data_at: null }]);
  });

  it("stops laying a change over the index once a release loaded the place's cell after the data had it", async () => {
    const load = (facts: Record<string, unknown>) => {
      const line = { id: PLACE, cell: [146, -37], facts, fact_sources: {}, fact_dates: {} };
      const hash = sha(JSON.stringify(line));
      return new Request("https://intake.example/v1/place-index", {
        method: "PUT",
        headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${TOKEN}` },
        body: `${JSON.stringify({ cells: [{ cell: [146, -37], hash }] })}\n${JSON.stringify(line)}\n`,
      });
    };
    await send(fact(PLACE, "toilets", true));
    const first = written()[0]!.id as string;
    clock += HOUR;
    // A release that does not hold the change yet: the change still lies over it.
    expect((await handle(load({ toilets: false }), e)).status).toBe(200);
    clock += HOUR;
    const mark = new Request("https://intake.example/v1/places/recent/in-data", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ ids: [first], at: new Date(clock).toISOString() }),
    });
    expect((await handle(mark, e)).status).toBe(200);
    expect(await send(fact(PLACE, "toilets", true, { device: otherDevice(1), contributor: "acct_second_person_01" }))).toMatchObject({ state: "live" });
    expect(store.db.prepare("SELECT count(*) AS n FROM recent_changes").get()).toEqual({ n: 1 });

    // A later release, after a person set it back to false on the data: the index is right, and the old change is not laid over it.
    clock += HOUR;
    expect((await handle(load({ toilets: false }), e)).status).toBe(200);
    clock += HOUR;
    expect(await send(fact(PLACE, "toilets", true, { device: otherDevice(2), contributor: "acct_third_person_01" }))).toMatchObject({ state: "live" });
    expect(store.db.prepare("SELECT feedback_id FROM recent_changes ORDER BY accepted").all()).toHaveLength(2);
  });

  it("skips Llama Guard for a contributor with a track record", async () => {
    await send(fact(PLACE, "toilets", true, { note: "Clean, and open all night" }));
    expect(safeAi.runs).toBe(1);
    const contributor = written()[0]!.contributor as string;
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
    expect(written()[0]).not.toHaveProperty("contributor");
  });

  it("counts a signed-out Android install's live changes under its hashed install", async () => {
    expect(await send(fact(PLACE, "toilets", true, { contributor: null }))).toMatchObject({ state: "live" });
    expect(written()[0]).not.toHaveProperty("contributor");
    const [record] = store.db.prepare("SELECT contributor, accepted FROM contributor_records").all() as { contributor: string; accepted: number }[];
    expect(record!.contributor).toMatch(/^ctr_[0-9a-f]{16}$/);
    expect(record!.accepted).toBe(1);
    // The same stand-in its new places are listed under.
    await send(newPlace({ contributor: null }));
    expect(written()[1]!.contributor).toBe(record!.contributor);
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
    // The data has held ELSEWHERE's change for 7 days, and PLACE's changes were accepted more than 7 days ago and never reached it.
    expect(store.db.prepare("SELECT place FROM recent_changes ORDER BY place").all()).toEqual([]);
  });

  it("drops a change the data never took 7 days after it was accepted", async () => {
    await send(fact(PLACE, "toilets", true));
    const prune = () => createScheduled({ fetch: services.fetch, now: () => clock })(e);
    clock = Date.parse("2026-11-10T08:59:00Z");
    await prune();
    expect((await listing()).changes.map((c) => c.place)).toEqual([PLACE]);
    clock = Date.parse("2026-11-10T09:01:00Z");
    await prune();
    expect(store.db.prepare("SELECT count(*) AS n FROM recent_changes").get()).toEqual({ n: 0 });
  });

  describe("doubts", () => {
    const doubt = (place: string, name: string, who: Parameters<typeof report>[2] & { note?: string } = {}) =>
      report(place, { kind: "doubt", fact: name, ...(who.note ? { note: who.note } : {}) }, who);
    const second = { device: otherDevice(1), contributor: "acct_second_person_01" };
    const third = { device: otherDevice(2), contributor: "acct_third_person_01" };
    const fourth = { device: otherDevice(3), contributor: "acct_fourth_person_01" };

    it("holds one doubt for a reviewer, and the fact stays", async () => {
      expect(await send(doubt(PLACE, "toilets"))).toEqual({ id: written()[0]!.id, ...held("single_doubt") });
      expect(written()[0]!.intake).toEqual(held("single_doubt"));
      expect((await listing()).changes).toEqual([]);
    });

    it("takes the fact down on a second source's doubt, as a recent change with no value", async () => {
      await send(doubt(PLACE, "toilets"));
      clock += HOUR;
      expect(await send(doubt(PLACE, "toilets", second))).toMatchObject({ state: "live" });
      expect(written()[1]!.intake).toEqual({ state: "live" });
      expect((await listing()).changes).toEqual([{ place: PLACE, fact: "toilets", value: null, accepted: "2026-11-03T10:00:00Z", in_data_at: null }]);
      // Once it is down, a doubt about it is about a fact the place no longer has.
      expect(await send(doubt(PLACE, "toilets", third))).toMatchObject(held("no_value"));
      // One traveller confirming the old value is not enough to bring it back.
      clock += HOUR;
      expect(await send(fact(PLACE, "toilets", false, third))).toMatchObject(held("taken_down"));
      expect((await listing()).changes).toMatchObject([{ fact: "toilets", value: null }]);
    });

    async function takeDown(name = "toilets") {
      await send(doubt(PLACE, name));
      clock += HOUR;
      expect(await send(doubt(PLACE, name, second))).toMatchObject({ state: "live" });
      clock += HOUR;
    }

    it("restores the fact when two new travellers confirm it, and closes the case", async () => {
      await takeDown();
      expect(await send(fact(PLACE, "toilets", false, third))).toMatchObject(held("taken_down"));
      clock += HOUR;
      expect(await send(fact(PLACE, "toilets", false, fourth))).toMatchObject({ state: "live" });
      expect((await listing()).changes).toEqual([{ place: PLACE, fact: "toilets", value: false, accepted: "2026-11-03T12:00:00Z", in_data_at: null }]);
      // The case is closed: a report of another value is decided as usual, against the confirmations.
      clock += HOUR;
      expect(await send(fact(PLACE, "toilets", true, { device: otherDevice(5), contributor: "acct_fifth_person_01" }))).toMatchObject(held("disagreement"));
    });

    it("replaces the fact with a new value, and closes the case", async () => {
      await takeDown();
      expect(await send(fact(PLACE, "toilets", true, third))).toMatchObject({ state: "live" });
      expect((await listing()).changes).toMatchObject([{ fact: "toilets", value: true }]);
      // A doubt now is about the new value: one source is held, and the fact stays.
      clock += HOUR;
      expect(await send(doubt(PLACE, "toilets", fourth))).toMatchObject(held("single_doubt"));
      expect((await listing()).changes).toMatchObject([{ fact: "toilets", value: true }]);
    });

    it("holds a doubt about a fact from OSM or the owner, and one about a fact the place doesn't have", async () => {
      const OWNED = "ocdb_01JB0000000000000000000003";
      index(OWNED, [150, -34], { pets: "yes", showers: true }, { pets: "owner", showers: "osm" });
      for (const name of ["pets", "showers"]) {
        await send(doubt(OWNED, name));
        expect(await send(doubt(OWNED, name, second))).toMatchObject(held("protected_source"));
      }
      expect(await send(doubt(PLACE, "drinking_water"))).toMatchObject(held("no_value"));
      expect((await listing()).changes).toEqual([]);
    });

    it("holds a second doubt sent without attestation, which the apply decides", async () => {
      await send(doubt(PLACE, "toilets"));
      const unattested = env(store, { requires_attestation: false });
      expect(await send(doubt(PLACE, "toilets", second), unattested)).toMatchObject(held("not_attested"));
      expect((await listing()).changes).toEqual([]);
    });

    it("holds a takedown whose note fails the checks, and the fact stays", async () => {
      await send(doubt(PLACE, "toilets"));
      expect(await send(doubt(PLACE, "toilets", { ...second, note: "Bloody shit dunny" }))).toMatchObject(held("text_check"));
      expect((await listing()).changes).toEqual([]);
    });

    it("counts a takedown as one live change for the day, and a held doubt as none", async () => {
      await send(fact(PLACE, "showers", true, second));
      const contributor = written()[0]!.contributor as string;
      store.db.prepare("UPDATE live_counts SET count = 49 WHERE contributor = ?").run(contributor);
      clock += HOUR;
      await send(doubt(PLACE, "toilets"));
      expect(await send(doubt(PLACE, "toilets", second))).toMatchObject({ state: "live" });
      expect(await send(doubt(PLACE, "showers", second))).toMatchObject(held("single_doubt"));
      expect(await send(fact(PLACE, "drinking_water", true, second))).toMatchObject(held("daily_cap"));
    });

    it("forgets a case 90 days after the takedown", async () => {
      await takeDown();
      clock += 91 * 24 * HOUR;
      await createScheduled({ fetch: services.fetch, now: () => clock })(e);
      expect(store.db.prepare("SELECT count(*) AS n FROM doubt_cases").get()).toEqual({ n: 0 });
    });

    const overruled = (ids: string[]) =>
      handle(
        new Request("https://intake.example/v1/places/recent/overruled", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ ids }),
        }),
        e,
      );

    it("puts the fact back when the apply overrules the takedown", async () => {
      await takeDown();
      const takedown = written()[1]!.id as string;
      expect((await overruled([takedown])).status).toBe(200);
      expect((await listing()).changes).toEqual([]);
      // The place has its value again, and one report of it is a value it already has.
      expect(await send(fact(PLACE, "toilets", false, third))).toMatchObject({ state: "live" });
      expect((await listing()).changes).toEqual([]);
    });

    const doubtCases = (cases: unknown, token = TOKEN) =>
      handle(
        new Request("https://intake.example/v1/places/recent/doubt-cases", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ cases }),
        }),
        e,
      );
    // The release drops the fact from the index once the apply's takedown is in the data.
    const released = () =>
      store.db.prepare("UPDATE place_index SET facts = ? WHERE id = ?").run(JSON.stringify({ phone: "03 5555 0100", website: "https://lake.example.org" }), PLACE);
    const caseRows = () => store.db.prepare("SELECT place, fact, value, taken_down_at, feedback_id, closed_by FROM doubt_cases").all();

    it("opens the case when the apply takes a fact down, so one confirmation does not bring it back", async () => {
      expect(await send(doubt(PLACE, "toilets"))).toMatchObject(held("single_doubt"));
      clock += HOUR;
      expect(await send(doubt(PLACE, "toilets", second), env(store, { requires_attestation: false }))).toMatchObject(held("not_attested"));
      const takedown = written()[1]!;
      const res = await doubtCases([{ place: PLACE, fact: "toilets", value: false, taken_down_at: takedown.received, feedback_id: takedown.id }]);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ opened: 1 });
      released();
      clock += HOUR;
      expect(await send(fact(PLACE, "toilets", false, third))).toMatchObject(held("taken_down"));
      clock += HOUR;
      expect(await send(fact(PLACE, "toilets", false, fourth))).toMatchObject({ state: "live" });
      expect(caseRows()).toEqual([expect.objectContaining({ place: PLACE, fact: "toilets", closed_by: written()[3]!.id })]);
    });

    it("keeps a case the intake closed after the apply's takedown, and its own later takedown", async () => {
      await takeDown();
      const own = written()[1]!;
      // An earlier takedown from the apply does not replace the intake's own.
      const before = { place: PLACE, fact: "toilets", value: false, taken_down_at: "2026-11-03T08:00:00Z", feedback_id: "fb_01JC0000000000000000000001" };
      expect(await (await doubtCases([before])).json()).toEqual({ opened: 0 });
      expect(caseRows()).toEqual([expect.objectContaining({ taken_down_at: own.received, feedback_id: own.id, closed_by: null })]);
      // Sent again on every run: nothing changes.
      const same = { ...before, taken_down_at: own.received, feedback_id: own.id };
      expect(await (await doubtCases([same])).json()).toEqual({ opened: 0 });
      // Closed by a restore at the intake: an apply takedown from before the restore stays closed, a later one opens it again.
      expect(await send(fact(PLACE, "toilets", false, third))).toMatchObject(held("taken_down"));
      clock += HOUR;
      expect(await send(fact(PLACE, "toilets", false, fourth))).toMatchObject({ state: "live" });
      const restore = written()[3]!;
      expect(await (await doubtCases([{ ...same, taken_down_at: "2026-11-03T11:30:00Z" }])).json()).toEqual({ opened: 0 });
      expect(caseRows()).toEqual([expect.objectContaining({ closed_by: restore.id })]);
      const later = { ...same, taken_down_at: "2026-11-03T13:00:00Z", feedback_id: "fb_01JC0000000000000000000002" };
      expect(await (await doubtCases([later])).json()).toEqual({ opened: 1 });
      expect(caseRows()).toEqual([{ place: PLACE, fact: "toilets", value: "false", taken_down_at: later.taken_down_at, feedback_id: later.feedback_id, closed_by: null }]);
    });

    it("refuses doubt cases without the token, or that are not cases", async () => {
      const good = { place: PLACE, fact: "toilets", value: false, taken_down_at: "2026-11-03T08:00:00Z", feedback_id: "fb_01JC0000000000000000000001" };
      expect((await doubtCases([good], "wrong-token")).status).toBe(401);
      for (const bad of [[], [{ ...good, fact: "phone" }], [{ ...good, value: "maybe" }], [{ ...good, taken_down_at: "yesterday" }], [{ ...good, feedback_id: "x" }], [{ ...good, place: "x" }], "x"]) {
        expect((await doubtCases(bad)).status).toBe(400);
      }
      expect(caseRows()).toEqual([]);
    });
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
      const first = written()[0]!.id as string;
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
      // A tick before ELSEWHERE's unmarked change is 7 days old, and after PLACE's 7 days in the data.
      clock = Date.parse("2026-11-10T08:59:00Z");
      store.db.prepare("UPDATE recent_changes SET in_data_at = ? WHERE place = ?").run("2026-11-03T08:58:00Z", PLACE);
      await createScheduled({ fetch: services.fetch, now: () => clock })(e);
      expect(store.db.prepare("SELECT place FROM recent_changes").all()).toEqual([{ place: ELSEWHERE }]);
    });

    it("takes a time later than its own clock as now", async () => {
      await send(fact(PLACE, "toilets", true));
      const id = written()[0]!.id as string;
      expect((await answer(call("in-data", { ids: [id], at: "2027-01-01T00:00:00Z" }))).status).toBe(200);
      expect((await listing()).changes[0]).toMatchObject({ in_data_at: "2026-11-03T09:00:00Z" });
    });

    it("takes an overruled change off the list at once, counts it against the contributor, and counts it once", async () => {
      await send(fact(PLACE, "toilets", true));
      const earlier = written()[0]!.id as string;
      clock += HOUR;
      await send(fact(PLACE, "toilets", false));
      const overruled = written()[1]!.id as string;
      expect((await listing()).changes).toMatchObject([{ place: PLACE, fact: "toilets", value: false }]);
      expect(record()).toEqual([{ accepted: 2, taken_down: 0 }]);

      expect(await answer(call("overruled", { ids: [overruled], refused: [overruled] }))).toEqual({ status: 200, body: { removed: 1 } });
      // The change it replaced is the latest again.
      expect((await listing()).changes).toEqual([{ place: PLACE, fact: "toilets", value: true, accepted: "2026-11-03T09:00:00Z", in_data_at: null }]);
      expect(record()).toEqual([{ accepted: 2, taken_down: 1 }]);
      expect(evidence()).toEqual([
        { feedback_id: earlier, state: "live" },
        { feedback_id: overruled, state: "held" },
      ]);

      // Sent again, as a failed run's items are decided again: nothing more changes.
      expect(await answer(call("overruled", { ids: [overruled], refused: [overruled] }))).toEqual({ status: 200, body: { removed: 0 } });
      expect(record()).toEqual([{ accepted: 2, taken_down: 1 }]);
      // With a change taken down, five accepted items are no longer a track record, so the AI checks their free text.
      store.db.prepare("UPDATE contributor_records SET accepted = 5").run();
      await send(fact(PLACE, "showers", true, { note: "Hot and clean" }));
      expect(safeAi.runs).toBe(1);
      store.db.prepare("UPDATE contributor_records SET taken_down = 0").run();
      await send(fact(PLACE, "drinking_water", true, { note: "Tank by the shed" }));
      expect(safeAi.runs).toBe(1);
    });

    it("takes a change the apply sent to a person off the list without counting it against the contributor", async () => {
      await send(fact(PLACE, "toilets", true));
      const forPerson = written()[0]!.id as string;
      await send(fact(PLACE, "showers", true));
      const refused = written()[1]!.id as string;
      // Only the refused one counts, and only when it is one of the ids.
      expect(await answer(call("overruled", { ids: [forPerson], refused: [refused] }))).toEqual({ status: 200, body: { removed: 1 } });
      expect(record()).toEqual([{ accepted: 2, taken_down: 0 }]);
      expect((await listing()).changes.map((c) => c.fact)).toEqual(["showers"]);
      // An apply that sends no refused list counts nothing.
      expect(await answer(call("overruled", { ids: [refused] }))).toEqual({ status: 200, body: { removed: 1 } });
      expect(record()).toEqual([{ accepted: 2, taken_down: 0 }]);
    });

    it("counts each refused item once, across calls", async () => {
      await send(fact(PLACE, "toilets", true));
      const a = written()[0]!.id as string;
      await send(fact(PLACE, "showers", true));
      const b = written()[1]!.id as string;
      expect(await answer(call("overruled", { ids: [a, b], refused: [a, b] }))).toEqual({ status: 200, body: { removed: 2 } });
      expect(record()).toEqual([{ accepted: 2, taken_down: 2 }]);
    });

    it("leaves held items and ids it doesn't know as they are", async () => {
      expect(await send(contact(PLACE, "phone"))).toMatchObject(held("unconfirmed"));
      const heldId = written()[0]!.id as string;
      expect(await answer(call("overruled", { ids: [heldId, "fb_01JC0000000000000000000099"] }))).toEqual({ status: 200, body: { removed: 0 } });
      expect(evidence()).toEqual([{ feedback_id: heldId, state: "held" }]);
      expect(store.db.prepare("SELECT count(*) AS n FROM contributor_records").get()).toEqual({ n: 0 });
    });

    it("takes 500 ids in one call", async () => {
      await send(fact(PLACE, "toilets", true));
      const id = written()[0]!.id as string;
      const many = [id, ...Array.from({ length: 499 }, (_, n) => `fb_01JC${String(n).padStart(22, "0")}`)];
      expect(await answer(call("in-data", { ids: many, at: "2026-11-03T09:00:00Z" }))).toEqual({ status: 200, body: { marked: 1 } });
      expect(await answer(call("overruled", { ids: many, refused: many }))).toEqual({ status: 200, body: { removed: 1 } });
      expect(record()).toEqual([{ accepted: 1, taken_down: 1 }]);
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
      expect((await answer(call("overruled", { ids: [id], refused: "all" }))).status).toBe(400);
      expect((await answer(call("overruled", { ids: [id], refused: ["ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA"] }))).status).toBe(400);
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

  it("answers 503 and gives the daily cap's place back when the item and its decision can't be stored", async () => {
    const count = () => store.db.prepare("SELECT contributor, count FROM live_counts ORDER BY contributor").all();
    const failing: D1Like = {
      prepare: (sql) => store.prepare(sql),
      batch: async () => {
        throw new Error("D1 is down");
      },
    };
    const res = await handle(feedback(fact(PLACE, "toilets", true), { "cf-connecting-ip": "203.0.113.7" }), { ...e, RECENT_LIST: failing });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "storage_unavailable" });
    expect(count().every((row) => (row as { count: number }).count === 0)).toBe(true);
    // Neither the item nor its change was stored: the two go in one batch.
    expect(written()).toEqual([]);
    expect((await listing()).changes).toEqual([]);
    // A change that is stored keeps its place.
    await send(fact(PLACE, "toilets", true));
    expect(count()).toEqual([
      { contributor: expect.stringMatching(/^ctr_/), count: 1 },
      { contributor: expect.stringMatching(/^org_/), count: 0 },
    ]);
    expect(written()).toHaveLength(1);
  });

  it("answers as before, with no state, without a D1 database bound or for items it doesn't decide", async () => {
    const { RECENT_LIST: _, ...without } = e;
    expect(Object.keys(await send(fact(PLACE, "toilets", true), without))).toEqual(["id"]);
    expect(Object.keys(await send(contact(PLACE, "phone"), without))).toEqual(["id"]);
    expect(Object.keys(await send(newPlace(), without))).toEqual(["id"]);
    expect(Object.keys(await send(report(PLACE, { kind: "name", value: "Lake Eppalock Rest Area" })))).toEqual(["id"]);
    expect(Object.keys(await send(report(PLACE, { kind: "closed" })))).toEqual(["id"]);
    expect(written()).toHaveLength(5);
  });

  describe("progress", () => {
    const progressCall = (items: unknown, token = TOKEN) =>
      handle(
        new Request("https://intake.example/v1/feedback/progress", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ items }),
        }),
        e,
      );
    const ask = async (query: string, headers: Record<string, string> = {}) => {
      const res = await handle(new Request(`https://intake.example/v1/feedback/progress${query}`, { headers }), e);
      return { status: res.status, headers: res.headers, body: (await res.json()) as { items?: Record<string, unknown>[] } };
    };
    const progressOf = async (id: string) => (await ask(`?ids=${id}`)).body.items![0]!;
    const rows = () => store.db.prepare("SELECT feedback_id, state, held_reason, refused_by, in_data_at, updated FROM item_progress").all();
    // Sent before rows were kept, on 1 November.
    const OLD = `fb_${ulid(Date.parse("2026-11-01T00:00:00Z"), () => new Uint8Array(16))}`;

    it("keeps a row from send time: live for a change put live, received with the held reason for a held one", async () => {
      const live = (await send(fact(PLACE, "toilets", true))).id as string;
      const held = (await send(report(PLACE, { kind: "doubt", fact: "toilets" }))).id as string;
      const named = (await send(report(PLACE, { kind: "name", value: "Lake Eppalock Rest Area" }))).id as string;
      expect(await progressOf(live)).toEqual({ id: live, state: "live", place: PLACE, received: "2026-11-03T09:00:00Z" });
      expect(await progressOf(held)).toEqual({ id: held, state: "received", held_reason: "single_doubt", place: PLACE, received: "2026-11-03T09:00:00Z" });
      // Items the intake doesn't decide are received, with nothing decided.
      expect(await progressOf(named)).toEqual({ id: named, state: "received", place: PLACE, received: "2026-11-03T09:00:00Z" });
    });

    it("keeps a new place's row under its new place id, and never the traveller's words, device or contributor", async () => {
      const id = (await send(newPlace())).id as string;
      const answer = await progressOf(id);
      expect(answer).toEqual({ id, state: "live", place: `ocdb_${id.slice(3)}`, received: "2026-11-03T09:00:00Z" });
      expect(JSON.stringify(answer)).not.toMatch(/Gravel|ctr_|acct_/);
    });

    it("refuses an update from the apply without the token", async () => {
      const res = await progressCall([{ id: OLD, state: "accepted" }], "not-the-token");
      expect(res.status).toBe(401);
      expect(rows()).toEqual([]);
    });

    it("refuses updates that are not progress the apply sends", async () => {
      const good = { id: OLD, state: "accepted" };
      for (const bad of [
        [],
        Array.from({ length: 501 }, () => good),
        [{ ...good, id: "ocdb_01JB0000000000000000000001" }],
        [{ ...good, state: "live" }],
        [{ ...good, state: "unknown" }],
        [{ id: OLD, state: "refused" }],
        [{ id: OLD, state: "refused", by: "someone" }],
        [{ ...good, by: "rules" }],
        [{ id: OLD, state: "in_data" }],
        [{ ...good, in_data_at: "2026-11-03T09:00:00Z" }],
        [{ ...good, place: "x" }],
        [{ ...good, decided_at: "yesterday" }],
        "x",
      ]) {
        expect((await progressCall(bad)).status).toBe(400);
      }
      expect(rows()).toEqual([]);
    });

    it("takes an item it has no row for, received at the time in its id", async () => {
      const res = await progressCall([{ id: OLD, state: "accepted", reason: "fee accepted", place: PLACE, decided_at: "2026-11-03T08:00:00Z" }]);
      expect(await res.json()).toEqual({ updated: 1 });
      expect(await progressOf(OLD)).toEqual({
        id: OLD,
        state: "accepted",
        reason: "fee accepted",
        place: PLACE,
        received: "2026-11-01T00:00:00Z",
        decided_at: "2026-11-03T08:00:00Z",
      });
    });

    it("never moves a row back from in_data or refused, and keeps the first in_data_at", async () => {
      const id = (await send(fact(PLACE, "toilets", true))).id as string;
      const other = (await send(report(PLACE, { kind: "name", value: "Lake Eppalock Rest Area" }))).id as string;
      clock += HOUR;
      await progressCall([
        { id, state: "in_data", reason: "fact set", decided_at: "2026-11-03T09:30:00Z", in_data_at: "2026-11-03T10:00:00Z" },
        { id: other, state: "refused", by: "reviewer", reason: "a reviewer did not take the change into the data" },
      ]);
      clock += HOUR;
      const later = await progressCall([
        { id, state: "accepted", reason: "fact set" },
        { id, state: "in_data", reason: "fact set", in_data_at: "2026-11-03T11:00:00Z" },
        { id: other, state: "held", reason: "names are checked by a person" },
        { id: other, state: "refused", by: "rules", reason: "something else" },
      ]);
      expect(await later.json()).toEqual({ updated: 0 });
      expect(await progressOf(id)).toMatchObject({ state: "in_data", in_data_at: "2026-11-03T10:00:00Z" });
      expect(await progressOf(other)).toMatchObject({ state: "refused", by: "reviewer", reason: "a reviewer did not take the change into the data" });
      // A change a reviewer turned down that reached the data after all.
      await progressCall([{ id: other, state: "in_data", in_data_at: "2026-11-03T11:00:00Z" }]);
      expect(await progressOf(other)).toMatchObject({ state: "in_data", in_data_at: "2026-11-03T11:00:00Z" });
      expect(await progressOf(other)).not.toHaveProperty("by");
    });

    it("keeps an in_data_at once set, takes a later time than its clock as now, and changes nothing when sent again", async () => {
      const id = (await send(report(PLACE, { kind: "name", value: "Lake Eppalock Rest Area" }))).id as string;
      await progressCall([{ id, state: "in_data", in_data_at: "2027-01-01T00:00:00Z" }]);
      expect(await progressOf(id)).toMatchObject({ in_data_at: "2026-11-03T09:00:00Z" });
      clock += HOUR;
      expect(await (await progressCall([{ id, state: "in_data", in_data_at: "2026-11-03T10:00:00Z" }])).json()).toEqual({ updated: 0 });
      expect(await progressOf(id)).toMatchObject({ in_data_at: "2026-11-03T09:00:00Z" });
      // Waiting sent on every run moves nothing either.
      const waiting = (await send(report(PLACE, { kind: "kind", place_kind: "caravan_park" }))).id as string;
      await progressCall([{ id: waiting, state: "waiting", reason: "needs a second device", decided_at: "2026-11-03T10:00:00Z" }]);
      clock += HOUR;
      expect(await (await progressCall([{ id: waiting, state: "waiting", reason: "needs a second device", decided_at: "2026-11-03T11:00:00Z" }])).json()).toEqual({ updated: 0 });
      expect(await progressOf(waiting)).toMatchObject({ state: "waiting", decided_at: "2026-11-03T10:00:00Z" });
    });

    it("answers known and unknown ids in the order asked, with CORS and not cached", async () => {
      const id = (await send(fact(PLACE, "toilets", true))).id as string;
      const unknown = "fb_01JC0000000000000000000099";
      const answer = await ask(`?ids=${unknown},${id},${unknown}`, { origin: "https://app.example" });
      expect(answer.status).toBe(200);
      expect(answer.body.items!.map((i) => [i.id, i.state])).toEqual([
        [unknown, "unknown"],
        [id, "live"],
        [unknown, "unknown"],
      ]);
      expect(answer.body.items![0]).toEqual({ id: unknown, state: "unknown" });
      expect(answer.headers.get("access-control-allow-origin")).toBe("*");
      expect(answer.headers.get("cache-control")).toBe("no-store");
    });

    it("answers 400 for too many ids, a bad id or none", async () => {
      const many = Array.from({ length: 101 }, (_, i) => `fb_01JC${String(i).padStart(22, "0")}`);
      expect((await ask(`?ids=${many.join(",")}`)).status).toBe(400);
      expect((await ask(`?ids=${many.slice(0, 100).join(",")}`)).status).toBe(200);
      expect((await ask(`?ids=${OLD},ocdb_01JB0000000000000000000001`)).status).toBe(400);
      expect((await ask("?ids=")).status).toBe(400);
      expect((await ask("")).status).toBe(400);
    });

    it("deletes rows 90 days after they last changed", async () => {
      const id = (await send(fact(PLACE, "toilets", true))).id as string;
      const changed = (await send(report(PLACE, { kind: "name", value: "Lake Eppalock Rest Area" }))).id as string;
      clock = NOW + 60 * 24 * HOUR;
      await progressCall([{ id: changed, state: "held", reason: "names are checked by a person" }]);
      clock = NOW + 90 * 24 * HOUR + HOUR;
      await createScheduled({ fetch: services.fetch, now: () => clock })(e);
      expect(rows().map((r) => (r as { feedback_id: string }).feedback_id)).toEqual([changed]);
      expect(await progressOf(id)).toEqual({ id, state: "unknown" });
      expect(await progressOf(changed)).toMatchObject({ state: "held" });
    });
  });
});
