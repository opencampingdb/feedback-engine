import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, createScheduled, type Env } from "../src/index.js";
import {
  REPEATED_TEXT_DAYS,
  REPEATED_TEXT_MIN_LENGTH,
  REPEATED_TEXT_MODEL,
  REPEATED_TEXT_SIMILARITY,
  REPEATED_TEXT_SOURCES,
  type VectorizeLike,
} from "../src/repeated.js";
import { fakeD1 } from "./fake-d1.js";
import { listableKv } from "./fake-kv.js";

const NOW = Date.parse("2026-11-17T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const APP_KEY = "test-app-key-0123456789";
const PACKAGE = "com.example.app";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const SPAM = "Best deals on camping gear this week only, ask at the counter for the special";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let clock = NOW;

/** GitHub and Play Integrity, as recent.test.ts fakes them. */
function fakeServices() {
  return async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(clock + 100 * 60 * 60 * 1000).toISOString() }), { status: 201 });
    }
    if (url.includes("/contents/")) return new Response("{}", { status: 201 });
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 360000 }), { status: 200 });
    if (url === `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`) {
      const token = (JSON.parse(String(init?.body)) as { integrity_token: string }).integrity_token;
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
}

/** Texts given a set embedding: two numbers, then zeros. */
const SET_VECTORS = new Map<string, number[]>();

/** A 768 number embedding of `text` from its character trigrams, so near-identical texts land close together. */
function embed(text: string): number[] {
  const set = SET_VECTORS.get(text);
  if (set) return [...set, ...new Array<number>(768 - set.length).fill(0)];
  const v = new Array<number>(768).fill(0);
  const t = text.toLowerCase();
  for (let i = 0; i + 3 <= t.length; i++) v[parseInt(sha(t.slice(i, i + 3)).slice(0, 6), 16) % 768]! += 1;
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** Workers AI: the embedding model gives `embed`, and Llama Guard says safe. `fail` makes embedding throw. */
function fakeAi() {
  const ai = {
    fail: false,
    unsafe: false,
    guardFail: false,
    embeddings: 0,
    guards: 0,
    run: async (model: string, inputs: Record<string, unknown>) => {
      if (model === REPEATED_TEXT_MODEL) {
        ai.embeddings += 1;
        if (ai.fail) throw new Error("capacity");
        const texts = inputs.text as string[];
        return { shape: [texts.length, 768], data: texts.map(embed), pooling: "mean" };
      }
      ai.guards += 1;
      if (ai.guardFail) throw new Error("guard down");
      return { response: ai.unsafe ? { safe: false, categories: ["S2"] } : { safe: true, categories: [] } };
    },
  };
  return ai;
}

/** Vectorize with a cosine index, `$gte` and `$ne` filters, and indexed metadata. `fail` makes every call throw. */
function fakeVectorize(): VectorizeLike & { vectors: Map<string, { values: number[]; metadata: Record<string, unknown> }>; fail: boolean } {
  const vectors = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  const index = {
    vectors,
    fail: false,
    async query(vector: number[], options: { topK: number; filter?: Record<string, unknown>; returnMetadata?: string }) {
      if (index.fail) throw new Error("vectorize down");
      const passes = (metadata: Record<string, unknown>) =>
        Object.entries(options.filter ?? {}).every(([key, cond]) => {
          const value = metadata[key];
          const c = cond as Record<string, unknown>;
          if (typeof cond !== "object" || cond === null) return value === cond;
          return (c.$gte === undefined || (value as number) >= (c.$gte as number)) && (c.$ne === undefined || value !== c.$ne);
        });
      const matches = [...vectors]
        .filter(([, v]) => passes(v.metadata))
        .map(([id, v]) => ({ id, score: v.values.reduce((s, x, i) => s + x * vector[i]!, 0), ...(options.returnMetadata && options.returnMetadata !== "none" ? { metadata: v.metadata } : {}) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);
      return { count: matches.length, matches };
    },
    async upsert(list: { id: string; values: number[]; metadata?: Record<string, unknown> }[]) {
      if (index.fail) throw new Error("vectorize down");
      for (const v of list) vectors.set(v.id, { values: v.values, metadata: v.metadata ?? {} });
      return { mutationId: "m" };
    },
    async deleteByIds(ids: string[]) {
      if (index.fail) throw new Error("vectorize down");
      for (const id of ids) vectors.delete(id);
      return { mutationId: "m" };
    },
  };
  return index;
}

function env(store: ReturnType<typeof fakeD1>, ai: ReturnType<typeof fakeAi> | undefined, index: VectorizeLike | undefined): Env {
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
    ...(ai ? { AI: ai } : {}),
    ...(index ? { VECTORIZE: index } : {}),
  };
}

const device = (i: number) => `${String(i).padStart(2, "0")}c24110-e2bb-4255-8caf-4136c566a962`;

/** A new place from sender `i`, on its own network unless `network` names another. */
function newPlace(i: number, note: string, network = i) {
  const body = {
    type: "report",
    place: null,
    location: { lat: -36.1 - i / 100, lon: 146.8 },
    device: device(i),
    contributor: `acct_sender_${String(i).padStart(8, "0")}`,
    app_version: "1.0.0",
    consent: true,
    report: { kind: "new_place", place_kind: "free_camp", note },
  };
  return post("/v1/feedback", body, network);
}

function review(i: number, text: string, network = i) {
  const body = {
    type: "review",
    place: PLACE,
    device: device(i),
    contributor: `acct_sender_${String(i).padStart(8, "0")}`,
    app_version: "1.0.0",
    consent: true,
    review: { stars: 5, text, visited: "2026-11" },
  };
  return post("/v1/feedback", body, network);
}

function post(path: string, body: unknown, network: number) {
  const text = JSON.stringify(body);
  return new Request(`https://intake.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-key": APP_KEY,
      "x-attest-platform": "android",
      "x-attest-token": `ok:${sha(text)}`,
      "cf-connecting-ip": `198.51.${network}.7`,
    },
    body: text,
  });
}

/** What the intake queued for the inbox, oldest first. */
const queued = (store: ReturnType<typeof fakeD1>) =>
  (store.db.prepare("SELECT content FROM inbox_queue ORDER BY rowid").all() as { content: string }[]).map((r) => JSON.parse(r.content) as Record<string, unknown>);

describe("repeated text across sources", () => {
  let store: ReturnType<typeof fakeD1>;
  let ai: ReturnType<typeof fakeAi>;
  let index: ReturnType<typeof fakeVectorize>;
  let handle: ReturnType<typeof createHandler>;
  let e: Env;

  beforeEach(() => {
    clock = NOW;
    store = fakeD1();
    ai = fakeAi();
    index = fakeVectorize();
    e = env(store, ai, index);
    handle = createHandler({ fetch: fakeServices(), now: () => clock, randomBytes: () => crypto.getRandomValues(new Uint8Array(16)) });
  });

  const send = async (request: Request, to = e) => {
    const res = await handle(request, to);
    expect(res.status).toBe(202);
    return (await res.json()) as { id: string; state?: string; held_reason?: string };
  };

  it("holds near-identical text from three other sources within 30 days as repeated_text", async () => {
    for (let i = 1; i <= REPEATED_TEXT_SOURCES; i++) expect(await send(newPlace(i, SPAM))).toMatchObject({ state: "live" });
    const guards = ai.guards;
    // Near-identical, not identical: a word changed and different capitals.
    expect(await send(newPlace(10, "Best deals on camping gear this week only! Ask at the counter for the specials"))).toMatchObject({ state: "held", held_reason: "repeated_text" });
    expect(queued(store).at(-1)!.intake).toEqual({ state: "held", held_reason: "repeated_text" });
    // Held before Llama Guard, which costs more than an embedding.
    expect(ai.guards).toBe(guards);
  });

  it("does not count two other sources, nor a different text", async () => {
    for (let i = 1; i < REPEATED_TEXT_SOURCES; i++) await send(newPlace(i, SPAM));
    expect(await send(newPlace(10, SPAM))).toMatchObject({ state: "live" });
    expect(await send(newPlace(11, "Quiet gravel pit behind the trees, flat ground for two vans and a fire ring"))).toMatchObject({ state: "live" });
  });

  it("does not count the same source repeating itself, on one network with many devices", async () => {
    for (let i = 1; i <= 5; i++) await send(newPlace(i, SPAM, 1));
    expect(await send(newPlace(10, SPAM))).toMatchObject({ state: "live" });
    // Nor a sender's own earlier texts when it sends again.
    expect(await send(newPlace(6, SPAM, 1))).toMatchObject({ state: "live" });
  });

  it("forgets texts older than 30 days, and the scheduled job deletes their vectors", async () => {
    for (let i = 1; i <= REPEATED_TEXT_SOURCES; i++) await send(newPlace(i, SPAM));
    expect(index.vectors.size).toBe(REPEATED_TEXT_SOURCES);
    clock = NOW + REPEATED_TEXT_DAYS * DAY + 60_000;
    expect(await send(newPlace(10, SPAM))).toMatchObject({ state: "live" });
    await createScheduled({ fetch: fakeServices(), now: () => clock })(e);
    expect([...index.vectors.keys()]).toHaveLength(1);
  });

  it("counts texts the rules held, so a campaign from unattested senders still adds up", async () => {
    const open = env(store, ai, index);
    open.APP_KEYS = JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 1000 } });
    const plain = (i: number) => {
      const r = newPlace(i, SPAM);
      const headers = new Headers(r.headers);
      headers.delete("x-attest-token");
      headers.delete("x-attest-platform");
      return new Request(r.url, { method: "POST", headers, body: r.body, duplex: "half" } as RequestInit);
    };
    for (let i = 1; i <= REPEATED_TEXT_SOURCES; i++) expect(await send(plain(i), open)).toMatchObject({ state: "held" });
    // Held by the rules too, but now for repeated text, which the apply sends to a person.
    expect(await send(plain(10), open)).toMatchObject({ state: "held", held_reason: "repeated_text" });
    expect(await send(newPlace(11, SPAM))).toMatchObject({ state: "held", held_reason: "repeated_text" });
  });

  it("marks a review repeated across sources for the apply to send to a person", async () => {
    for (let i = 1; i <= REPEATED_TEXT_SOURCES; i++) await send(review(i, SPAM));
    expect(queued(store).map((item) => item.intake)).toEqual([undefined, undefined, undefined]);
    await send(review(10, SPAM));
    expect(queued(store).at(-1)!.intake).toEqual({ state: "held", held_reason: "repeated_text" });
  });

  it("has Llama Guard read every review, and marks one it calls unsafe for the apply to send to a person", async () => {
    await send(review(1, "Quiet spot by the river, good shade."));
    expect(queued(store).at(-1)!.intake).toBeUndefined();
    expect(ai.guards).toBe(1);
    ai.unsafe = true;
    await send(review(2, "A quiet spot by the river where people come to deal at night."));
    expect(queued(store).at(-1)!.intake).toEqual({ state: "held", held_reason: "ai_check" });
    ai.unsafe = false;
    ai.guardFail = true;
    await send(review(3, "Lovely creek, lots of birds in the morning."));
    expect(queued(store).at(-1)!.intake).toEqual({ state: "held", held_reason: "check_unavailable" });
  });

  it("leaves short text alone, such as a name", async () => {
    const short = "Gravel pit, room for vans";
    expect(short.length).toBeLessThan(REPEATED_TEXT_MIN_LENGTH);
    for (let i = 1; i <= REPEATED_TEXT_SOURCES + 1; i++) expect(await send(newPlace(i, short))).toMatchObject({ state: "live" });
    expect(ai.embeddings).toBe(0);
  });

  it("is off without the Vectorize binding or the AI binding", async () => {
    const without = env(store, ai, undefined);
    for (let i = 1; i <= REPEATED_TEXT_SOURCES + 1; i++) expect(await send(newPlace(i, SPAM), without)).toMatchObject({ state: "live" });
    expect(ai.embeddings).toBe(0);
    // Without AI, free text is held by the Llama Guard check as before, and Vectorize is never called.
    const noAi = env(store, undefined, index);
    expect(await send(newPlace(20, SPAM), noAi)).toMatchObject({ state: "held", held_reason: "check_unavailable" });
    expect(index.vectors.size).toBe(0);
  });

  it("holds an item with free text as check_unavailable when embeddings or Vectorize fail, and passes one without", async () => {
    ai.fail = true;
    expect(await send(newPlace(1, SPAM))).toMatchObject({ state: "held", held_reason: "check_unavailable" });
    expect(await send(newPlace(2, "short note"))).toMatchObject({ state: "live" });
    ai.fail = false;
    index.fail = true;
    expect(await send(newPlace(3, SPAM))).toMatchObject({ state: "held", held_reason: "check_unavailable" });
    await send(review(4, SPAM));
    expect(queued(store).at(-1)!.intake).toEqual({ state: "held", held_reason: "check_unavailable" });
  });

  it("sets the threshold and window as constants", () => {
    expect(REPEATED_TEXT_SIMILARITY).toBe(0.95);
    expect(REPEATED_TEXT_SOURCES).toBe(3);
    expect(REPEATED_TEXT_DAYS).toBe(30);
    expect(REPEATED_TEXT_MIN_LENGTH).toBe(40);
  });

  it("holds at the threshold and not just under it", async () => {
    const base = "A text whose embedding points one way, long enough to be checked";
    const at = "A text whose embedding sits exactly at the threshold from the base text";
    const under = "A text whose embedding sits just under the threshold from the base text";
    const over = (cos: number) => [cos, Math.sqrt(1 - cos * cos)];
    SET_VECTORS.set(base, [1, 0]);
    SET_VECTORS.set(at, over(REPEATED_TEXT_SIMILARITY));
    SET_VECTORS.set(under, over(REPEATED_TEXT_SIMILARITY - 0.001));
    for (let i = 1; i <= REPEATED_TEXT_SOURCES; i++) await send(newPlace(i, base));
    expect(await send(newPlace(10, under))).toMatchObject({ state: "live" });
    expect(await send(newPlace(11, at))).toMatchObject({ state: "held", held_reason: "repeated_text" });
  });
});
