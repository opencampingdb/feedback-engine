import { describe, expect, it } from "vitest";
import { createPhotoClient, sha256HexBytes, stripJpegMetadata, type PhotoFetchLike, type PhotoSettled, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const CONTRIBUTOR = "contributor_0123456789";

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
/** An APPn segment: marker, a length that counts itself, then the payload. */
const segment = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const EXIF = segment(0xe1, [...ascii("Exif"), 0, 0, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
const XMP = segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii("<x:xmpmeta/>")]);
const JFIF = segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
/** A frame header, whose last byte the file number fills. */
const FRAME = [0xff, 0xc0, 0x00, 0x0c, 0x08, 0x00, 0x10, 0x00, 0x10, 0x01, 0x01, 0x11, 0x00];
const SCAN = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0x00, 0x56];

/** A small JPEG, with the given segments after SOI. `n` makes each file differ. */
const jpeg = (n: number, ...segments: number[][]) => new Uint8Array([0xff, 0xd8, ...segments.flat(), ...FRAME, n, ...SCAN, 0xff, 0xd9]);

const decodeMeta = (header: string) =>
  JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));

function photoClient(extra: Partial<Parameters<typeof createPhotoClient>[0]> = {}) {
  const uploads: { headers: Record<string, string>; body: Uint8Array }[] = [];
  const fetchPhoto: PhotoFetchLike = async (_url, init) => {
    uploads.push({ headers: init.headers, body: init.body });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { status: 202, json: async () => ({ id: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZA" }), headers: { get: () => null } };
  };
  const settled: PhotoSettled[] = [];
  const c = createPhotoClient({
    endpoint: "https://photos.example",
    appKey: "key",
    appVersion: "1.0.0",
    storage: memoryStorage(),
    fetch: async () => ({ status: 202, json: async () => ({}), headers: { get: () => null } }),
    fetchPhoto,
    onPhotoSettled: (s) => void settled.push(s),
    ...extra,
  });
  return { c, uploads, settled };
}

describe("stripJpegMetadata", () => {
  it("removes the APP1 Exif and XMP segments and keeps the rest", () => {
    expect(stripJpegMetadata(jpeg(1, JFIF, EXIF, XMP))).toEqual(jpeg(1, JFIF));
    expect(stripJpegMetadata(jpeg(1, EXIF))).toEqual(jpeg(1));
  });

  it("gives back the same bytes when there is nothing to remove", () => {
    const plain = jpeg(1, JFIF);
    expect(stripJpegMetadata(plain)).toBe(plain);
  });

  it("leaves the image data after the start of scan alone, even where it looks like a marker", () => {
    const tail = [0xff, 0xe1, 0x00, 0x04, 0x00, 0x00];
    const bytes = new Uint8Array([...jpeg(1, EXIF).slice(0, -2), ...tail, 0xff, 0xd9]);
    const stripped = stripJpegMetadata(bytes);
    expect([...stripped.slice(-8)]).toEqual([...tail, 0xff, 0xd9]);
    expect(stripped.length).toBe(bytes.length - EXIF.length);
  });

  it("leaves bytes it cannot read as JPEG segments alone", () => {
    const odd = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x01, 1, 1, 1]);
    expect(stripJpegMetadata(odd)).toBe(odd);
  });
});

describe("photo uploads", () => {
  it("uploads a photo without the EXIF or XMP it carried, and the meta describes the bytes sent", async () => {
    const { c, uploads } = photoClient();
    const full = jpeg(1, JFIF, EXIF, XMP);
    const thumb = jpeg(2, EXIF);
    const result = await c.photo({ place: PLACE, contributor: CONTRIBUTOR, consent: true, full, thumb });
    expect(result).toEqual({ status: "sent", id: "pho_01JBXK3M8Q4R5S6T7V8W9X0YZA" });
    expect(uploads.length).toBe(1);
    const sentFull = jpeg(1, JFIF);
    const sentThumb = jpeg(2);
    expect(uploads[0]!.body).toEqual(new Uint8Array([...sentFull, ...sentThumb]));
    const meta = decodeMeta(uploads[0]!.headers["x-photo-meta"]!);
    expect(meta.photo).toEqual({
      full_sha256: sha256HexBytes(sentFull),
      full_bytes: sentFull.length,
      thumb_sha256: sha256HexBytes(sentThumb),
      thumb_bytes: sentThumb.length,
    });
  });

  it("onPhotoSettled is called once for a waiting photo when two flushes overlap", async () => {
    let place: string | undefined;
    const { c, settled, uploads } = photoClient({
      resolveNewPlace: async () => (place ? { status: "sent", place } : { status: "waiting" }),
      loadPhoto: async () => ({ full: jpeg(1), thumb: jpeg(2) }),
    });
    await c.photo({ place: { newPlace: "np1" }, key: "k1", contributor: CONTRIBUTOR, consent: true, full: jpeg(1), thumb: jpeg(2) });
    place = PLACE;
    await Promise.all([c.flush(), c.flush()]); // app foreground and connection regained at the same moment
    expect(settled.length).toBe(1);
    expect(uploads.length).toBe(1);
  });
});
