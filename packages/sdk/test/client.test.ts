import { describe, expect, it } from "vitest";
import {
  ConsentRequiredError,
  CONSENT_TEXT,
  createFeedbackClient,
  FeedbackValidationError,
  type FetchLike,
  type StorageAdapter,
} from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";

function memoryStorage(): StorageAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
  };
}

type Reply = number | "network" | { status: number; retryAfter?: string };

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  let n = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const reply = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    if (reply === "network") throw new TypeError("Network request failed");
    const status = typeof reply === "number" ? reply : reply.status;
    const retryAfter = typeof reply === "object" ? reply.retryAfter ?? null : null;
    return {
      status,
      json: async () => (status === 202 ? { id: `fb_${n}` } : { error: "x" }),
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter : null) },
    };
  };
  return { fetch, calls };
}

function setup(replies: Reply[], start = 1_000_000) {
  const storage = memoryStorage();
  const { fetch, calls } = fakeFetch(replies);
  let clock = start;
  let uuid = 0;
  const client = createFeedbackClient({
    endpoint: "https://intake.example/",
    appKey: "key-1",
    appVersion: "1.2.3",
    storage,
    fetch,
    now: () => clock,
    random: () => 0,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  });
  return {
    client,
    storage,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const check = { place: PLACE, check: { visited: "2026-10-20", still_there: true }, consent: true };

describe("createFeedbackClient", () => {
  it("refuses to send without consent", async () => {
    const { client, calls } = setup([202]);
    await expect(client.check({ ...check, consent: false })).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(calls).toHaveLength(0);
  });

  it("sends a check with the app key, device and version", async () => {
    const { client, calls } = setup([202]);
    const result = await client.check(check);
    expect(result).toEqual({ status: "sent", id: "fb_1" });
    expect(calls[0]!.url).toBe("https://intake.example/v1/feedback");
    expect(calls[0]!.headers["x-app-key"]).toBe("key-1");
    expect(calls[0]!.body).toEqual({
      type: "check",
      place: PLACE,
      device: "00000000-0000-4000-8000-000000000001",
      app_version: "1.2.3",
      consent: true,
      check: { visited: "2026-10-20", still_there: true },
    });
  });

  it("generates one device id per install and keeps it", async () => {
    const { client, calls, storage } = setup([202]);
    await client.check(check);
    await client.review({ place: PLACE, review: { stars: 4, text: "Shady and quiet", visited: "2026-10" }, consent: true });
    const devices = calls.map((c) => (c.body as { device: string }).device);
    expect(new Set(devices).size).toBe(1);
    expect(storage.data.get("ocdb.feedback.device")).toBe(devices[0]);
  });

  it("throws on an invalid payload before queuing it", async () => {
    const { client, calls } = setup([202]);
    await expect(
      client.review({ place: PLACE, review: { stars: 6 as 5, text: "", visited: "2026-10" }, consent: true }),
    ).rejects.toBeInstanceOf(FeedbackValidationError);
    expect(calls).toHaveLength(0);
    expect(await client.pending()).toBe(0);
  });

  it("keeps an item on a network error and sends it on a later flush", async () => {
    const { client, calls, advance } = setup(["network", 202]);
    expect(await client.check(check)).toEqual({ status: "queued" });
    expect(await client.pending()).toBe(1);

    // Not due yet: backoff is 15 to 30 seconds after the first failure.
    expect(await client.flush()).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    expect(calls).toHaveLength(1);

    advance(30_000);
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(await client.pending()).toBe(0);
  });

  it("keeps items on 429 and 5xx", async () => {
    for (const status of [429, 500, 503]) {
      const { client } = setup([status]);
      expect(await client.check(check)).toEqual({ status: "queued" });
      expect(await client.pending()).toBe(1);
    }
  });

  it("honours Retry-After on 429", async () => {
    const { client, calls, advance } = setup([{ status: 429, retryAfter: "120" }, 202]);
    await client.check(check);
    advance(60_000);
    await client.flush();
    expect(calls).toHaveLength(1);
    advance(60_000);
    expect((await client.flush()).sent).toBe(1);
  });

  it("drops items on 400 and 401", async () => {
    for (const status of [400, 401]) {
      const { client } = setup([status]);
      expect(await client.check(check)).toEqual({ status: "rejected", httpStatus: status });
      expect(await client.pending()).toBe(0);
    }
  });

  it("backs off further after each failure", async () => {
    const { client, calls, advance } = setup(["network"]);
    await client.check(check);
    advance(15_000);
    await client.flush(); // second try
    expect(calls).toHaveLength(2);
    advance(15_000);
    await client.flush(); // not due: second backoff is at least 30 seconds
    expect(calls).toHaveLength(2);
    advance(15_000);
    await client.flush();
    expect(calls).toHaveLength(3);
  });

  it("stops a flush at the first network error so the rest wait", async () => {
    const { client, calls, advance } = setup(["network"]);
    await client.check(check);
    await client.check(check); // first item is not due, second fails and is kept
    advance(60_000);
    const result = await client.flush();
    expect(result).toEqual({ sent: 0, dropped: 0, remaining: 2 });
    expect(calls).toHaveLength(3);
  });

  it("survives a restart because the queue is in storage", async () => {
    const first = setup(["network"]);
    await first.client.check(check);
    const { fetch, calls } = fakeFetch([202]);
    const again = createFeedbackClient({
      endpoint: "https://intake.example",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: first.storage,
      fetch,
      now: () => 10_000_000,
    });
    expect(await again.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(calls).toHaveLength(1);
  });

  it("drops queued items older than the maximum age", async () => {
    const { client, advance } = setup(["network"]);
    await client.check(check);
    advance(31 * 24 * 60 * 60 * 1000);
    expect(await client.flush()).toEqual({ sent: 0, dropped: 1, remaining: 0 });
  });

  it("exports consent wording that names both licences", () => {
    expect(CONSENT_TEXT).toContain("ODbL");
    expect(CONSENT_TEXT).toContain("DbCL");
    expect(CONSENT_TEXT).toContain("OpenStreetMap as notes");
    expect(CONSENT_TEXT).not.toMatch(/[\u2013\u2014]/);
  });
});
