import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPhotos, KEPT, photoStates, planSync, recordFiles } from "../src/photorepo.js";

const A = "pho_01JA0000000000000000000001";
const B = "pho_01JA0000000000000000000002";
const C = "pho_01JA0000000000000000000003";
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const BUCKETS = { serving: "app-photos", pending: "app-photos-pending" };

const photo = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  place: PLACE,
  contributor: "ctr_0123456789abcdef",
  created: "2026-11-02T10:00:00Z",
  app: "example-app",
  licence: "CC-BY-4.0",
  width: 1600,
  height: 1200,
  sha256: "a".repeat(64),
  ...extra,
});
const keys = (ids: string[], prefix = "") => new Set(ids.flatMap((id) => [`${prefix}${id}/full.jpg`, `${prefix}${id}/thumb.jpg`]));

describe("planSync", () => {
  it("publishes visible photos from the pending bucket", () => {
    const todo = planSync({ visible: new Set([A]), other: new Set(), removed: new Set(), serving: new Set(), pending: keys([A]) }, BUCKETS);
    expect(todo.copies).toEqual([
      ["app-photos-pending", `${A}/full.jpg`, "app-photos", `${A}/full.jpg`],
      ["app-photos-pending", `${A}/thumb.jpg`, "app-photos", `${A}/thumb.jpg`],
    ]);
    expect(todo.deletes).toEqual({});
    expect(todo.missing).toEqual([]);
  });

  it("keeps a copy when it hides a photo, and uses that copy to show it again", () => {
    const hide = planSync({ visible: new Set(), other: new Set([A]), removed: new Set(), serving: keys([A]), pending: new Set() }, BUCKETS);
    expect(hide.copies).toEqual([
      ["app-photos", `${A}/full.jpg`, "app-photos-pending", `${KEPT}${A}/full.jpg`],
      ["app-photos", `${A}/thumb.jpg`, "app-photos-pending", `${KEPT}${A}/thumb.jpg`],
    ]);
    expect(hide.deletes["app-photos"]?.sort()).toEqual([...keys([A])].sort());
    const show = planSync({ visible: new Set([A]), other: new Set(), removed: new Set(), serving: new Set(), pending: keys([A], KEPT) }, BUCKETS);
    expect(show.copies.map((c) => c[1])).toEqual([`${KEPT}${A}/full.jpg`, `${KEPT}${A}/thumb.jpg`]);
  });

  it("deletes removed photos from both buckets and never publishes them", () => {
    const todo = planSync(
      { visible: new Set([A]), other: new Set(), removed: new Set([A, B]), serving: keys([B]), pending: new Set([...keys([A]), ...keys([B], KEPT)]) },
      BUCKETS,
    );
    expect(todo.copies).toEqual([]);
    expect(todo.deletes["app-photos"]?.sort()).toEqual([...keys([B])].sort());
    expect(todo.deletes["app-photos-pending"]?.sort()).toEqual([...keys([A]), ...keys([B], KEPT)].sort());
  });

  it("reports a visible photo without files", () => {
    expect(planSync({ visible: new Set([C]), other: new Set(), removed: new Set(), serving: new Set(), pending: new Set() }, BUCKETS).missing).toEqual([
      `${C}/full.jpg`,
      `${C}/thumb.jpg`,
    ]);
  });

  it("leaves records files alone", () => {
    const todo = planSync({ visible: new Set(), other: new Set(), removed: new Set(), serving: new Set([`records/${PLACE}.ndjson`]), pending: new Set() }, BUCKETS);
    expect(todo).toEqual({ copies: [], deletes: {}, missing: [] });
  });
});

describe("a photo repository on disk", () => {
  let root: string;
  const put = async (path: string, text: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const lines = (...photos: object[]) => photos.map((p) => `${JSON.stringify(p)}\n`).join("");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "photo-repo-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("counts hidden photos and blocked contributors' photos as not visible, and writes records of visible ones only", async () => {
    await put(`photos/${PLACE}.ndjson`, lines(photo(A), photo(B, { contributor: "ctr_ffffffffffffffff" }), photo(C, { hidden: "reported" })));
    await put(`photos/${OTHER}.ndjson`, lines(photo(C.replace("3", "4"), { place: OTHER, hidden: "moderator" })));
    await put("moderation/blocked_contributors.json", JSON.stringify({ contributors: [{ contributor: "ctr_ffffffffffffffff", added: "2026-11-01", reason: "spam" }] }));
    const states = await photoStates(root);
    expect([...states.visible]).toEqual([A]);
    expect([...states.other].sort()).toEqual([B, C, C.replace("3", "4")].sort());
    expect(await recordFiles(root)).toEqual(new Map([[PLACE, lines(photo(A))]]));
  });

  it("checks photo lines: licence, order, place and the removed list", async () => {
    const places = new Set([PLACE]);
    await put(`photos/${PLACE}.ndjson`, lines(photo(B), photo(A, { licence: "CC-BY-SA-4.0" })));
    expect(await checkPhotos(root, { places, licence: "CC-BY-4.0" })).toEqual([
      `photos/${PLACE}.ndjson line 2: licence must be CC-BY-4.0`,
      `photos/${PLACE}.ndjson line 2: lines must be sorted by id`,
    ]);
    await put(`photos/${PLACE}.ndjson`, lines(photo(A)));
    expect(await checkPhotos(root, { places, licence: "CC-BY-4.0" })).toEqual([]);
    expect(await checkPhotos(root, { places: new Set(), licence: "CC-BY-4.0" })).toEqual([`photos/${PLACE}.ndjson: no such place ${PLACE}`]);
    await put("moderation/removed_photos.json", JSON.stringify({ photos: [{ photo: A, reason: "erased", removed: "2026-11-03T00:00:00Z" }] }));
    expect(await checkPhotos(root, { places, licence: "CC-BY-4.0" })).toEqual([`photos/${PLACE}.ndjson line 1: photo ${A} is on moderation/removed_photos.json`]);
  });
});
