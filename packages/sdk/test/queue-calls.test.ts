// What an app can ask the client about its queue, and trying every queued item now, without reading or writing the client's storage.
import { describe, expect, it } from "vitest";
import { createFeedbackClient, createPhotoClient, type Answer, type FeedbackClientOptions, type FetchLike, type StorageAdapter } from "../src/index.js";

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

describe("queueSummary()", () => {
  it("answers an empty queue", async () => {
    const { client } = setup();
    expect(await client.queueSummary()).toEqual({
      items: 0,
      tried: 0,
      oldestQueuedAt: null,
      mostAttempts: 0,
      types: [],
      nextAttemptAt: null,
      intakeWaitUntil: null,
      waitingForNewPlace: 0,
    });
  });

  it("answers a fresh queue, including an item queued a moment ago by another call", async () => {
    const { client, clock } = setup();
    const queued = client.check(check("c1"), { wait: false });
    const summary = await client.queueSummary();
    await queued;
    expect(summary).toEqual({
      items: 1,
      tried: 0,
      oldestQueuedAt: clock.t,
      mostAttempts: 0,
      types: ["check"],
      nextAttemptAt: null,
      intakeWaitUntil: null,
      waitingForNewPlace: 0,
    });
  });

  it("answers a queue with tried items in backoff", async () => {
    const { client, intake, clock } = setup();
    const start = clock.t;
    intake.mode.value = "offline";
    await client.check(check("c1"));
    clock.t += 60_000;
    await client.review({ place: PLACE, review: { stars: 4, text: "Quiet spot by the river with shade.", visited: "2026-10" }, consent: true, ref: "r1" });
    await client.flush({ ignoreBackoff: true });
    // The check was tried by its own call, with the review in one batch, and by the flush: three times. The review twice.
    expect(await client.queueSummary()).toEqual({
      items: 2,
      tried: 2,
      oldestQueuedAt: start,
      mostAttempts: 3,
      types: ["check", "review"],
      // The review's backoff after its second try, 45 s with random 0.5, ends before the check's 90 s.
      nextAttemptAt: clock.t + 45_000,
      intakeWaitUntil: null,
      waitingForNewPlace: 0,
    });
  });

  it("answers a queue held by a wait the intake asked for", async () => {
    const { client, intake, clock } = setup();
    intake.mode.value = { status: 429, retryAfter: 3_600 };
    await client.check(check("c1"));
    const summary = await client.queueSummary();
    expect(summary).toMatchObject({ items: 1, tried: 1, mostAttempts: 1, nextAttemptAt: clock.t + 3_600_000, intakeWaitUntil: clock.t + 3_600_000 });
    clock.t += 3_600_001;
    expect(await client.queueSummary()).toMatchObject({ items: 1, nextAttemptAt: null, intakeWaitUntil: null });
  });

  it("answers a queue with items waiting for a new place", async () => {
    const { client, intake } = setup();
    intake.mode.value = "offline";
    await client.report({ place: null, location: { lat: -33.87, lon: 151.21 }, report: { kind: "new_place", name: "River Bend", place_kind: "campground" }, consent: true, ref: "np" });
    await client.check({ ...check("c1"), place: { newPlace: "np" } });
    await client.review({ place: { newPlace: "np" }, review: { stars: 5, text: "Shady and quiet, a good stop.", visited: "2026-10" }, consent: true });
    expect(await client.queueSummary()).toMatchObject({ items: 3, tried: 1, mostAttempts: 1, types: ["check", "report", "review"], waitingForNewPlace: 2 });
  });

  it("holds no text, device or contributor from any item", async () => {
    const { client, intake, store } = setup();
    intake.mode.value = "offline";
    const text = "The creek crossing near the gate washed out after the storm.";
    await client.review({ place: PLACE, review: { stars: 3, text, visited: "2026-10" }, contributor: "acct_abc123def456ghi", consent: true, ref: "secret-ref" });
    const json = JSON.stringify(await client.queueSummary());
    expect(json).not.toContain("creek");
    expect(json).not.toContain("acct_abc123def456ghi");
    expect(json).not.toContain("secret-ref");
    expect(json).not.toContain(store.data.get("ocdb.feedback.device")!);
  });
});

const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const CONTRIBUTOR = "acct_abc123def456ghi";
const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, ...Array(n).fill(0)]);

function photoSetup(store = countingStorage(), intake = fakeIntake()) {
  const client = createPhotoClient({
    endpoint: "https://photos.example",
    appKey: "key",
    appVersion: "1.0.0",
    storage: store.storage,
    fetch: intake.fetch,
    fetchPhoto: async () => {
      throw new TypeError("Network request failed");
    },
    now: () => Date.UTC(2026, 10, 12),
    random: () => 0.5,
    resolveNewPlace: async () => ({ status: "waiting" }),
    loadPhoto: async () => null,
  });
  return { client, store, intake };
}

describe("queuedRefs()", () => {
  it("answers the feedback client's queued refs, in queue order, leaving out an item without one", async () => {
    const { client, intake } = setup();
    intake.mode.value = "offline";
    await client.check(check("c1"));
    await client.check(check());
    await client.reportFacts({ place: PLACE, facts: { toilets: true, showers: false }, consent: true, ref: "e1" });
    expect(await client.queuedRefs()).toEqual({ refs: ["c1", "e1:toilets", "e1:showers"] });
  });

  it("answers no refs once the items are sent", async () => {
    const { client, intake, clock } = setup();
    intake.mode.value = "offline";
    await client.check(check("c1"));
    intake.mode.value = "online";
    clock.t += 1_000;
    await client.flush({ ignoreBackoff: true });
    expect(await client.queuedRefs()).toEqual({ refs: [] });
  });

  it("answers the photo client's refs and the keys of photos waiting for a new place", async () => {
    const { client, intake } = photoSetup();
    intake.mode.value = "offline";
    await client.reportPhoto({ place: PLACE, photo: PHOTO, reason: "not_this_place", consent: true, ref: "pr1" });
    await client.reportPhoto({ place: PLACE, photo: PHOTO, reason: "not_this_place", consent: true });
    expect(await client.photo({ place: { newPlace: "np" }, key: "file-a", contributor: CONTRIBUTOR, consent: true, full: jpeg(20), thumb: jpeg(10) })).toEqual({ status: "waiting" });
    expect(await client.queuedRefs()).toEqual({ refs: ["pr1"], waitingPhotoKeys: ["file-a"] });
  });

  it("answers each client for its own queue only", async () => {
    const store = countingStorage();
    const feedback = setup(store);
    const photos = photoSetup(store);
    feedback.intake.mode.value = "offline";
    photos.intake.mode.value = "offline";
    await feedback.client.check(check("c1"));
    await photos.client.reportPhoto({ place: PLACE, photo: PHOTO, reason: "not_this_place", consent: true, ref: "pr1" });
    expect(await feedback.client.queuedRefs()).toEqual({ refs: ["c1"] });
    expect(await photos.client.queuedRefs()).toEqual({ refs: ["pr1"], waitingPhotoKeys: [] });
    expect((await photos.client.queueSummary()).types).toEqual(["photo_report"]);
  });
});

describe("the new calls cost nothing outside the client", () => {
  it("queueSummary and queuedRefs make no request and no storage write, and read nothing once the queue is held", async () => {
    const { client, intake, store } = setup();
    intake.mode.value = "offline";
    await client.check(check("c1"));
    const asked = intake.requests.length;
    store.reset();
    await client.queueSummary();
    await client.queuedRefs();
    expect(intake.requests).toHaveLength(asked);
    expect(store.writes()).toBe(0);
    expect(store.reads()).toBe(0);
  });

  it("on a new client they read the stored queue once and write nothing", async () => {
    const store = countingStorage();
    const first = setup(store);
    first.intake.mode.value = "offline";
    await first.client.check(check("c1"));
    const { client, intake } = setup(store);
    store.reset();
    expect((await client.queueSummary()).items).toBe(1);
    expect(await client.queuedRefs()).toEqual({ refs: ["c1"] });
    expect(intake.requests).toHaveLength(0);
    expect(store.writes()).toBe(0);
    expect(store.reads()).toBe(1);
  });

  it("on the photo client they make no request and no storage write", async () => {
    const { client, intake, store } = photoSetup();
    intake.mode.value = "offline";
    await client.reportPhoto({ place: PLACE, photo: PHOTO, reason: "not_this_place", consent: true, ref: "pr1" });
    const asked = intake.requests.length;
    store.reset();
    await client.queueSummary();
    await client.queuedRefs();
    expect(intake.requests).toHaveLength(asked);
    expect(store.writes()).toBe(0);
  });
});

describe("the stored queue across SDK versions", () => {
  const OLD_FIELDS = ["localId", "ref", "body", "queuedAt", "attempts", "nextAttemptAt", "waitsFor"];

  it("adds only intakeWaitUntil, set to the same time as nextAttemptAt", async () => {
    const { client, intake, store, clock } = setup();
    intake.mode.value = { status: 429, retryAfter: 3_600 };
    await client.check(check("c1"));
    const [item] = JSON.parse(store.data.get(QUEUE)!) as Record<string, unknown>[];
    for (const key of Object.keys(item!)) expect([...OLD_FIELDS, "intakeWaitUntil"]).toContain(key);
    expect(item!.intakeWaitUntil).toBe(clock.t + 3_600_000);
    expect(item!.nextAttemptAt).toBe(item!.intakeWaitUntil);
  });

  it("a reader that ignores intakeWaitUntil waits on nextAttemptAt alone, as 0.28.x does", async () => {
    const store = countingStorage();
    const first = setup(store);
    first.intake.mode.value = { status: 429, retryAfter: 3_600 };
    await first.client.check(check("c1"));
    const stored = JSON.parse(store.data.get(QUEUE)!) as Record<string, unknown>[];
    for (const item of stored) delete item.intakeWaitUntil;
    store.data.set(QUEUE, JSON.stringify(stored));

    const { client, intake, clock, answers } = setup(store);
    clock.t = first.clock.t + 60_000;
    expect(await client.flush()).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    expect(intake.requests).toHaveLength(0);
    clock.t = first.clock.t + 3_600_000;
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(answers.map((a) => a.ref)).toEqual(["c1"]);
  });

  it("a plain flush waits the same with the field as without it", async () => {
    const { client, intake, clock } = setup();
    intake.mode.value = { status: 429, retryAfter: 3_600 };
    await client.check(check("c1"));
    intake.mode.value = "online";
    const asked = intake.requests.length;
    clock.t += 60_000;
    expect(await client.flush()).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    expect(intake.requests).toHaveLength(asked);
    clock.t += 3_600_000;
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });

  it("removes intakeWaitUntil once the wait is over, and the item then backs off as usual", async () => {
    const { client, intake, store, clock } = setup();
    intake.mode.value = { status: 429, retryAfter: 600 };
    await client.check(check("c1"));
    intake.mode.value = "offline";
    clock.t += 600_000;
    await client.flush({ ignoreBackoff: true });
    const [item] = JSON.parse(store.data.get(QUEUE)!) as Record<string, unknown>[];
    expect(item).not.toHaveProperty("intakeWaitUntil");
    expect(item!.nextAttemptAt).toBeGreaterThan(clock.t);
    expect((await client.queueSummary()).intakeWaitUntil).toBeNull();
    // Only the client's own backoff holds it now.
    intake.mode.value = "online";
    expect(await client.flush({ ignoreBackoff: true })).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });
});
