import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubApp } from "../src/github.js";
import {
  FLUSH_ATTEMPTS,
  FLUSH_LEASE_MS,
  flushInbox,
  MAX_ROW_ATTEMPTS,
  MAX_FLUSH_BYTES,
  MAX_FLUSH_ITEMS,
  queueStatement,
  timedFetch,
  type QueuedFile,
} from "../src/inbox-queue.js";
import { createHandler, createScheduled, type Env } from "../src/index.js";
import type { D1Like } from "../src/recent.js";
import { fakeD1 } from "./fake-d1.js";
import { fakeGit } from "./fake-git.js";

const NOW = Date.parse("2026-11-04T09:00:00Z");
const MINUTE = 60 * 1000;
const APP_KEY = "test-app-key-0123456789";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const INBOX = { appId: "12345", privateKeyPem: privateKey, installationId: "678", repo: "opencampingdb/inbox" };
const id = (n: number) => `fb_01JC${String(n).padStart(22, "0")}`;
const file = (n: number, extra = ""): QueuedFile => ({
  id: id(n),
  path: `pending/2026-11-04/${id(n)}.json`,
  content: `${JSON.stringify({ id: id(n), received: "2026-11-04T09:00:00Z", extra }, null, 2)}\n`,
});

describe("the inbox queue", () => {
  let db: ReturnType<typeof fakeD1>;
  let git: ReturnType<typeof fakeGit>;
  let github: GitHubApp;
  let written: number;
  let clock: number;

  beforeEach(() => {
    clock = NOW;
    db = fakeD1();
    git = fakeGit({ now: () => NOW });
    github = new GitHubApp(git.fetch, () => NOW);
    written = 0;
  });

  const queue = async (...files: QueuedFile[]) => {
    for (const [i, f] of files.entries()) await queueStatement(db, f, NOW + i).run();
  };
  const flush = (to: D1Like = db) => flushInbox({ db: to, github, inbox: INBOX, branch: "main", now: () => clock, onWritten: async () => void (written += 1) });
  const queued = () => (db.db.prepare("SELECT id FROM inbox_queue ORDER BY rowid").all() as { id: string }[]).map((r) => r.id);
  const writes = () => git.calls.filter((c) => c.method !== "GET" && !c.url.endsWith("/access_tokens"));

  it("does nothing with an empty queue", async () => {
    expect(await flush()).toEqual({ outcome: "empty" });
    expect(git.calls).toEqual([]);
    expect(written).toBe(0);
  });

  it("writes every queued item in one commit on the head, without force, then deletes the rows", async () => {
    await queue(file(1), file(2), file(3));
    const before = git.branches.get("main")!;
    const result = await flush();
    expect(result).toMatchObject({ outcome: "committed", items: 3 });
    expect(git.pending().map((p) => p.id)).toEqual([id(1), id(2), id(3)]);
    expect(git.files().get(file(2).path)).toBe(file(2).content);
    expect(git.files().get("README.md")).toBe("inbox\n");
    const [last] = git.log();
    expect(last).toMatchObject({ message: "Add 3 items", parents: [before] });
    // Three content-creating requests: a tree, a commit and the ref.
    expect(writes().map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /repos/opencampingdb/inbox/git/trees",
      "POST /repos/opencampingdb/inbox/git/commits",
      "PATCH /repos/opencampingdb/inbox/git/refs/heads/main",
    ]);
    expect(writes()[0]!.body).toMatchObject({ base_tree: expect.any(String), tree: [{ path: file(1).path, mode: "100644", type: "blob", content: file(1).content }, {}, {}] });
    expect(writes()[2]!.body).toEqual({ sha: (result as { commit: string }).commit, force: false });
    expect(queued()).toEqual([]);
    expect(written).toBe(1);
    expect(await flush()).toEqual({ outcome: "empty" });
  });

  it("names a single item's commit after it, as the direct write did", async () => {
    await queue(file(1));
    await flush();
    expect(git.log()[0]!.message).toBe(`Add ${id(1)}`);
  });

  it("starts again from the new head when the branch moved on, keeping what the other writer added", async () => {
    await queue(file(1), file(2));
    let moved = false;
    git.control.beforeRefUpdate = () => {
      if (moved) return;
      moved = true;
      // The apply commits its inbox moves between the head read and the ref update.
      git.commitOnBranch("applied/2026-11-03/fb_01JB00000000000000000000AA.json", "{}\n");
    };
    expect(await flush()).toMatchObject({ outcome: "committed", items: 2 });
    expect(git.files().has("applied/2026-11-03/fb_01JB00000000000000000000AA.json")).toBe(true);
    expect(git.pending()).toHaveLength(2);
    expect(git.log().map((c) => c.message)).toEqual(["Add 2 items", "Add applied/2026-11-03/fb_01JB00000000000000000000AA.json", "first"]);
    expect(writes().filter((c) => c.method === "PATCH")).toHaveLength(2);
    expect(queued()).toEqual([]);
  });

  it("leaves the items for the next minute when the branch keeps moving", async () => {
    await queue(file(1));
    git.control.refStatus = Array.from({ length: FLUSH_ATTEMPTS }, () => 422);
    expect(await flush()).toEqual({ outcome: "conflict" });
    expect(queued()).toEqual([id(1)]);
    expect(git.pending()).toEqual([]);
    expect(written).toBe(0);
    // The commit it made never reached the branch, so the next flush writes the item.
    expect(await flush()).toMatchObject({ outcome: "committed", items: 1 });
    expect(git.pending().map((p) => p.id)).toEqual([id(1)]);
  });

  it("is harmless to repeat after the commit landed but the rows were not deleted", async () => {
    await queue(file(1), file(2));
    // D1 fails to delete the rows once the branch holds the commit.
    const failingDelete: D1Like = {
      prepare: (sql) => db.prepare(sql),
      batch: async (list) => {
        if ((list[0] as unknown as { sql: string }).sql.startsWith("DELETE")) throw new Error("D1 is down");
        return db.batch(list);
      },
    };
    await expect(flush(failingDelete)).rejects.toThrow("D1 is down");
    expect(git.pending()).toHaveLength(2);
    const commits = git.log().length;
    // Meanwhile the apply moves the items out of pending/: the repeat must not put them back.
    git.commitOnBranch("applied/marker", "moved\n");
    const result = await flush();
    expect(result).toEqual({ outcome: "settled", items: 2 });
    expect(git.log()).toHaveLength(commits + 1);
    expect(writes().filter((c) => c.method === "POST")).toHaveLength(2);
    expect(queued()).toEqual([]);
  });

  it("makes no empty commit when every queued file is in the inbox with the same text", async () => {
    await queue(file(1));
    git.commitOnBranch(file(1).path, file(1).content);
    const commits = git.log().length;
    expect(await flush()).toEqual({ outcome: "settled", items: 1 });
    expect(git.log()).toHaveLength(commits);
    expect(writes().map((c) => c.method)).toEqual(["POST"]);
    expect(queued()).toEqual([]);
  });

  it("writes a queued item again when the commit it was marked with never reached the branch", async () => {
    await queue(file(1));
    // The ref update fails outright, after the rows were marked with the commit.
    git.control.refStatus = [500];
    await expect(flush()).rejects.toThrow(/500/);
    expect(db.db.prepare("SELECT commit_sha FROM inbox_queue").get()).toEqual({ commit_sha: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(await flush()).toMatchObject({ outcome: "committed", items: 1 });
    expect(git.pending().map((p) => p.id)).toEqual([id(1)]);
    expect(queued()).toEqual([]);
  });

  it("runs one flush at a time, under a lease in runs that a stalled flush loses after 5 minutes", async () => {
    await queue(file(1));
    const lease = () => db.db.prepare("SELECT last_start FROM runs WHERE name = 'flush'").get();
    // A flush that started and never finished holds the lease.
    db.db.prepare("INSERT INTO runs (name, last_start) VALUES ('flush', ?)").run(clock);
    clock += FLUSH_LEASE_MS - 1;
    expect(await flush()).toEqual({ outcome: "busy" });
    expect(git.calls).toEqual([]);
    clock += 1;
    expect(await flush()).toMatchObject({ outcome: "committed", items: 1 });
    // Given back at the end, so the next minute's flush runs.
    expect(lease()).toEqual({ last_start: null });
    await queue(file(2));
    expect(await flush()).toMatchObject({ outcome: "committed" });
  });

  it("gives the lease back when the flush fails", async () => {
    await queue(file(1));
    git.control.down = 503;
    await expect(flush()).rejects.toThrow(/503/);
    expect(db.db.prepare("SELECT last_start FROM runs WHERE name = 'flush'").get()).toEqual({ last_start: null });
  });

  it("fails a GitHub call that takes longer than its timeout, and keeps the items", async () => {
    await queue(file(1));
    github = new GitHubApp(timedFetch(git.fetch, 20), () => NOW);
    git.control.hang = "/git/trees";
    await expect(flush()).rejects.toThrow(/took longer than 20 ms/);
    git.control.hang = undefined;
    expect(queued()).toEqual([id(1)]);
    expect(await flush()).toMatchObject({ outcome: "committed", items: 1 });
  });

  it("stops before moving the branch when its lease is nearly over", async () => {
    await queue(file(1));
    git.control.beforeTree = () => void (clock += FLUSH_LEASE_MS);
    expect(await flush()).toEqual({ outcome: "expired" });
    expect(git.pending()).toEqual([]);
    expect(queued()).toEqual([id(1)]);
  });

  it("reads the marks again just before each tree, so it never writes a row another flush already wrote", async () => {
    await queue(file(1), file(2));
    // The first attempt loses to a moved branch. Meanwhile another flush, stalled past its lease, wrote item 1
    // and deleted its row, and the apply may already have moved it out of pending/.
    git.control.refStatus = [422];
    git.control.beforeRefUpdate = () => {
      git.control.beforeRefUpdate = undefined;
      db.db.prepare("DELETE FROM inbox_queue WHERE id = ?").run(id(1));
    };
    expect(await flush()).toMatchObject({ outcome: "committed", items: 1 });
    expect(git.pending().map((p) => p.id)).toEqual([id(2)]);
    const trees = writes().filter((c) => c.url.endsWith("/git/trees"));
    expect(trees.map((c) => (c.body!.tree as unknown[]).length)).toEqual([2, 1]);
  });

  it("deletes, without writing it again, a row another flush marked with a commit the branch now holds", async () => {
    await queue(file(1), file(2));
    git.control.beforeTree = async () => {
      git.control.beforeTree = undefined;
      // Another flush commits item 1 and marks its row, then stalls before deleting it.
      git.commitOnBranch(file(1).path, file(1).content);
      const sha = git.branches.get("main")!;
      db.db.prepare("UPDATE inbox_queue SET commit_sha = ? WHERE id = ?").run(sha, id(1));
    };
    git.control.refStatus = [422];
    expect(await flush()).toMatchObject({ outcome: "committed", items: 1 });
    expect(queued()).toEqual([]);
    expect(git.log()[0]!.message).toBe(`Add ${id(2)}`);
  });

  it("drains 300 rows queued behind one whose file GitHub keeps refusing, and moves that one to the back", async () => {
    git.control.refuseContent = "poison";
    await queue(file(0, "poison"), ...Array.from({ length: 300 }, (_, n) => file(n + 1)));
    const attempts = () => db.db.prepare("SELECT attempts FROM inbox_queue WHERE id = ?").get(id(0));
    expect(await flush()).toMatchObject({ outcome: "committed", items: MAX_FLUSH_ITEMS - 1 });
    expect(attempts()).toEqual({ attempts: 1 });
    expect(await flush()).toMatchObject({ outcome: "committed", items: 101 });
    expect(git.pending()).toHaveLength(300);
    expect(queued()).toEqual([id(0)]);
    // On its own it fails each flush, makes no commit, and counts each time.
    for (let n = 2; n < MAX_ROW_ATTEMPTS; n++) expect(await flush()).toEqual({ outcome: "settled", items: 0 });
    expect(attempts()).toEqual({ attempts: MAX_ROW_ATTEMPTS });
    // From then on it waits behind items queued after it.
    await queue(file(400));
    expect(await flush()).toMatchObject({ outcome: "committed", items: 1 });
    expect(git.pending().map((p) => p.id)).toContain(id(400));
    expect(queued()).toEqual([id(0)]);
  });

  it("leaves out a marked row whose commit GitHub can't place, and after 5 tries writes it again as new", async () => {
    await queue(file(1), file(2));
    db.db.prepare("UPDATE inbox_queue SET commit_sha = ? WHERE id = ?").run("0".repeat(40), id(1));
    git.control.compareStatus = 500;
    expect(await flush()).toMatchObject({ outcome: "committed", items: 1 });
    expect(git.pending().map((p) => p.id)).toEqual([id(2)]);
    for (let n = 1; n < MAX_ROW_ATTEMPTS; n++) await flush();
    expect(db.db.prepare("SELECT commit_sha, attempts FROM inbox_queue").get()).toEqual({ commit_sha: null, attempts: MAX_ROW_ATTEMPTS });
    expect(await flush()).toMatchObject({ outcome: "committed", items: 1 });
    expect(git.pending().map((p) => p.id).sort()).toEqual([id(1), id(2)]);
  });

  it("writes at most MAX_FLUSH_ITEMS a flush, oldest first, and the rest on the next", async () => {
    const files = Array.from({ length: MAX_FLUSH_ITEMS + 50 }, (_, n) => file(n));
    await queue(...files);
    expect(await flush()).toMatchObject({ outcome: "committed", items: MAX_FLUSH_ITEMS });
    expect(new Set(git.pending().map((p) => p.id))).toEqual(new Set(files.slice(0, MAX_FLUSH_ITEMS).map((f) => f.id)));
    expect(await flush()).toMatchObject({ outcome: "committed", items: 50 });
    expect(git.pending()).toHaveLength(MAX_FLUSH_ITEMS + 50);
  });

  it("keeps each flush within MAX_FLUSH_BYTES of file text", async () => {
    const big = "x".repeat(Math.floor(MAX_FLUSH_BYTES / 3));
    await queue(file(1, big), file(2, big), file(3, big), file(4, big));
    expect(await flush()).toMatchObject({ outcome: "committed", items: 2 });
    expect(await flush()).toMatchObject({ outcome: "committed", items: 2 });
    expect(queued()).toEqual([]);
  });

  it("throws, keeping the items, while GitHub is down", async () => {
    await queue(file(1));
    git.control.down = 503;
    await expect(flush()).rejects.toThrow(/503/);
    expect(queued()).toEqual([id(1)]);
  });
});

describe("queued writes through the intake", () => {
  let git: ReturnType<typeof fakeGit>;
  let db: ReturnType<typeof fakeD1>;
  let env: Env;
  let clock: number;

  const review = (n: number) => ({
    type: "review",
    place: PLACE,
    device: "3b241101-e2bb-4255-8caf-4136c566a962",
    contributor: `acct_3f9a8b7c6d5e4f${String(n).padStart(2, "0")}`,
    app_version: "1.0.0",
    consent: true,
    review: { stars: 4, text: "Quiet and shady", visited: "2026-10" },
  });
  const post = (body: unknown) =>
    new Request("https://intake.example/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-app-key": APP_KEY },
      body: JSON.stringify(body),
    });
  const claim = {
    type: "owner_claim",
    place: PLACE,
    device: "3b241101-e2bb-4255-8caf-4136c566a962",
    app_version: "1.0.0",
    terms_accepted: true,
    owner: { name: "Jo Example", email: "jo@park.example.org" },
    claim: { proof_url: "https://park.example.org/about" },
  };

  beforeEach(() => {
    clock = NOW;
    git = fakeGit({ now: () => clock });
    db = fakeD1();
    env = {
      APP_KEYS: JSON.stringify({ [APP_KEY]: { app: "example-app", daily_limit: 50 } }),
      DEVICE_SALT: "pepper",
      GH_APP_ID: "12345",
      GH_APP_PRIVATE_KEY: privateKey,
      GH_INSTALLATION_ID: "678",
      INBOX_REPO: "opencampingdb/inbox",
      RATE_LIMIT: { get: async () => null, put: async () => undefined, delete: async () => undefined },
      RECENT_LIST: db,
      APPLY_WORKFLOW: "apply-feedback.yml",
    };
  });

  it("answers 202 once an item is queued, and the scheduled job writes the minute's items in one commit", async () => {
    const handle = createHandler({ fetch: git.fetch, now: () => clock });
    const ids: string[] = [];
    for (let n = 0; n < 5; n++) {
      const res = await handle(post(review(n)), env);
      expect(res.status).toBe(202);
      ids.push(((await res.json()) as { id: string }).id);
    }
    // Nothing reaches GitHub at send time.
    expect(git.calls).toEqual([]);
    expect(db.db.prepare("SELECT count(*) AS n FROM inbox_queue").get()).toEqual({ n: 5 });

    clock += 30_000;
    await createScheduled({ fetch: git.fetch, now: () => clock })(env);
    expect(git.pending().map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(git.log()[0]!.message).toBe("Add 5 items");
    expect(db.db.prepare("SELECT count(*) AS n FROM inbox_queue").get()).toEqual({ n: 0 });
    // The flush counts as the inbox write for the run triggers.
    expect(db.db.prepare("SELECT last_write FROM runs WHERE name = 'apply'").get()).toEqual({ last_write: clock });
  });

  it("queues owner submissions too, and never stores their token", async () => {
    const handle = createHandler({ fetch: git.fetch, now: () => clock, randomBytes: (n) => new Uint8Array(n).fill(7) });
    const res = await handle(post(claim), env);
    expect(res.status).toBe(202);
    const { id, token } = (await res.json()) as { id: string; token: string };
    await createScheduled({ fetch: git.fetch, now: () => clock })(env);
    const [stored] = git.pending();
    expect(stored).toMatchObject({ id, type: "owner_claim", token_sha256: expect.any(String) });
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("answers 503 storage_unavailable and queues nothing when D1 fails", async () => {
    const failing: D1Like = {
      prepare: (sql) => db.prepare(sql),
      batch: async () => {
        throw new Error("D1 is down");
      },
    };
    const handle = createHandler({ fetch: git.fetch, now: () => clock });
    const res = await handle(post(review(1)), { ...env, RECENT_LIST: failing });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "storage_unavailable" });
    expect(db.db.prepare("SELECT count(*) AS n FROM inbox_queue").get()).toEqual({ n: 0 });
  });

  it("writes each item at once, as before, without RECENT_LIST", async () => {
    const { RECENT_LIST: _, ...without } = env;
    const handle = createHandler({ fetch: git.fetch, now: () => clock });
    expect((await handle(post(review(1)), without)).status).toBe(202);
    expect(git.pending()).toHaveLength(1);
    expect(git.calls.some((c) => c.method === "PUT" && c.url.includes("/contents/pending/"))).toBe(true);
  });

  it("logs an error when the flush fails, when it gives up on a moving branch, and on every tick while the queue is 15 minutes behind", async () => {
    const handle = createHandler({ fetch: git.fetch, now: () => clock });
    const scheduled = createScheduled({ fetch: git.fetch, now: () => clock });
    await handle(post(review(1)), env);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // The App lost contents: write, or a ruleset refuses it.
      git.control.down = 403;
      await scheduled(env);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/writing the queued items to the inbox failed.*403/));
      expect(error.mock.calls.some(([m]) => String(m).includes("behind"))).toBe(false);
      git.control.down = undefined;
      error.mockClear();
      git.control.refStatus = [422, 422, 422];
      clock += 16 * MINUTE;
      await scheduled(env);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("gave up"));
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/the inbox queue is behind: 1 item\(s\) waiting, the oldest for 16 minutes/));
      error.mockClear();
      git.control.down = 503;
      clock += MINUTE;
      await scheduled(env);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("the inbox queue is behind"));
      // Once the item is written, the ticks are quiet again.
      git.control.down = undefined;
      error.mockClear();
      clock += MINUTE;
      await scheduled(env);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("shows the queue's backlog on GET /v1/health/queue, behind the places token", async () => {
    const health = (token?: string) =>
      new Request("https://intake.example/v1/health/queue", token ? { headers: { authorization: `Bearer ${token}` } } : {});
    const handle = createHandler({ fetch: git.fetch, now: () => clock });
    const guarded = { ...env, PLACES_TOKEN: "places-token-for-the-apply-run" };
    expect((await handle(health(), guarded)).status).toBe(401);
    expect((await handle(health("wrong"), guarded)).status).toBe(401);
    expect((await handle(health("places-token-for-the-apply-run"), env)).status).toBe(404);
    const read = async () => (await handle(health("places-token-for-the-apply-run"), guarded)).json();
    expect(await read()).toEqual({ queued: 0, oldest_age_seconds: null, stale: false, stuck: 0 });
    await handle(post(review(1)), guarded);
    clock += 30_000;
    await handle(post(review(2)), guarded);
    clock += 30_000;
    expect(await read()).toEqual({ queued: 2, oldest_age_seconds: 60, stale: false, stuck: 0 });
    clock += 15 * MINUTE;
    expect(await read()).toMatchObject({ queued: 2, stale: true });
  });

  it("keeps queued items while GitHub is down, logs it, and writes them once it is back", async () => {
    const handle = createHandler({ fetch: git.fetch, now: () => clock });
    await handle(post(review(1)), env);
    git.control.down = 503;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await createScheduled({ fetch: git.fetch, now: () => clock })(env);
      expect(error).toHaveBeenCalledWith(expect.stringContaining("writing the queued items to the inbox failed"));
    } finally {
      error.mockRestore();
    }
    expect(db.db.prepare("SELECT count(*) AS n FROM inbox_queue").get()).toEqual({ n: 1 });
    git.control.down = undefined;
    clock += MINUTE;
    await createScheduled({ fetch: git.fetch, now: () => clock })(env);
    expect(git.pending()).toHaveLength(1);
  });
});
