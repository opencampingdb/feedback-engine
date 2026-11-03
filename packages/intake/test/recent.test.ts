import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, type CacheLike, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";
import type { ListableKV } from "../src/recent.js";

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

function fakeKv(): KVLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

/** A KV namespace with list and metadata, as Workers KV has, paging two keys at a time. */
function listableKv(): ListableKV & { data: Map<string, { value: string; metadata?: unknown }>; lists: number } {
  const data = new Map<string, { value: string; metadata?: unknown }>();
  const kv = {
    data,
    lists: 0,
    get: async (k: string) => data.get(k)?.value ?? null,
    put: async (k: string, value: string, options?: { metadata?: unknown }) =>
      void data.set(k, { value, ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}) }),
    delete: async (k: string) => void data.delete(k),
    list: async ({ prefix, cursor }: { prefix?: string; cursor?: string }) => {
      kv.lists += 1;
      const names = [...data.keys()].filter((k) => k.startsWith(prefix ?? "")).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + 2);
      const done = start + 2 >= names.length;
      return {
        keys: page.map((name) => ({ name, metadata: data.get(name)!.metadata })),
        list_complete: done,
        ...(done ? {} : { cursor: String(start + 2) }),
      };
    },
  };
  return kv;
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

function env(store: ListableKV, appKey: Record<string, unknown> = {}): Env {
  return {
    APP_KEYS: JSON.stringify({
      [APP_KEY]: { app: "example-app", daily_limit: 1000, requires_attestation: true, android: { package: PACKAGE }, ...appKey },
    }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "2",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: fakeKv(),
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "intake@example.iam.gserviceaccount.com", private_key: privateKey }),
    RECENT_PLACES: store,
    PLACES_TOKEN: TOKEN,
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

const newPlace = (extra: { device?: string; contributor?: string; note?: string; name?: string; contacts?: Record<string, string> } = {}) => ({
  type: "report",
  place: null,
  location: { lat: -36.12345, lon: 146.88765 },
  device: extra.device ?? ADDER,
  contributor: extra.contributor ?? "acct_3f9a8b7c6d5e4f30",
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
  let store: ReturnType<typeof listableKv>;
  let e: Env;

  beforeEach(() => {
    clock = NOW;
    services = fakeServices();
    store = listableKv();
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

  it("never lists the note or the contacts", async () => {
    await add({ note: "Behind the old servo, gate code 4471", contacts: { phone: "03 5555 0100", email: "park@example.org" } });
    const res = await handle(recent(), e);
    const text = await res.text();
    expect(text).not.toContain("servo");
    expect(text).not.toContain("5555");
    expect(text).not.toContain("park@example.org");
    expect(text).not.toContain(ADDER);
    expect(Object.keys((JSON.parse(text) as { places: Listed[] }).places[0]!).sort()).toEqual(
      ["added", "contributor", "id", "kind", "location", "name", "standing"],
    );
  });

  it("lists the name tidied, as the data would have it", async () => {
    await add({ name: "lake   eppalock rest area" });
    expect((await list())[0]!.name).toBe("Lake Eppalock Rest Area");
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
    expect(store.lists).toBe(1);
    expect(second.headers.get("cache-control")).toBe("public, max-age=30");
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

  it("lists every page of the store", async () => {
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

    it("is not served without a token configured", async () => {
      const { PLACES_TOKEN: _, ...noToken } = e;
      expect((await handle(block([]), noToken)).status).toBe(404);
    });
  });
});
