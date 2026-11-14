import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyRules, REPORTS_TO_HIDE } from "../src/rules.js";
import { run } from "../src/run.js";
import { dumpPhotoLine, dumpPlace, placePath } from "../src/serialise.js";
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
const removal = (who: string, photo: string, placeId = PLACE): StoredFeedback =>
  ({ ...base(who, placeId), type: "photo_removal", photo_removal: { photo } }) as StoredFeedback;
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

function rules(
  pending: StoredFeedback[],
  opts: { photos?: Photo[]; history?: StoredFeedback[]; blocked?: string[]; recent?: ReadonlySet<string> | "unreadable"; holdFirstPhoto?: boolean } = {},
) {
  const out = applyRules({
    now: NOW,
    pending,
    history: opts.history ?? [],
    places: new Map([place(), place(OTHER)].map((p) => [p.id, p])),
    reviews: () => [],
    blocked: new Set(opts.blocked ?? []),
    photos: opts.photos ?? [],
    ...(opts.recent !== undefined ? { recent: opts.recent } : {}),
    ...(opts.holdFirstPhoto !== undefined ? { holdFirstPhoto: opts.holdFirstPhoto } : {}),
  });
  return { ...out, outcome: (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.outcome };
}

describe("photo rules", () => {
  const NEW = "ocdb_01JC0000000000000000000NEW";

  it("leaves a photo and a photo report for a new place on the recent list waiting", () => {
    const p = upload("kim", 1, NEW);
    const r = { ...report("sam", "pho_01JC0000000000000000000001"), place: NEW } as StoredFeedback;
    const out = rules([p, r], { recent: new Set([NEW]) });
    expect(out.outcome(p)).toBe("waiting");
    expect(out.outcome(r)).toBe("waiting");
    expect(out.edits).toEqual([]);
  });

  it("refuses a photo for a place on neither the data nor the recent list", () => {
    const p = upload("kim", 1, NEW);
    const out = rules([p], { recent: new Set([OTHER]) });
    expect(out.outcome(p)).toBe("refused");
  });

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

  it("writes the licence the photo service sets", () => {
    const p = upload("sam", 7);
    const out = applyRules({
      now: NOW,
      pending: [p],
      history: [],
      places: new Map([[PLACE, place()]]),
      reviews: () => [],
      blocked: new Set(),
      photos: [photoLine(1, "sam")],
      photoLicence: "CC-BY-SA-4.0",
    });
    expect(out.photos.get(PLACE)!.find((l) => l.id === p.id.replace("fb_", "pho_"))!.licence).toBe("CC-BY-SA-4.0");
  });

  it("publishes the photo's focus beside its size, and none when it has none", () => {
    const plain = upload("sam", 2) as StoredFeedback & { photo: object };
    const withFocus = { ...plain, photo: { ...plain.photo, focus: { y: 0.6, x: 0.25 } } } as StoredFeedback;
    const without = { ...upload("sam", 3), id: "fb_01JBXK3M8Q4R5S6T7V8W9X0Y03" } as StoredFeedback;
    const out = rules([withFocus, without], { photos: [photoLine(1, "sam")] });
    const line = (item: StoredFeedback) => out.photos.get(PLACE)!.find((l) => l.id === item.id.replace("fb_", "pho_"))!;
    expect(line(withFocus)).toMatchObject({ width: 1600, height: 1200, focus: { x: 0.25, y: 0.6 } });
    expect(dumpPhotoLine(line(withFocus))).toContain('"focus":{"x":0.25,"y":0.6}');
    expect(line(without)).not.toHaveProperty("focus");
  });

  it("publishes a photo from a contributor with a visible photo", () => {
    const p = upload("sam", 2);
    const out = rules([p], { photos: [photoLine(1, "sam")] });
    expect(out.outcome(p)).toBe("applied");
    expect(out.photos.get(PLACE)!.map((l) => l.id)).toEqual([photoLine(1, "sam").id, p.id.replace("fb_", "pho_")]);
  });

  it("holds a photo SafeSearch flags or couldn't check, even from a trusted contributor", () => {
    const calm = { adult: "VERY_UNLIKELY", violence: "VERY_UNLIKELY", racy: "UNLIKELY", medical: "VERY_UNLIKELY", spoof: "VERY_UNLIKELY" } as const;
    const rated = (n: number, safesearch: unknown) => {
      const item = upload("sam", n) as StoredFeedback & { photo: Record<string, unknown> };
      return { ...item, photo: { ...item.photo, safesearch } } as StoredFeedback;
    };
    for (const safesearch of [{ ...calm, adult: "LIKELY" }, { ...calm, racy: "VERY_LIKELY" }, "unchecked"]) {
      const p = rated(2, safesearch);
      expect(rules([p], { photos: [photoLine(1, "sam")] }).outcome(p)).toBe("needs_review");
    }
    const ok = rated(3, calm);
    expect(rules([ok], { photos: [photoLine(1, "sam")] }).outcome(ok)).toBe("applied");
  });

  it("keeps the held reason's code with the decision of each photo it holds", () => {
    const calm = { adult: "VERY_UNLIKELY", violence: "VERY_UNLIKELY", racy: "UNLIKELY", medical: "VERY_UNLIKELY", spoof: "VERY_UNLIKELY" } as const;
    const rated = (n: number, safesearch: unknown) => {
      const item = upload("sam", n) as StoredFeedback & { photo: Record<string, unknown> };
      return { ...item, photo: { ...item.photo, safesearch } } as StoredFeedback;
    };
    const first = upload("kim", 2);
    const flagged = rated(3, { ...calm, adult: "LIKELY" });
    const unchecked = rated(4, "unchecked");
    const copy = upload("sam", 5, OTHER);
    const trusted = upload("sam", 6);
    const out = rules([first, flagged, unchecked, copy, trusted], { photos: [photoLine(1, "sam"), photoLine(9, "sam", { sha256: sha(5) })] });
    const heldReason = (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.held_reason;
    expect([first, flagged, unchecked, copy, trusted].map(heldReason)).toEqual(["first_photo", "safesearch", "check_unavailable", "same_file", undefined]);
  });

  describe("with the first photo hold off", () => {
    const calm = { adult: "VERY_UNLIKELY", violence: "VERY_UNLIKELY", racy: "UNLIKELY", medical: "VERY_UNLIKELY", spoof: "VERY_UNLIKELY" } as const;
    const rated = (who: string, n: number, safesearch: unknown, placeId = PLACE) => {
      const item = upload(who, n, placeId) as StoredFeedback & { photo: Record<string, unknown> };
      return { ...item, photo: { ...item.photo, safesearch } } as StoredFeedback;
    };

    it("still holds a first photo by default, even when SafeSearch passed it", () => {
      const p = rated("kim", 2, calm);
      const out = rules([p]);
      expect(out.decisions.find((d) => d.id === p.id)).toMatchObject({ outcome: "needs_review", held_reason: "first_photo" });
    });

    it("publishes a first photo SafeSearch passed, like a trusted contributor's", () => {
      const p = rated("kim", 2, calm);
      const out = rules([p], { holdFirstPhoto: false });
      expect(out.outcome(p)).toBe("applied");
      expect(out.decisions.find((d) => d.id === p.id)?.held_reason).toBeUndefined();
      expect(out.photos.get(PLACE)!.map((l) => l.id)).toEqual([p.id.replace("fb_", "pho_")]);
      expect(out.changes.every((c) => c.automatic)).toBe(true);
    });

    it("still holds a first photo with no SafeSearch rating, so an unchecked photo never publishes", () => {
      const p = upload("kim", 2);
      const out = rules([p], { holdFirstPhoto: false });
      expect(out.decisions.find((d) => d.id === p.id)).toMatchObject({ outcome: "needs_review", held_reason: "first_photo" });
    });

    it("still holds a first photo SafeSearch flags, couldn't check, or that was sent for another place", () => {
      const flagged = rated("kim", 3, { ...calm, adult: "LIKELY" });
      const unchecked = rated("lee", 4, "unchecked");
      const copy = rated("max", 5, calm, OTHER);
      const out = rules([flagged, unchecked, copy], { holdFirstPhoto: false, photos: [photoLine(9, "sam", { sha256: sha(5) })] });
      const heldReason = (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.held_reason;
      expect([flagged, unchecked, copy].map(heldReason)).toEqual(["safesearch", "check_unavailable", "same_file"]);
    });
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

  it("counts photo reports from one network once, whatever contributor ids they carry", () => {
    const target = photoLine(1, "sam");
    const oneNetwork = ["a", "b", "c"].map((who) => ({ ...report(who, target.id), origin: "net-a" }) as StoredFeedback);
    expect(rules(oneNetwork, { photos: [target] }).photos.get(PLACE)?.[0]?.hidden).toBeUndefined();
  });

  it("puts a withheld report it cannot act on in front of a person, so the withhold can be released", () => {
    const target = photoLine(1, "sam");
    const misfiled = { ...report("a", target.id, "illegal"), place: OTHER, withheld: true } as StoredFeedback;
    const own = { ...report("sam", target.id, "illegal"), withheld: true } as StoredFeedback;
    const out = rules([misfiled, own], { photos: [target] });
    expect(out.outcome(misfiled)).toBe("needs_review");
    expect(out.outcome(own)).toBe("needs_review");
    expect(out.needsReview).toBe(true);
    expect(out.changes.filter((c) => /withheld key/.test(c.summary))).toHaveLength(2);
    expect(out.photos.get(PLACE)?.[0]?.hidden).toBeUndefined();
  });

  it("puts a withheld report from a blocked contributor in front of a person, so the withhold can be released", () => {
    const target = photoLine(1, "sam");
    const withheld = { ...report("bad", target.id, "illegal"), withheld: true } as StoredFeedback;
    const plain = report("bad", target.id, "offensive");
    const out = rules([withheld, plain], { photos: [target], blocked: [ctr("bad")] });
    expect(out.outcome(withheld)).toBe("needs_review");
    expect(out.outcome(plain)).toBe("refused");
    expect(out.decisions.find((d) => d.id === plain.id)?.reason).toBe("the contributor is blocked");
    expect(out.changes.filter((c) => !c.automatic && /withheld key/.test(c.summary)).map((c) => c.feedback)).toEqual([[withheld.id]]);
    expect(out.photos.get(PLACE)?.[0]?.hidden).toBeUndefined();
  });

  it("hides a photo at once only on a report from an attested install or the photo's own app", () => {
    const target = photoLine(1, "sam");
    const otherApp = { ...report("a", target.id, "illegal"), app: "example-app-dev", withheld: true } as StoredFeedback;
    const out = rules([otherApp], { photos: [target] });
    expect(out.outcome(otherApp)).toBe("needs_review");
    expect(out.photos.get(PLACE)?.[0]?.hidden).toBeUndefined();
    expect(out.changes.some((c) => !c.automatic && /URGENT/.test(c.summary) && /withheld key/.test(c.summary))).toBe(true);
    const attested = { ...otherApp, id: "fb_01JC9999999999999999999999", attested: "play_integrity" } as StoredFeedback;
    expect(rules([attested], { photos: [target] }).photos.get(PLACE)?.[0]?.hidden).toBe("reported");
    const sameAppWithheld = { ...report("b", target.id, "personal_details"), withheld: true } as StoredFeedback;
    const otherAppWithheld = { ...sameAppWithheld, id: "fb_01JC9999999999999999999998", app: "example-app-dev" } as StoredFeedback;
    expect(rules([sameAppWithheld], { photos: [target] }).photos.get(PLACE)?.[0]?.hidden).toBe("reported");
    const held = rules([otherAppWithheld], { photos: [target] });
    expect(held.outcome(otherAppWithheld)).toBe("needs_review");
    expect(held.photos.get(PLACE)?.[0]?.hidden).toBeUndefined();
  });

  it("hides a photo at once after one illegal-content report, and flags it urgent", () => {
    const target = photoLine(1, "sam");
    const one = report("a", target.id, "illegal");
    const out = rules([one], { photos: [target] });
    expect(out.outcome(one)).toBe("needs_review");
    expect(out.photos.get(PLACE)![0]!.hidden).toBe("reported");
    expect(out.needsReview).toBe(true);
  });

  it("hides a photo at once after one report the intake withheld, without calling it illegal", () => {
    const target = photoLine(1, "sam");
    const one = { ...report("a", target.id, "personal_details"), withheld: true } as StoredFeedback;
    const out = rules([one], { photos: [target] });
    expect(out.outcome(one)).toBe("needs_review");
    expect(out.photos.get(PLACE)![0]!.hidden).toBe("reported");
    expect(out.needsReview).toBe(true);
    expect(out.decisions.find((d) => d.id === one.id)?.reason).toBe("a personal_details report withholds the photo at once and is read by a person");
  });

  it("leaves a report the intake did not withhold to the reports threshold", () => {
    const target = photoLine(1, "sam");
    const one = report("a", target.id, "personal_details");
    expect(rules([one], { photos: [target] }).photos.get(PLACE)![0]!.hidden).toBeUndefined();
  });

  it("refuses a report of a photo not in the data, or of the reporter's own photo", () => {
    const own = report("sam", photoLine(1, "sam").id);
    const missing = report("kim", "pho_01JA0000000000000000000099");
    const out = rules([own, missing], { photos: [photoLine(1, "sam")] });
    expect(out.outcome(own)).toBe("refused");
    expect(out.outcome(missing)).toBe("refused");
  });

  it("honours a blocked contributor's removal and erasure", () => {
    const photos = [photoLine(1, "bad"), photoLine(2, "bad"), photoLine(3, "kim")];
    const r = removal("bad", photoLine(1, "bad").id);
    const removed = rules([r], { photos, blocked: [ctr("bad")] });
    expect(removed.outcome(r)).toBe("applied");
    expect(removed.removedPhotos.map((p) => p.photo)).toEqual([photoLine(1, "bad").id]);
    const e = erasure("bad");
    const erased = rules([e], { photos, blocked: [ctr("bad")] });
    expect(erased.outcome(e)).toBe("applied");
    expect(erased.photos.get(PLACE)!.map((p) => p.id)).toEqual([photoLine(3, "kim").id]);
    expect(erased.removedPhotos.map((p) => p.photo).sort()).toEqual([photoLine(1, "bad").id, photoLine(2, "bad").id].sort());
  });

  it("removes one published photo at its contributor's request, and leaves their others", () => {
    const mine = photoLine(1, "sam");
    const r = removal("sam", mine.id);
    const out = rules([r], { photos: [mine, photoLine(2, "sam"), photoLine(3, "kim")] });
    expect(out.outcome(r)).toBe("applied");
    expect(out.photos.get(PLACE)!.map((p) => p.id)).toEqual([photoLine(2, "sam").id, photoLine(3, "kim").id]);
    expect(out.removedPhotos.map((p) => [p.photo, p.reason])).toEqual([[mine.id, "removed"]]);
  });

  it("refuses a removal from anyone but the photo's contributor, or of a photo not at that place", () => {
    const theirs = photoLine(1, "kim");
    const other = removal("sam", theirs.id);
    const wrongPlace = removal("kim", theirs.id, OTHER);
    const missing = removal("sam", "pho_01JA0000000000000000000099");
    const out = rules([other, wrongPlace, missing], { photos: [theirs] });
    expect([other, wrongPlace, missing].map((i) => out.outcome(i))).toEqual(["refused", "refused", "refused"]);
    expect(out.decisions.find((d) => d.id === other.id)?.reason).toBe("only the photo's contributor can remove it");
    expect(out.photos.get(PLACE)?.map((p) => p.id) ?? [theirs.id]).toEqual([theirs.id]);
    expect(out.removedPhotos).toEqual([]);
  });

  it("removes a held photo from the review branch, and one sent in the same run", () => {
    const held = { ...upload("sam", 7), outcome: { result: "needs_review", reason: "", run: NOW } } as unknown as StoredFeedback;
    const fresh = upload("sam", 8);
    const r1 = removal("sam", held.id.replace("fb_", "pho_"));
    const r2 = removal("sam", fresh.id.replace("fb_", "pho_"));
    const out = rules([fresh, r1, r2], { history: [held] });
    expect([r1, r2].map((i) => out.outcome(i))).toEqual(["applied", "applied"]);
    expect(out.edits).toContainEqual({ kind: "photo_removal", place: PLACE, photo: held.id.replace("fb_", "pho_"), feedback: r1.id });
    expect(out.removedPhotos.map((p) => p.photo).sort()).toEqual([held.id.replace("fb_", "pho_"), fresh.id.replace("fb_", "pho_")].sort());
  });

  it("takes an operator's erasure the same as an install's, and one for a contributor with no photos", () => {
    const op = { ...erasure("sam"), device: "operator", app_version: "operator", operator: true, withheld: true } as StoredFeedback;
    const none = { ...erasure("lee"), operator: true } as StoredFeedback;
    const out = rules([op, none], { photos: [photoLine(1, "sam"), photoLine(2, "kim"), photoLine(3, "sam", { place: OTHER })] });
    expect([op, none].map((i) => out.outcome(i))).toEqual(["applied", "applied"]);
    expect(out.photos.get(PLACE)!.map((p) => p.id)).toEqual([photoLine(2, "kim").id]);
    expect(out.photos.get(OTHER)).toEqual([]);
    expect(out.removedPhotos.map((r) => r.photo)).toEqual([photoLine(1, "sam").id, photoLine(3, "sam").id]);
    expect(out.decisions.find((d) => d.id === none.id)?.reason).toBe("photos removed at the contributor's request, 0 published");
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
    root = await mkdtemp(join(tmpdir(), "photo-run-"));
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

  it("writes a first photo SafeSearch passed to the data when the run turns the first photo hold off", async () => {
    const calm = { adult: "VERY_UNLIKELY", violence: "VERY_UNLIKELY", racy: "UNLIKELY", medical: "VERY_UNLIKELY", spoof: "VERY_UNLIKELY" };
    const first = { ...upload("kim", 4), photo: { ...(upload("kim", 4) as unknown as { photo: object }).photo, safesearch: calm } } as unknown as StoredFeedback;
    await put(join(inbox, "pending", "2026-11-02", `${first.id}.json`), JSON.stringify(first));
    const summary = await run({ inbox, data, reviewData: review, now: new Date(NOW), holdFirstPhoto: false });
    expect(summary.auto_files).toEqual([`photos/${PLACE}.ndjson`]);
    expect(summary.review_files).toEqual([]);
    expect(summary.photo_decisions).toEqual([{ id: first.id, place: PLACE, outcome: "applied", reason: "photo accepted" }]);
  });

  it("leaves photos out of the decisions it lists for progress, as apps know a photo by its pho_ id", async () => {
    const photo = upload("kim", 4);
    const e = erasure("sam");
    for (const item of [photo, e]) await put(join(inbox, "pending", "2026-11-02", `${item.id}.json`), JSON.stringify(item));
    const summary = await run({ inbox, data, reviewData: review, now: new Date(NOW) });
    expect(summary.decisions.map((d) => d.id)).toEqual([e.id]);
    // Photo progress takes them from photo_decisions, with the held reason's code.
    expect(summary.photo_decisions).toEqual([{ id: photo.id, place: PLACE, outcome: "needs_review", reason: expect.any(String), held_reason: "first_photo" }]);
    // The inbox keeps the code with the outcome, for later runs.
    const moved = JSON.parse(await readFile(join(inbox, "applied", "2026-11-02", `${photo.id}.json`), "utf8")) as { outcome: Record<string, unknown> };
    expect(moved.outcome).toMatchObject({ result: "needs_review", held_reason: "first_photo" });
  });

  it("removes one photo at its contributor's request, from the data or the review checkout", async () => {
    await put(join(data, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine(photoLine(1, "sam"))}\n${dumpPhotoLine(photoLine(3, "sam"))}\n`);
    const held = { ...upload("sam", 7), outcome: { result: "needs_review", reason: "", run: NOW } } as unknown as StoredFeedback;
    const heldId = held.id.replace("fb_", "pho_");
    await put(join(review, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine({ ...photoLine(2, "sam"), id: heldId })}\n`);
    await put(join(inbox, "applied", "2026-11-01", `${held.id}.json`), JSON.stringify(held));
    const r1 = removal("sam", photoLine(1, "sam").id);
    const r2 = removal("sam", heldId);
    for (const item of [r1, r2]) await put(join(inbox, "pending", "2026-11-02", `${item.id}.json`), JSON.stringify(item));
    const summary = await run({ inbox, data, reviewData: review, now: new Date(NOW) });
    expect(summary.auto_files.sort()).toEqual(["moderation/removed_photos.json", `photos/${PLACE}.ndjson`]);
    expect(summary.review_files).toEqual([`photos/${PLACE}.ndjson`]);
    const auto = (await readFile(join(data, "photos", `${PLACE}.ndjson`), "utf8")).trim().split("\n");
    expect(auto.map((l) => JSON.parse(l).id)).toEqual([photoLine(3, "sam").id]);
    // The place has no held photos left, so its review file goes.
    await expect(readFile(join(review, "photos", `${PLACE}.ndjson`), "utf8")).rejects.toThrow();
    const removed = JSON.parse(await readFile(join(data, "moderation", "removed_photos.json"), "utf8")) as { photos: { photo: string; reason: string }[] };
    expect(removed.photos.map((p) => [p.photo, p.reason]).sort()).toEqual([[heldId, "removed"], [photoLine(1, "sam").id, "removed"]].sort());
  });

  it("removes a photo at its contributor's request after its place was merged, sent with either id", async () => {
    const OLD = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZC";
    for (const tree of [data, review]) await put(join(tree, placePath(OLD)), dumpPlace({ ...place(OLD), status: "merged", merged_into: PLACE }));
    const a = { ...photoLine(1, "sam"), place: OLD };
    const b = { ...photoLine(2, "sam"), place: OLD };
    const c = { ...photoLine(3, "kim"), place: OLD };
    await put(join(data, "photos", `${OLD}.ndjson`), [a, b, c].map((l) => `${dumpPhotoLine(l)}\n`).join(""));
    const byOld = removal("sam", a.id, OLD);
    const byKept = removal("sam", b.id, PLACE);
    const notMine = removal("sam", c.id, PLACE);
    for (const item of [byOld, byKept, notMine]) await put(join(inbox, "pending", "2026-11-02", `${item.id}.json`), JSON.stringify(item));
    const summary = await run({ inbox, data, reviewData: review, now: new Date(NOW) });
    const outcome = (item: StoredFeedback) => summary.decisions.find((d) => d.id === item.id)?.outcome;
    expect([byOld, byKept, notMine].map(outcome)).toEqual(["applied", "applied", "refused"]);
    const left = (await readFile(join(data, "photos", `${OLD}.ndjson`), "utf8")).trim().split("\n");
    expect(left.map((l) => JSON.parse(l).id)).toEqual([c.id]);
    const removed = JSON.parse(await readFile(join(data, "moderation", "removed_photos.json"), "utf8")) as { photos: { photo: string }[] };
    expect(removed.photos.map((p) => p.photo).sort()).toEqual([a.id, b.id].sort());
  });

  it("removes a held photo whose place was merged from the review checkout", async () => {
    const OLD = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZC";
    for (const tree of [data, review]) await put(join(tree, placePath(OLD)), dumpPlace({ ...place(OLD), status: "merged", merged_into: PLACE }));
    const held = { ...upload("sam", 7, OLD), outcome: { result: "needs_review", reason: "", run: NOW } } as unknown as StoredFeedback;
    const heldId = held.id.replace("fb_", "pho_");
    await put(join(inbox, "applied", "2026-11-01", `${held.id}.json`), JSON.stringify(held));
    await put(join(review, "photos", `${OLD}.ndjson`), `${dumpPhotoLine({ ...photoLine(2, "sam"), id: heldId, place: OLD })}\n`);
    const r = removal("sam", heldId, PLACE);
    await put(join(inbox, "pending", "2026-11-02", `${r.id}.json`), JSON.stringify(r));
    const summary = await run({ inbox, data, reviewData: review, now: new Date(NOW) });
    expect(summary.decisions.find((d) => d.id === r.id)?.outcome).toBe("applied");
    await expect(readFile(join(review, "photos", `${OLD}.ndjson`), "utf8")).rejects.toThrow();
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

  describe("with the intake's recent list", () => {
    const NEW = "ocdb_01JC0000000000000000000NEW";
    let photosRepo: string;
    let ocdb: string;

    beforeEach(async () => {
      photosRepo = join(root, "app-photos");
      ocdb = join(root, "ocdb-data");
      await put(join(ocdb, "places", "za", `${PLACE}.json`), dumpPlace(place()));
      await put(join(photosRepo, "moderation", "blocked_contributors.json"), '{"contributors":[]}\n');
    });

    async function send(...items: StoredFeedback[]) {
      for (const item of items) await put(join(inbox, "pending", "2026-11-02", `${item.id}.json`), JSON.stringify(item));
    }
    const isPending = (item: StoredFeedback) =>
      readFile(join(inbox, "pending", "2026-11-02", `${item.id}.json`), "utf8").then(
        () => true,
        () => false,
      );

    it("keeps a photo of a new place on the list in pending/", async () => {
      const p = upload("kim", 8, NEW);
      await send(p);
      const summary = await run({ inbox, data: photosRepo, places: ocdb, now: new Date(NOW), recentList: { ids: async () => new Set([NEW]) } });
      expect(summary.counts).toMatchObject({ waiting: 1, refused: 0 });
      expect(await isPending(p)).toBe(true);
      expect(summary.photo_decisions).toEqual([{ id: p.id, place: NEW, outcome: "waiting", reason: expect.stringContaining("new place not in the data yet") }]);
    });

    const removedIds = async () =>
      ((JSON.parse(await readFile(join(photosRepo, "moderation", "removed_photos.json"), "utf8").catch(() => '{"photos":[]}')) as { photos: { photo: string }[] }).photos.map(
        (p) => p.photo,
      ));

    it("refuses a waiting photo sent before its contributor's erasure in the same run, and lists its files for removal", async () => {
      const p = { ...upload("sam", 8, NEW), received: "2026-11-02T09:00:00Z" } as StoredFeedback;
      const e = erasure("sam");
      await send(p, e);
      const summary = await run({ inbox, data: photosRepo, places: ocdb, now: new Date(NOW), recentList: { ids: async () => new Set([NEW]) } });
      expect(summary.photo_decisions.find((d) => d.id === p.id)).toMatchObject({ outcome: "refused", reason: "the contributor asked for their photos to be removed" });
      expect(await isPending(p)).toBe(false);
      expect(await removedIds()).toContain(p.id.replace("fb_", "pho_"));
    });

    it("refuses a waiting photo sent before an erasure an earlier run applied, even from a trusted contributor", async () => {
      const earlier = applied({ ...upload("sam", 6), received: "2026-10-20T09:00:00Z" } as StoredFeedback);
      await put(join(inbox, "applied", "2026-10-20", `${earlier.id}.json`), JSON.stringify(earlier));
      const e = applied(erasure("sam"));
      await put(join(inbox, "applied", "2026-11-02", `${e.id}.json`), JSON.stringify(e));
      const p = { ...upload("sam", 8, NEW), received: "2026-11-02T09:00:00Z" } as StoredFeedback;
      await send(p);
      const summary = await run({ inbox, data: photosRepo, places: ocdb, now: new Date(NOW), recentList: { ids: async () => new Set([NEW]) } });
      expect(summary.photo_decisions.find((d) => d.id === p.id)).toMatchObject({ outcome: "refused" });
      expect(await removedIds()).toContain(p.id.replace("fb_", "pho_"));
      // A photo sent after the erasure is decided as usual.
      const later = { ...upload("sam", 9, NEW), received: "2026-11-02T11:00:00Z" } as StoredFeedback;
      await send(later);
      const next = await run({ inbox, data: photosRepo, places: ocdb, now: new Date(NOW), recentList: { ids: async () => new Set([NEW]) } });
      expect(next.photo_decisions.find((d) => d.id === later.id)?.outcome).toBe("waiting");
    });

    it("refuses a photo of a place on neither the data nor the list", async () => {
      const p = upload("kim", 8, NEW);
      await send(p);
      const summary = await run({ inbox, data: photosRepo, places: ocdb, now: new Date(NOW), recentList: { ids: async () => new Set([OTHER]) } });
      expect(summary.counts).toMatchObject({ waiting: 0, refused: 1 });
      expect(await isPending(p)).toBe(false);
    });

    it("keeps the photo in pending/ when the list cannot be read", async () => {
      const p = upload("kim", 8, NEW);
      await send(p);
      const ids = async (): Promise<ReadonlySet<string>> => {
        throw new Error("the intake is down");
      };
      const summary = await run({ inbox, data: photosRepo, places: ocdb, now: new Date(NOW), recentList: { ids } });
      expect(summary.counts).toMatchObject({ waiting: 1, refused: 0 });
      expect(await isPending(p)).toBe(true);
    });

    it("does not ask for the list when every place is in the data", async () => {
      const ids = vi.fn(async () => new Set<string>());
      await send(upload("kim", 8));
      await run({ inbox, data: photosRepo, places: ocdb, now: new Date(NOW), recentList: { ids } });
      expect(ids).not.toHaveBeenCalled();
    });

    it("refuses the photo as before without the list", async () => {
      const p = upload("kim", 8, NEW);
      await send(p);
      const summary = await run({ inbox, data: photosRepo, places: ocdb, now: new Date(NOW) });
      expect(summary.counts).toMatchObject({ waiting: 0, refused: 1 });
    });
  });

  it("runs an app's own photo repository: places from a separate checkout, everything else refused", async () => {
    // The photo repository holds no places. Open Camping DB's data does.
    const photosRepo = join(root, "app-photos");
    const ocdb = join(root, "ocdb-data");
    await put(join(ocdb, "places", "za", `${PLACE}.json`), dumpPlace(place()));
    await put(join(photosRepo, "moderation", "blocked_contributors.json"), '{"contributors":[]}\n');
    const held = upload("kim", 6);
    const review = { ...base("kim"), type: "review", review: { stars: 4, text: "Good camp.", visited: "2026-10" } } as StoredFeedback;
    for (const item of [held, review]) await put(join(inbox, "pending", "2026-11-02", `${item.id}.json`), JSON.stringify(item));
    const summary = await run({ inbox, data: photosRepo, places: ocdb, now: new Date(NOW) });
    expect(summary.counts).toMatchObject({ needs_review: 1, refused: 1, applied: 0 });
    const lines = (await readFile(join(photosRepo, "photos", `${PLACE}.ndjson`), "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([held.id.replace("fb_", "pho_")]);
    const refused = JSON.parse(await readFile(join(inbox, "refused", "2026-11-02", `${review.id}.json`), "utf8"));
    expect(refused.outcome).toMatchObject({ result: "refused", reason: "this repository takes photos only" });
    await expect(readFile(join(photosRepo, "places", "za", `${PLACE}.json`), "utf8")).rejects.toThrow();
  });
});
