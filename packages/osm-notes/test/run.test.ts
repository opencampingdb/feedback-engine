import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FetchLike } from "../src/osm.js";
import { run, type RunOptions } from "../src/run.js";
import type { Place } from "../src/types.js";

const NOW = new Date("2026-10-31T00:00:00Z");
const CROCKFORD = "ABCDEFGHJKMNPQRSTVWXYZ";

/** A valid place id, different for each n below 22 * 22. */
function placeId(n: number): string {
  return `ocdb_01JBXK3M8Q4R5S6T7V8W9X0Y${CROCKFORD[Math.floor(n / 22)]}${CROCKFORD[n % 22]}`;
}

function place(n: number, patch: Partial<Place> = {}): Place {
  return {
    id: placeId(n),
    name: `Camp ${n}`,
    kind: "free_camp",
    location: { lat: -36.85, lon: 144.55 },
    osm: { type: "node", id: 1000 + n, version: 1 },
    facts: { fee: true },
    status: "open",
    fact_sources: { fee: "osm" },
    ...patch,
  };
}

const pathOf = (id: string) => `places/${id.slice(-2).toLowerCase()}/${id}.json`;

let root: string;
let data: string;
let inbox: string;
let options: RunOptions;
let posts: { url: string; body: URLSearchParams; headers: Record<string, string> }[];
let replies: number[];

function git(...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", data, "-c", "user.name=test", "-c", "user.email=test@example.org", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args],
    { encoding: "utf8" },
  ).trim();
}

async function commit(places: Place[]): Promise<string> {
  for (const p of places) {
    const path = join(data, pathOf(p.id));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(p, null, 2)}\n`);
  }
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", "change");
  return git("rev-parse", "HEAD");
}

const fakeFetch: FetchLike = async (url, init) => {
  posts.push({ url, body: new URLSearchParams(init.body), headers: init.headers });
  const status = replies.shift() ?? 200;
  const id = 9000 + posts.length;
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => ({ type: "Feature", properties: { id } }),
    text: async () => "slow down",
  };
};

async function applied(n: number, received: string, device: string, body: Record<string, unknown>) {
  const path = join(inbox, "applied", received.slice(0, 10), `fb_01JC${String(n).padStart(22, "0")}.json`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ id: `fb_${n}`, received, device, app: "camporacle", outcome: { result: "applied" }, ...body }),
  );
}

const sentLines = async () =>
  (await readFile(options.sentFile, "utf8").catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const cursor = async () => (await readFile(options.cursorFile, "utf8").catch(() => "")).trim();
const feeFromFeedback = { facts: { fee: false }, fact_sources: { fee: "feedback" as const } };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocdb-osm-notes-"));
  data = join(root, "data");
  inbox = join(root, "inbox");
  await mkdir(data, { recursive: true });
  git("init", "-q", "-b", "main");
  posts = [];
  replies = [];
  options = {
    data,
    inbox,
    cursorFile: join(inbox, "osm", "cursor"),
    sentFile: join(inbox, "osm", "sent.ndjson"),
    token: "test-token",
    fetch: fakeFetch,
    now: NOW,
    sleep: async () => {},
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("run", () => {
  it("on the first run sets the cursor to data HEAD and sends nothing", async () => {
    const head = await commit([place(1)]);
    const result = await run(options);
    expect(result.mode).toBe("first_run");
    expect(await cursor()).toBe(head);
    expect(posts).toEqual([]);
    expect(result.stateChanged).toBe(true);
  });

  it("does nothing when data has not changed", async () => {
    await commit([place(1)]);
    await run(options);
    const result = await run(options);
    expect(result.mode).toBe("up_to_date");
    expect(result.stateChanged).toBe(false);
  });

  it("posts one note per place for feedback changes and advances the cursor", async () => {
    await commit([place(1), place(2)]);
    await run(options);
    const fee = { type: "report", place: placeId(1), report: { kind: "fact", fact: "fee", value: false } };
    await applied(1, "2026-10-02T03:00:00Z", "aaaa", fee);
    await applied(2, "2026-10-20T03:00:00Z", "bbbb", fee);
    await applied(3, "2026-10-21T03:00:00Z", "bbbb", fee);
    const head = await commit([
      place(1, { facts: { fee: false, toilets: true }, fact_sources: { fee: "feedback", toilets: "feedback" } }),
      // From the nightly OSM sync: never echoed.
      place(2, { facts: { fee: false }, fact_sources: { fee: "osm" } }),
    ]);

    const result = await run(options);
    expect(result.mode).toBe("posted");
    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.url).toBe("https://api.openstreetmap.org/api/0.6/notes.json");
    expect(post.headers.Authorization).toBe("Bearer test-token");
    expect(post.headers["User-Agent"]).toMatch(/^opencampingdb-osm-notes\//);
    expect(post.body.get("lat")).toBe("-36.85");
    expect(post.body.get("lon")).toBe("144.55");
    const text = post.body.get("text")!;
    expect(text).toContain("node/1001 (Camp 1)");
    expect(text).toContain("there is no fee to stay (fee=no). 2 independent reports, 2 to 21 October 2026.");
    expect(text).toContain("- Travellers report there are toilets (toilets=yes).\n");
    expect(text).toContain(`https://github.com/opencampingdb/data/blob/main/${pathOf(placeId(1))}`);
    expect(text).not.toContain("aaaa");
    expect(text).not.toContain("camporacle");
    expect(await cursor()).toBe(head);
    expect(await sentLines()).toEqual([
      { field: "fee", note: 9001, place: placeId(1), sent: NOW.toISOString(), value: false },
      { field: "toilets", note: 9001, place: placeId(1), sent: NOW.toISOString(), value: true },
    ]);
    expect(result.summary).toContain("[note 9001](https://www.openstreetmap.org/note/9001)");
  });

  it("in a dry run posts nothing and leaves the cursor and sent log alone", async () => {
    const start = await commit([place(1)]);
    await run(options);
    await commit([place(1, { facts: { fee: false }, fact_sources: { fee: "owner" } })]);
    const { token: _token, ...dry } = options;
    const result = await run(dry);
    expect(result.mode).toBe("dry_run");
    expect(result.notes).toHaveLength(1);
    expect(result.stateChanged).toBe(false);
    expect(result.summary).toContain("Dry run");
    expect(result.summary).toContain("The owner reports there is no fee to stay (fee=no).");
    expect(posts).toEqual([]);
    expect(await cursor()).toBe(start);
    expect(await sentLines()).toEqual([]);
  });

  it("never sends for contributed places or fields it must leave out", async () => {
    await commit([place(1, { osm: null, fact_sources: { fee: "contributed" } }), place(2)]);
    await run(options);
    await commit([
      place(1, { osm: null, ...feeFromFeedback }),
      place(2, {
        status: "temporarily_closed",
        fact_sources: { fee: "osm", status: "owner", location: "feedback" },
        location: { lat: -36.9, lon: 144.6 },
      }),
    ]);
    const result = await run(options);
    expect(result.notes).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("never resends the same place, field and value", async () => {
    await commit([place(1)]);
    await run(options);
    await commit([place(1, feeFromFeedback)]);
    await run(options);
    expect(posts).toHaveLength(1);

    // OSM sync puts the fee back, feedback sets it again: same value, no new note.
    await commit([place(1)]);
    await run(options);
    await commit([place(1, feeFromFeedback)]);
    const later = await run({ ...options, now: new Date("2027-01-31T00:00:00Z") });
    expect(posts).toHaveLength(1);
    expect(later.skipped).toEqual([{ place: placeId(1), reason: "already sent" }]);
  });

  it("holds a place that had a note in the last 30 days for a later run", async () => {
    await commit([place(1)]);
    await run(options);
    const first = await commit([place(1, feeFromFeedback)]);
    await run(options);
    await commit([place(1, { facts: { fee: false, toilets: true }, fact_sources: { fee: "feedback", toilets: "feedback" } })]);

    const soon = await run({ ...options, now: new Date("2026-11-10T00:00:00Z") });
    expect(soon.notes).toEqual([]);
    expect(soon.held).toBe(1);
    expect(await cursor()).toBe(first);

    const later = await run({ ...options, now: new Date("2026-12-05T00:00:00Z") });
    expect(later.posted).toHaveLength(1);
    expect(later.posted[0]!.note.changes.map((c) => c.field)).toEqual(["toilets"]);
  });

  it("posts at most 10 notes a run and keeps the cursor until the rest are sent", async () => {
    const all = Array.from({ length: 12 }, (_, i) => place(i + 1));
    await commit(all);
    await run(options);
    const start = await cursor();
    const head = await commit(all.map((p) => ({ ...p, ...feeFromFeedback })));

    const first = await run(options);
    expect(first.posted).toHaveLength(10);
    expect(first.held).toBe(2);
    expect(await cursor()).toBe(start);

    const second = await run(options);
    expect(second.posted).toHaveLength(2);
    expect(await cursor()).toBe(head);
    expect(new Set((await sentLines()).map((l) => l.place)).size).toBe(12);
  });

  it("stops on HTTP 429 or 5xx without moving the cursor", async () => {
    await commit([place(1), place(2), place(3)]);
    await run(options);
    const start = await cursor();
    await commit([1, 2, 3].map((n) => place(n, feeFromFeedback)));
    replies = [200, 429];
    const result = await run(options);
    expect(posts).toHaveLength(2);
    expect(result.posted).toHaveLength(1);
    expect(result.stopped).toBe("OSM answered HTTP 429");
    expect(await cursor()).toBe(start);
    expect((await sentLines()).map((l) => l.place)).toEqual([placeId(1)]);

    replies = [503];
    const again = await run(options);
    expect(again.stopped).toBe("OSM answered HTTP 503");
    expect(posts.at(-1)!.body.get("text")).toContain("node/1002");
    expect(await cursor()).toBe(start);
  });

  it("fails the job when OSM refuses the token", async () => {
    await commit([place(1)]);
    await run(options);
    await commit([place(1, feeFromFeedback)]);
    replies = [401];
    const result = await run(options);
    expect(result.authFailed).toBe(true);
    expect(await sentLines()).toEqual([]);
  });

  it("takes a closure from feedback and counts closed reports and checks", async () => {
    await commit([place(1)]);
    await run(options);
    await applied(1, "2026-10-01T00:00:00Z", "aaaa", { type: "report", place: placeId(1), report: { kind: "closed" } });
    await applied(2, "2026-10-04T00:00:00Z", "bbbb", {
      type: "check",
      place: placeId(1),
      check: { visited: "2026-10-03", still_there: false },
    });
    await commit([place(1, { status: "closed", fact_sources: { fee: "osm", status: "feedback" } })]);
    await run(options);
    expect(posts[0]!.body.get("text")).toContain(
      "Travellers report the place has closed permanently (OSM has no single tag for this, a lifecycle prefix such as disused: is common). 2 independent reports, 1 to 4 October 2026.",
    );
  });

  it("finds a record moved to its SPEC path", async () => {
    const p = place(1);
    const odd = join(data, "places", "old", `${p.id}.json`);
    await mkdir(dirname(odd), { recursive: true });
    await writeFile(odd, `${JSON.stringify(p, null, 2)}\n`);
    await commit([]);
    await run(options);
    await rm(odd);
    await commit([place(1, feeFromFeedback)]);
    const result = await run(options);
    expect(result.posted).toHaveLength(1);
  });
});
