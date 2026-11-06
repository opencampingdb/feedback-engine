import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import {
  idsOnDecidedReviewPrs,
  itemInDataOnMain,
  progressOf,
  REVIEWER_DECLINED,
  sendProgress,
  type MainData,
  type ProgressUpdate,
} from "../src/progress.js";
import type { ReviewPr } from "../src/owners.js";
import { intakeRecentStore } from "../src/recent.js";
import type { Fee, Place, Review } from "../src/types.js";

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
  return { places: new Map(places.map((p) => [p.id, p])), reviews: () => [], fees: () => [], doNotMatch: [], ...extra };
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

  for (const [kind, key, body] of [
    ["name", "name", { value: "Lake Eppalock Rest Area" }],
    ["description", "description", { value: "Shady sites by the water." }],
    ["kind", "kind", { place_kind: "caravan_park" }],
    ["wrong_location", "location", {}],
    ["closed", "status", {}],
    ["reopened", "status", {}],
  ] as const) {
    it(`${kind}: main has ${key} dated by that run or later`, () => {
      const item = decided(1, report({ kind, ...body }), "needs_review");
      expect(inData(item, main())).toBe(false);
      expect(inData(item, main([dated(key, BEFORE)]))).toBe(false);
      expect(inData(item, main([dated(key, RUN)]))).toBe(true);
    });
  }

  it("new_place: the place file is on main, and a merged one names the place it went into", () => {
    const item = decided(1, report({ kind: "new_place" }, { place: null, location: { lat: -30, lon: 140 } }));
    const own = `ocdb_${id(1).slice(3)}`;
    expect(itemInDataOnMain(item, main())).toEqual({ inData: false });
    expect(itemInDataOnMain(item, main([{ ...record, id: own }]))).toEqual({ inData: true });
    expect(itemInDataOnMain(item, main([{ ...record, id: own, status: "merged", merged_into: TARGET }]))).toEqual({ inData: true, place: TARGET });
  });

  it("check: last_confirmed or the status dated by that run or later, or the place is a new place", () => {
    const item = decided(1, { type: "check", check: { visited: "2026-10-30", still_there: true } });
    expect(inData(item, main([{ ...record, last_confirmed: BEFORE }]))).toBe(false);
    expect(inData(item, main([{ ...record, last_confirmed: RUN }]))).toBe(true);
    expect(inData(item, main([dated("status", RUN, { status: "reported_closed" })]))).toBe(true);
    expect(inData(item, main([{ ...record, standing: "shown" }]))).toBe(true);
  });

  it("fee: its line is in fees/ on main, or a later one from the contributor for that site type", () => {
    const item = decided(1, { type: "fee", contributor: "ctr_0000000000000001", fee: { amount: 30, site: "powered", paid: "2026-10" } });
    const line = (n: number, site: Fee["site"] = "powered"): Fee => ({
      id: `fee_${id(n).slice(3)}`, place: PLACE, amount: 30, site, paid: "2026-10", created: RUN, app: "example-app", contributor: "ctr_0000000000000001",
    });
    expect(inData(item, main([record], { fees: () => [] }))).toBe(false);
    expect(inData(item, main([record], { fees: () => [line(1)] }))).toBe(true);
    expect(inData(item, main([record], { fees: () => [line(2)] }))).toBe(true);
    expect(inData(item, main([record], { fees: () => [line(2, "cabin")] }))).toBe(false);
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

  it("a place main doesn't have is not in the data", () => {
    expect(inData(decided(1, report({ kind: "fact", fact: "power", value: true })), main([]))).toBe(false);
  });
});

describe("progressOf", () => {
  const ctx = (declined: string[] = []) => ({ declined: new Set(declined), runAt: "2026-11-03T00:00:00Z" });
  const nameReport = (result = "needs_review") => decided(1, report({ kind: "name", value: "Lake Eppalock Rest Area" }), result, "names are checked by a person");

  it("maps every outcome to its state", () => {
    const fact = report({ kind: "fact", fact: "power", value: true });
    const base = { id: id(1), place: PLACE, decided_at: RUN, reason: "r" };
    expect(progressOf(decided(1, fact, "applied", "r"), main(), ctx())).toEqual({ ...base, state: "accepted" });
    expect(progressOf(decided(1, fact, "needs_review", "r"), main(), ctx())).toEqual({ ...base, state: "held" });
    expect(progressOf(decided(1, fact, "awaiting_approval", "r"), main(), ctx())).toEqual({ ...base, state: "held" });
    expect(progressOf(decided(1, fact, "refused", "r"), main(), ctx())).toEqual({ ...base, state: "refused", by: "rules" });
    expect(progressOf(decided(1, fact, "waiting", "r"), main(), ctx())).toEqual({ ...base, state: "waiting" });
    expect(progressOf(decided(1, fact, "applied", "r"), main([dated("power", RUN, { facts: { power: true } })]), ctx())).toEqual({
      ...base,
      state: "in_data",
      in_data_at: "2026-11-03T00:00:00Z",
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

  it("items that never change the data keep their decision's state", () => {
    const other = decided(1, report({ kind: "other", note: "x" }), "needs_review");
    expect(progressOf(other, main(), ctx([id(1)]))).toMatchObject({ state: "held" });
    const reported = decided(2, { type: "review_report", review_report: { review: "rev_x", reason: "spam" } }, "applied");
    expect(progressOf(reported, main(), ctx())).toMatchObject({ state: "accepted" });
  });
});

describe("idsOnDecidedReviewPrs", () => {
  const pr = (state: ReviewPr["state"], body: string, extra: Partial<ReviewPr> = {}): ReviewPr => ({
    number: 1, state, body, comments: [], author: { login: "ocdb-bot[bot]" }, isCrossRepository: false, ...extra,
  });

  it("reads the ids in merged and closed PRs the bot opened, in the body and the bot's comments", () => {
    const prs = [
      pr("MERGED", `- place: name (${id(1)})`, { comments: [{ author: { login: "ocdb-bot[bot]" }, body: `- (${id(2)})` }, { author: { login: "someone" }, body: id(3) }] }),
      pr("CLOSED", `(${id(4)})`),
      pr("OPEN", `(${id(5)})`),
      pr("MERGED", `(${id(6)})`, { author: { login: "someone" } }),
      pr("MERGED", `(${id(7)})`, { isCrossRepository: true }),
    ];
    expect([...idsOnDecidedReviewPrs(prs, ["ocdb-bot"])].sort()).toEqual([id(1), id(2), id(4)]);
  });
});

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
    expect(result).toEqual({ sent: 5, failed: 0 });
    expect(sent.progress).toHaveBeenCalledTimes(1);
    expect(sent.progress.mock.calls[0]![0]).toEqual([
      { id: id(1), place: PLACE, decided_at: RUN, state: "in_data", in_data_at: "2026-11-03T00:00:00Z" },
      { id: id(2), place: PLACE, decided_at: RUN, state: "refused", by: "reviewer", reason: REVIEWER_DECLINED },
      { id: id(3), place: PLACE, decided_at: RUN, state: "refused", by: "rules", reason: "the contributor is blocked" },
      { id: id(6), place: PLACE, decided_at: "2026-11-03T00:00:00Z", state: "waiting", reason: "a closed place needs a second device to reopen it" },
      { id: id(7), place: PLACE, decided_at: "2026-11-03T00:00:00Z", state: "held", reason: "proof found" },
    ]);
  });

  it("reads reviews, fees and the do-not-match list from main", async () => {
    await inInbox(decided(1, { type: "review", contributor: "ctr_0000000000000001", review: { stars: 4, text: "Quiet", visited: "2026-10" } }));
    await inInbox(decided(2, { type: "fee", contributor: "ctr_0000000000000001", fee: { amount: 30, site: "powered", paid: "2026-10" } }));
    await inInbox(decided(3, report({ kind: "commons_mismatch", file: "Lake Pool 6.jpg" })));
    await onMain(record);
    await put(join(mainDir, "reviews", `${PLACE}.ndjson`), { id: `rev_${id(1).slice(3)}`, place: PLACE, contributor: "ctr_0000000000000001" });
    await put(join(mainDir, "fees", `${PLACE}.ndjson`), { id: `fee_${id(2).slice(3)}`, place: PLACE, contributor: "ctr_0000000000000001", site: "powered" });
    await put(join(mainDir, "moderation", "commons-do-not-match.json"), { pairs: [{ place: PLACE, file: "Lake Pool 6.jpg", added: "2026-11-01", source: "reports" }] });
    const sent = store();
    await sendProgress({ inbox, main: mainDir, store: sent, decisions: [], now: NOW });
    expect(sent.progress.mock.calls[0]![0].map((u) => u.state)).toEqual(["in_data", "in_data", "in_data"]);
  });

  it("sends at most 500 items a call", async () => {
    const decisions = Array.from({ length: 1201 }, (_, i) => ({ id: id(i + 1), place: PLACE, outcome: "waiting" as const, reason: "waiting" }));
    const sent = store();
    expect(await sendProgress({ inbox, main: mainDir, store: sent, decisions, now: NOW })).toEqual({ sent: 1201, failed: 0 });
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
    expect(await sendProgress({ inbox, main: mainDir, store: failing, decisions, now: NOW })).toEqual({ sent: 100, failed: 500 });
    expect(failing.progress).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("503"));
    warn.mockRestore();
  });

  it("calls nothing when there is nothing to send", async () => {
    const sent = store();
    expect(await sendProgress({ inbox, main: mainDir, store: sent, decisions: [], now: NOW })).toEqual({ sent: 0, failed: 0 });
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
