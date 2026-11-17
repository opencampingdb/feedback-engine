import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, type BucketLike, type Env } from "../src/index.js";
import { tileKeys } from "../src/place-geometry.js";
import { fakeD1 } from "./fake-d1.js";
import { listableKv } from "./fake-kv.js";

const NOW = Date.parse("2026-11-17T09:00:00Z");
const APP_KEY = "test-app-key-0123456789";
const PACKAGE = "com.example.app";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** GitHub and Play Integrity, as repeated-text.test.ts fakes them. */
function fakeServices() {
  return async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(NOW + 100 * 60 * 60 * 1000).toISOString() }), { status: 201 });
    if (url.includes("/contents/")) return new Response("{}", { status: 201 });
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 360000 }), { status: 200 });
    if (url === `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`) {
      const token = (JSON.parse(String(init?.body)) as { integrity_token: string }).integrity_token;
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
    return new Response("not found", { status: 404 });
  };
}

/**
 * The apply's fixture (packages/apply/test/fixtures/place-geometry), cut into
 * tiles as the data repository uploads them: each line goes in every tile its
 * shape touches. The fixture is small enough that bounds are all it takes.
 */
function tiled(): Map<string, string> {
  const tiles = new Map<string, string>();
  const read = (name: string) => readFileSync(new URL(`../../apply/test/fixtures/place-geometry/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);
  for (const [layer, file] of [["water", "water.ndjson"], ["roads", "roads.ndjson"], ["buildings", "buildings.ndjson"]] as const) {
    for (const line of read(file)) {
      const value = JSON.parse(line) as { polygons?: number[][][][]; coords?: number[][] };
      const points = value.polygons ? value.polygons.flat(2) : value.coords!;
      const lons = points.map((p) => p[0]!);
      const lats = points.map((p) => p[1]!);
      for (const key of tileKeys(layer, { minLon: Math.min(...lons), minLat: Math.min(...lats), maxLon: Math.max(...lons), maxLat: Math.max(...lats) })) {
        tiles.set(key, `${tiles.get(key) ?? ""}${line}\n`);
      }
    }
  }
  return tiles;
}

function bucket(tiles: Map<string, string>, fail = false): BucketLike & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    put: async () => undefined,
    delete: async () => undefined,
    async get(key: string) {
      reads.push(key);
      if (fail) throw new Error("R2 down");
      const text = tiles.get(key);
      if (text === undefined) return null;
      const bytes = new TextEncoder().encode(text);
      return { body: new Response(bytes).body!, size: bytes.length };
    },
  };
}

function env(store: ReturnType<typeof fakeD1>, geometry?: BucketLike): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 1000, requires_attestation: true, android: { package: PACKAGE } } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "2",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: listableKv(),
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "intake@example.iam.gserviceaccount.com", private_key: privateKey }),
    RECENT_LIST: store,
    PLACES_TOKEN: "places-token",
    ...(geometry ? { PLACE_GEOMETRY: geometry } : {}),
  };
}

let sender = 0;
function newPlace(location: { lat: number; lon: number }, placeKind = "free_camp") {
  sender += 1;
  const body = {
    type: "report",
    place: null,
    location,
    device: `${String(sender).padStart(2, "0")}c24110-e2bb-4255-8caf-4136c566a962`,
    contributor: `acct_sender_${String(sender).padStart(8, "0")}`,
    app_version: "1.0.0",
    consent: true,
    report: { kind: "new_place", place_kind: placeKind },
  };
  const text = JSON.stringify(body);
  return new Request("https://intake.example/v1/feedback", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-key": APP_KEY,
      "x-attest-platform": "android",
      "x-attest-token": `ok:${sha(text)}`,
      "cf-connecting-ip": `198.51.${sender}.7`,
    },
    body: text,
  });
}

const queued = (store: ReturnType<typeof fakeD1>) =>
  (store.db.prepare("SELECT content FROM inbox_queue ORDER BY rowid").all() as { content: string }[]).map((r) => JSON.parse(r.content) as Record<string, unknown>);

describe("plausible locations for new places at send time", () => {
  let store: ReturnType<typeof fakeD1>;
  let handle: ReturnType<typeof createHandler>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = fakeD1();
    handle = createHandler({ fetch: fakeServices(), now: () => NOW, randomBytes: () => crypto.getRandomValues(new Uint8Array(16)) });
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  const send = async (request: Request, to: Env) => {
    const res = await handle(request, to);
    expect(res.status).toBe(202);
    return (await res.json()) as { id: string; state?: string; held_reason?: string };
  };

  it("holds a new place in the sea, in a lake, on a major road or inside a building as implausible_location", async () => {
    const e = env(store, bucket(tiled()));
    for (const location of [
      { lat: -33.05, lon: 151.15 },
      { lat: -33.045, lon: 151.005 },
      { lat: -33.05, lon: 151.06003 },
      { lat: -33.01985, lon: 151.05015 },
    ]) {
      expect(await send(newPlace(location), e), JSON.stringify(location)).toMatchObject({ state: "held", held_reason: "implausible_location" });
    }
    expect(queued(store).at(-1)!.intake).toEqual({ state: "held", held_reason: "implausible_location" });
    // Nothing is listed on the recent list.
    expect(store.db.prepare("SELECT count(*) AS n FROM new_places").get()).toEqual({ n: 0 });
  });

  it("lists a remote place on land and one beside the road, reading one tile of each layer", async () => {
    const geometry = bucket(tiled());
    const e = env(store, geometry);
    expect(await send(newPlace({ lat: -25.3, lon: 131.0 }), e)).toMatchObject({ state: "live" });
    expect(geometry.reads.sort()).toEqual(["buildings/-2530/13100.ndjson", "roads/-253/1310.ndjson", "water/-253/1310.ndjson"]);
    expect(await send(newPlace({ lat: -33.05, lon: 151.0604 }), e)).toMatchObject({ state: "live" });
  });

  it("lists every new place, and logs it, without the PLACE_GEOMETRY binding", async () => {
    expect(await send(newPlace({ lat: -33.05, lon: 151.15 }), env(store))).toMatchObject({ state: "live" });
    expect(warn).toHaveBeenCalledWith("no PLACE_GEOMETRY binding, so new places are not checked for plausible locations");
  });

  it("holds a new place for the apply when the tiles cannot be read", async () => {
    expect(await send(newPlace({ lat: -25.3, lon: 131.0 }), env(store, bucket(tiled(), true)))).toMatchObject({ state: "held", held_reason: "check_unavailable" });
  });
});
