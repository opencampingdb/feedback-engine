import { describe, expect, it } from "vitest";
import { createPhotoClient, FeedbackValidationError, OwnerRequestError, validateSubmission, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const PHOTO = "pho_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const TOKEN = "A".repeat(43);
const NOW = new Date("2026-11-15T03:00:00Z");
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true, type: "photo_hero", place: PLACE, token: TOKEN };
const errorsOf = (input: unknown) => (validateSubmission(input, NOW) as { errors?: string[] }).errors ?? [];

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

describe("photo hero validation", () => {
  it("takes a traveller photo, a Commons file or none, with the owner's token", () => {
    for (const photo_hero of [{ photo: PHOTO }, { commons: "Lake Eppalock camp 2019.jpg" }, { none: true }]) {
      expect(validateSubmission({ ...base, photo_hero }, NOW)).toMatchObject({ ok: true, value: { type: "photo_hero", place: PLACE, token: TOKEN, photo_hero } });
    }
  });

  it("needs a place, the token and exactly one choice", () => {
    expect(errorsOf({ ...base, photo_hero: { photo: PHOTO }, token: "short" })).toEqual(["token must be the 43 character token from the claim"]);
    expect(errorsOf({ ...base, photo_hero: { photo: PHOTO }, place: null })).toContain("place is required for a photo_hero");
    expect(errorsOf({ ...base, photo_hero: {} })).toEqual(["photo_hero needs one of photo, commons or none"]);
    expect(errorsOf({ ...base, photo_hero: { photo: PHOTO, none: true } })).toEqual(["photo_hero takes one of photo, commons or none"]);
    expect(errorsOf({ ...base, photo_hero: { none: false } })).toEqual(["photo_hero.none must be true"]);
    expect(errorsOf({ ...base, photo_hero: { photo: "rev_01JBXK3M8Q4R5S6T7V8W9X0YZA" } })).toEqual(["photo_hero.photo must be a photo id (pho_<ulid>)"]);
    expect(errorsOf({ ...base, photo_hero: { commons: "File:Lake.jpg" } })).toEqual(["photo_hero.commons must be a Commons file name, without File:"]);
    expect(errorsOf({ ...base, photo_hero: { photo: PHOTO, size: 2 } })).toEqual(["unknown field photo_hero.size"]);
    expect(errorsOf({ ...base, type: "photo_vote", photo_vote: { photo: PHOTO, vote: "helpful" }, contributor: "acct_3f9a8b7c6d5e4f30" })).toContain("token is not allowed when type is photo_vote");
  });
});

describe("setHeroPhoto", () => {
  function setup(status = 202, answer: Record<string, unknown> = { id: "fb_01JBXK3M8Q4R5S6T7V8W9X0YZA" }) {
    const posts: { url: string; body: string }[] = [];
    const client = createPhotoClient({
      endpoint: "https://photos-intake.example/",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: memoryStorage(),
      now: () => NOW.getTime(),
      fetch: async (url, init) => {
        posts.push({ url, body: init.body as string });
        return { status, json: async () => answer, headers: { get: () => null } };
      },
    });
    return { client, posts };
  }

  it("sends the owner's choice at once, never queued", async () => {
    const t = setup();
    expect(await t.client.setHeroPhoto(TOKEN, { place: PLACE, commons: "Lake Eppalock camp 2019.jpg", consent: true })).toEqual({ id: "fb_01JBXK3M8Q4R5S6T7V8W9X0YZA" });
    await t.client.setHeroPhoto(TOKEN, { place: PLACE, none: true, consent: true });
    expect(t.posts.map((p) => JSON.parse(p.body))).toEqual([
      expect.objectContaining({ type: "photo_hero", place: PLACE, token: TOKEN, photo_hero: { commons: "Lake Eppalock camp 2019.jpg" }, app_version: "1.2.3", consent: true }),
      expect.objectContaining({ type: "photo_hero", photo_hero: { none: true } }),
    ]);
    expect(await t.client.pending()).toBe(0);
  });

  it("throws the intake's refusal, and a bad choice before sending", async () => {
    const t = setup(403, { error: "not_owner" });
    await expect(t.client.setHeroPhoto(TOKEN, { place: PLACE, photo: PHOTO, consent: true })).rejects.toMatchObject({ httpStatus: 403 });
    await expect(t.client.setHeroPhoto(TOKEN, { place: PLACE, photo: PHOTO, consent: true })).rejects.toBeInstanceOf(OwnerRequestError);
    const u = setup();
    // @ts-expect-error A choice needs one of photo, commons or none.
    await expect(u.client.setHeroPhoto(TOKEN, { place: PLACE, consent: true })).rejects.toBeInstanceOf(FeedbackValidationError);
    // @ts-expect-error Only one of them.
    await expect(u.client.setHeroPhoto(TOKEN, { place: PLACE, photo: PHOTO, none: true, consent: true })).rejects.toBeInstanceOf(FeedbackValidationError);
    expect(u.posts).toHaveLength(0);
  });
});
