import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduled, type Env } from "../src/index.js";
import { CATCH_UP_MS, cronMatches, dueSlot, parseCron, parseTimetable, startTimedIfDue, type TimedStart } from "../src/timed.js";
import { fakeD1 } from "./fake-d1.js";

const MINUTE = 60 * 1000;
const at = (iso: string) => Date.parse(iso);

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("cron", () => {
  it("matches a daily time", () => {
    const c = parseCron("0 16 * * *");
    expect(cronMatches(c, at("2026-11-15T16:00:00Z"))).toBe(true);
    expect(cronMatches(c, at("2026-11-15T16:01:00Z"))).toBe(false);
    expect(cronMatches(c, at("2026-11-15T15:00:00Z"))).toBe(false);
  });

  it("matches steps, ranges and lists", () => {
    const c = parseCron("17 */6 * * *");
    expect(["00", "06", "12", "18"].every((h) => cronMatches(c, at(`2026-11-15T${h}:17:00Z`)))).toBe(true);
    expect(cronMatches(c, at("2026-11-15T07:17:00Z"))).toBe(false);
    const d = parseCron("0,30 9-11 * * 1-5");
    expect(cronMatches(d, at("2026-11-16T10:30:00Z"))).toBe(true); // a Monday
    expect(cronMatches(d, at("2026-11-15T10:30:00Z"))).toBe(false); // a Sunday
  });

  it("matches a day of the month", () => {
    const c = parseCron("0 20 28 * *");
    expect(cronMatches(c, at("2026-11-28T20:00:00Z"))).toBe(true);
    expect(cronMatches(c, at("2026-11-27T20:00:00Z"))).toBe(false);
  });

  it("takes 7 as Sunday, and either day field when both are given", () => {
    expect(cronMatches(parseCron("0 0 * * 7"), at("2026-11-15T00:00:00Z"))).toBe(true);
    const both = parseCron("0 0 1 * 1");
    expect(cronMatches(both, at("2026-12-01T00:00:00Z"))).toBe(true); // the 1st, a Tuesday
    expect(cronMatches(both, at("2026-11-16T00:00:00Z"))).toBe(true); // a Monday
    expect(cronMatches(both, at("2026-11-17T00:00:00Z"))).toBe(false);
  });

  it("refuses what it cannot read", () => {
    for (const bad of ["0 16 * *", "60 * * * *", "* 24 * * *", "@daily", "0 16 * * MON", "*/0 * * * *", "5-1 * * * *"]) {
      expect(() => parseCron(bad), bad).toThrow();
    }
  });

  it("finds the slot due, up to CATCH_UP_MS late", () => {
    const c = parseCron("0 16 * * *");
    expect(dueSlot(c, at("2026-11-15T15:59:30Z"))).toBeNull();
    expect(dueSlot(c, at("2026-11-15T16:00:40Z"))).toBe(at("2026-11-15T16:00:00Z"));
    expect(dueSlot(c, at("2026-11-15T16:00:00Z") + CATCH_UP_MS)).toBe(at("2026-11-15T16:00:00Z"));
    expect(dueSlot(c, at("2026-11-15T16:00:00Z") + CATCH_UP_MS + MINUTE)).toBeNull();
  });
});

describe("the timetable", () => {
  it("reads a JSON string or a list", () => {
    const list = [{ repo: "opencampingdb/data", workflow: "sync-osm.yml", cron: "0 16 * * *" }];
    expect(parseTimetable(JSON.stringify(list))).toEqual(list);
    expect(parseTimetable([{ ...list[0], ref: "dev" }])).toEqual([{ ...list[0], ref: "dev" }]);
  });

  it("refuses a bad entry", () => {
    expect(() => parseTimetable("{}")).toThrow();
    expect(() => parseTimetable([{ repo: "data", workflow: "a.yml", cron: "0 16 * * *" }])).toThrow(/owner\/name/);
    expect(() => parseTimetable([{ repo: "o/r", cron: "0 16 * * *" }])).toThrow(/workflow/);
    expect(() => parseTimetable([{ repo: "o/r", workflow: "a.yml", cron: "daily" }])).toThrow();
  });
});

describe("starting at set times", () => {
  const sync: TimedStart = { repo: "opencampingdb/data", workflow: "sync-osm.yml", cron: "0 16 * * *" };
  const release: TimedStart = { repo: "opencampingdb/data", workflow: "release.yml", cron: "17 * * * *" };
  let db: ReturnType<typeof fakeD1>;
  let started: string[];
  const start = async (e: TimedStart) => void started.push(e.workflow);

  beforeEach(() => {
    db = fakeD1();
    started = [];
  });

  it("starts each slot once", async () => {
    expect(await startTimedIfDue(db, at("2026-11-15T15:59:00Z"), [sync], start)).toEqual(["not_due"]);
    expect(await startTimedIfDue(db, at("2026-11-15T16:00:05Z"), [sync], start)).toEqual(["started"]);
    for (let m = 1; m <= 30; m++) {
      expect(await startTimedIfDue(db, at("2026-11-15T16:00:05Z") + m * MINUTE, [sync], start)).not.toContain("started");
    }
    expect(await startTimedIfDue(db, at("2026-11-16T16:00:05Z"), [sync], start)).toEqual(["started"]);
    expect(started).toEqual(["sync-osm.yml", "sync-osm.yml"]);
  });

  it("catches up a slot missed by a few minutes", async () => {
    expect(await startTimedIfDue(db, at("2026-11-15T16:12:00Z"), [sync], start)).toEqual(["started"]);
  });

  it("tries a failed start again on the next tick, and the other entries still run", async () => {
    const errors: string[] = [];
    let fail = true;
    const flaky = async (e: TimedStart) => {
      if (e.workflow === "sync-osm.yml" && fail) throw new Error("502");
      started.push(e.workflow);
    };
    const now = at("2026-11-15T16:17:00Z");
    expect(await startTimedIfDue(db, now, [sync, release], flaky, (e) => errors.push(e.workflow))).toEqual(["failed", "started"]);
    expect(errors).toEqual(["sync-osm.yml"]);
    fail = false;
    expect(await startTimedIfDue(db, now + MINUTE, [sync, release], flaky)).toEqual(["started", "done"]);
    expect(started).toEqual(["release.yml", "sync-osm.yml"]);
  });

  it("starts once when two ticks run at once", async () => {
    const now = at("2026-11-15T16:00:00Z");
    const outcomes = await Promise.all([startTimedIfDue(db, now, [sync], start), startTimedIfDue(db, now, [sync], start)]);
    expect(outcomes.flat().filter((o) => o === "started")).toHaveLength(1);
    expect(started).toHaveLength(1);
  });
});

describe("the scheduled job", () => {
  function fakeGitHub() {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/access_tokens")) {
        return new Response(JSON.stringify({ token: "t", expires_at: new Date(Date.now() + 3600_000).toISOString() }), { status: 201 });
      }
      if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
      return new Response("{}", { status: 404 });
    });
    return { fetch, calls };
  }

  function env(extra: Partial<Env>): Env {
    return {
      APP_KEYS: "{}",
      DEVICE_SALT: "salt",
      GH_APP_ID: "1",
      GH_APP_PRIVATE_KEY: privateKey,
      GH_INSTALLATION_ID: "2",
      INBOX_REPO: "opencampingdb/inbox",
      RATE_LIMIT: { get: async () => null, put: async () => undefined } as unknown as Env["RATE_LIMIT"],
      RECENT_LIST: fakeD1(),
      ...extra,
    } as Env;
  }

  it("starts a timed workflow with its own App, limited to actions on that repo", async () => {
    const gh = fakeGitHub();
    const scheduled = createScheduled({ fetch: gh.fetch, now: () => at("2026-11-15T16:00:10Z") });
    await scheduled(
      env({
        TIMED_STARTS: '[{"repo":"opencampingdb/data","workflow":"sync-osm.yml","cron":"0 16 * * *"}]',
        TIMED_APP_ID: "77",
        TIMED_APP_PRIVATE_KEY: privateKey,
        TIMED_INSTALLATION_ID: "88",
      }),
    );
    expect(gh.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/app/installations/88/access_tokens",
      "https://api.github.com/repos/opencampingdb/data/actions/workflows/sync-osm.yml/dispatches",
    ]);
    expect(gh.calls[0]?.body).toEqual({ repositories: ["data"], permissions: { actions: "write" } });
    expect(gh.calls[1]?.body).toEqual({ ref: "main" });
  });

  it("starts nothing, and warns, while the App settings are missing", async () => {
    const gh = fakeGitHub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const scheduled = createScheduled({ fetch: gh.fetch, now: () => at("2026-11-15T16:00:10Z") });
    await scheduled(env({ TIMED_STARTS: '[{"repo":"opencampingdb/data","workflow":"sync-osm.yml","cron":"0 16 * * *"}]' }));
    expect(gh.calls).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("TIMED_APP_ID"));
    warn.mockRestore();
  });

  it("logs a timetable it cannot read and carries on", async () => {
    const gh = fakeGitHub();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const scheduled = createScheduled({ fetch: gh.fetch, now: () => at("2026-11-15T16:00:10Z") });
    await expect(
      scheduled(env({ TIMED_STARTS: "not json", TIMED_APP_ID: "77", TIMED_APP_PRIVATE_KEY: privateKey, TIMED_INSTALLATION_ID: "88" })),
    ).resolves.toBe("off");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed starts failed"));
    warn.mockRestore();
  });
});
