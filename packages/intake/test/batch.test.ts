import { createHash, generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, MAX_BATCH_BODY_BYTES, MAX_BATCH_ITEMS, type Env } from "../src/index.js";
import { NEW_PLACE_DAILY_LIMIT, type D1Like } from "../src/recent.js";
import { fakeD1 } from "./fake-d1.js";
import { listableKv } from "./fake-kv.js";

const NOW = Date.parse("2026-11-07T09:00:00Z");
const DAY = "2026-11-07";
const APP_KEY = "test-app-key-0123456789";
const PACKAGE = "com.example.app";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const PLACE = "ocdb_01JB0000000000000000000001";
const SEASONAL = "ocdb_01JB0000000000000000000003";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** GitHub and Play Integrity. A token `ok:<hash>` decodes to a sound verdict for the body with that hash. `integrity` counts the decodes. */
function fakeServices() {
  const counted = { integrity: 0, commits: 0 };
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.endsWith("/access_tokens")) return new Response(JSON.stringify({ token: "ghs_x", expires_at: new Date(NOW + 3_600_000).toISOString() }), { status: 201 });
    if (url.includes("/contents/")) {
      counted.commits += 1;
      return new Response("{}", { status: 201 });
    }
    if (url === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 360000 }), { status: 200 });
    if (url === `https://playintegrity.googleapis.com/v1/${PACKAGE}:decodeIntegrityToken`) {
      counted.integrity += 1;
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
    return new Response("not found", { status: 404 });
  };
  return { fetch, counted };
}

/** Workers AI as Llama Guard: everything is safe. */
const safeAi = { run: async () => ({ response: { safe: true, categories: [] } }) };

function env(store: D1Like | undefined, appKey: Record<string, unknown> = {}): Env {
  return {
    APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 1000, requires_attestation: true, android: { package: PACKAGE }, ...appKey } }),
    DEVICE_SALT: "pepper",
    GH_APP_ID: "1",
    GH_APP_PRIVATE_KEY: privateKey,
    GH_INSTALLATION_ID: "2",
    INBOX_REPO: "opencampingdb/inbox",
    RATE_LIMIT: listableKv(),
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({ client_email: "intake@example.iam.gserviceaccount.com", private_key: privateKey }),
    ...(store ? { RECENT_LIST: store } : {}),
    AI: safeAi,
  };
}

/** A batch POST with one sound Play Integrity token over the whole body. */
function batch(items: unknown[], options: { token?: string; appKey?: string; text?: string } = {}) {
  const text = options.text ?? JSON.stringify({ items });
  return new Request("https://intake.example/v1/feedback/batch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-app-key": options.appKey ?? APP_KEY,
      "x-attest-platform": "android",
      "x-attest-token": options.token ?? `ok:${sha(text)}`,
    },
    body: text,
  });
}

const report = (place: string | null, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "report",
  place,
  device: DEVICE,
  contributor: CONTRIBUTOR,
  app_version: "1.0.0",
  consent: true,
  report: body,
  ...extra,
});
const fact = (place: string, name: string, value: unknown) => report(place, { kind: "fact", fact: name, value });
const placeOf = (i: number) => `ocdb_01JB00000000000000000${String(i).padStart(5, "0")}`;
const review = (place: string, extra: Record<string, unknown> = {}) => ({
  type: "review",
  place,
  device: DEVICE,
  contributor: CONTRIBUTOR,
  app_version: "1.0.0",
  consent: true,
  review: { stars: 4, text: "Quiet and shady.", visited: "2026-10" },
  ...extra,
});
const newPlace = (i: number) =>
  report(null, { kind: "new_place", place_kind: "free_camp", note: "Gravel pit off the highway, room for three vans" }, { location: { lat: -36.1 - i / 100, lon: 146.8 } });

type ItemAnswer = { status: number; id?: string; error?: string; details?: string[]; state?: string; held_reason?: string; retry_after?: number };

describe("POST /v1/feedback/batch", () => {
  let services: ReturnType<typeof fakeServices>;
  let handle: ReturnType<typeof createHandler>;
  let store: ReturnType<typeof fakeD1>;
  let e: Env;

  const rows = (table: string) => store.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  const queued = () => (store.db.prepare("SELECT content FROM inbox_queue ORDER BY id").all() as { content: string }[]).map((r) => JSON.parse(r.content) as Record<string, unknown>);

  async function send(items: unknown[], to: Env = e): Promise<ItemAnswer[]> {
    const res = await handle(batch(items), to);
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: ItemAnswer[] }).items;
  }

  function index(id: string, [lon, lat]: [number, number], facts: Record<string, unknown>) {
    store.db
      .prepare("INSERT INTO place_index (id, cell_lon, cell_lat, facts, fact_sources, fact_dates) VALUES (?, ?, ?, ?, '{}', '{}')")
      .run(id, lon, lat, JSON.stringify(facts));
  }

  beforeEach(() => {
    services = fakeServices();
    store = fakeD1();
    e = env(store);
    handle = createHandler({ fetch: services.fetch, now: () => NOW, randomBytes: () => crypto.getRandomValues(new Uint8Array(16)) });
    index(PLACE, [146, -37], { toilets: false });
    index(SEASONAL, [146, -37], { pets: "seasonal", pets_months: "May-Sep" });
  });

  it("checks one attestation for 50 items and queues all of them", async () => {
    const items = Array.from({ length: MAX_BATCH_ITEMS }, (_, i) => review(placeOf(i)));
    const answers = await send(items);
    expect(answers).toHaveLength(50);
    expect(answers.every((a) => a.status === 202 && a.id?.startsWith("fb_"))).toBe(true);
    expect(services.counted.integrity).toBe(1);
    expect(queued().map((q) => q.id)).toEqual(answers.map((a) => a.id));
    expect(queued().every((q) => q.attested === "play_integrity")).toBe(true);
  });
  it("answers each item in order, accepted or refused, as it would be answered alone", async () => {
    const answers = await send([
      fact(PLACE, "toilets", true),
      { type: "review", place: PLACE },
      review(placeOf(1), { contributor: undefined }),
      review(placeOf(2)),
    ]);
    expect(answers.map((a) => a.status)).toEqual([202, 400, 400, 202]);
    expect(answers[0]).toMatchObject({ status: 202, state: "live" });
    expect(answers[1]).toMatchObject({ error: "invalid" });
    expect(answers[1]!.details!.length).toBeGreaterThan(0);
    expect(answers[2]).toEqual({ status: 400, error: "contributor_required" });
    // The ids sort in the order the items were sent.
    expect(answers[0]!.id! < answers[3]!.id!).toBe(true);
    expect(queued().map((q) => q.id)).toEqual([answers[0]!.id, answers[3]!.id]);
  });

  it("counts each item against the daily limits in turn, with the 429 and its retry_after per item", async () => {
    const limited = env(store, { contributor_daily_limit: 3 });
    const answers = await send(Array.from({ length: 5 }, (_, i) => review(placeOf(i))), limited);
    expect(answers.map((a) => a.status)).toEqual([202, 202, 202, 429, 429]);
    // Seconds to midnight UTC from 09:00.
    expect(answers[3]).toEqual({ status: 429, error: "rate_limited", retry_after: 15 * 3600 });
    expect(queued()).toHaveLength(3);
    // The next request sees the counts the batch stored.
    expect((await send([review(placeOf(9))], limited))[0]!.status).toBe(429);
  });

  it("counts one place's reports in a batch once against the limits, as one edit", async () => {
    const answers = await send([fact(PLACE, "toilets", true), fact(PLACE, "drinking_water", true), fact(PLACE, "showers", false)]);
    expect(answers.map((a) => a.status)).toEqual([202, 202, 202]);
    const counts = Object.fromEntries(rows("rate_counts").map((r) => [String(r.key).split(":")[0], r.count]));
    expect(counts.d).toBe(1);
    expect(counts.a).toBe(1);
    expect(counts.pe).toBe(3);
  });

  it("lists the new places in a batch up to the contributor's daily new places, and refuses the rest", async () => {
    const answers = await send(Array.from({ length: NEW_PLACE_DAILY_LIMIT + 1 }, (_, i) => newPlace(i)));
    expect(answers.slice(0, NEW_PLACE_DAILY_LIMIT).every((a) => a.status === 202 && a.state === "live")).toBe(true);
    expect(answers[NEW_PLACE_DAILY_LIMIT]).toMatchObject({ status: 429, error: "rate_limited" });
    expect(rows("new_places")).toHaveLength(NEW_PLACE_DAILY_LIMIT);
  });

  it("decides each item with the ones before it in the batch, as if each were sent alone in turn", async () => {
    // Alone, pets taken off seasonal goes live and clears the months, and months sent after it are held.
    const answers = await send([fact(SEASONAL, "pets", "leashed"), fact(SEASONAL, "pets_months", "Dec-Feb")]);
    expect(answers[0]).toMatchObject({ status: 202, state: "live" });
    expect(answers[1]).toMatchObject({ status: 202, state: "held", held_reason: "not_seasonal" });
    expect(rows("contributor_records")).toEqual([{ contributor: expect.any(String), accepted: 1, taken_down: 0 }]);
  });

  it("refuses an owner submission or a photo per item, and takes the rest", async () => {
    const claim = { type: "owner_claim", place: PLACE, device: DEVICE, app_version: "1.0.0", terms_accepted: true, owner: { name: "Jo Bloggs", email: "jo@example.com" }, claim: { proof_url: "https://riverbend.example/about" } };
    const photo = { type: "photo", place: PLACE, device: DEVICE, contributor: CONTRIBUTOR, app_version: "1.0.0", consent: true, photo: { full_sha256: sha("a"), full_bytes: 10, thumb_sha256: sha("b"), thumb_bytes: 5 } };
    const answers = await send([claim, photo, review(PLACE)]);
    expect(answers.slice(0, 2)).toEqual([
      { status: 400, error: "type_not_allowed_in_batch" },
      { status: 400, error: "type_not_allowed_in_batch" },
    ]);
    expect(answers[2]!.status).toBe(202);
    expect(queued()).toHaveLength(1);
  });

  it("answers the whole batch for a bad attestation, a bad app key, or a body that is not a batch or too large", async () => {
    const items = [review(PLACE)];
    const bad = await handle(batch(items, { token: "bad" }), e);
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: "attestation_invalid" });
    expect((await handle(batch(items, { appKey: "not-a-key-0000000000" }), e)).status).toBe(401);
    expect((await handle(batch([], {}), e)).status).toBe(400);
    expect((await handle(batch(Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => review(PLACE))), e)).status).toBe(400);
    expect((await handle(batch(items, { text: "not json" }), e)).status).toBe(400);
    const huge = JSON.stringify({ items: [review(PLACE, { review: { stars: 4, text: "x".repeat(MAX_BATCH_BODY_BYTES), visited: "2026-10" } })] });
    expect((await handle(batch([], { text: huge }), e)).status).toBe(413);
    expect(queued()).toEqual([]);
    expect(rows("rate_counts")).toEqual([]);
  });

  it("measures each item as sent, so an item answers 413 in a batch exactly when it would alone", async () => {
    const LIMIT = 16 * 1024;
    // Spaces and \u escapes the intake reads but JSON.stringify would not write back.
    const spaced = (item: object, pad: number) => `{${" ".repeat(pad)}${JSON.stringify(item).slice(1)}`;
    const escaped = (item: object) => JSON.stringify(item).replace(/"Quiet and shady\."/, `"${"\\u0051".repeat(2800)}"`);
    const wide = spaced(review(placeOf(1)), LIMIT);
    const fits = spaced(review(placeOf(2)), LIMIT - JSON.stringify(review(placeOf(2))).length);
    const quoted = escaped(review(placeOf(3)));
    expect(new TextEncoder().encode(wide).length).toBeGreaterThan(LIMIT);
    expect(new TextEncoder().encode(fits).length).toBe(LIMIT);
    expect(new TextEncoder().encode(quoted).length).toBeGreaterThan(LIMIT);
    // Read and written again, each is well under the limit.
    for (const text of [wide, fits, quoted]) expect(JSON.stringify(JSON.parse(text)).length).toBeLessThan(LIMIT);

    const alone = async (text: string) => {
      const res = await handle(
        new Request("https://intake.example/v1/feedback", {
          method: "POST",
          headers: { "content-type": "application/json", "x-app-key": APP_KEY, "x-attest-platform": "android", "x-attest-token": `ok:${sha(text)}` },
          body: text,
        }),
        env(fakeD1()),
      );
      return res.status;
    };
    expect([await alone(wide), await alone(fits), await alone(quoted)]).toEqual([413, 202, 413]);

    const text = `{"items":[${JSON.stringify(review(PLACE))}, ${wide},\n${fits} , ${quoted}]}`;
    const res = await handle(batch([], { text }), e);
    expect(res.status).toBe(200);
    const answers = ((await res.json()) as { items: ItemAnswer[] }).items;
    expect(answers.map((a) => a.status)).toEqual([202, 413, 202, 413]);
    expect(answers[1]).toEqual({ status: 413, error: "too_large" });
  });

  it("answers the whole batch 429 when the app is at its daily limit", async () => {
    const small = env(store, { daily_limit: 2 });
    expect((await send([review(placeOf(1)), review(placeOf(2)), review(placeOf(3))], small)).map((a) => a.status)).toEqual([202, 202, 429]);
    const res = await handle(batch([review(placeOf(4))]), small);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe(String(15 * 3600));
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("stores nothing and answers 503 when storage fails", async () => {
    const failing: D1Like = { prepare: (sql) => store.prepare(sql), batch: async () => Promise.reject(new Error("D1 is down")) };
    const res = await handle(batch([fact(PLACE, "toilets", true), review(placeOf(1)), newPlace(1)]), env(failing));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    for (const table of ["inbox_queue", "rate_counts", "item_progress", "recent_changes", "report_evidence", "new_places", "contributor_records"]) {
      expect(rows(table)).toEqual([]);
    }
    // The live changes the checks took are given back.
    expect(rows("live_counts").every((r) => r.count === 0)).toBe(true);
  });

  it("writes a progress row for each accepted item", async () => {
    const answers = await send([fact(PLACE, "toilets", true), { type: "review" }, review(placeOf(1))]);
    const ids = [answers[0]!.id!, answers[2]!.id!];
    const res = await handle(new Request(`https://intake.example/v1/feedback/progress?ids=${ids.join(",")}`), e);
    expect(((await res.json()) as { items: { id: string; state: string }[] }).items.map((p) => [p.id, p.state])).toEqual([
      [ids[0], "live"],
      [ids[1], "received"],
    ]);
    expect(rows("item_progress")).toHaveLength(2);
  });

  it("is not served without the recent list, so the SDK sends one item at a time", async () => {
    const res = await handle(batch([review(PLACE)]), env(undefined));
    expect(res.status).toBe(404);
    expect(services.counted.commits).toBe(0);
  });
});
