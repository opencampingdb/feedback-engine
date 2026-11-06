import { describe, expect, it } from "vitest";
import { createFeedbackClient, MAX_BATCH_SIZE, newPlaceId, type Answer, type FeedbackClientOptions, type FetchLike, type StorageAdapter } from "../src/index.js";

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
 * An intake. `reply` answers each call; by default a batch is answered 202
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
        ? { status: 200, body: { items: call.body.items!.map(() => ({ status: 202, id: `fb_${++ids}` })) } }
        : { status: 202, body: { id: `fb_${++ids}` } });
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
  let clock = 1_000_000;
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
});

