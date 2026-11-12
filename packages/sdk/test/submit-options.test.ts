// Sending without waiting, whole-edit reportFacts, request timeouts and which refusals drop an item.
import { describe, expect, it } from "vitest";
import { createFeedbackClient, type Answer, type FeedbackClientOptions, type FetchLike, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

type Reply = { status: number; body?: unknown; html?: true } | "network" | "hang";

function fakeFetch(reply: (n: number, url: string) => Reply) {
  const calls: { url: string; body: unknown; signal?: AbortSignal }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), ...(init.signal ? { signal: init.signal } : {}) });
    const r = reply(calls.length, url);
    if (r === "network") throw new TypeError("Network request failed");
    if (r === "hang") return new Promise(() => undefined);
    return {
      status: r.status,
      json: async () => {
        if (r.html) throw new SyntaxError("Unexpected token < in JSON");
        return r.body;
      },
      headers: { get: () => null },
    };
  };
  return { fetch, calls };
}

function client(fetch: FetchLike, extra: Partial<FeedbackClientOptions> = {}) {
  const clock = { t: Date.UTC(2026, 10, 12) };
  const answers: Answer[] = [];
  const c = createFeedbackClient({
    endpoint: "https://intake.example",
    appKey: "key",
    appVersion: "1.0.0",
    storage: memoryStorage(),
    fetch,
    now: () => clock.t,
    random: () => 0.5,
    onAnswered: (a) => void answers.push(a),
    ...extra,
  });
  return { c, clock, answers };
}

const accepted = (n: number): Reply => ({ status: 202, body: { id: `fb_01JBXK3M8Q4R5S6T7V8W9X0Y${String(n).padStart(2, "0")}` } });
const closed = { place: PLACE, report: { kind: "closed" as const }, consent: true as const };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("wait: false", () => {
  it("resolves queued before the intake answers, and the outcome reaches onAnswered", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetch: FetchLike = async () => {
      await gate;
      return { status: 202, json: async () => ({ id: "fb_01JBXK3M8Q4R5S6T7V8W9X0Y01" }), headers: { get: () => null } };
    };
    const { c, answers } = client(fetch);
    expect(await c.report({ ...closed, ref: "r1" }, { wait: false })).toEqual({ status: "queued" });
    expect(answers).toEqual([]);
    release();
    await settle();
    expect(answers).toEqual([{ ref: "r1", type: "report", outcome: { kind: "sent", id: "fb_01JBXK3M8Q4R5S6T7V8W9X0Y01" } }]);
    expect(await c.pending()).toBe(0);
  });

  it("still throws on a refused input before anything is queued", async () => {
    const { fetch, calls } = fakeFetch(accepted);
    const { c } = client(fetch);
    await expect(c.report({ place: PLACE, report: { kind: "fact", fact: "toilets", value: "maybe" }, consent: true } as never, { wait: false })).rejects.toThrow();
    await settle();
    expect(calls).toHaveLength(0);
    expect(await c.pending()).toBe(0);
  });

  it("waits behind a flush already running no longer than timeoutMs", async () => {
    // Saving goes through the queue's one-at-a-time chain, so a send already under way is waited for, up to the timeout.
    const { fetch } = fakeFetch((n) => (n === 1 ? "hang" : accepted(n)));
    const { c } = client(fetch, { timeoutMs: 100 });
    void c.report(closed);
    await settle();
    const quick = await Promise.race([
      c.check({ place: PLACE, check: { visited: "2026-11-10", still_there: true }, consent: true }, { wait: false }),
      new Promise((r) => setTimeout(() => r("blocked"), 400)),
    ]);
    expect(quick).toEqual({ status: "queued" });
  });

  it("is the default to wait, as before", async () => {
    const { fetch } = fakeFetch(accepted);
    const { c } = client(fetch);
    expect(await c.report(closed)).toMatchObject({ status: "sent" });
  });
});

describe("reportFacts", () => {
  it("sends an edit of five facts as one batch with one attestation", async () => {
    const { fetch, calls } = fakeFetch(accepted);
    let attestations = 0;
    const { c } = client(fetch, {
      attest: async () => {
        attestations += 1;
        return { "x-attest-platform": "android", "x-attest-token": "t" };
      },
    });
    await c.reportFacts({ place: PLACE, facts: { toilets: true, showers: true, power: false, tents: true, bins: true }, consent: true });
    expect({ requests: calls.length, attestations }).toEqual({ requests: 1, attestations: 1 });
  });

  it("sends nothing when one fact of the edit is refused", async () => {
    const { fetch, calls } = fakeFetch(accepted);
    const { c } = client(fetch);
    await expect(c.reportFacts({ place: PLACE, facts: { toilets: true, seasonal_closure: true, showers: true }, consent: true })).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(await c.pending()).toBe(0);
  });

  it("marks every fact first-hand when the edit is", async () => {
    const { fetch, calls } = fakeFetch(accepted);
    const { c } = client(fetch);
    await c.reportFacts({ place: PLACE, facts: { toilets: true, showers: false }, consent: true, first_hand: "seen_nearby" });
    const items = (calls[0]!.body as { items: { report: { first_hand?: string } }[] }).items;
    expect(items.map((item) => item.report.first_hand)).toEqual(["seen_nearby", "seen_nearby"]);
  });

  it("with wait: false answers each fact queued", async () => {
    const { fetch } = fakeFetch(accepted);
    const { c } = client(fetch);
    const results = await c.reportFacts({ place: PLACE, facts: { toilets: true, showers: false }, consent: true }, { wait: false });
    expect(results).toEqual([
      { fact: "toilets", result: { status: "queued" } },
      { fact: "showers", result: { status: "queued" } },
    ]);
  });
});

describe("timeoutMs", () => {
  it("a request that never answers is given up on, so later calls are not blocked", async () => {
    const { fetch, calls } = fakeFetch(() => "hang");
    const { c } = client(fetch, { timeoutMs: 50 });
    void c.report(closed);
    await settle();
    const answer = await Promise.race([c.pending(), new Promise((resolve) => setTimeout(() => resolve("blocked"), 300))]);
    expect(answer).toBe(1);
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("refuses a timeout that is not above 0", () => {
    const { fetch } = fakeFetch(accepted);
    expect(() => client(fetch, { timeoutMs: 0 })).toThrow(/timeoutMs/);
  });
});

describe("refusals that are not the intake's", () => {
  it("keep an item when a 403 is an HTML page, not the intake's JSON", async () => {
    const { fetch } = fakeFetch(() => ({ status: 403, html: true }));
    const { c, answers } = client(fetch);
    expect(await c.report(closed)).toEqual({ status: "queued" });
    expect(await c.pending()).toBe(1);
    expect(answers).toEqual([]);
  });

  it("keep a whole queue when the batch and each single send get an HTML 403", async () => {
    let online = false;
    const { fetch } = fakeFetch(() => (online ? { status: 403, html: true } : "network"));
    const { c, answers, clock } = client(fetch);
    for (let i = 0; i < 5; i++) await c.check({ place: PLACE, check: { visited: `2026-11-0${i + 1}`, still_there: true }, consent: true });
    online = true;
    clock.t += 7 * 60 * 60 * 1000;
    expect((await c.flush()).dropped).toBe(0);
    expect(await c.pending()).toBe(5);
    expect(answers.filter((a) => a.outcome.kind === "dropped")).toEqual([]);
  });

  it("still drop an item the intake itself refuses", async () => {
    const { fetch } = fakeFetch(() => ({ status: 400, body: { error: "invalid_submission" } }));
    const { c } = client(fetch);
    expect(await c.report(closed)).toEqual({ status: "rejected", httpStatus: 400 });
    expect(await c.pending()).toBe(0);
  });
});
