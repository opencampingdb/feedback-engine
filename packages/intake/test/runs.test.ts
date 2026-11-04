import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHandler, createScheduled, type Env } from "../src/index.js";
import type { KVLike } from "../src/ratelimit.js";
import { CAP_MS, MAX_WAIT_MS, QUIET_MS, recordInboxWrite, startApplyIfDue } from "../src/runs.js";
import { fakeD1 } from "./fake-d1.js";

const NOW = Date.parse("2026-11-04T09:00:00Z");
const MINUTE = 60 * 1000;
const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("starting the apply", () => {
  let db: ReturnType<typeof fakeD1>;
  let starts: number[];
  let clock: number;
  const start = async () => void starts.push(clock);
  const tick = () => startApplyIfDue(db, clock, start);

  beforeEach(() => {
    db = fakeD1();
    starts = [];
    clock = NOW;
  });

  it("does nothing before any inbox write", async () => {
    expect(await tick()).toBe("idle");
    expect(starts).toEqual([]);
  });

  it("waits until the inbox has had no new write for 2 minutes", async () => {
    await recordInboxWrite(db, clock);
    clock += MINUTE;
    expect(await tick()).toBe("waiting_quiet");
    await recordInboxWrite(db, clock);
    clock += QUIET_MS - 1;
    expect(await tick()).toBe("waiting_quiet");
    clock += 1;
    expect(await tick()).toBe("started");
    expect(starts).toEqual([NOW + MINUTE + QUIET_MS]);
  });

  it("starts once per quiet spell", async () => {
    await recordInboxWrite(db, clock);
    clock += QUIET_MS;
    expect(await tick()).toBe("started");
    for (let i = 0; i < 30; i++) {
      clock += MINUTE;
      expect(await tick()).toBe("idle");
    }
    expect(starts).toHaveLength(1);
  });

  it("starts at most once every 10 minutes", async () => {
    await recordInboxWrite(db, clock);
    clock += QUIET_MS;
    expect(await tick()).toBe("started");
    const first = clock;
    clock += MINUTE;
    await recordInboxWrite(db, clock);
    clock += QUIET_MS;
    expect(await tick()).toBe("waiting_cap");
    clock = first + CAP_MS - 1;
    expect(await tick()).toBe("waiting_cap");
    clock = first + CAP_MS;
    expect(await tick()).toBe("started");
    expect(starts).toEqual([first, first + CAP_MS]);
  });

  it("starts one run at the 10 minute mark while writes come every minute for 15 minutes", async () => {
    const outcomes: string[] = [];
    for (let minute = 0; minute <= 15; minute++) {
      clock = NOW + minute * MINUTE;
      outcomes.push(await tick());
      if (minute < 15) await recordInboxWrite(db, clock);
    }
    expect(starts).toEqual([NOW + MAX_WAIT_MS]);
    expect(outcomes[10]).toBe("started");
    expect(outcomes.slice(1, 10).every((o) => o === "waiting_quiet")).toBe(true);
    expect(outcomes.slice(11)).not.toContain("started");
  });

  it("starts again at the cap when the stream goes on", async () => {
    for (let minute = 0; minute <= 25; minute++) {
      clock = NOW + minute * MINUTE;
      await tick();
      await recordInboxWrite(db, clock);
    }
    expect(starts).toEqual([NOW + 10 * MINUTE, NOW + 20 * MINUTE]);
  });

  it("keeps the first waiting write when a start fails", async () => {
    await recordInboxWrite(db, clock);
    for (let minute = 1; minute < 10; minute++) {
      clock = NOW + minute * MINUTE;
      await recordInboxWrite(db, clock);
    }
    clock = NOW + MAX_WAIT_MS;
    const failing = async () => {
      throw new Error("403");
    };
    expect(await startApplyIfDue(db, clock, failing)).toBe("failed");
    await recordInboxWrite(db, clock);
    clock += MINUTE;
    expect(await tick()).toBe("started");
  });

  it("never moves the last write back", async () => {
    await recordInboxWrite(db, clock + MINUTE);
    await recordInboxWrite(db, clock);
    clock += QUIET_MS;
    expect(await tick()).toBe("waiting_quiet");
  });

  it("keeps the write pending when a start fails, and tries again on the next tick", async () => {
    await recordInboxWrite(db, clock);
    clock += QUIET_MS;
    const errors: unknown[] = [];
    const failing = async () => {
      throw new Error("403");
    };
    expect(await startApplyIfDue(db, clock, failing, (e) => errors.push(e))).toBe("failed");
    expect(errors).toHaveLength(1);
    clock += MINUTE;
    expect(await tick()).toBe("started");
    expect(starts).toEqual([NOW + QUIET_MS + MINUTE]);
  });

  it("starts one run when two ticks reach it at once", async () => {
    await recordInboxWrite(db, clock);
    clock += QUIET_MS;
    const outcomes = await Promise.all([tick(), tick()]);
    expect(outcomes.sort()).toEqual(["idle", "started"]);
    expect(starts).toHaveLength(1);
  });
});

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

function fakeGitHub(options: { dispatchStatus?: number[]; tokenStatus?: (permissions: unknown) => number } = {}) {
  const calls: Call[] = [];
  const dispatchStatus = [...(options.dispatchStatus ?? [])];
  let tokens = 0;
  const fetch = async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url.endsWith("/access_tokens")) {
      const status = options.tokenStatus?.(body?.permissions) ?? 201;
      if (status !== 201) return new Response("{}", { status });
      tokens += 1;
      return new Response(JSON.stringify({ token: `ghs_${tokens}`, expires_at: new Date(NOW + 60 * MINUTE).toISOString() }), { status: 201 });
    }
    if (url.includes("/contents/")) return new Response("{}", { status: 201 });
    if (url.endsWith("/dispatches")) return new Response(null, { status: dispatchStatus.shift() ?? 204 });
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

function memoryKv(): KVLike {
  const data = new Map<string, string>();
  return {
    get: async (k) => data.get(k) ?? null,
    put: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

describe("the scheduled job", () => {
  let gh: ReturnType<typeof fakeGitHub>;
  let clock: number;
  let env: Env;

  const review = {
    type: "review",
    place: PLACE,
    device: "3b241101-e2bb-4255-8caf-4136c566a962",
    contributor: "acct_3f9a8b7c6d5e4f30",
    app_version: "1.0.0",
    consent: true,
    review: { stars: 4, text: "Quiet and shady", visited: "2026-10" },
  };
  const post = () =>
    new Request("https://intake.example/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-key": APP_KEY },
      body: JSON.stringify(review),
    });

  beforeEach(() => {
    clock = NOW;
    env = {
      APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 50 } }),
      DEVICE_SALT: "pepper",
      GH_APP_ID: "12345",
      GH_APP_PRIVATE_KEY: privateKey,
      GH_INSTALLATION_ID: "678",
      INBOX_REPO: "opencampingdb/inbox",
      INBOX_BRANCH: "main",
      RATE_LIMIT: memoryKv(),
      RECENT_LIST: fakeD1(),
      APPLY_WORKFLOW: "apply-feedback.yml",
    };
  });

  it("starts the inbox's apply workflow 2 minutes after a write, with an actions-only token", async () => {
    gh = fakeGitHub();
    const handle = createHandler({ fetch: gh.fetch, now: () => clock });
    const scheduled = createScheduled({ fetch: gh.fetch, now: () => clock });
    expect((await handle(post(), env)).status).toBe(202);
    clock += MINUTE;
    expect(await scheduled(env)).toBe("waiting_quiet");
    clock += MINUTE;
    expect(await scheduled(env)).toBe("started");

    const dispatch = gh.calls.find((c) => c.url.endsWith("/dispatches"))!;
    expect(dispatch.url).toBe("https://api.github.com/repos/opencampingdb/inbox/actions/workflows/apply-feedback.yml/dispatches");
    expect(dispatch.method).toBe("POST");
    expect(dispatch.body).toEqual({ ref: "main" });
    const tokenBodies = gh.calls.filter((c) => c.url.endsWith("/access_tokens")).map((c) => c.body);
    expect(tokenBodies).toEqual([
      { repositories: ["inbox"], permissions: { contents: "write" } },
      { repositories: ["inbox"], permissions: { actions: "write" } },
    ]);
  });

  it("fails softly while the App lacks actions: write, and keeps writing to the inbox", async () => {
    let actionsGranted = false;
    gh = fakeGitHub({ tokenStatus: (p) => ((p as Record<string, string>).actions && !actionsGranted ? 422 : 201) });
    const handle = createHandler({ fetch: gh.fetch, now: () => clock });
    const scheduled = createScheduled({ fetch: gh.fetch, now: () => clock });
    expect((await handle(post(), env)).status).toBe(202);
    clock += QUIET_MS;
    expect(await scheduled(env)).toBe("failed");
    expect((await handle(post(), env)).status).toBe(202);
    clock += QUIET_MS;
    expect(await scheduled(env)).toBe("failed");
    actionsGranted = true;
    clock += MINUTE;
    expect(await scheduled(env)).toBe("started");
    expect(gh.calls.filter((c) => c.url.endsWith("/dispatches"))).toHaveLength(1);
  });

  it("retries a refused dispatch on the next tick", async () => {
    gh = fakeGitHub({ dispatchStatus: [403] });
    const handle = createHandler({ fetch: gh.fetch, now: () => clock });
    const scheduled = createScheduled({ fetch: gh.fetch, now: () => clock });
    await handle(post(), env);
    clock += QUIET_MS;
    expect(await scheduled(env)).toBe("failed");
    clock += MINUTE;
    expect(await scheduled(env)).toBe("started");
  });

  it("is off without APPLY_WORKFLOW, and records no writes", async () => {
    gh = fakeGitHub();
    const { APPLY_WORKFLOW: _off, ...rest } = env;
    const handle = createHandler({ fetch: gh.fetch, now: () => clock });
    const scheduled = createScheduled({ fetch: gh.fetch, now: () => clock });
    expect((await handle(post(), rest)).status).toBe(202);
    clock += QUIET_MS;
    expect(await scheduled(rest)).toBe("off");
    const db = env.RECENT_LIST as ReturnType<typeof fakeD1>;
    expect(db.db.prepare("SELECT count(*) AS n FROM runs").get()).toEqual({ n: 0 });
    expect(gh.calls.some((c) => c.url.endsWith("/dispatches"))).toBe(false);
  });
});
