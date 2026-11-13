import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyRules } from "../src/rules.js";
import { run } from "../src/run.js";
import { changesData } from "../src/progress.js";
import { dumpPlace, dumpReviewLine, placePath, reviewPath } from "../src/serialise.js";
import type { Place, Review } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const NOW = "2026-11-03T00:00:00Z";

const place = (id = PLACE, rating: Place["rating"] = null): Place => ({
  id,
  name: "Lake Eppalock Camp",
  kind: "free_camp",
  group: "overnight",
  location: { lat: -36.85, lon: 144.55 },
  osm: { type: "node", id: 123456, version: 7 },
  facts: {},
  status: "open",
  rating,
  fact_sources: {},
  updated: "2026-06-01T00:00:00Z",
});

const ctr = (name: string) => `ctr_${Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16)}`;
let seq = 0;
const fbId = () => `fb_01JC${String(++seq).padStart(22, "0")}`;
const base = (who: string, placeId: string | null, received = "2026-11-02T10:00:00Z") => ({
  id: fbId(),
  received,
  app: "example-app",
  place: placeId,
  device: who,
  contributor: ctr(who),
  app_version: "1.0.0",
  consent: true as const,
});
const erasure = (who: string, received?: string): StoredFeedback => ({ ...base(who, null, received), type: "review_erasure" }) as StoredFeedback;
const reviewItem = (who: string, placeId = PLACE, received?: string): StoredFeedback =>
  ({ ...base(who, placeId, received), type: "review", review: { stars: 4, text: "Shady spot by the water, quiet at night.", visited: "2026-10-30" } }) as StoredFeedback;
const line = (n: number, who: string, placeId = PLACE, stars = 5): Review => ({
  id: `rev_01JA00000000000000000000${String(n).padStart(2, "0")}`,
  place: placeId,
  stars,
  text: "Good spot.",
  visited: "2026-10-01",
  created: "2026-10-02T00:00:00Z",
  app: "example-app",
  contributor: ctr(who),
});

function rules(pending: StoredFeedback[], lines: Review[], blocked: string[] = []) {
  const byPlace = (id: string) => lines.filter((r) => r.place === id);
  const out = applyRules({
    now: NOW,
    pending,
    history: [],
    places: new Map([place(PLACE, { count: 2, mean: 4 }), place(OTHER, { count: 1, mean: 5 })].map((p) => [p.id, p])),
    reviews: byPlace,
    blocked: new Set(blocked.map(ctr)),
    reviewers: new Set(lines.map((r) => r.contributor)),
    allReviews: lines,
  });
  return { ...out, outcome: (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.outcome };
}

describe("review erasure rules", () => {
  it("removes every review from the contributor, on every place, and recomputes the ratings", () => {
    const lines = [line(1, "sam"), line(2, "kim", PLACE, 3), line(3, "sam", OTHER)];
    const e = erasure("sam");
    const out = rules([e], lines);
    expect(out.outcome(e)).toBe("applied");
    expect(out.reviews.get(PLACE)?.map((r) => r.id)).toEqual([line(2, "kim").id]);
    expect(out.reviews.get(OTHER)).toEqual([]);
    expect(out.places.get(PLACE)?.rating).toEqual({ count: 1, mean: 3 });
    expect(out.places.get(OTHER)?.rating).toBeNull();
    expect(out.edits).toContainEqual({ kind: "review_erasure", contributor: ctr("sam"), feedback: e.id });
    expect(out.changes).toContainEqual(expect.objectContaining({ automatic: true, feedback: [e.id] }));
  });

  it("succeeds for a contributor with no reviews", () => {
    const e = erasure("lee");
    const out = rules([e], [line(1, "sam")]);
    expect(out.outcome(e)).toBe("applied");
    expect(out.reviews.size).toBe(0);
  });

  it("refuses a review the contributor sent before erasing in the same run, and takes one sent after", () => {
    const before = reviewItem("sam", OTHER, "2026-11-02T09:00:00Z");
    const e = erasure("sam", "2026-11-02T10:00:00Z");
    const after = reviewItem("sam", OTHER, "2026-11-02T11:00:00Z");
    const out = rules([before, e, after], [line(1, "sam")]);
    expect(out.outcome(before)).toBe("refused");
    expect(out.outcome(after)).not.toBe("refused");
    expect(out.reviews.get(PLACE)).toEqual([]);
  });

  it("honours a blocked contributor's erasure", () => {
    const e = erasure("bad");
    const out = rules([e], [{ ...line(1, "bad"), hidden: "moderator" }], ["bad"]);
    expect(out.outcome(e)).toBe("applied");
    expect(out.reviews.get(PLACE)).toEqual([]);
  });

  it("never counts as a change to a place for progress", () => {
    expect(changesData(erasure("sam"))).toBe(false);
  });
});

describe("review erasure in a run", () => {
  let root: string;
  let inbox: string;
  let data: string;
  let review: string;

  async function put(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "review-erasure-run-"));
    inbox = join(root, "inbox");
    data = join(root, "data");
    review = join(root, "review");
    for (const tree of [data, review]) {
      await put(join(tree, "places", "za", `${PLACE}.json`), dumpPlace(place(PLACE, { count: 2, mean: 4 })));
      await put(join(tree, "places", "zb", `${OTHER}.json`), dumpPlace(place(OTHER)));
    }
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("removes the contributor's reviews from the data and their held reviews from the review checkout", async () => {
    await put(join(data, reviewPath(PLACE)), `${dumpReviewLine(line(1, "sam"))}\n${dumpReviewLine(line(2, "kim", PLACE, 3))}\n`);
    await put(join(review, reviewPath(OTHER)), `${dumpReviewLine(line(3, "sam", OTHER))}\n`);
    const e = erasure("sam");
    await put(join(inbox, "pending", "2026-11-02", `${e.id}.json`), JSON.stringify(e));
    const summary = await run({ inbox, data, reviewData: review, now: new Date(NOW) });
    expect(summary.decisions).toEqual([expect.objectContaining({ id: e.id, outcome: "applied" })]);
    expect(summary.auto_files).toContain(reviewPath(PLACE));
    expect(summary.review_files).toContain(reviewPath(OTHER));
    const left = (await readFile(join(data, reviewPath(PLACE)), "utf8")).trim().split("\n").map((l) => (JSON.parse(l) as Review).contributor);
    expect(left).toEqual([ctr("kim")]);
    expect(await readFile(join(review, reviewPath(OTHER)), "utf8")).toBe("");
    const record = JSON.parse(await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8")) as Place;
    expect(record.rating).toEqual({ count: 1, mean: 3 });
  });
});

describe("review erasure across runs", () => {
  const NEW = "ocdb_01JC0000000000000000000NEW";
  let root: string;
  let inbox: string;
  let data: string;
  let review: string;

  async function put(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }
  const folderOf = async (item: StoredFeedback) => {
    for (const folder of ["pending", "applied", "refused"]) {
      if (await readFile(join(inbox, folder, "2026-11-02", `${item.id}.json`), "utf8").then(() => true, () => false)) return folder;
    }
    return undefined;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "review-erasure-runs-"));
    inbox = join(root, "inbox");
    data = join(root, "data");
    review = join(root, "review");
    for (const tree of [data, review]) await put(join(tree, "places", "za", `${PLACE}.json`), dumpPlace(place(PLACE)));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a review of a new place sent before the erasure, so a later run never publishes it", async () => {
    const r = reviewItem("sam", NEW, "2026-11-02T09:00:00Z");
    const e = erasure("sam", "2026-11-02T10:00:00Z");
    for (const item of [r, e]) await put(join(inbox, "pending", "2026-11-02", `${item.id}.json`), JSON.stringify(item));
    const one = await run({ inbox, data, reviewData: review, now: new Date(NOW), recentList: { ids: async () => new Set([NEW]) } });
    expect(one.decisions.find((d) => d.id === r.id)).toMatchObject({ outcome: "refused", reason: "the contributor's reviews were erased at their request" });
    expect(await folderOf(r)).toBe("refused");
    expect(await folderOf(e)).toBe("applied");

    for (const tree of [data, review]) await put(join(tree, placePath(NEW)), dumpPlace(place(NEW)));
    await run({ inbox, data, reviewData: review, now: new Date("2026-11-04T00:00:00Z") });
    await expect(readFile(join(data, reviewPath(NEW)), "utf8")).rejects.toThrow();
    await expect(readFile(join(review, reviewPath(NEW)), "utf8")).rejects.toThrow();
  });

  it("refuses a waiting review sent before an erasure an earlier run applied, and decides one sent after it", async () => {
    const e = { ...erasure("sam", "2026-11-02T10:00:00Z"), outcome: { result: "applied", reason: "", run: "2026-11-02T12:00:00Z" } };
    await put(join(inbox, "applied", "2026-11-02", `${e.id}.json`), JSON.stringify(e));
    const before = reviewItem("sam", PLACE, "2026-11-02T09:00:00Z");
    const after = reviewItem("sam", PLACE, "2026-11-02T11:00:00Z");
    for (const item of [before, after]) await put(join(inbox, "pending", "2026-11-02", `${item.id}.json`), JSON.stringify(item));
    const summary = await run({ inbox, data, reviewData: review, now: new Date(NOW) });
    expect(summary.decisions.find((d) => d.id === before.id)).toMatchObject({ outcome: "refused", reason: "the contributor's reviews were erased at their request" });
    // The erasure earns no trust, so the later review is a first review for a person.
    expect(summary.decisions.find((d) => d.id === after.id)?.outcome).toBe("needs_review");
    await expect(readFile(join(data, reviewPath(PLACE)), "utf8")).rejects.toThrow();
  });
});
