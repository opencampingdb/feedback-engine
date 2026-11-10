import { describe, expect, it } from "vitest";
import { createFeedbackClient, createPhotoClient, validateSubmission, type FetchLike, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return { getItem: async (k) => data.get(k) ?? null, setItem: async (k, v) => void data.set(k, v), removeItem: async (k) => void data.delete(k) };
}

function setup() {
  const posts: { url: string; body: string }[] = [];
  const fetch: FetchLike = async (url, init) => {
    posts.push({ url, body: init.body });
    return { status: 202, json: async () => ({ id: "fb_1" }), headers: { get: () => null } };
  };
  const client = createFeedbackClient({ endpoint: "https://intake.example/", appKey: "key-1", appVersion: "1.2.3", storage: memoryStorage(), fetch });
  return { client, posts };
}

describe("review erasure", () => {
  it("validates: a contributor, no place and no location; a proof is allowed", () => {
    expect(validateSubmission({ ...base, contributor: CONTRIBUTOR, type: "review_erasure", place: null })).toMatchObject({ ok: true });
    expect(validateSubmission({ ...base, contributor: CONTRIBUTOR, type: "review_erasure", place: null, contributor_proof: "abc.def" })).toMatchObject({
      ok: true,
      value: { contributor_proof: "abc.def" },
    });
    expect((validateSubmission({ ...base, type: "review_erasure", place: PLACE, location: { lat: -36, lon: 144 } }) as { errors: string[] }).errors).toEqual([
      "contributor is required for a review_erasure",
      "place must be null for a review_erasure",
      "location is not allowed on a review_erasure",
    ]);
  });

  it("sends an erasure through the feedback client's queue, with the proof when given", async () => {
    const { client, posts } = setup();
    expect(await client.eraseReviews({ contributor: CONTRIBUTOR, consent: true })).toMatchObject({ status: "sent" });
    await client.eraseReviews({ contributor: CONTRIBUTOR, contributorProof: "abc.def", consent: true });
    expect(posts[0]!.url).toBe("https://intake.example/v1/feedback");
    expect(JSON.parse(posts[0]!.body)).toEqual({ ...base, app_version: "1.2.3", device: expect.any(String), type: "review_erasure", place: null, contributor: CONTRIBUTOR });
    expect(JSON.parse(posts[1]!.body)).toMatchObject({ type: "review_erasure", contributor_proof: "abc.def" });
  });

  it("is not on the photo client", () => {
    const photos = createPhotoClient({ endpoint: "https://photos.example/", appKey: "key-1", appVersion: "1", storage: memoryStorage() });
    expect("eraseReviews" in photos).toBe(false);
  });
});
