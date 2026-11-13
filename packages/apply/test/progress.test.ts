import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import {
  AUTO_PR_CLOSED,
  idsOnPrs,
  lastCommitTimes,
  turnedDown,
  itemInDataOnMain,
  progressOf,
  REVIEWER_DECLINED,
  sendProgress,
  type MainData,
  type ProgressUpdate,
} from "../src/progress.js";
import type { ReviewPr } from "../src/owners.js";
import { intakeRecentStore } from "../src/recent.js";
import type { Place, Review } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const TARGET = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const RUN = "2026-11-01T00:00:00Z";
const BEFORE = "2026-10-01T00:00:00Z";
const LATER = "2026-11-02T00:00:00Z";
const NOW = new Date("2026-11-03T00:00:00Z");
const id = (n: number) => `fb_01JC${String(n).padStart(22, "0")}`;

const record: Place = {
  id: PLACE,
  name: "Lake Eppalock Camp",
  kind: "free_camp",
  group: "overnight",
  location: { lat: -36.85, lon: 144.55 },
  osm: { type: "node", id: 123456, version: 7 },
  facts: { power: false, phone: "03 5555 0100" },
  status: "open",
  rating: null,
  fact_sources: { power: "osm", phone: "osm" },
  updated: "2026-06-01T00:00:00Z",
};

function main(places: Place[] = [record], extra: Partial<MainData> = {}): MainData {
  return { places: new Map(places.map((p) => [p.id, p])), reviews: () => [], doNotMatch: [], ...extra };
}

/** An item as the inbox keeps it once a run decided it. */
function decided(n: number, body: Record<string, unknown>, result = "applied", reason = "", run = RUN): StoredFeedback {
  return {
    id: id(n),
    received: "2026-10-31T00:00:00Z",
    app: "example-app",
    device: "aaaa",
    app_version: "1.0.0",
    consent: true,
    place: PLACE,
    ...body,
    outcome: { result, reason, run },
  } as unknown as StoredFeedback;
}
const report = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "report", report: body, ...extra });
const dated = (key: string, at: string, change: Partial<Place> = {}): Place => ({ ...record, ...change, fact_dates: { [key]: at } });
const inData = (item: StoredFeedback, data: MainData) => itemInDataOnMain(item, data).inData;

describe("itemInDataOnMain", () => {
  it("fact: main has the fact dated by that run or later, or the value already", () => {
    const item = decided(1, report({ kind: "fact", fact: "power", value: true }));
    expect(inData(item, main())).toBe(false);
    expect(inData(item, main([dated("power", BEFORE, { facts: { power: false } })]))).toBe(false);
    expect(inData(item, main([dated("power", RUN, { facts: { power: true } })]))).toBe(true);
    expect(inData(decided(2, report({ kind: "fact", fact: "power", value: false })), main())).toBe(true);
  });

  it("name, description, kind, location and status: main already holds what the item asks for", () => {
    // A description edit identical to the one a new place was published with writes no date, but is in the data.
    expect(inData(decided(1, report({ kind: "description", value: "Shady sites by the water." }), "needs_review"), main([{ ...record, description: "Shady sites by the water." }]))).toBe(true);
    expect(inData(decided(2, report({ kind: "description", value: "Shady sites." }), "needs_review"), main([{ ...record, description: "Shady sites by the water." }]))).toBe(false);
    expect(inData(decided(3, report({ kind: "name", value: "Lake Eppalock Camp" }), "needs_review"), main())).toBe(true);
    expect(inData(decided(4, report({ kind: "name", value: "Lake Eppalock Rest Area" }), "needs_review"), main())).toBe(false);
    expect(inData(decided(5, report({ kind: "kind", place_kind: "free_camp" }), "needs_review"), main())).toBe(true);
    expect(inData(decided(6, report({ kind: "kind", place_kind: "caravan_park" }), "needs_review"), main())).toBe(false);
    expect(inData(decided(7, report({ kind: "wrong_location" }, { location: { lat: -36.85, lon: 144.55 } }), "needs_review"), main())).toBe(true);
    expect(inData(decided(8, report({ kind: "wrong_location" }, { location: { lat: -36.86, lon: 144.55 } }), "needs_review"), main())).toBe(false);
    expect(inData(decided(9, report({ kind: "wrong_location" })), main())).toBe(false);
    expect(inData(decided(10, report({ kind: "closed" })), main([{ ...record, status: "closed" }]))).toBe(true);
    expect(inData(decided(11, report({ kind: "closed" })), main())).toBe(false);
    expect(inData(decided(12, report({ kind: "reopened" })), main())).toBe(true);
    expect(inData(decided(13, report({ kind: "reopened" })), main([{ ...record, status: "closed" }]))).toBe(false);
  });

  it("contact value: a fact report of a contact counts like any fact", () => {
    const item = decided(1, report({ kind: "fact", fact: "phone", value: "03 5555 0199" }));
    expect(inData(item, main())).toBe(false);
    expect(inData(item, main([dated("phone", RUN, { facts: { power: false, phone: "03 5555 0199" } })]))).toBe(true);
  });

  it("contact takedown: main no longer has the contact", () => {
    const item = decided(1, report({ kind: "contact", fact: "phone", reason: "wrong" }));
    expect(inData(item, main())).toBe(false);
    expect(inData(item, main([{ ...record, facts: { power: false } }]))).toBe(true);
  });

  it("doubt: main no longer has the fact, or set it again since", () => {
    const item = decided(1, report({ kind: "doubt", fact: "power" }));
    expect(inData(item, main())).toBe(false);
    expect(inData(item, main([{ ...record, facts: { phone: "03 5555 0100" } }]))).toBe(true);
    expect(inData(item, main([dated("power", LATER, { facts: { power: true, phone: "03 5555 0100" } })]))).toBe(true);
  });

  for (const [kind, key, body, base] of [
    ["name", "name", { value: "Lake Eppalock Rest Area" }, {}],
    ["description", "description", { value: "Shady sites by the water." }, {}],
    ["kind", "kind", { place_kind: "caravan_park" }, {}],
    ["wrong_location", "location", {}, {}],
    ["closed", "status", {}, {}],
    ["reopened", "status", {}, { status: "closed" }],
  ] as const) {
    it(`${kind}: main has ${key} dated by that run or later`, () => {
      const item = decided(1, report({ kind, ...body }), "needs_review");
      const differs = { ...record, ...base } as Place;
      expect(inData(item, main([differs]))).toBe(false);
      expect(inData(item, main([{ ...differs, fact_dates: { [key]: BEFORE } }]))).toBe(false);
      expect(inData(item, main([{ ...differs, fact_dates: { [key]: RUN } }]))).toBe(true);
    });
  }

  it("new_place: the place file is on main, and a merged one names the place it went into", () => {
    const item = decided(1, report({ kind: "new_place" }, { place: null, location: { lat: -30, lon: 140 } }));
    const own = `ocdb_${id(1).slice(3)}`;
    expect(itemInDataOnMain(item, main())).toEqual({ inData: false });
    const file = `places/${own.slice(-2).toLowerCase()}/${own}.json`;
    expect(itemInDataOnMain(item, main([{ ...record, id: own }]))).toEqual({ inData: true, file });
    expect(itemInDataOnMain(item, main([{ ...record, id: own, status: "merged", merged_into: TARGET }]))).toEqual({ inData: true, file, place: TARGET });
  });

  it("check: last_confirmed or the status dated by that run or later, or the place is a new place", () => {
    const item = decided(1, { type: "check", check: { visited: "2026-10-30", still_there: true } });
    expect(inData(item, main([{ ...record, last_confirmed: BEFORE }]))).toBe(false);
    expect(inData(item, main([{ ...record, last_confirmed: RUN }]))).toBe(true);
    expect(inData(item, main([dated("status", RUN, { status: "reported_closed" })]))).toBe(true);
    expect(inData(item, main([{ ...record, standing: "shown" }]))).toBe(true);
  });

  it("review: its line is in reviews/ on main, or a later one from the contributor", () => {
    const item = decided(1, { type: "review", contributor: "ctr_0000000000000001", review: { stars: 4, text: "Quiet", visited: "2026-10" } }, "needs_review");
    const line = (n: number, contributor = "ctr_0000000000000001"): Review => ({
      id: `rev_${id(n).slice(3)}`, place: PLACE, stars: 4, text: "Quiet", visited: "2026-10", created: RUN, app: "example-app", contributor,
    });
    expect(inData(item, main([record], { reviews: () => [] }))).toBe(false);
    expect(inData(item, main([record], { reviews: () => [line(1)] }))).toBe(true);
    expect(inData(item, main([record], { reviews: () => [line(2)] }))).toBe(true);
    expect(inData(item, main([record], { reviews: () => [line(2, "ctr_0000000000000002")] }))).toBe(false);
  });

  it("remove: the new place on main is hidden", () => {
    const item = decided(1, report({ kind: "remove", reason: "not_there" }));
    expect(inData(item, main([{ ...record, standing: "shown" }]))).toBe(false);
    expect(inData(item, main([{ ...record, standing: "hidden" }]))).toBe(true);
  });

  it("withdraw: the withdrawn place's record is gone from main; a late withdraw counts as a removal report", () => {
    const item = decided(1, { type: "withdraw" }, "applied", "new place withdrawn");
    expect(inData(item, main())).toBe(false);
    expect(inData(item, main([]))).toBe(true);
    const late = decided(2, { type: "withdraw" }, "applied", "withdrawn more than 24 hours after it was added, so it counts as a report");
    expect(inData(late, main([{ ...record, standing: "shown" }]))).toBe(false);
    expect(inData(late, main([{ ...record, standing: "hidden" }]))).toBe(true);
  });

  it("commons_mismatch: the place and file are on the do-not-match list on main", () => {
    const item = decided(1, report({ kind: "commons_mismatch", file: "Lake Pool 6.jpg" }));
    expect(inData(item, main([record], { doNotMatch: [{ place: PLACE, file: "Lake Pool 7.jpg" }] }))).toBe(false);
    expect(inData(item, main([record], { doNotMatch: [{ place: PLACE, file: "Lake Pool 6.jpg" }] }))).toBe(true);
  });

  it("a place merged into another on main counts as in the data", () => {
    const item = decided(1, report({ kind: "name", value: "Lake Eppalock Rest Area" }), "needs_review");
    expect(inData(item, main([{ ...record, status: "merged", merged_into: TARGET }]))).toBe(true);
  });

  it("a later change that replaced it still counts as in the data", () => {
    const item = decided(1, report({ kind: "fact", fact: "power", value: true }));
    expect(inData(item, main([dated("power", LATER, { facts: { power: false } })]))).toBe(true);
  });

  it("a commit by the AI reviewer counts the same as a person's: only main's dates are read", () => {
    const item = decided(1, report({ kind: "description", value: "Shady sites by the water." }), "needs_review");
    // The review branch, as the AI reviewer left it, merged into main: the run's date is on the description.
    const merged = dated("description", RUN, { description: "Shady sites by the water." });
    expect(inData(item, main([merged]))).toBe(true);
  });

  it("names the file each change is in, for dating it by its last commit", () => {
    const fileOf = (item: StoredFeedback, data: MainData) => {
      const found = itemInDataOnMain(item, data);
      return found.inData ? found.file : undefined;
    };
    const who = { contributor: "ctr_0000000000000001" };
    expect(fileOf(decided(1, report({ kind: "fact", fact: "power", value: false })), main())).toBe(`places/za/${PLACE}.json`);
    const review = decided(3, { type: "review", ...who, review: { stars: 4, text: "Quiet", visited: "2026-10" } });
    expect(fileOf(review, main([record], { reviews: () => [{ id: `rev_${id(3).slice(3)}` } as Review] }))).toBe(`reviews/${PLACE}.ndjson`);
    const commons = decided(4, report({ kind: "commons_mismatch", file: "Lake Pool 6.jpg" }));
    expect(fileOf(commons, main([record], { doNotMatch: [{ place: PLACE, file: "Lake Pool 6.jpg" }] }))).toBe("moderation/commons-do-not-match.json");
  });

  it("a place main doesn't have is not in the data", () => {
    expect(inData(decided(1, report({ kind: "fact", fact: "power", value: true })), main([]))).toBe(false);
  });
});

describe("progressOf", () => {
  const ctx = (review: string[] = [], auto: string[] = []) => ({
    declined: { review: new Set(review), auto: new Set(auto) },
    inDataAt: (file: string) => (file === `places/za/${PLACE}.json` ? "2026-11-02T10:00:00Z" : "2026-11-03T00:00:00Z"),
  });
  const nameReport = (result = "needs_review") => decided(1, report({ kind: "name", value: "Lake Eppalock Rest Area" }), result, "names are checked by a person");

  it("maps every outcome to its state", () => {
    const fact = report({ kind: "fact", fact: "power", value: true });
    const base = { id: id(1), place: PLACE, decided_at: RUN, reason: "r" };
    expect(progressOf(decided(1, fact, "applied", "r"), main(), ctx())).toEqual({ ...base, state: "accepted" });
    expect(progressOf(decided(1, fact, "needs_review", "r"), main(), ctx())).toEqual({ ...base, state: "held" });
    expect(progressOf(decided(1, fact, "awaiting_approval", "r"), main(), ctx())).toEqual({ ...base, state: "held" });
    expect(progressOf(decided(1, fact, "refused", "r"), main(), ctx())).toEqual({ ...base, state: "refused", by: "rules" });
    expect(progressOf(decided(1, fact, "waiting", "r"), main(), ctx())).toEqual({ ...base, state: "waiting" });
    // in_data_at is when main got the place file.
    expect(progressOf(decided(1, fact, "applied", "r"), main([dated("power", RUN, { facts: { power: true } })]), ctx())).toEqual({
      ...base,
      state: "in_data",
      in_data_at: "2026-11-02T10:00:00Z",
    });
  });

  it("a new place merged into another is in the data under the place it went into", () => {
    const item = decided(1, report({ kind: "new_place" }, { place: null }));
    const own = `ocdb_${id(1).slice(3)}`;
    expect(progressOf(item, main([{ ...record, id: own }]), ctx())).toMatchObject({ state: "in_data", place: own });
    expect(progressOf(item, main([{ ...record, id: own, status: "merged", merged_into: TARGET }]), ctx())).toMatchObject({ state: "in_data", place: TARGET });
  });

  it("a held change a person took out of the review PR is refused by the reviewer once the PR merged, and held while it is open", () => {
    expect(progressOf(nameReport(), main(), ctx())).toMatchObject({ state: "held" });
    expect(progressOf(nameReport(), main(), ctx([id(1)]))).toEqual({ id: id(1), place: PLACE, decided_at: RUN, state: "refused", by: "reviewer", reason: REVIEWER_DECLINED });
    // Merged with the change: in the data.
    expect(progressOf(nameReport(), main([dated("name", RUN)]), ctx([id(1)]))).toMatchObject({ state: "in_data" });
  });

  it("an applied change whose automatic PR was closed without merging is refused by the reviewer, unless main has it", () => {
    const fact = decided(1, report({ kind: "fact", fact: "power", value: true }), "applied", "fact accepted");
    expect(progressOf(fact, main(), ctx([], [id(1)]))).toEqual({ id: id(1), place: PLACE, decided_at: RUN, state: "refused", by: "reviewer", reason: AUTO_PR_CLOSED });
    expect(progressOf(fact, main([dated("power", RUN, { facts: { power: true } })]), ctx([], [id(1)]))).toMatchObject({ state: "in_data" });
    // A held item is decided by its review PR, not the automatic one.
    expect(progressOf(nameReport(), main(), ctx([], [id(1)]))).toMatchObject({ state: "held" });
  });

  it("items that never change the data keep their decision's state", () => {
    const other = decided(1, report({ kind: "other", note: "x" }), "needs_review");
    expect(progressOf(other, main(), ctx([id(1)]))).toMatchObject({ state: "held" });
    const reported = decided(2, { type: "review_report", review_report: { review: "rev_x", reason: "spam" } }, "applied");
    expect(progressOf(reported, main(), ctx())).toMatchObject({ state: "accepted" });
  });
});

describe("idsOnPrs and turnedDown", () => {
  const pr = (state: ReviewPr["state"], body: string, extra: Partial<ReviewPr> = {}): ReviewPr => ({
    number: 1, state, body, comments: [], author: { login: "ocdb-bot[bot]" }, isCrossRepository: false, ...extra,
  });
  const none = { open: new Set<string>(), merged: new Set<string>(), closed: new Set<string>() };

  it("reads the ids on PRs the bot opened, in the body and the bot's comments, by the PR's state", () => {
    const prs = [
      pr("MERGED", `- place: name (${id(1)})`, { comments: [{ author: { login: "ocdb-bot[bot]" }, body: `- (${id(2)}, ${id(8)})` }, { author: { login: "someone" }, body: id(3) }] }),
      pr("CLOSED", `(${id(4)})`),
      pr("OPEN", `(${id(5)})`),
      pr("MERGED", `(${id(6)})`, { author: { login: "someone" } }),
      pr("MERGED", `(${id(7)})`, { isCrossRepository: true }),
    ];
    const ids = idsOnPrs(prs, ["ocdb-bot"]);
    expect([...ids.merged].sort()).toEqual([id(1), id(2), id(8)]);
    expect([...ids.closed]).toEqual([id(4)]);
    expect([...ids.open]).toEqual([id(5)]);
  });

  it("reads a comment only from an account of type Bot, never from a login equal to the bare slug", () => {
    const prs = [
      pr("MERGED", "", {
        comments: [
          { author: { login: "ocdb-bot" }, body: id(1) },
          { author: { login: "ocdb-bot", type: "User" }, body: id(2) },
          { author: { login: "ocdb-bot", type: "Bot" }, body: id(3) },
        ],
      }),
      pr("CLOSED", `(${id(4)})`, { author: { login: "ocdb-bot" } }),
    ];
    const ids = idsOnPrs(prs, ["ocdb-bot"]);
    expect([...ids.merged]).toEqual([id(3)]);
    expect([...ids.closed]).toEqual([]);
  });

  it("an item on a closed review PR and then listed again on an open one is not turned down", () => {
    const review = idsOnPrs([pr("OPEN", `held case (${id(1)})`), pr("CLOSED", `(${id(1)}, ${id(2)})`)], ["ocdb-bot"]);
    expect([...turnedDown(review, none).review]).toEqual([id(2)]);
  });

  it("an item on a closed automatic PR is turned down, and not while an open automatic PR names it", () => {
    expect([...turnedDown(none, idsOnPrs([pr("CLOSED", `(${id(1)})`), pr("MERGED", `(${id(2)})`)], ["ocdb-bot"])).auto]).toEqual([id(1)]);
    expect([...turnedDown(none, idsOnPrs([pr("CLOSED", `(${id(1)})`), pr("OPEN", `(${id(1)})`)], ["ocdb-bot"])).auto]).toEqual([]);
  });
});

describe("lastCommitTimes", () => {
  it("dates a file last touched before a shallow checkout's range by the last commit", async () => {
    const source = await mkdtemp(join(tmpdir(), "ocdb-progress-source-"));
    const clone = await mkdtemp(join(tmpdir(), "ocdb-progress-clone-"));
    await commitIn(source, `places/za/${PLACE}.json`, "{}", "2026-10-01T10:00:00Z");
    // The oldest commit in range: git shows it as adding every file.
    await commitIn(source, "NOTES.md", "notes", "2026-10-25T10:00:00Z");
    await commitIn(source, `places/zb/${TARGET}.json`, "{}", "2026-10-30T10:00:00Z");
    await commitIn(source, "README.md", "data", "2026-11-02T10:00:00Z");
    await execFileP("git", ["clone", "-q", "--shallow-since=2026-10-20", `file://${source}`, join(clone, "main")]);
    const times = await lastCommitTimes(join(clone, "main"), [`places/za/${PLACE}.json`, `places/zb/${TARGET}.json`], "2026-11-03T00:00:00Z");
    expect(Object.fromEntries(times)).toEqual({
      // Its commit is older than the checkout: the last commit stands in.
      [`places/za/${PLACE}.json`]: "2026-11-02T10:00:00Z",
      [`places/zb/${TARGET}.json`]: "2026-10-30T10:00:00Z",
    });
    await rm(source, { recursive: true, force: true });
    await rm(clone, { recursive: true, force: true });
  });

  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ocdb-progress-git-"));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("dates each file by the last commit that touched it, an untracked one by the last commit, and falls back without git", async () => {
    await commitIn(repo, `places/za/${PLACE}.json`, "{}", "2026-11-01T10:00:00Z");
    await commitIn(repo, `reviews/${PLACE}.ndjson`, "{}", "2026-11-02T10:00:00Z");
    const times = await lastCommitTimes(repo, [`places/za/${PLACE}.json`, `places/zb/${TARGET}.json`], "2026-11-03T00:00:00Z");
    expect(Object.fromEntries(times)).toEqual({ [`places/za/${PLACE}.json`]: "2026-11-01T10:00:00Z", [`places/zb/${TARGET}.json`]: "2026-11-02T10:00:00Z" });
    const plain = await mkdtemp(join(tmpdir(), "ocdb-progress-plain-"));
    expect(Object.fromEntries(await lastCommitTimes(plain, ["x"], "2026-11-03T00:00:00Z"))).toEqual({ x: "2026-11-03T00:00:00Z" });
    await rm(plain, { recursive: true, force: true });
  });
});

const execFileP = promisify(execFile);
/** Writes `file` in the git repository `repo` and commits it, with the commit time `at`. */
async function commitIn(repo: string, file: string, content: string, at: string): Promise<void> {
  const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  const g = (...args: string[]) => execFileP("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { env });
  await mkdir(repo, { recursive: true });
  await g("init", "-q");
  await mkdir(dirname(join(repo, file)), { recursive: true });
  await writeFile(join(repo, file), content);
  await g("add", "-A");
  await g("commit", "-q", "-m", `Add ${file}`);
}

describe("sendProgress", () => {
  let root: string;
  let inbox: string;
  let mainDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ocdb-progress-"));
    inbox = join(root, "inbox");
    mainDir = join(root, "main");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function put(path: string, body: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(body)}\n`);
  }
  const inInbox = (item: StoredFeedback) => {
    const folder = (item as unknown as { outcome: { result: string } }).outcome.result === "refused" ? "refused" : "applied";
    return put(join(inbox, folder, item.received.slice(0, 10), `${item.id}.json`), item);
  };
  const onMain = (place: Place) => put(join(mainDir, "places", place.id.slice(-2).toLowerCase(), `${place.id}.json`), place);
  const store = () => ({ progress: vi.fn(async (_items: readonly ProgressUpdate[]) => {}) });

  it("sends every decided item of the last 90 days and this run's other decisions, but photos", async () => {
    await inInbox(decided(1, report({ kind: "fact", fact: "power", value: true })));
    await inInbox(decided(2, report({ kind: "name", value: "Lake Eppalock Rest Area" }), "needs_review", "names are checked by a person"));
    await inInbox(decided(3, report({ kind: "fact", fact: "toilets", value: true }), "refused", "the contributor is blocked"));
    await inInbox({ ...decided(4, { type: "photo" }), received: "2026-10-31T00:00:00Z" });
    // Too old.
    await inInbox({ ...decided(5, report({ kind: "fact", fact: "power", value: true })), received: "2026-07-01T00:00:00Z" } as StoredFeedback);
    await onMain(dated("power", RUN, { facts: { power: true } }));
    const sent = store();
    const result = await sendProgress({
      inbox,
      main: mainDir,
      store: sent,
      decisions: [
        { id: id(6), place: PLACE, outcome: "waiting", reason: "a closed place needs a second device to reopen it" },
        { id: id(7), place: PLACE, outcome: "awaiting_approval", reason: "proof found" },
        // Already in the inbox: the inbox's record wins.
        { id: id(1), place: PLACE, outcome: "applied", reason: "" },
      ],
      reviewPrs: [{ number: 9, state: "CLOSED", body: `(${id(2)})`, comments: [], author: { login: "ocdb-bot[bot]" }, isCrossRepository: false }],
      botLogins: ["ocdb-bot"],
      now: NOW,
    });
    expect(result).toEqual({ sent: 5, failed: 0, recorded: true });
    expect(sent.progress).toHaveBeenCalledTimes(1);
    expect(sent.progress.mock.calls[0]![0]).toEqual([
      { id: id(1), place: PLACE, decided_at: RUN, state: "in_data", in_data_at: "2026-11-03T00:00:00Z" },
      { id: id(2), place: PLACE, decided_at: RUN, state: "refused", by: "reviewer", reason: REVIEWER_DECLINED },
      { id: id(3), place: PLACE, decided_at: RUN, state: "refused", by: "rules", reason: "the contributor is blocked" },
      { id: id(6), place: PLACE, decided_at: "2026-11-03T00:00:00Z", state: "waiting", reason: "a closed place needs a second device to reopen it" },
      { id: id(7), place: PLACE, decided_at: "2026-11-03T00:00:00Z", state: "held", reason: "proof found" },
    ]);
  });

  it("dates a change in the data by the last commit on main that touched its file", async () => {
    await inInbox(decided(1, report({ kind: "fact", fact: "power", value: true })));
    await commitIn(mainDir, `places/za/${PLACE}.json`, JSON.stringify(dated("power", RUN, { facts: { power: true } })), "2026-11-01T06:00:00Z");
    await commitIn(mainDir, "README.md", "data", "2026-11-02T06:00:00Z");
    const sent = store();
    await sendProgress({ inbox, main: mainDir, store: sent, decisions: [], now: NOW });
    expect(sent.progress.mock.calls[0]![0]).toEqual([{ id: id(1), place: PLACE, decided_at: RUN, state: "in_data", in_data_at: "2026-11-01T06:00:00Z" }]);
  });

  it("refuses an applied change whose automatic PR was closed without merging", async () => {
    await inInbox(decided(1, report({ kind: "fact", fact: "power", value: true }), "applied", "fact accepted"));
    await onMain(record);
    const sent = store();
    await sendProgress({
      inbox,
      main: mainDir,
      store: sent,
      decisions: [],
      autoPrs: [{ number: 3, state: "CLOSED", body: `(${id(1)})`, comments: [], author: { login: "ocdb-bot[bot]" }, isCrossRepository: false }],
      botLogins: ["ocdb-bot"],
      now: NOW,
    });
    expect(sent.progress.mock.calls[0]![0]).toEqual([{ id: id(1), place: PLACE, decided_at: RUN, state: "refused", by: "reviewer", reason: AUTO_PR_CLOSED }]);
  });

  describe("only what changed since the last send", () => {
    const fact = (n: number, fact: string) => decided(n, report({ kind: "fact", fact, value: true }));
    const at = (iso: string) => new Date(iso);
    const sentIds = (s: ReturnType<typeof store>) => s.progress.mock.calls.flatMap((c) => c[0].map((u) => `${u.id.slice(-2)}:${u.state}`));
    const send = (s: { progress: (items: readonly ProgressUpdate[]) => Promise<void> }, now: Date, decisions: Parameters<typeof sendProgress>[0]["decisions"] = []) =>
      sendProgress({ inbox, main: mainDir, store: s, decisions, now });

    it("sends nothing on a second run when nothing changed, and records what it sent in the inbox", async () => {
      await inInbox(fact(1, "power"));
      await inInbox(decided(2, report({ kind: "name", value: "Lake Eppalock Rest Area" }), "needs_review"));
      await onMain(record);
      const first = store();
      expect(await send(first, NOW, [{ id: id(3), place: PLACE, outcome: "waiting", reason: "waiting" }])).toMatchObject({ sent: 3, recorded: true });
      expect(JSON.parse(await readFile(join(inbox, "progress", "sent.json"), "utf8")).items).toEqual({ [id(1)]: "accepted", [id(2)]: "held", [id(3)]: "waiting" });
      const second = store();
      expect(await send(second, at("2026-11-03T01:00:00Z"), [{ id: id(3), place: PLACE, outcome: "waiting", reason: "waiting" }])).toMatchObject({ sent: 0, recorded: false });
      expect(second.progress).not.toHaveBeenCalled();
    });

    it("sends only the item whose state changed, and never a final one again", async () => {
      await inInbox(fact(1, "power"));
      await inInbox(fact(2, "toilets"));
      await onMain(record);
      await send(store(), NOW);
      await onMain(dated("power", RUN, { facts: { power: true } }));
      const second = store();
      await send(second, at("2026-11-03T01:00:00Z"));
      expect(sentIds(second)).toEqual(["01:in_data"]);
      const third = store();
      await send(third, at("2026-11-03T02:00:00Z"));
      expect(third.progress).not.toHaveBeenCalled();
    });

    it("sends a failed batch again on the next run", async () => {
      await inInbox(fact(1, "power"));
      await onMain(record);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await send({ progress: async () => Promise.reject(new Error("503")) }, NOW)).toMatchObject({ sent: 0, failed: 1 });
      warn.mockRestore();
      const retry = store();
      await send(retry, at("2026-11-03T01:00:00Z"));
      expect(sentIds(retry)).toEqual(["01:accepted"]);
    });

    it("sends all 90 days on the first run after midnight UTC each Monday", async () => {
      await inInbox(fact(1, "power"));
      await inInbox(decided(2, report({ kind: "fact", fact: "toilets", value: true }), "refused", "blocked"));
      await onMain(record);
      await send(store(), NOW);
      // Sunday: nothing changed, nothing sent.
      const sunday = store();
      await send(sunday, at("2026-11-08T23:00:00Z"));
      expect(sunday.progress).not.toHaveBeenCalled();
      const monday = store();
      await send(monday, at("2026-11-09T00:30:00Z"));
      expect(sentIds(monday)).toEqual(["01:accepted", "02:refused"]);
      const later = store();
      await send(later, at("2026-11-09T06:00:00Z"));
      expect(later.progress).not.toHaveBeenCalled();
    });
  });

  it("reads reviews and the do-not-match list from main", async () => {
    await inInbox(decided(1, { type: "review", contributor: "ctr_0000000000000001", review: { stars: 4, text: "Quiet", visited: "2026-10" } }));
    await inInbox(decided(3, report({ kind: "commons_mismatch", file: "Lake Pool 6.jpg" })));
    await onMain(record);
    await put(join(mainDir, "reviews", `${PLACE}.ndjson`), { id: `rev_${id(1).slice(3)}`, place: PLACE, contributor: "ctr_0000000000000001" });
    await put(join(mainDir, "moderation", "commons-do-not-match.json"), { pairs: [{ place: PLACE, file: "Lake Pool 6.jpg", added: "2026-11-01", source: "reports" }] });
    const sent = store();
    await sendProgress({ inbox, main: mainDir, store: sent, decisions: [], now: NOW });
    expect(sent.progress.mock.calls[0]![0].map((u) => u.state)).toEqual(["in_data", "in_data"]);
  });

  it("sends at most 500 items a call", async () => {
    const decisions = Array.from({ length: 1201 }, (_, i) => ({ id: id(i + 1), place: PLACE, outcome: "waiting" as const, reason: "waiting" }));
    const sent = store();
    expect(await sendProgress({ inbox, main: mainDir, store: sent, decisions, now: NOW })).toEqual({ sent: 1201, failed: 0, recorded: true });
    expect(sent.progress.mock.calls.map((c) => c[0].length)).toEqual([500, 500, 201]);
  });

  it("logs a failing intake and keeps going, never failing the run", async () => {
    const decisions = Array.from({ length: 600 }, (_, i) => ({ id: id(i + 1), place: PLACE, outcome: "waiting" as const, reason: "waiting" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const failing = {
      progress: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error("the intake refused the progress: 503");
      }),
    };
    expect(await sendProgress({ inbox, main: mainDir, store: failing, decisions, now: NOW })).toEqual({ sent: 100, failed: 500, recorded: true });
    expect(failing.progress).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("503"));
    warn.mockRestore();
  });

  it("calls nothing when there is nothing to send", async () => {
    const sent = store();
    expect(await sendProgress({ inbox, main: mainDir, store: sent, decisions: [], now: NOW })).toMatchObject({ sent: 0, failed: 0 });
    expect(sent.progress).not.toHaveBeenCalled();
  });
});

describe("intakeRecentStore progress", () => {
  it("posts the items with the token, and throws when the intake refuses", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const items: ProgressUpdate[] = [{ id: id(1), state: "accepted" }];
    await intakeRecentStore("https://intake.example", "token-1", ok).progress(items);
    expect(calls[0]!.url).toBe("https://intake.example/v1/feedback/progress");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer token-1" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ items });
    const refused = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(intakeRecentStore("https://intake.example", "x", refused).progress(items)).rejects.toThrow(/401/);
  });
});
