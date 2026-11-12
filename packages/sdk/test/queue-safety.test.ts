import { describe, expect, it } from "vitest";
import { createFeedbackClient, createPhotoClient, type Answer, type FeedbackClientOptions, type FetchLike, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const CONTRIBUTOR = "contributor_0123456789";
const HOUR = 60 * 60 * 1000;

function memoryStorage() {
  const data = new Map<string, string>();
  const storage: StorageAdapter = {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
  return { storage, data };
}

type Reply = { status: number; body?: unknown; json?: "throws"; retryAfter?: string } | "network";

function fakeFetch(reply: (n: number, url: string, body: unknown) => Reply) {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ url, body });
    const r = reply(calls.length, url, body);
    if (r === "network") throw new TypeError("Network request failed");
    return {
      status: r.status,
      json: async () => {
        if (r.json === "throws") throw new SyntaxError("Unexpected token < in JSON");
        return r.body;
      },
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? (r.retryAfter ?? null) : null) },
    };
  };
  return { fetch, calls };
}

function client(fetch: FetchLike, extra: Partial<FeedbackClientOptions> = {}) {
  const mem = memoryStorage();
  const clock = { t: Date.UTC(2026, 10, 12) };
  const answers: Answer[] = [];
  const c = createFeedbackClient({
    endpoint: "https://intake.example",
    appKey: "key",
    appVersion: "1.0.0",
    storage: mem.storage,
    fetch,
    now: () => clock.t,
    random: () => 0.5,
    onAnswered: (a) => void answers.push(a),
    ...extra,
  });
  return { c, clock, answers, ...mem };
}

const check = (n = 0) => ({ place: PLACE, check: { visited: `2026-11-${String(1 + (n % 9)).padStart(2, "0")}`, still_there: true }, consent: true as const });
const accepted = (n: number): Reply => ({ status: 202, body: { id: `fb_01JBXK3M8Q4R5S6T7V8W9X0Y${String(n).padStart(2, "0")}` } });

describe("batch answers", () => {
  it("keeps a batch item whose own answer has no status", async () => {
    let online = false;
    const { fetch } = fakeFetch((_n, url, body) => {
      if (!online) return "network";
      if (url.endsWith("/batch")) {
        const items = (body as { items: unknown[] }).items;
        const answer = (i: number) => (i === 1 ? null : i === 2 ? { status: "202", error: "odd" } : { status: 202, id: `fb_01JBXK3M8Q4R5S6T7V8W9X0Y0${i}` });
        return { status: 200, body: { items: items.map((_, i) => answer(i)) } };
      }
      return accepted(9);
    });
    const { c, answers, clock } = client(fetch);
    for (let i = 0; i < 4; i++) await c.check(check(i));
    online = true;
    clock.t += 7 * HOUR; // past every backoff
    const flushed = await c.flush();
    expect(flushed).toMatchObject({ sent: 2, dropped: 0, remaining: 2 });
    expect(answers.filter((a) => a.outcome.kind === "dropped")).toEqual([]);
  });
});

describe("times from a wrong clock", () => {
  it("an item queued and tried under a clock far ahead is tried again once the clock is right", async () => {
    let online = false;
    const { fetch, calls } = fakeFetch((n) => (online ? accepted(n) : "network"));
    const { c, clock } = client(fetch);
    const right = clock.t;
    clock.t = Date.UTC(2070, 0, 1); // a phone that booted with a wrong clock
    await c.check(check()); // fails offline: queuedAt and nextAttemptAt are in 2070
    clock.t = right + 7 * HOUR;
    online = true;
    const before = calls.length;
    await c.flush();
    expect(calls.length).toBe(before + 1);
    expect(await c.pending()).toBe(0);
  });

  it("an item tried under a clock far ahead waits no longer than the longest backoff", async () => {
    let online = false;
    const { fetch, calls } = fakeFetch((n) => (online ? accepted(n) : "network"));
    const { c, clock } = client(fetch);
    const right = clock.t;
    await c.check(check()); // queued under the right clock, fails offline
    clock.t = right + 20 * 24 * HOUR;
    await c.flush(); // a failed try under a clock 20 days ahead: the next try is set 20 days ahead
    clock.t = right + HOUR;
    await c.flush(); // the clock is right again: the wait is cut to the longest backoff from now
    online = true;
    clock.t += 6 * HOUR + 1;
    const before = calls.length;
    await c.flush();
    expect(calls.length).toBe(before + 1);
    expect(await c.pending()).toBe(0);
  });

  it("an item queued with a time in the future is not kept past its age limit", async () => {
    const { fetch } = fakeFetch(() => "network");
    const { c, clock, answers } = client(fetch, { maxQueueAgeMs: 10 * HOUR });
    const right = clock.t;
    clock.t = Date.UTC(2070, 0, 1);
    await c.check({ ...check(), ref: "future" });
    clock.t = right;
    await c.flush(); // queuedAt is taken as now
    clock.t += 11 * HOUR;
    await c.flush();
    expect(await c.pending()).toBe(0);
    expect(answers).toEqual([{ ref: "future", type: "check", outcome: { kind: "dropped", httpStatus: 0 } }]);
  });
});

describe("Retry-After", () => {
  it("a Retry-After longer than a day waits one day", async () => {
    const { fetch, calls } = fakeFetch((n) => (n === 1 ? { status: 429, body: { error: "rate_limited" }, retryAfter: "31536000" } : accepted(n)));
    const { c, clock } = client(fetch);
    await c.check(check());
    expect((await c.queueSummary()).intakeWaitUntil).toBe(clock.t + 24 * HOUR);
    clock.t += 24 * HOUR + 1;
    await c.flush();
    expect(calls.length).toBe(2);
  });
});

describe("a full queue", () => {
  it("does not drop a queued erasure request to make room for reports", async () => {
    const { fetch } = fakeFetch(() => "network");
    const { c, answers } = client(fetch, { maxQueueLength: 5 });
    await c.eraseReviews({ contributor: CONTRIBUTOR, consent: true, ref: "erase" });
    for (let i = 0; i < 5; i++) await c.check({ ...check(i), ref: `check-${i}` });
    expect(answers.find((a) => a.ref === "erase")).toBeUndefined();
    expect(answers).toEqual([{ ref: "check-0", type: "check", outcome: { kind: "dropped", httpStatus: 0 } }]);
    expect((await c.queuedRefs()).refs).toEqual(["erase", "check-1", "check-2", "check-3", "check-4"]);
  });

  it("keeps every erasure when only erasures are left", async () => {
    const { fetch } = fakeFetch(() => "network");
    const answers: Answer[] = [];
    const photos = createPhotoClient({
      endpoint: "https://photos.example",
      appKey: "key",
      appVersion: "1.0.0",
      storage: memoryStorage().storage,
      fetch,
      now: () => Date.UTC(2026, 10, 12),
      maxQueueLength: 2,
      onAnswered: (a) => void answers.push(a),
    });
    await photos.removePhoto({ place: PLACE, photo: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB", contributor: CONTRIBUTOR, consent: true, ref: "removal" });
    await photos.erasePhotos({ contributor: CONTRIBUTOR, consent: true, ref: "photos" });
    await photos.erasePhotos({ contributor: CONTRIBUTOR, consent: true, ref: "again" });
    expect(answers).toEqual([]);
    expect(await photos.pending()).toBe(3);
    // A report queued now is the oldest item that is not an erasure, so it goes.
    expect(await photos.reportPhoto({ place: PLACE, photo: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZB", reason: "not_this_place", consent: true, ref: "late" })).toEqual({
      status: "rejected",
      httpStatus: 0,
    });
    expect(answers).toEqual([{ ref: "late", type: "photo_report", outcome: { kind: "dropped", httpStatus: 0 } }]);
    expect(await photos.pending()).toBe(3);
  });

});

describe("a failed save after a send", () => {
  it("report() answers from the send when only saving the queue afterwards failed", async () => {
    const { fetch, calls } = fakeFetch((n) => accepted(n));
    const mem = memoryStorage();
    let failRemove = true;
    const storage: StorageAdapter = {
      ...mem.storage,
      removeItem: async (k) => {
        if (failRemove && k.endsWith(".queue")) throw new Error("storage is full");
        return mem.storage.removeItem(k);
      },
    };
    const answers: Answer[] = [];
    const { c } = client(fetch, { storage, onAnswered: (a) => void answers.push(a) });
    const result = await c.report({ place: PLACE, report: { kind: "closed" }, consent: true, ref: "r" });
    failRemove = false;
    expect(calls.length).toBe(1);
    expect(result).toMatchObject({ status: "sent", id: "fb_01JBXK3M8Q4R5S6T7V8W9X0Y01" });
    expect(answers.map((a) => a.ref)).toEqual(["r"]);
    // This session does not send it again.
    expect(await c.pending()).toBe(0);
    await c.flush();
    expect(calls.length).toBe(1);
  });

  it("a failed save when nothing was sent still rejects", async () => {
    const { fetch } = fakeFetch(() => "network");
    const mem = memoryStorage();
    let fail = false;
    const storage: StorageAdapter = {
      ...mem.storage,
      setItem: async (k, v) => {
        if (fail && k.endsWith(".queue")) throw new Error("storage is full");
        return mem.storage.setItem(k, v);
      },
    };
    const { c } = client(fetch, { storage });
    await c.check(check());
    fail = true;
    await expect(c.flush({ ignoreBackoff: true })).rejects.toThrow("storage is full");
  });
});

describe("an unreadable queue", () => {
  it("is kept aside, not overwritten by the next submit, and reported", async () => {
    const { fetch } = fakeFetch(() => "network");
    const seen: unknown[] = [];
    const { c, data } = client(fetch, { onQueueUnreadable: (u) => void seen.push(u) });
    await c.check(check(1));
    await c.check(check(2));
    const key = "ocdb.feedback.queue";
    const cut = data.get(key)!.slice(0, -20); // a write cut short
    data.set(key, cut);
    // A new client reads the queue from storage, as after a restart.
    const again = createFeedbackClient({
      endpoint: "https://intake.example",
      appKey: "key",
      appVersion: "1.0.0",
      storage: { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) },
      fetch,
      onQueueUnreadable: (u) => void seen.push(u),
    });
    await again.check(check(3));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(data.get("ocdb.feedback.queue.corrupt")).toBe(cut);
    expect(await again.pending()).toBe(1);
    expect(seen).toEqual([{ keptAt: "ocdb.feedback.queue.corrupt" }]);
  });

  it("a queue that is JSON but not a list is kept aside too", async () => {
    const { fetch } = fakeFetch(() => "network");
    const { c, data } = client(fetch);
    data.set("ocdb.feedback.queue", '{"not":"a list"}');
    await c.check(check());
    expect(data.get("ocdb.feedback.queue.corrupt")).toBe('{"not":"a list"}');
    expect(await c.pending()).toBe(1);
  });

  it("a hook that throws does not stop the queue", async () => {
    const { fetch } = fakeFetch(() => "network");
    const { c, data } = client(fetch, {
      onQueueUnreadable: () => {
        throw new Error("app bug");
      },
    });
    data.set("ocdb.feedback.queue", "[{");
    expect(await c.check(check())).toEqual({ status: "queued" });
    expect(data.get("ocdb.feedback.queue.corrupt")).toBe("[{");
  });
});
