import { describe, expect, it } from "vitest";
import { createFeedbackClient, MAX_BATCH_SIZE, newPlaceId, type Answer, type FeedbackClientOptions, type FetchLike, type StorageAdapter } from "../src/index.js";

/** A clock in December 2026, after every visit date the tests send. */
const T0 = Date.UTC(2026, 11, 1);

/** The intake's id for the n-th item it accepts. */
const fb = (n: number) => `fb_01JBXK3M8Q4R5S6T7V8W9${String(n).padStart(5, "0")}`;
const place = (i: number) => `ocdb_01JBXK3M8Q4R5S6T7V8W9${String(i).padStart(5, "0")}`;

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

type Reply = { status: number; body?: unknown; retryAfter?: string } | "network";
interface Call {
  url: string;
  headers: Record<string, string>;
  body: { items?: Record<string, unknown>[] } & Record<string, unknown>;
}

/**
 * An intake. `reply` answers each call. By default a batch is answered 202
 * for every item, with ids fb_1, fb_2 and so on, and a single POST 202.
 */
function fakeIntake(reply?: (call: Call, n: number) => Reply | undefined) {
  const calls: Call[] = [];
  let ids = 0;
  const fetch: FetchLike = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body) as Call["body"] };
    calls.push(call);
    const given = reply?.(call, calls.length);
    if (given === "network") throw new TypeError("Network request failed");
    const answer =
      given ??
      (url.endsWith("/batch")
        ? { status: 200, body: { items: call.body.items!.map(() => ({ status: 202, id: fb(++ids) })) } }
        : { status: 202, body: { id: fb(++ids) } });
    return {
      status: answer.status,
      json: async () => answer.body ?? {},
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (answer.retryAfter ?? null) : null) },
    };
  };
  return { fetch, calls };
}

function setup(intake: ReturnType<typeof fakeIntake>, extra: Partial<FeedbackClientOptions> = {}) {
  const answers: Answer[] = [];
  const attests: string[] = [];
  let clock = T0;
  let uuid = 0;
  const client = createFeedbackClient({
    endpoint: "https://intake.example",
    appKey: "key-1",
    appVersion: "1.2.3",
    storage: memoryStorage(),
    fetch: intake.fetch,
    now: () => clock,
    random: () => 0,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    attest: async ({ body }) => {
      attests.push(body);
      return { "x-attest-platform": "android", "x-attest-token": `t${attests.length}` };
    },
    onAnswered: (answer) => void answers.push(answer),
    ...extra,
  });
  return { client, answers, attests, advance: (ms: number) => void (clock += ms) };
}

/** Queues `n` checks while the intake is unreachable, so they are all due at the next flush. */
async function queueOffline(client: ReturnType<typeof setup>["client"], online: { value: boolean }, n: number, from = 0) {
  online.value = false;
  for (let i = from; i < from + n; i++) await client.check({ place: place(i), check: { still_there: true, visited: "2026-11-01" }, consent: true, ref: `c${i}` });
  online.value = true;
}

describe("batched flush", () => {
  it("sends 120 due items as 3 batches, with one attestation each over the batch body", async () => {
    const online = { value: true };
    const intake = fakeIntake(() => (online.value ? undefined : "network"));
    const { client, attests, advance } = setup(intake, { maxQueueLength: 200 });
    await queueOffline(client, online, 120);
    advance(24 * 60 * 60 * 1000);
    intake.calls.length = 0;
    attests.length = 0;
    expect(await client.flush()).toEqual({ sent: 120, dropped: 0, remaining: 0 });
    expect(intake.calls.map((c) => [c.url, c.body.items?.length])).toEqual([
      ["https://intake.example/v1/feedback/batch", 50],
      ["https://intake.example/v1/feedback/batch", 50],
      ["https://intake.example/v1/feedback/batch", 20],
    ]);
    expect(attests).toEqual(intake.calls.map((c) => JSON.stringify(c.body)));
    expect(intake.calls.map((c) => c.headers["x-attest-token"])).toEqual(["t1", "t2", "t3"]);
  });
  it("drops an item the intake refused and keeps one it rate limited, then stops after the batch", async () => {
    const online = { value: true };
    const intake = fakeIntake((call) => {
      if (!online.value) return "network";
      if (!call.url.endsWith("/batch")) return undefined;
      return {
        status: 200,
        body: {
          items: [
            { status: 202, id: "fb_a", state: "live" },
            { status: 400, error: "invalid", details: ["bad"] },
            { status: 429, error: "rate_limited", retry_after: 600 },
            { status: 202, id: "fb_d" },
          ],
        },
      };
    });
    const { client, answers, advance } = setup(intake);
    await queueOffline(client, online, 4);
    advance(24 * 60 * 60 * 1000);
    intake.calls.length = 0;
    answers.length = 0;
    expect(await client.flush()).toEqual({ sent: 2, dropped: 1, remaining: 1 });
    // The 400 stopped nothing, and the 429 kept its item, after which the answers that followed still count.
    expect(intake.calls).toHaveLength(1);
    expect(answers).toEqual([
      { ref: "c0", type: "check", outcome: { kind: "sent", id: "fb_a", state: "live" } },
      { ref: "c1", type: "check", outcome: { kind: "dropped", httpStatus: 400 } },
      { ref: "c3", type: "check", outcome: { kind: "sent", id: "fb_d" } },
    ]);
    // The rate-limited item waits as long as the intake said, then goes alone.
    advance(599_000);
    await client.flush();
    expect(intake.calls).toHaveLength(1);
    advance(2_000);
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(intake.calls[1]!.url).toBe("https://intake.example/v1/feedback");
    expect(intake.calls[1]!.body.check).toEqual({ still_there: true, visited: "2026-11-01" });
    expect(answers.map((a) => a.ref)).toEqual(["c0", "c1", "c3", "c2"]);
  });

  it("keeps every item and stops when the whole batch fails", async () => {
    for (const reply of ["network", { status: 503 }, { status: 408 }, { status: 429, retryAfter: "120" }, { status: 401, body: { error: "attestation_invalid", reason: "integrity_not_met" } }] as Reply[]) {
      const online = { value: true };
      const refusals: string[] = [];
      const intake = fakeIntake((call) => (!online.value ? "network" : call.url.endsWith("/batch") ? reply : undefined));
      const { client, answers, advance } = setup(intake, { maxBatchSize: 2, onAttestationRejected: (error) => void refusals.push(error) });
      await queueOffline(client, online, 5);
      advance(24 * 60 * 60 * 1000);
      intake.calls.length = 0;
      answers.length = 0;
      expect(await client.flush()).toEqual({ sent: 0, dropped: 0, remaining: 5 });
      expect(intake.calls).toHaveLength(1);
      expect(answers).toEqual([]);
      expect(refusals).toEqual(typeof reply === "object" && reply.status === 401 ? ["attestation_invalid"] : []);
    }
  });

  it("sends each item of the round alone when the intake refuses the whole batch with 400, 403 or 413", async () => {
    for (const status of [400, 403, 413]) {
      const online = { value: true };
      let batches = 0;
      const intake = fakeIntake((call) => {
        if (!online.value) return "network";
        // The first batch is refused as a whole, the next is taken.
        if (call.url.endsWith("/batch")) return ++batches === 1 ? { status, body: { error: "refused" } } : undefined;
        // Alone, each item gets its own answer: the second is refused, the others accepted.
        return call.body.check && (call.body.place as string) === place(1) ? { status: 400, body: { error: "invalid" } } : undefined;
      });
      const { client, answers, advance } = setup(intake, { maxBatchSize: 3 });
      await queueOffline(client, online, 5);
      advance(24 * 60 * 60 * 1000);
      intake.calls.length = 0;
      answers.length = 0;
      expect(await client.flush(), `status ${status}`).toEqual({ sent: 4, dropped: 1, remaining: 0 });
      expect(intake.calls.map((c) => c.url.replace("https://intake.example", ""))).toEqual([
        "/v1/feedback/batch",
        "/v1/feedback",
        "/v1/feedback",
        "/v1/feedback",
        "/v1/feedback/batch",
      ]);
      expect(answers.map((a) => [a.ref, a.outcome.kind])).toEqual([
        ["c0", "sent"],
        ["c1", "dropped"],
        ["c2", "sent"],
        ["c3", "sent"],
        ["c4", "sent"],
      ]);
    }
  });

  it("keeps batching after a whole-batch refusal, for the client's lifetime", async () => {
    const online = { value: true };
    let refuse = true;
    const intake = fakeIntake((call) => (!online.value ? "network" : call.url.endsWith("/batch") && refuse ? { status: 413, body: { error: "too_large" } } : undefined));
    const { client, advance } = setup(intake);
    await queueOffline(client, online, 2);
    advance(24 * 60 * 60 * 1000);
    await client.flush();
    refuse = false;
    await queueOffline(client, online, 2, 10);
    advance(24 * 60 * 60 * 1000);
    intake.calls.length = 0;
    expect(await client.flush()).toEqual({ sent: 2, dropped: 0, remaining: 0 });
    expect(intake.calls.map((c) => c.url)).toEqual(["https://intake.example/v1/feedback/batch"]);
  });

  it("drops every item of the batch on 401 invalid_app_key", async () => {
    const online = { value: true };
    const intake = fakeIntake((call) => (!online.value ? "network" : call.url.endsWith("/batch") ? { status: 401, body: { error: "invalid_app_key" } } : undefined));
    const { client, answers, advance } = setup(intake);
    await queueOffline(client, online, 3);
    advance(24 * 60 * 60 * 1000);
    intake.calls.length = 0;
    answers.length = 0;
    expect(await client.flush()).toEqual({ sent: 0, dropped: 3, remaining: 0 });
    expect(intake.calls).toHaveLength(1);
    expect(answers.map((a) => a.outcome)).toEqual(Array.from({ length: 3 }, () => ({ kind: "dropped", httpStatus: 401 })));
  });

  it("sends the items waiting for a new place in the next batch of the same flush, once a batch gives it its id", async () => {
    const online = { value: true };
    const intake = fakeIntake(() => (online.value ? undefined : "network"));
    const { client, answers, advance } = setup(intake);
    online.value = false;
    await client.report({ place: null, location: { lat: -36.1, lon: 146.8 }, report: { kind: "new_place", place_kind: "free_camp" }, consent: true, ref: "np" });
    await client.check({ place: place(1), check: { still_there: true, visited: "2026-11-01" }, consent: true, ref: "other" });
    await client.reportFacts({ place: { newPlace: "np" }, facts: { toilets: true, drinking_water: true }, consent: true, ref: "edit" });
    online.value = true;
    advance(24 * 60 * 60 * 1000);
    intake.calls.length = 0;
    answers.length = 0;
    expect(await client.flush()).toEqual({ sent: 4, dropped: 0, remaining: 0 });
    expect(intake.calls.map((c) => c.body.items?.map((b) => [b.type, b.place]))).toEqual([
      [
        ["report", null],
        ["check", place(1)],
      ],
      [
        ["report", newPlaceId(fb(1))],
        ["report", newPlaceId(fb(1))],
      ],
    ]);
    expect(answers.map((a) => a.ref)).toEqual(["np", "other", "edit:toilets", "edit:drinking_water"]);
  });

  it("sends one at a time, for the client's lifetime, when the intake has no batch route", async () => {
    for (const status of [404, 405]) {
      const online = { value: true };
      const intake = fakeIntake((call) => (!online.value ? "network" : call.url.endsWith("/batch") ? { status } : undefined));
      const { client, answers, advance } = setup(intake);
      await queueOffline(client, online, 3);
      advance(24 * 60 * 60 * 1000);
      intake.calls.length = 0;
      answers.length = 0;
      expect(await client.flush()).toEqual({ sent: 3, dropped: 0, remaining: 0 });
      expect(intake.calls.map((c) => c.url.replace("https://intake.example", ""))).toEqual(["/v1/feedback/batch", "/v1/feedback", "/v1/feedback", "/v1/feedback"]);
      expect(answers.map((a) => a.ref)).toEqual(["c0", "c1", "c2"]);
      await queueOffline(client, online, 2, 10);
      advance(24 * 60 * 60 * 1000);
      intake.calls.length = 0;
      await client.flush();
      expect(intake.calls.every((c) => c.url === "https://intake.example/v1/feedback")).toBe(true);
    }
  });

  it("sends one due item alone, as before", async () => {
    const intake = fakeIntake();
    const { client, attests } = setup(intake);
    expect(await client.check({ place: place(1), check: { still_there: true, visited: "2026-11-01" }, consent: true })).toEqual({ status: "sent", id: fb(1) });
    expect(intake.calls.map((c) => c.url)).toEqual(["https://intake.example/v1/feedback"]);
    expect(attests).toEqual([JSON.stringify(intake.calls[0]!.body)]);
  });

  it("takes a maxBatchSize from 1 to 50 only", () => {
    const intake = fakeIntake();
    for (const bad of [0, 51, 1.5, Number.NaN]) expect(() => setup(intake, { maxBatchSize: bad })).toThrow(/maxBatchSize/);
    for (const good of [1, MAX_BATCH_SIZE]) expect(() => setup(intake, { maxBatchSize: good })).not.toThrow();
    expect(MAX_BATCH_SIZE).toBe(50);
  });

  it("tells onAnswered in queue order, batch by batch", async () => {
    const online = { value: true };
    const intake = fakeIntake(() => (online.value ? undefined : "network"));
    const { client, answers, advance } = setup(intake, { maxBatchSize: 3 });
    await queueOffline(client, online, 7);
    advance(24 * 60 * 60 * 1000);
    answers.length = 0;
    await client.flush();
    expect(answers.map((a) => a.ref)).toEqual(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(answers.map((a) => (a.outcome as { id: string }).id)).toEqual([1, 2, 3, 4, 5, 6, 7].map(fb));
  });
});
