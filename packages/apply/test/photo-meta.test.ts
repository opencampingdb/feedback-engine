import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { PHOTO_VOTES_FILE } from "../src/io.js";
import { applyRules } from "../src/rules.js";
import { run } from "../src/run.js";
import { dumpPhotoLine, dumpPlace } from "../src/serialise.js";
import type { Photo, PhotoVotes, Place } from "../src/types.js";

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
const fbId = () => `fb_01JD${String(++seq).padStart(22, "0")}`;
const base = (who: string, placeId: string | null = PLACE, received = "2026-11-02T10:00:00Z") => ({
  id: fbId(),
  received,
  app: "example-app",
  place: placeId,
  device: `dev-${who}`,
  contributor: ctr(who),
  app_version: "1.0.0",
  consent: true as const,
});
const sha = (n: number) => String(n).repeat(64).slice(0, 64);
const upload = (who: string, n: number, photo: Record<string, unknown>): StoredFeedback =>
  ({
    ...base(who),
    type: "photo",
    photo: { full_sha256: sha(n), full_bytes: 400_000, thumb_sha256: "f".repeat(64), thumb_bytes: 40_000, width: 1600, height: 1200, ...photo },
  }) as StoredFeedback;
/** A vote as the intake stores it now, or with true or false, as an older intake stored it. */
const vote = (who: string, photo: string, value: "helpful" | "not_helpful" | "none" | boolean = "helpful", extra: Record<string, unknown> = {}): StoredFeedback =>
  ({ ...base(who), type: "photo_vote", photo_vote: typeof value === "boolean" ? { photo, helpful: value } : { photo, vote: value }, ...extra }) as StoredFeedback;
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
const PHOTO = photoLine(1, "sam").id;

function rules(pending: StoredFeedback[], opts: { photos?: Photo[]; votes?: PhotoVotes; blocked?: string[]; now?: string } = {}) {
  const out = applyRules({
    now: opts.now ?? NOW,
    pending,
    history: [],
    places: new Map([place(), place(OTHER)].map((p) => [p.id, p])),
    reviews: () => [],
    blocked: new Set(opts.blocked ?? []),
    photos: opts.photos ?? [photoLine(1, "sam")],
    ...(opts.votes ? { photoVotes: opts.votes } : {}),
  });
  const decision = (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id);
  const line = (id = PHOTO) => [...out.photos.values()].flat().find((p) => p.id === id);
  return { ...out, outcome: (item: StoredFeedback) => decision(item)?.outcome, reason: (item: StoredFeedback) => decision(item)?.reason, line };
}

describe("photo caption and taken month", () => {
  it("publishes a tidied caption and the taken month", () => {
    const p = upload("sam", 2, { caption: "Sunset   over the LAKE!!!", taken: "2026-10" });
    const out = rules([p]);
    expect(out.outcome(p)).toBe("applied");
    const line = out.line(p.id.replace("fb_", "pho_"))!;
    expect(line).toMatchObject({ caption: "Sunset over the lake!", taken: "2026-10" });
    expect(dumpPhotoLine(line)).toContain('"caption":"Sunset over the lake!"');
  });

  it("leaves out a caption that fails the text checks, and publishes the photo without it", () => {
    for (const [caption, problem] of [
      ["Call 0412 345 678 for a spot", "contact"],
      ["Great views, use promo code CAMP10", "spam"],
    ] as const) {
      const p = upload("sam", 3, { caption, taken: "2026-09" });
      const out = rules([p]);
      expect(out.outcome(p)).toBe("applied");
      expect(out.reason(p)).toBe(`photo accepted, caption left out (${problem})`);
      const line = out.line(p.id.replace("fb_", "pho_"))!;
      expect(line).not.toHaveProperty("caption");
      expect(line.taken).toBe("2026-09");
    }
  });

  it("keeps a held photo's caption on the review edit, and says when one was left out", () => {
    const kept = upload("kim", 4, { caption: "Shady site" });
    const dropped = upload("lee", 5, { caption: "Ring 0412 345 678" });
    const out = rules([kept, dropped]);
    expect(out.outcome(kept)).toBe("needs_review");
    const edit = (item: StoredFeedback) => out.edits.find((e) => e.feedback === item.id) as { photo: Photo };
    expect(edit(kept).photo.caption).toBe("Shady site");
    expect(edit(dropped).photo).not.toHaveProperty("caption");
    expect(out.reason(dropped)).toContain("caption left out (contact)");
  });

  it("leaves both out of a line when the photo had neither", () => {
    const p = upload("sam", 6, {});
    const line = rules([p]).line(p.id.replace("fb_", "pho_"))!;
    expect(line).not.toHaveProperty("caption");
    expect(line).not.toHaveProperty("taken");
  });
});

describe("photo votes", () => {
  it("counts helpful and not helpful votes apart, and none as nothing", () => {
    const a = vote("kim", PHOTO, "helpful");
    const b = vote("lee", PHOTO, "not_helpful");
    const c = vote("amy", PHOTO, "not_helpful");
    const d = vote("joe", PHOTO, "none");
    const out = rules([a, b, c, d]);
    expect(out.reason(b)).toBe("photo marked not helpful");
    expect(out.reason(d)).toBe("no vote to take back");
    expect(out.line()).toMatchObject({ helpful: 1, helpful_12m: 1, not_helpful: 2, not_helpful_12m: 2 });
    expect(out.photoVotes.photos[PHOTO]!.map((v) => v.vote)).toEqual(["helpful", "not_helpful", "not_helpful", "none"]);
    expect(out.changes).toContainEqual(
      expect.objectContaining({ summary: `photo ${PHOTO} marked helpful by 1 (1 in the last 12 months), not helpful by 2 (2 in the last 12 months)` }),
    );
  });

  it("replaces a helpful vote with a not helpful one from the same traveller", () => {
    const votes: PhotoVotes = { photos: { [PHOTO]: [{ feedback: "fb_01JC0000000000000000000001", at: "2026-10-01T00:00:00Z", vote: "helpful", contributor: ctr("kim"), device: "dev-kim" }] } };
    const change = vote("kim", PHOTO, "not_helpful");
    const out = rules([change], { photos: [photoLine(1, "sam", { helpful: 1, helpful_12m: 1 })], votes });
    expect(out.reason(change)).toBe("photo marked not helpful");
    expect(out.line()).not.toHaveProperty("helpful");
    expect(out.line()).toMatchObject({ not_helpful: 1, not_helpful_12m: 1 });
  });

  it("takes back a not helpful vote, and removes its counts at 0", () => {
    const votes: PhotoVotes = { photos: { [PHOTO]: [{ feedback: "fb_01JC0000000000000000000001", at: "2026-10-01T00:00:00Z", vote: "not_helpful", contributor: ctr("kim"), device: "dev-kim" }] } };
    const back = vote("kim", PHOTO, "none");
    const out = rules([back], { photos: [photoLine(1, "sam", { not_helpful: 1, not_helpful_12m: 1 })], votes });
    expect(out.reason(back)).toBe("vote taken back");
    expect(out.line()).not.toHaveProperty("not_helpful");
    expect(out.line()).not.toHaveProperty("not_helpful_12m");
    expect(out.photoVotes.photos[PHOTO]).toEqual([expect.objectContaining({ feedback: back.id, vote: "none" })]);
  });

  it("reads older kept votes, helpful true or left out as helpful and false as none", () => {
    const votes: PhotoVotes = {
      photos: {
        [PHOTO]: [
          { feedback: "fb_01JC0000000000000000000001", at: "2026-10-01T00:00:00Z", contributor: ctr("kim"), device: "dev-kim" },
          { feedback: "fb_01JC0000000000000000000002", at: "2026-10-01T00:00:00Z", helpful: true, contributor: ctr("lee"), device: "dev-lee" },
          { feedback: "fb_01JC0000000000000000000003", at: "2026-10-01T00:00:00Z", helpful: false, contributor: ctr("amy"), device: "dev-amy" },
        ],
      },
    };
    const out = rules([vote("joe", PHOTO, "not_helpful")], { votes });
    expect(out.line()).toMatchObject({ helpful: 2, helpful_12m: 2, not_helpful: 1, not_helpful_12m: 1 });
  });
});

describe("helpful votes", () => {
  it("counts one vote per traveller and publishes the count and the last 12 months' count", () => {
    const a = vote("kim", PHOTO);
    const b = vote("lee", PHOTO);
    const out = rules([a, b]);
    expect(out.outcome(a)).toBe("applied");
    expect(out.reason(a)).toBe("photo marked helpful");
    expect(out.line()).toMatchObject({ helpful: 2, helpful_12m: 2 });
    expect(out.photoVotes.photos[PHOTO]!.map((v) => v.contributor)).toEqual([ctr("kim"), ctr("lee")]);
    expect(out.changes).toContainEqual(expect.objectContaining({ place: PLACE, automatic: true, summary: `photo ${PHOTO} marked helpful by 2 (2 in the last 12 months)` }));
  });

  it("counts a second vote from the same traveller, install or attested key once", () => {
    const first = vote("kim", PHOTO, true, { attest_key: "ak_one" });
    const sameDevice = { ...vote("other", PHOTO), device: "dev-kim" } as StoredFeedback;
    const sameKey = vote("third", PHOTO, true, { attest_key: "ak_one" });
    const again = vote("kim", PHOTO);
    for (const second of [sameDevice, sameKey, again]) {
      const out = rules([first, second]);
      expect(out.line()!.helpful).toBe(1);
      expect(out.photoVotes.photos[PHOTO]!.map((v) => v.feedback)).toEqual([second.id]);
    }
  });

  it("takes a vote back, and removes the count when none are left", () => {
    const votes: PhotoVotes = { photos: { [PHOTO]: [{ feedback: "fb_01JC0000000000000000000001", at: "2026-10-01T00:00:00Z", contributor: ctr("kim"), device: "dev-kim" }] } };
    const back = vote("kim", PHOTO, false);
    const out = rules([back], { photos: [photoLine(1, "sam", { helpful: 1, helpful_12m: 1 })], votes });
    expect(out.reason(back)).toBe("vote taken back");
    expect(out.line()).not.toHaveProperty("helpful");
    expect(out.line()).not.toHaveProperty("helpful_12m");
    expect(out.photoVotes.photos[PHOTO]).toEqual([expect.objectContaining({ feedback: back.id, vote: "none" })]);
  });

  it("applies a take-back with no vote to take back, and changes nothing", () => {
    const back = vote("kim", PHOTO, false);
    const out = rules([back]);
    expect(out.reason(back)).toBe("no vote to take back");
    expect(out.photos.get(PLACE)?.find((p) => p.id === PHOTO)).not.toHaveProperty("helpful");
  });

  it("refuses a vote for the voter's own photo, a photo not in the data, and one with no contributor", () => {
    const own = vote("sam", PHOTO);
    const missing = vote("kim", photoLine(9, "sam").id);
    const elsewhere = { ...vote("kim", PHOTO), place: OTHER } as StoredFeedback;
    const { contributor: _c, ...anonymous } = vote("lee", PHOTO) as StoredFeedback & { contributor: string };
    const out = rules([own, missing, elsewhere, anonymous as StoredFeedback]);
    expect(out.reason(own)).toBe("a contributor cannot vote for their own photo");
    expect(out.reason(missing)).toBe(`photo ${photoLine(9, "sam").id} is not in the data for this place`);
    expect(out.reason(elsewhere)).toBe(`photo ${PHOTO} is not in the data for this place`);
    expect(out.reason(anonymous as StoredFeedback)).toBe("photo vote has no contributor");
    expect(out.photoVotes.photos).toEqual({});
  });

  it("stops counting votes from a blocked contributor, and refuses their new ones", () => {
    const votes: PhotoVotes = {
      photos: {
        [PHOTO]: [
          { feedback: "fb_01JC0000000000000000000001", at: "2026-10-01T00:00:00Z", contributor: ctr("kim"), device: "dev-kim" },
          { feedback: "fb_01JC0000000000000000000002", at: "2026-10-01T00:00:00Z", contributor: ctr("bad"), device: "dev-bad" },
        ],
      },
    };
    const again = vote("bad", PHOTO);
    const out = rules([again], { photos: [photoLine(1, "sam", { helpful: 2, helpful_12m: 2 })], votes, blocked: [ctr("bad")] });
    expect(out.reason(again)).toBe("the contributor is blocked");
    expect(out.line()).toMatchObject({ helpful: 1, helpful_12m: 1 });
  });

  it("drops an erased contributor's votes, and the votes for a photo removed in the run", () => {
    const votes: PhotoVotes = {
      photos: {
        [PHOTO]: [{ feedback: "fb_01JC0000000000000000000001", at: "2026-10-01T00:00:00Z", contributor: ctr("kim"), device: "dev-kim" }],
        [photoLine(2, "lee").id]: [{ feedback: "fb_01JC0000000000000000000002", at: "2026-10-01T00:00:00Z", contributor: ctr("amy"), device: "dev-amy" }],
      },
    };
    const erase = { ...base("kim", null), type: "photo_erasure" } as StoredFeedback;
    const remove = { ...base("lee"), type: "photo_removal", photo_removal: { photo: photoLine(2, "lee").id } } as StoredFeedback;
    const out = rules([erase, remove], { photos: [photoLine(1, "sam", { helpful: 1, helpful_12m: 1 }), photoLine(2, "lee", { helpful: 1, helpful_12m: 1 })], votes });
    expect(out.photoVotes.photos).toEqual({});
    expect(out.line()).not.toHaveProperty("helpful");
  });

  it("ignores an older vote run again after a newer take-back from the same traveller", () => {
    const back = vote("kim", PHOTO, false);
    const votes: PhotoVotes = { photos: { [PHOTO]: [{ feedback: back.id, at: "2026-11-02T10:00:00Z", helpful: false, contributor: ctr("kim"), device: "dev-kim" }] } };
    const older = { ...vote("kim", PHOTO), received: "2026-11-02T09:00:00Z" } as StoredFeedback;
    const out = rules([older], { votes });
    expect(out.reason(older)).toBe("a later vote from the same traveller already counts");
    expect(out.photoVotes.photos[PHOTO]).toEqual(votes.photos[PHOTO]);
    expect(out.line()).not.toHaveProperty("helpful");
  });

  it("counts a vote for a photo filed under a place since merged into another", () => {
    const merged = { ...place(OTHER), status: "merged", merged_into: PLACE } as Place;
    const filed = photoLine(3, "sam", { place: OTHER });
    const v = vote("kim", filed.id);
    const out = applyRules({
      now: NOW,
      pending: [v],
      history: [],
      places: new Map([[PLACE, place()], [OTHER, merged]]),
      reviews: () => [],
      blocked: new Set(),
      photos: [filed],
    });
    expect(out.decisions[0]!.reason).toBe("photo marked helpful");
    expect(out.photos.get(OTHER)!.find((p) => p.id === filed.id)!.helpful).toBe(1);
  });

  it("counts a vote for a photo published earlier in the same run", () => {
    const p = upload("sam", 7, {});
    const v = { ...vote("kim", p.id.replace("fb_", "pho_")), received: "2026-11-02T11:00:00Z" } as StoredFeedback;
    const out = rules([p, v]);
    expect(out.reason(v)).toBe("photo marked helpful");
    expect(out.line(p.id.replace("fb_", "pho_"))!.helpful).toBe(1);
    expect(Object.keys(out.photoVotes.photos)).toEqual([p.id.replace("fb_", "pho_")]);
  });

  it("counts votes older than 12 months in the total only, recounting as they age with no new vote", () => {
    const votes: PhotoVotes = {
      photos: {
        [PHOTO]: [
          { feedback: "fb_01JC0000000000000000000001", at: "2025-10-01T00:00:00Z", contributor: ctr("kim"), device: "dev-kim" },
          { feedback: "fb_01JC0000000000000000000002", at: "2026-10-01T00:00:00Z", contributor: ctr("lee"), device: "dev-lee" },
        ],
      },
    };
    const out = rules([], { photos: [photoLine(1, "sam", { helpful: 2, helpful_12m: 2 })], votes });
    expect(out.line()).toMatchObject({ helpful: 2, helpful_12m: 1 });
    expect(out.changes).toContainEqual(expect.objectContaining({ summary: `photo ${PHOTO} marked helpful by 2 (1 in the last 12 months)`, feedback: [] }));
  });

  it("leaves a photo's line alone when its counts are already right", () => {
    const votes: PhotoVotes = { photos: { [PHOTO]: [{ feedback: "fb_01JC0000000000000000000001", at: "2026-10-01T00:00:00Z", contributor: ctr("kim"), device: "dev-kim" }] } };
    const out = rules([], { photos: [photoLine(1, "sam", { helpful: 1, helpful_12m: 1 })], votes });
    expect(out.photos.size).toBe(0);
    expect(out.changes).toEqual([]);
  });
});

describe("helpful votes in a run", () => {
  let root: string;
  let inbox: string;
  let data: string;

  async function put(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "photo-votes-"));
    inbox = join(root, "inbox");
    data = join(root, "data");
    await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace(place()));
    await put(join(data, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine(photoLine(1, "sam"))}\n`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the votes in the inbox, writes the count to the photo line and records the inbox as changed", async () => {
    const v = vote("kim", PHOTO);
    await put(join(inbox, "pending", "2026-11-02", `${v.id}.json`), JSON.stringify(v));
    const summary = await run({ inbox, data, now: new Date(NOW) });
    expect(summary.inbox_changed).toBe(true);
    expect(summary.auto_files).toEqual([`photos/${PLACE}.ndjson`]);
    const line = JSON.parse((await readFile(join(data, "photos", `${PLACE}.ndjson`), "utf8")).trim()) as Photo;
    expect(line).toMatchObject({ helpful: 1, helpful_12m: 1 });
    const kept = JSON.parse(await readFile(join(inbox, PHOTO_VOTES_FILE), "utf8")) as PhotoVotes;
    expect(kept.photos[PHOTO]).toEqual([{ feedback: v.id, at: v.received, vote: "helpful", contributor: ctr("kim"), device: "dev-kim" }]);
  });

  it("stops on a votes file that is not JSON, and skips malformed entries in one that is", async () => {
    await put(join(inbox, PHOTO_VOTES_FILE), "{ not json");
    await expect(run({ inbox, data, now: new Date(NOW) })).rejects.toThrow(/votes\/photos.json in the inbox is not valid JSON/);
    const good = { feedback: "fb_01JC0000000000000000000001", at: "2026-10-01T00:00:00Z", contributor: ctr("kim"), device: "dev-kim" };
    await put(join(inbox, PHOTO_VOTES_FILE), JSON.stringify({ photos: { [PHOTO]: [good, { feedback: 3 }], pho_01JA0000000000000000000009: null } }));
    await run({ inbox, data, now: new Date(NOW) });
    const line = JSON.parse((await readFile(join(data, "photos", `${PLACE}.ndjson`), "utf8")).trim()) as Photo;
    expect(line.helpful).toBe(1);
  });

  it("recounts aged votes on a run with nothing pending", async () => {
    await put(join(data, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine(photoLine(1, "sam", { helpful: 1, helpful_12m: 1 }))}\n`);
    const votes: PhotoVotes = { photos: { [PHOTO]: [{ feedback: "fb_01JC0000000000000000000001", at: "2025-11-01T00:00:00Z", contributor: ctr("kim"), device: "dev-kim" }] } };
    await put(join(inbox, PHOTO_VOTES_FILE), `${JSON.stringify(votes, null, 2)}\n`);
    const summary = await run({ inbox, data, now: new Date(NOW) });
    expect(summary.auto_files).toEqual([`photos/${PLACE}.ndjson`]);
    expect(summary.inbox_changed).toBe(false);
    const line = JSON.parse((await readFile(join(data, "photos", `${PLACE}.ndjson`), "utf8")).trim()) as Photo;
    expect(line.helpful).toBe(1);
    expect(line).not.toHaveProperty("helpful_12m");
  });
});
