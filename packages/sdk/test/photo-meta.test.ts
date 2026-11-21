import { describe, expect, it } from "vitest";
import {
  createPhotoClient,
  FeedbackValidationError,
  MAX_PHOTO_CAPTION_LENGTH,
  photoTakenMonth,
  tidyCaption,
  validateSubmission,
  type StorageAdapter,
} from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const NEW_PLACE = "ocdb_01M6R45Y75GTXQBS5ETC16CYSZ";
const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const NOW = new Date("2026-11-15T03:00:00Z");
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true, contributor: CONTRIBUTOR, type: "photo", place: PLACE };
const files = { full_sha256: "a".repeat(64), full_bytes: 400_000, thumb_sha256: "b".repeat(64), thumb_bytes: 40_000 };
const errorsOf = (input: unknown) => (validateSubmission(input, NOW) as { errors?: string[] }).errors ?? [];

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

const jpeg = (size: number, fill = 1) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};

const decodeMeta = (header: string) =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));

describe("photo caption and taken validation", () => {
  it("accepts a caption and a taken month, and keeps them", () => {
    const r = validateSubmission({ ...base, photo: { ...files, caption: "Sunset over the lake", taken: "2026-10" } }, NOW);
    expect(r).toMatchObject({ ok: true, value: { photo: { caption: "Sunset over the lake", taken: "2026-10" } } });
  });

  it("leaves both out when the photo has neither", () => {
    const r = validateSubmission({ ...base, photo: files }, NOW) as { value: { photo: object } };
    expect(r.value.photo).not.toHaveProperty("caption");
    expect(r.value.photo).not.toHaveProperty("taken");
  });

  it("refuses a caption that is too long, empty, not a string or on more than one line", () => {
    expect(errorsOf({ ...base, photo: { ...files, caption: "a".repeat(MAX_PHOTO_CAPTION_LENGTH) } })).toEqual([]);
    expect(errorsOf({ ...base, photo: { ...files, caption: "a".repeat(MAX_PHOTO_CAPTION_LENGTH + 1) } })).toEqual(["photo.caption must be at most 200 characters"]);
    expect(errorsOf({ ...base, photo: { ...files, caption: "  " } })).toEqual(["photo.caption must not be empty"]);
    expect(errorsOf({ ...base, photo: { ...files, caption: 7 } })).toEqual(["photo.caption must be a string"]);
    expect(errorsOf({ ...base, photo: { ...files, caption: "one\ntwo" } })).toContain("photo.caption must be one line");
  });

  it("refuses a taken month that is malformed, in the future or before 1990", () => {
    for (const taken of ["2026-1", "2026-13", "26-10", "2026-10-03", 202610]) expect(errorsOf({ ...base, photo: { ...files, taken } })).toEqual(["photo.taken must be YYYY-MM"]);
    expect(errorsOf({ ...base, photo: { ...files, taken: "2026-12" } })).toEqual(["photo.taken must not be in the future"]);
    expect(errorsOf({ ...base, photo: { ...files, taken: "1989-12" } })).toEqual(["photo.taken must not be before 1990-01"]);
    expect(errorsOf({ ...base, photo: { ...files, taken: "2026-11" } })).toEqual([]);
  });

  it("takes next month once it has started somewhere (UTC+14)", () => {
    const lateOnTheLastDay = new Date("2026-11-30T11:00:00Z");
    expect((validateSubmission({ ...base, photo: { ...files, taken: "2026-12" } }, lateOnTheLastDay) as { ok: boolean }).ok).toBe(true);
  });
});

describe("photoTakenMonth", () => {
  it("reads Exif text, an ISO date and a Date", () => {
    expect(photoTakenMonth("2026:11:03 14:22:01", NOW)).toBe("2026-11");
    expect(photoTakenMonth("2025-07-21T08:00:00+10:00", NOW)).toBe("2025-07");
    expect(photoTakenMonth(new Date("2024-02-10T00:00:00Z"), NOW)).toBe("2024-02");
  });

  it("gives undefined for a missing, unreadable, future or too early date", () => {
    for (const value of [undefined, null, "", "yesterday", "0000:00:00 00:00:00", "2027:01:01 00:00:00", "1980:05:01 10:00:00", new Date(Number.NaN)]) {
      expect(photoTakenMonth(value, NOW)).toBeUndefined();
    }
  });
});

describe("tidyCaption", () => {
  it("puts a caption on one line and tidies it as a review is tidied", () => {
    expect(tidyCaption("  Great   spot\nby the river!!!  ")).toBe("Great spot by the river!");
    expect(tidyCaption(" \n ")).toBe("");
  });
});

describe("photo client caption and taken", () => {
  function setup(storage: StorageAdapter = memoryStorage(), resolve: () => { status: "waiting" } | { status: "sent"; place: string } = () => ({ status: "waiting" })) {
    const metas: { photo: Record<string, unknown> }[] = [];
    const posts: { body: string }[] = [];
    const client = createPhotoClient({
      endpoint: "https://intake.example/",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage,
      now: () => NOW.getTime(),
      fetch: async (_url, init) => {
        posts.push({ body: init.body as string });
        return { status: 202, json: async () => ({ id: "fb_01JBXK3M8Q4R5S6T7V8W9X0YZA" }), headers: { get: () => null } };
      },
      fetchPhoto: async (_url, init) => {
        metas.push(decodeMeta(init.headers["x-photo-meta"]!));
        return { status: 202, json: async () => ({ id: `pho_01JBXK3M8Q4R5S6T7V8W9X0YZ${metas.length}` }), headers: { get: () => null } };
      },
      resolveNewPlace: async () => resolve(),
      loadPhoto: async () => ({ full: jpeg(20), thumb: jpeg(10) }),
    });
    return { client, metas, posts };
  }

  it("sends the caption tidied onto one line, and the taken month", async () => {
    const t = setup();
    await t.client.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: jpeg(100), thumb: jpeg(50), caption: " Morning\n mist ", taken: "2026-10" });
    expect(t.metas[0]!.photo).toMatchObject({ caption: "Morning mist", taken: "2026-10" });
  });

  it("leaves out a caption with nothing left after tidying", async () => {
    const t = setup();
    await t.client.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: jpeg(100), thumb: jpeg(50), caption: "   " });
    expect(t.metas[0]!.photo).not.toHaveProperty("caption");
  });

  it("refuses a future taken month or an over-long caption, before sending or keeping anything", async () => {
    const t = setup();
    const photo = { contributor: CONTRIBUTOR, consent: true, full: jpeg(100), thumb: jpeg(50) };
    for (const extra of [{ taken: "2027-01" }, { caption: "ab ".repeat(70) }]) {
      await expect(t.client.photo({ ...photo, place: PLACE, ...extra })).rejects.toThrow(FeedbackValidationError);
      await expect(t.client.photo({ ...photo, place: { newPlace: "np-1" }, key: "a", ...extra })).rejects.toThrow(FeedbackValidationError);
    }
    expect(t.metas).toHaveLength(0);
  });

  it("keeps a waiting photo's caption and taken month until the new place has its id", async () => {
    const storage = memoryStorage();
    let status: { status: "waiting" } | { status: "sent"; place: string } = { status: "waiting" };
    const first = setup(storage, () => status);
    await first.client.photo({ place: { newPlace: "np-1" }, key: "a", contributor: CONTRIBUTOR, consent: true, full: jpeg(20), thumb: jpeg(10), caption: "Shady site", taken: "2026-09" });
    status = { status: "sent", place: NEW_PLACE };
    const second = setup(storage, () => status);
    await second.client.flush();
    expect(second.metas[0]!.photo).toMatchObject({ caption: "Shady site", taken: "2026-09" });
  });

  it("sends votes on a photo and on a Commons file through the queue", async () => {
    const t = setup();
    await t.client.votePhoto({ place: PLACE, photo: PHOTO, vote: "helpful", contributor: CONTRIBUTOR, consent: true });
    await t.client.votePhoto({ place: PLACE, photo: PHOTO, vote: "none", contributor: CONTRIBUTOR, consent: true, ref: "v2" });
    await t.client.votePhoto({ place: PLACE, commons: "Lake Eppalock camp 2019.jpg", vote: "not_helpful", contributor: CONTRIBUTOR, consent: true });
    expect(t.posts.map((p) => JSON.parse(p.body))).toEqual([
      expect.objectContaining({ type: "photo_vote", place: PLACE, contributor: CONTRIBUTOR, photo_vote: { photo: PHOTO, vote: "helpful" } }),
      expect.objectContaining({ type: "photo_vote", place: PLACE, contributor: CONTRIBUTOR, photo_vote: { photo: PHOTO, vote: "none" } }),
      expect.objectContaining({ type: "photo_vote", place: PLACE, contributor: CONTRIBUTOR, photo_vote: { commons: "Lake Eppalock camp 2019.jpg", vote: "not_helpful" } }),
    ]);
  });

  it("refuses a vote with two targets, or with both vote and helpful, at compile time and before sending", async () => {
    const t = setup();
    // @ts-expect-error One target: photo or commons.
    await expect(t.client.votePhoto({ place: PLACE, photo: PHOTO, commons: "Lake.jpg", vote: "helpful", contributor: CONTRIBUTOR, consent: true })).rejects.toThrow(FeedbackValidationError);
    // @ts-expect-error vote or helpful, not both.
    await expect(t.client.votePhoto({ place: PLACE, photo: PHOTO, vote: "helpful", helpful: true, contributor: CONTRIBUTOR, consent: true })).rejects.toThrow(FeedbackValidationError);
    // @ts-expect-error A target is needed.
    await expect(t.client.votePhoto({ place: PLACE, vote: "helpful", contributor: CONTRIBUTOR, consent: true })).rejects.toThrow(FeedbackValidationError);
    expect(t.posts).toEqual([]);
  });

  it("still takes an older helpful true or false from the app", async () => {
    const t = setup();
    await t.client.votePhoto({ place: PLACE, photo: PHOTO, helpful: false, contributor: CONTRIBUTOR, consent: true });
    expect(JSON.parse(t.posts[0]!.body).photo_vote).toEqual({ photo: PHOTO, vote: "none" });
  });
});

describe("photo vote validation", () => {
  const vote = { ...base, type: "photo_vote", photo_vote: { photo: PHOTO, vote: "helpful" } };
  const COMMONS = "Lake Eppalock camp 2019.jpg";
  it("accepts helpful, not helpful and none on a traveller photo or a Commons file", () => {
    for (const value of ["helpful", "not_helpful", "none"]) {
      expect(validateSubmission({ ...vote, photo_vote: { photo: PHOTO, vote: value } }, NOW)).toMatchObject({ ok: true, value: { type: "photo_vote", photo_vote: { photo: PHOTO, vote: value } } });
      expect(validateSubmission({ ...vote, photo_vote: { commons: COMMONS, vote: value } }, NOW)).toMatchObject({ ok: true, value: { photo_vote: { commons: COMMONS, vote: value } } });
    }
  });

  it("reads an older SDK's helpful true or false as helpful or none", () => {
    const older = (helpful: boolean) => (validateSubmission({ ...vote, photo_vote: { photo: PHOTO, helpful } }, NOW) as { value: { photo_vote: object } }).value.photo_vote;
    expect(older(true)).toEqual({ photo: PHOTO, vote: "helpful" });
    expect(older(false)).toEqual({ photo: PHOTO, vote: "none" });
  });

  it("needs a contributor, one photo id or Commons file name, one vote and nothing else", () => {
    const { contributor: _c, ...anonymous } = vote;
    expect(errorsOf(anonymous)).toEqual(["contributor is required for a photo_vote"]);
    expect(errorsOf({ ...vote, photo_vote: { photo: "rev_01JBXK3M8Q4R5S6T7V8W9X0YZA", vote: "helpful" } })).toEqual(["photo_vote.photo must be a photo id (pho_<ulid>)"]);
    expect(errorsOf({ ...vote, photo_vote: { commons: "File:Lake.jpg", vote: "helpful" } })).toEqual(["photo_vote.commons must be a Commons file name, without File:"]);
    expect(errorsOf({ ...vote, photo_vote: { vote: "helpful" } })).toEqual(["photo_vote needs photo or commons"]);
    expect(errorsOf({ ...vote, photo_vote: { photo: PHOTO, commons: COMMONS, vote: "helpful" } })).toEqual(["photo_vote takes photo or commons, not both"]);
    expect(errorsOf({ ...vote, photo_vote: { photo: PHOTO, vote: "great" } })).toEqual(["photo_vote.vote must be helpful, not_helpful or none"]);
    expect(errorsOf({ ...vote, photo_vote: { photo: PHOTO } })).toEqual(["photo_vote.vote must be helpful, not_helpful or none"]);
    expect(errorsOf({ ...vote, photo_vote: { photo: PHOTO, helpful: "yes" } })).toEqual(["photo_vote.helpful must be true or false"]);
    expect(errorsOf({ ...vote, photo_vote: { photo: PHOTO, vote: "helpful", helpful: true } })).toEqual(["photo_vote takes vote or helpful, not both"]);
    expect(errorsOf({ ...vote, photo_vote: { photo: PHOTO, vote: "helpful", stars: 5 } })).toEqual(["unknown field photo_vote.stars"]);
    expect(errorsOf({ ...vote, place: null })).toContain("place is required for a photo_vote");
    expect(errorsOf({ ...vote, photo_report: { photo: PHOTO, reason: "offensive" } })).toContain("photo_report is not allowed when type is photo_vote");
  });
});
