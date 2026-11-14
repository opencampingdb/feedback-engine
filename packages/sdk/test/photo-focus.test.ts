import { describe, expect, it } from "vitest";
import { createPhotoClient, FeedbackValidationError, isPhotoFocus, validateSubmission, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const NEW_PLACE = "ocdb_01M6R45Y75GTXQBS5ETC16CYSZ";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true, contributor: CONTRIBUTOR, type: "photo", place: PLACE };
const files = { full_sha256: "a".repeat(64), full_bytes: 400_000, thumb_sha256: "b".repeat(64), thumb_bytes: 40_000 };

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

describe("photo focus validation", () => {
  it("accepts a focus with x and y from 0 to 1", () => {
    for (const focus of [{ x: 0, y: 1 }, { x: 0.5, y: 0.25 }, { x: 0.123, y: 0.999 }]) {
      expect(validateSubmission({ ...base, photo: { ...files, focus } })).toMatchObject({ ok: true, value: { photo: { ...files, focus } } });
    }
  });

  it("leaves focus out when the photo has none", () => {
    const r = validateSubmission({ ...base, photo: files }) as { value: { photo: object } };
    expect(r.value.photo).not.toHaveProperty("focus");
  });

  it("refuses a focus out of range, not a number, with extra fields or more than 3 decimal places", () => {
    const bad = [{ x: -0.1, y: 0.5 }, { x: 0.5, y: 1.01 }, { x: "0.5", y: 0.5 }, { x: 0.5 }, { x: 0.5, y: 0.5, z: 0 }, { x: 0.1234, y: 0.5 }, [0.5, 0.5], null, { x: Number.NaN, y: 0.5 }];
    for (const focus of bad) {
      expect((validateSubmission({ ...base, photo: { ...files, focus } }) as { errors: string[] }).errors).toEqual([
        "photo.focus must be an object with only x and y, each a number from 0 to 1 with at most 3 decimal places",
      ]);
    }
  });

  it("isPhotoFocus agrees with validation", () => {
    expect(isPhotoFocus({ x: 0.5, y: 0.5 })).toBe(true);
    expect(isPhotoFocus({ x: 0.5, y: 2 })).toBe(false);
    expect(isPhotoFocus(undefined)).toBe(false);
  });
});

describe("photo client focus", () => {
  function setup(storage: StorageAdapter = memoryStorage(), resolve: () => { status: "waiting" } | { status: "sent"; place: string } = () => ({ status: "waiting" })) {
    const metas: { photo: Record<string, unknown> }[] = [];
    const client = createPhotoClient({
      endpoint: "https://intake.example/",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage,
      fetch: async () => ({ status: 202, json: async () => ({}), headers: { get: () => null } }),
      fetchPhoto: async (_url, init) => {
        metas.push(decodeMeta(init.headers["x-photo-meta"]!));
        return { status: 202, json: async () => ({ id: `pho_01JBXK3M8Q4R5S6T7V8W9X0YZ${metas.length}` }), headers: { get: () => null } };
      },
      resolveNewPlace: async () => resolve(),
      loadPhoto: async () => ({ full: jpeg(20), thumb: jpeg(10) }),
    });
    return { client, metas };
  }

  it("sends the focus rounded to 3 decimal places", async () => {
    const t = setup();
    await t.client.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: jpeg(100), thumb: jpeg(50), focus: { x: 0.12345, y: 0.6789 } });
    expect(t.metas[0]!.photo.focus).toEqual({ x: 0.123, y: 0.679 });
  });

  it("sends no focus when the app gives none", async () => {
    const t = setup();
    await t.client.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: jpeg(100), thumb: jpeg(50) });
    expect(t.metas[0]!.photo).not.toHaveProperty("focus");
  });

  it("refuses a focus that is not two numbers from 0 to 1, before sending", async () => {
    const t = setup();
    for (const focus of [{ x: 1.5, y: 0.5 }, { x: 0.5, y: Number.POSITIVE_INFINITY }, { x: 0.5 } as { x: number; y: number }]) {
      await expect(t.client.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full: jpeg(100), thumb: jpeg(50), focus })).rejects.toThrow(
        FeedbackValidationError,
      );
      await expect(t.client.photo({ place: { newPlace: "np-1" }, key: "a", contributor: CONTRIBUTOR, consent: true, full: jpeg(20), thumb: jpeg(10), focus })).rejects.toThrow(
        FeedbackValidationError,
      );
    }
    expect(t.metas).toHaveLength(0);
  });

  it("keeps a waiting photo's focus across a restart, and sends it once the new place has its id", async () => {
    const storage = memoryStorage();
    let status: { status: "waiting" } | { status: "sent"; place: string } = { status: "waiting" };
    const first = setup(storage, () => status);
    expect(await first.client.photo({ place: { newPlace: "np-1" }, key: "a", contributor: CONTRIBUTOR, consent: true, full: jpeg(20), thumb: jpeg(10), focus: { x: 0.25, y: 0.75 } })).toEqual({
      status: "waiting",
    });
    expect(await first.client.photo({ place: { newPlace: "np-1" }, key: "b", contributor: CONTRIBUTOR, consent: true, full: jpeg(20), thumb: jpeg(10) })).toEqual({ status: "waiting" });
    status = { status: "sent", place: NEW_PLACE };
    const second = setup(storage, () => status);
    await second.client.flush();
    expect(second.metas.map((m) => m.photo.focus)).toEqual([{ x: 0.25, y: 0.75 }, undefined]);
  });
});
