// What the client asks of the app's storage adapter, the intake and the attester for an edit and the calls around it.
import { describe, expect, it } from "vitest";
import { createFeedbackClient, createPhotoClient, type Answer, type FeedbackClientOptions, type FetchLike, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const QUEUE = "ocdb.feedback.queue";
const DEVICE = "ocdb.feedback.device";

/** Storage held in a map, counting each call by key. `failSet` makes the next writes of a key throw. */
function countingStorage() {
  const data = new Map<string, string>();
  const reads = new Map<string, number>();
  const writes = new Map<string, number>();
  const failSet = new Set<string>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const storage: StorageAdapter = {
    getItem: async (k) => {
      bump(reads, k);
      return data.get(k) ?? null;
    },
    setItem: async (k, v) => {
      bump(writes, k);
      if (failSet.has(k)) throw new Error("disk full");
      data.set(k, v);
    },
    removeItem: async (k) => {
      bump(writes, k);
      if (failSet.has(k)) throw new Error("disk full");
      data.delete(k);
    },
  };
  return {
    storage,
    data,
    failSet,
    reads: (k: string) => reads.get(k) ?? 0,
    writes: (k: string) => writes.get(k) ?? 0,
    reset: () => {
      reads.clear();
      writes.clear();
    },
  };
}

/** An intake that answers each single item 202 and each batch item 202, while `online.value` holds. */
function fakeIntake() {
  const online = { value: true };
  const requests: { url: string; body: { items?: unknown[] } & Record<string, unknown> }[] = [];
  let ids = 0;
  const id = () => `fb_01JBXK3M8Q4R5S6T7V8W9${String(++ids).padStart(5, "0")}`;
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as (typeof requests)[number]["body"];
    requests.push({ url, body });
    if (!online.value) throw new TypeError("Network request failed");
    const answer = url.endsWith("/batch") ? { items: body.items!.map(() => ({ status: 202, id: id() })) } : { id: id() };
    return { status: url.endsWith("/batch") ? 200 : 202, json: async () => answer, headers: { get: () => null } };
  };
  return { fetch, requests, online };
}

function setup(store = countingStorage(), intake = fakeIntake(), extra: Partial<FeedbackClientOptions> = {}) {
  const answers: Answer[] = [];
  let attests = 0;
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
    attest: async () => {
      attests += 1;
      return { "x-attest-platform": "android", "x-attest-token": `t${attests}` };
    },
    onAnswered: (a) => void answers.push(a),
    ...extra,
  };
  const client = createFeedbackClient(options);
  return { client, store, intake, answers, options, clock, attests: () => attests };
}

const TEN_FACTS = {
  toilets: true,
  showers: true,
  power: false,
  tents: true,
  bins: true,
  bbq: true,
  kitchen: false,
  laundry: true,
  shade: true,
  wifi: false,
} as const;

const review = (i: number) => ({ place: PLACE, review: { stars: 4 as const, text: `Lovely spot by the river, visit ${i}. `.repeat(20), visited: "2026-10" }, consent: true as const });

describe("storage calls for an edit", () => {
  it("a ten fact edit behind a backlog makes at most 1 queue read and exactly 2 queue writes", async () => {
    const { client, store, intake } = setup();
    intake.online.value = false;
    for (let i = 0; i < 90; i++) await client.review(review(i));
    intake.online.value = true;
    store.reset();
    await client.reportFacts({ place: PLACE, facts: TEN_FACTS, consent: true });
    expect(store.reads(QUEUE)).toBeLessThanOrEqual(1);
    expect(store.writes(QUEUE)).toBe(2);
  });

  it("a failed save leaves the client holding only what storage holds", async () => {
    const { client, store, intake, clock } = setup();
    intake.online.value = false;
    await client.check({ place: PLACE, check: { still_there: true, visited: "2026-11-01" }, consent: true });
    store.failSet.add(QUEUE);
    await expect(client.reportFacts({ place: PLACE, facts: TEN_FACTS, consent: true })).rejects.toThrow("disk full");
    store.failSet.delete(QUEUE);
    expect(await client.pending()).toBe(1);
    intake.online.value = true;
    clock.t += 60_000;
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });

  it("reads the device id on the first operation only", async () => {
    const { client, store, clock } = setup();
    await client.check({ place: PLACE, check: { still_there: true, visited: "2026-11-01" }, consent: true });
    store.reset();
    await client.reportFacts({ place: PLACE, facts: TEN_FACTS, consent: true });
    await client.review(review(1));
    clock.t += 60_000;
    await client.flush();
    await client.ownerClaim({ place: PLACE, owner: { name: "Sam Owner", email: "owner@example.com" }, proofUrl: "https://example.com/proof", termsAccepted: true }).catch(() => undefined);
    expect(store.reads(DEVICE)).toBe(0);
    expect(store.writes(DEVICE)).toBe(0);
  });

  it("the photo client reads the device id on the first operation only", async () => {
    const store = countingStorage();
    const intake = fakeIntake();
    const photos = createPhotoClient({
      endpoint: "https://photos.example",
      appKey: "key",
      appVersion: "1.0.0",
      storage: store.storage,
      fetch: intake.fetch,
      now: () => Date.UTC(2026, 10, 12),
      random: () => 0.5,
    });
    await photos.photoPass();
    store.reset();
    await photos.photoPass({ renew: true });
    await photos.reportPhoto({ place: PLACE, photo: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZA", reason: "not_this_place", consent: true });
    expect(store.reads("ocdb.photos.device")).toBe(0);
  });
});

