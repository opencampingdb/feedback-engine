import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyRules, REPORTS_TO_HIDE } from "../src/rules.js";
import { run } from "../src/run.js";
import { dumpPhotoLine, dumpPlace } from "../src/serialise.js";
import type { Photo, Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const NOW = "2026-11-03T00:00:00Z";

const place = (id = PLACE): Place => ({
  id,
  name: "Lake Eppalock Camp",
  kind: "free_camp",
  group: "overnight",
  location: { lat: -36.85, lon: 144.55 },
  osm: { type: "node", id: 123456, version: 7 },
  facts: {},
  status: "open",
  rating: null,
  fact_sources: {},
  updated: "2026-06-01T00:00:00Z",
});

const ctr = (name: string) => `ctr_${Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16)}`;
let seq = 0;
const fbId = () => `fb_01JC${String(++seq).padStart(22, "0")}`;
const base = (who: string, placeId: string | null = PLACE) => ({
  id: fbId(),
  received: "2026-11-02T10:00:00Z",
  app: "example-app",
  place: placeId,
  device: who,
  contributor: ctr(who),
  app_version: "1.0.0",
  consent: true as const,
});
const sha = (n: number) => String(n).repeat(64).slice(0, 64);
const upload = (who: string, n = 1, placeId = PLACE): StoredFeedback =>
  ({
    ...base(who, placeId),
    type: "photo",
    photo: { full_sha256: sha(n), full_bytes: 400_000, thumb_sha256: "f".repeat(64), thumb_bytes: 40_000, width: 1600, height: 1200 },
  }) as StoredFeedback;
const report = (who: string, photo: string, reason = "offensive"): StoredFeedback =>
  ({ ...base(who), type: "photo_report", photo_report: { photo, reason } }) as StoredFeedback;
const erasure = (who: string): StoredFeedback => ({ ...base(who, null), type: "photo_erasure" }) as StoredFeedback;
const photoLine = (n: number, who: string, extra: Partial<Photo> = {}): Photo => ({
  id: `pho_01JA00000000000000000000${String(n).padStart(2, "0")}`,
  place: PLACE,
  contributor: ctr(who),
  created: "2026-10-01T00:00:00Z",
  app: "example-app",
  licence: "CC-BY-4.0",
  width: 1600,
  height: 1200,
  sha256: sha(n + 5),
  ...extra,
});
const applied = (item: StoredFeedback) => ({ ...item, outcome: { result: "applied", reason: "", run: NOW } }) as unknown as StoredFeedback;

function rules(pending: StoredFeedback[], opts: { photos?: Photo[]; history?: StoredFeedback[]; blocked?: string[] } = {}) {
  const out = applyRules({
    now: NOW,
    pending,
    history: opts.history ?? [],
    places: new Map([place(), place(OTHER)].map((p) => [p.id, p])),
    reviews: () => [],
    blocked: new Set(opts.blocked ?? []),
    photos: opts.photos ?? [],
  });
  return { ...out, outcome: (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.outcome };
}

describe("photo rules", () => {
  it("holds a first photo from a contributor for a person", () => {
    const p = upload("kim");
    const out = rules([p]);
    expect(out.outcome(p)).toBe("needs_review");
    expect(out.edits).toEqual([
      {
        kind: "photo",
        place: PLACE,
        feedback: p.id,
        photo: {
          id: p.id.replace("fb_", "pho_"),
          place: PLACE,
          contributor: ctr("kim"),
          created: p.received,
          app: "example-app",
          licence: "CC-BY-4.0",
          width: 1600,
          height: 1200,
          sha256: sha(1),
        },
      },
    ]);
    expect(out.photos.get(PLACE) ?? []).toEqual([]);
  });

  it("publishes a photo from a contributor with a visible photo", () => {
    const p = upload("sam", 2);
    const out = rules([p], { photos: [photoLine(1, "sam")] });
    expect(out.outcome(p)).toBe("applied");
    expect(out.photos.get(PLACE)!.map((l) => l.id)).toEqual([photoLine(1, "sam").id, p.id.replace("fb_", "pho_")]);
  });

  it("holds a file already sent for another place, even from a trusted contributor", () => {
    const p = upload("sam", 3, OTHER);
    const out = rules([p], { photos: [photoLine(1, "sam", { sha256: sha(3) })] });
    expect(out.outcome(p)).toBe("needs_review");
    expect(out.changes[0]!.summary).toContain("the same file was sent for another place");
  });

  it("refuses a blocked contributor's photo and deletes its files", () => {
    const p = upload("bad");
    const out = rules([p], { blocked: [ctr("bad")] });
    expect(out.outcome(p)).toBe("refused");
    expect(out.removedPhotos).toEqual([{ photo: p.id.replace("fb_", "pho_"), removed: NOW, reason: "refused" }]);
  });

  it("hides a photo after reports from three contributors", () => {
    const target = photoLine(1, "sam");
    const reports = ["a", "b", "c"].map((who) => report(who, target.id));
    expect(REPORTS_TO_HIDE).toBe(3);
    const out = rules(reports, { photos: [target] });
    expect(reports.map((r) => out.outcome(r))).toEqual(["needs_review", "needs_review", "needs_review"]);
    expect(out.photos.get(PLACE)![0]!.hidden).toBe("reported");
    expect(rules(reports.slice(0, 2), { photos: [target] }).photos.get(PLACE)![0]!.hidden).toBeUndefined();
  });

  it("hides a photo at once after one illegal-content report, and flags it urgent", () => {
    const target = photoLine(1, "sam");
    const one = report("a", target.id, "illegal");
    const out = rules([one], { photos: [target] });
    expect(out.outcome(one)).toBe("needs_review");
    expect(out.photos.get(PLACE)![0]!.hidden).toBe("reported");
    expect(out.needsReview).toBe(true);
  });

  it("refuses a report of a photo not in the data, or of the reporter's own photo", () => {
    const own = report("sam", photoLine(1, "sam").id);
    const missing = report("kim", "pho_01JA0000000000000000000099");
    const out = rules([own, missing], { photos: [photoLine(1, "sam")] });
    expect(out.outcome(own)).toBe("refused");
    expect(out.outcome(missing)).toBe("refused");
  });

  it("erases every photo from a contributor, and refuses their uploads in the same run", () => {
    const sent = applied(upload("sam", 7));
    const late = upload("sam", 8);
    const e = erasure("sam");
    const out = rules([e, late], { photos: [photoLine(1, "sam"), photoLine(2, "kim"), photoLine(3, "sam", { place: OTHER })], history: [sent] });
    expect(out.outcome(e)).toBe("applied");
    expect(out.outcome(late)).toBe("refused");
    expect(out.photos.get(PLACE)!.map((p) => p.id)).toEqual([photoLine(2, "kim").id]);
    expect(out.photos.get(OTHER)).toEqual([]);
    expect(out.removedPhotos.map((r) => [r.photo, r.reason])).toEqual([
      [photoLine(1, "sam").id, "erased"],
      [photoLine(3, "sam").id, "erased"],
      [sent.id.replace("fb_", "pho_"), "erased"],
      [late.id.replace("fb_", "pho_"), "refused"],
    ]);
    expect(out.edits).toContainEqual({ kind: "photo_erasure", contributor: ctr("sam"), feedback: e.id });
  });
});

describe("photo run", () => {
  let root: string;
  let inbox: string;
  let data: string;
  let review: string;

  async function put(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ocdb-photos-"));
    inbox = join(root, "inbox");
    data = join(root, "data");
    review = join(root, "review");
    for (const tree of [data, review]) await put(join(tree, "places", "za", `${PLACE}.json`), dumpPlace(place()));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a held photo to the review checkout and a trusted one to the data", async () => {
    await put(join(data, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine(photoLine(1, "sam"))}\n`);
    const held = upload("kim", 4);
    const trusted = upload("sam", 5);
    for (const item of [held, trusted]) await put(join(inbox, "pending", "2026-11-02", `${item.id}.json`), JSON.stringify(item));
    const summary = await run({ inbox, data, reviewData: review, now: new Date(NOW) });
    expect(summary.auto_files).toEqual([`photos/${PLACE}.ndjson`]);
    expect(summary.review_files).toEqual([`photos/${PLACE}.ndjson`]);
    const auto = (await readFile(join(data, "photos", `${PLACE}.ndjson`), "utf8")).trim().split("\n");
    expect(auto.map((l) => JSON.parse(l).id)).toEqual([photoLine(1, "sam").id, trusted.id.replace("fb_", "pho_")]);
    const reviewLines = (await readFile(join(review, "photos", `${PLACE}.ndjson`), "utf8")).trim().split("\n");
    expect(reviewLines.map((l) => JSON.parse(l).id)).toEqual([held.id.replace("fb_", "pho_")]);
  });

  it("removes an erased contributor's photos and lists them in removed_photos.json", async () => {
    await put(join(data, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine(photoLine(1, "sam"))}\n`);
    await put(join(review, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine(photoLine(2, "sam"))}\n`);
    const e = erasure("sam");
    await put(join(inbox, "pending", "2026-11-02", `${e.id}.json`), JSON.stringify(e));
    const summary = await run({ inbox, data, reviewData: review, now: new Date(NOW) });
    expect(summary.auto_files.sort()).toEqual(["moderation/removed_photos.json", `photos/${PLACE}.ndjson`]);
    expect(summary.review_files).toEqual([`photos/${PLACE}.ndjson`]);
    expect(await readFile(join(data, "moderation", "removed_photos.json"), "utf8")).toBe(
      `${JSON.stringify({ photos: [{ photo: photoLine(1, "sam").id, reason: "erased", removed: NOW }] }, null, 2)}\n`,
    );
  });
});
