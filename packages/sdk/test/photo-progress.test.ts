import { describe, expect, it } from "vitest";
import { createPhotoClient, PHOTO_HELD_REASONS, ProgressRequestError, type FetchLike, type Progress, type StorageAdapter } from "../src/index.js";

const storage: StorageAdapter = { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
const phoId = (n: number) => `pho_01JC${String(n).padStart(22, "0")}`;
const PLACE = "ocdb_01JB0000000000000000000001";

type Reply = "network" | { status: number; body?: unknown } | ((ids: string[]) => { status: number; body?: unknown });

/** The photo intake's GET /v1/photos/progress. */
function client(replies: Reply[]) {
  const calls: { url: string; method: string; body: unknown; ids: string[] }[] = [];
  let n = 0;
  const fetch: FetchLike = async (url, init) => {
    const ids = new URL(url).searchParams.get("ids")?.split(",") ?? [];
    calls.push({ url, method: init.method, body: init.body, ids });
    const reply = replies[Math.min(n++, replies.length - 1)]!;
    if (reply === "network") throw new TypeError("Network request failed");
    const { status, body } = typeof reply === "function" ? reply(ids) : reply;
    return { status, json: async () => body, headers: { get: () => null } };
  };
  const photos = createPhotoClient({ endpoint: "https://photos-upload.example/", appKey: "photo-key-1", appVersion: "1.0.0", storage, fetch });
  return { photos, calls };
}

describe("photos.progress", () => {
  it("lists the photo held reasons", () => {
    expect(PHOTO_HELD_REASONS).toEqual(["first_photo", "same_file", "safesearch", "check_unavailable", "reported"]);
  });

  it("asks the photo intake's public GET and answers each photo's state, as feedback progress does", async () => {
    const items: Progress[] = [
      { id: phoId(1), state: "received", place: PLACE, received: "2026-11-01T00:00:00Z" },
      { id: phoId(2), state: "held", held_reason: "first_photo", reason: "first photo from this contributor, so a person checks it", place: PLACE, received: "2026-11-01T00:00:00Z", decided_at: "2026-11-01T01:00:00Z" },
      { id: phoId(3), state: "refused", by: "reviewer", reason: "removed by a reviewer", place: PLACE, received: "2026-11-01T00:00:00Z" },
      { id: phoId(4), state: "in_data", place: PLACE, received: "2026-11-01T00:00:00Z", decided_at: "2026-11-01T01:00:00Z", in_data_at: "2026-11-01T02:00:00Z" },
      { id: phoId(5), state: "unknown" },
    ];
    const { photos, calls } = client([{ status: 200, body: { items } }]);
    expect(await photos.progress(items.map((i) => i.id))).toEqual(items);
    expect(calls).toEqual([{ url: `https://photos-upload.example/v1/photos/progress?ids=${items.map((i) => i.id).join(",")}`, method: "GET", body: undefined, ids: items.map((i) => i.id) }]);
  });

  it("keeps a photo held reason, and drops one it does not know", async () => {
    const { photos } = client([
      { status: 200, body: { items: [{ id: phoId(1), state: "held", held_reason: "reported" }, { id: phoId(2), state: "held", held_reason: "new_reason" }] } },
    ]);
    expect(await photos.progress([phoId(1), phoId(2)])).toEqual([
      { id: phoId(1), state: "held", held_reason: "reported" },
      { id: phoId(2), state: "held" },
    ]);
  });

  it("asks in calls of 100 ids, keeping the order given and asking each id once", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => phoId(201 - i));
    const { photos, calls } = client([(asked) => ({ status: 200, body: { items: [...asked].reverse().map((id) => ({ id, state: "in_data", in_data_at: "2026-11-01T02:00:00Z" })) } })]);
    const answer = await photos.progress([...ids, ids[0]!]);
    expect(calls.map((c) => c.ids.length)).toEqual([100, 100, 1]);
    expect(answer.map((p) => p.id)).toEqual([...ids, ids[0]!]);
    expect(answer.every((p) => p.state === "in_data")).toBe(true);
  });

  it("answers unknown without asking for an id that is not a photo id, and for one the intake leaves out", async () => {
    const { photos, calls } = client([{ status: 200, body: { items: [] } }]);
    expect(await photos.progress(["fb_01JC0000000000000000000001", "x"])).toEqual([
      { id: "fb_01JC0000000000000000000001", state: "unknown" },
      { id: "x", state: "unknown" },
    ]);
    expect(calls).toHaveLength(0);
    expect(await photos.progress([phoId(1)])).toEqual([{ id: phoId(1), state: "unknown" }]);
  });

  it("throws ProgressRequestError when the intake can't be reached or refuses the call", async () => {
    await expect(client(["network"]).photos.progress([phoId(1)])).rejects.toMatchObject({ name: "ProgressRequestError", httpStatus: 0 });
    const refused = client([{ status: 404, body: { error: "not_found" } }]).photos.progress([phoId(1)]);
    await expect(refused).rejects.toBeInstanceOf(ProgressRequestError);
    await expect(refused).rejects.toMatchObject({ httpStatus: 404 });
  });
});
