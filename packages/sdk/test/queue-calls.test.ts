// What an app can ask the client about its queue, and trying every queued item now, without reading or writing the client's storage.
import { describe, expect, it } from "vitest";
import { createFeedbackClient, type Answer, type FeedbackClientOptions, type FetchLike, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const QUEUE = "ocdb.feedback.queue";

/** Storage held in a map, counting each call by key. */
function countingStorage() {
  const data = new Map<string, string>();
  const reads = new Map<string, number>();
  const writes = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const storage: StorageAdapter = {
    getItem: async (k) => {
      bump(reads, k);
      return data.get(k) ?? null;
    },
    setItem: async (k, v) => {
      bump(writes, k);
      data.set(k, v);
    },
    removeItem: async (k) => {
      bump(writes, k);
      data.delete(k);
    },
  };
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  return {
    storage,
    data,
    reads: () => total(reads),
    writes: () => total(writes),
    reset: () => {
      reads.clear();
      writes.clear();
    },
  };
}

type Mode = "online" | "offline" | { status: 429; retryAfter: number } | { batchRetryAfter: number };

/**
 * An intake that answers by `mode.value`: `online` takes every item, `offline`
 * throws, a 429 refuses the whole request with `Retry-After`, and
 * `batchRetryAfter` answers a batch 200 with every item 429 and its own `retry_after`.
 */
function fakeIntake() {
  const mode: { value: Mode } = { value: "online" };
  const requests: { url: string; body: { items?: unknown[] } & Record<string, unknown> }[] = [];
  let ids = 0;
  const id = () => `fb_01JBXK3M8Q4R5S6T7V8W9${String(++ids).padStart(5, "0")}`;
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as (typeof requests)[number]["body"];
    requests.push({ url, body });
    const m = mode.value;
    const batch = url.endsWith("/batch");
    if (m === "offline") throw new TypeError("Network request failed");
    if (typeof m === "object" && "status" in m) {
      return { status: 429, json: async () => ({ error: "rate_limited" }), headers: { get: (h: string) => (h === "retry-after" ? String(m.retryAfter) : null) } };
    }
    if (typeof m === "object" && batch) {
      const answer = { items: body.items!.map(() => ({ status: 429, error: "rate_limited", retry_after: m.batchRetryAfter })) };
      return { status: 200, json: async () => answer, headers: { get: () => null } };
    }
    const answer = batch ? { items: body.items!.map(() => ({ status: 202, id: id() })) } : { id: id() };
    return { status: batch ? 200 : 202, json: async () => answer, headers: { get: () => null } };
  };
  return { fetch, requests, mode };
}

function setup(store = countingStorage(), intake = fakeIntake(), extra: Partial<FeedbackClientOptions> = {}) {
  const answers: Answer[] = [];
  let uuid = 0;
  const clock = { t: Date.UTC(2026, 10, 12) };
  const options: FeedbackClientOptions = {
    endpoint: "https://intake.example",
    appKey: "key",
    appVersion: "1.0.0",
    storage: store.storage,
    fetch: intake.fetch,
    now: () => clock.t,
    random: () => 0.5,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    attest: async () => ({ "x-attest-platform": "android", "x-attest-token": "t" }),
    onAnswered: (a) => void answers.push(a),
    ...extra,
  };
  const client = createFeedbackClient(options);
  return { client, store, intake, answers, clock };
}

const check = (ref?: string) => ({ place: PLACE, check: { still_there: true, visited: "2026-11-01" }, consent: true as const, ...(ref ? { ref } : {}) });

describe("flush({ ignoreBackoff: true })", () => {
  it("sends an item in backoff after a network failure, which a plain flush leaves", async () => {
    const { client, intake, clock } = setup();
    intake.mode.value = "offline";
    expect((await client.check(check("c1"))).status).toBe("queued");
    intake.mode.value = "online";
    clock.t += 1_000;
    expect(await client.flush()).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    expect(await client.flush({ ignoreBackoff: true })).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });

  it("leaves an item waiting out a 429 Retry-After until the wait ends", async () => {
    const { client, intake, clock } = setup();
    intake.mode.value = { status: 429, retryAfter: 3_600 };
    expect((await client.check(check("c1"))).status).toBe("queued");
    intake.mode.value = "online";
    const asked = intake.requests.length;
    clock.t += 60_000;
    expect(await client.flush({ ignoreBackoff: true })).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    expect(intake.requests).toHaveLength(asked);
    clock.t += 3_600_000;
    expect(await client.flush({ ignoreBackoff: true })).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });

  it("leaves batch items waiting out their retry_after until the wait ends", async () => {
    const { client, intake, clock } = setup();
    intake.mode.value = { batchRetryAfter: 600 };
    const results = await client.reportFacts({ place: PLACE, facts: { toilets: true, showers: false }, consent: true, ref: "e1" });
    expect(results.map((r) => r.result.status)).toEqual(["queued", "queued"]);
    intake.mode.value = "online";
    const asked = intake.requests.length;
    clock.t += 60_000;
    expect(await client.flush({ ignoreBackoff: true })).toEqual({ sent: 0, dropped: 0, remaining: 2 });
    expect(intake.requests).toHaveLength(asked);
    clock.t += 600_000;
    expect(await client.flush({ ignoreBackoff: true })).toEqual({ sent: 2, dropped: 0, remaining: 0 });
  });

  it("leaves an item waiting for a new place's id while the new place is unsent", async () => {
    const { client, intake, clock } = setup();
    intake.mode.value = "offline";
    await client.report({ place: null, location: { lat: -33.87, lon: 151.21 }, report: { kind: "new_place", name: "River Bend", place_kind: "campground" }, consent: true, ref: "np" });
    await client.check({ ...check("c1"), place: { newPlace: "np" } });
    clock.t += 1_000;
    await client.flush({ ignoreBackoff: true });
    const sentTypes = intake.requests.flatMap((r) => (r.body.items ?? [r.body]).map((b) => (b as { type: string }).type));
    expect(sentTypes).not.toContain("check");
    expect(await client.pending()).toBe(2);
  });

  it("still drops items older than maxQueueAgeMs", async () => {
    const { client, intake, clock, answers } = setup();
    intake.mode.value = "offline";
    await client.check(check("old"));
    intake.mode.value = "online";
    clock.t += 31 * 24 * 60 * 60 * 1000;
    expect(await client.flush({ ignoreBackoff: true })).toEqual({ sent: 0, dropped: 1, remaining: 0 });
    expect(answers.at(-1)).toEqual({ ref: "old", type: "check", outcome: { kind: "dropped", httpStatus: 0 } });
  });
});
