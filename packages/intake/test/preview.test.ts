import { describe, expect, it } from "vitest";
import { createHandler, type BucketLike, type Env } from "../src/index.js";
import { previewUrl, PREVIEW_TTL_SECONDS, verifyPreview } from "../../apply/src/preview.js";

const SECRET = "review-secret";
const PHOTO = "pho_01M6JPNZNFN1MQN9GMCXFC7WCB";
const NOW = Date.parse("2026-11-04T08:00:00Z");
const EXPIRES = Math.floor(NOW / 1000) + PREVIEW_TTL_SECONDS;
const BASE = "https://intake.example";

function bucket(): BucketLike {
  const files = new Map([[`${PHOTO}/full.jpg`, new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9])]]);
  return {
    put: async () => undefined,
    delete: async () => undefined,
    get: async (key) => {
      const bytes = files.get(key);
      return bytes ? { body: new Response(bytes).body!, size: bytes.length } : null;
    },
  };
}

const env = (extra: Partial<Env> = {}): Env =>
  ({ APP_KEYS: "{}", DEVICE_SALT: "pepper", RATE_LIMIT: {}, PHOTOS_PENDING: bucket(), REVIEW_PREVIEW_SECRET: SECRET, ...extra }) as unknown as Env;

const handle = createHandler({ fetch: async () => new Response("", { status: 404 }), now: () => NOW });

describe("review previews", () => {
  it("signs a link that only works for its photo and until it expires", async () => {
    const url = new URL(await previewUrl(BASE, SECRET, PHOTO, "full", EXPIRES));
    const [expires, sig] = [url.searchParams.get("expires")!, url.searchParams.get("sig")!];
    expect(url.pathname).toBe(`/v1/photos/review/${PHOTO}/full.jpg`);
    expect(await verifyPreview(SECRET, PHOTO, expires, sig, NOW)).toBe(true);
    expect(await verifyPreview(SECRET, "pho_01M6JPNZNFN1MQN9GMCXFC7WCC", expires, sig, NOW)).toBe(false);
    expect(await verifyPreview("another-secret", PHOTO, expires, sig, NOW)).toBe(false);
    expect(await verifyPreview(SECRET, PHOTO, expires, sig, EXPIRES * 1000)).toBe(false);
  });

  it("serves the held photo, never cached", async () => {
    const response = await handle(new Request(await previewUrl(BASE, SECRET, PHOTO, "full", EXPIRES)), env());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]));
  });

  it("answers not found for a bad link, a missing file, or with previews off", async () => {
    const good = await previewUrl(BASE, SECRET, PHOTO, "full", EXPIRES);
    expect((await handle(new Request(good.replace(/sig=[^&]+/, "sig=" + "A".repeat(43))), env())).status).toBe(404);
    expect((await handle(new Request(await previewUrl(BASE, SECRET, PHOTO, "thumb", EXPIRES)), env())).status).toBe(404);
    expect((await handle(new Request(good), env({ REVIEW_PREVIEW_SECRET: "" }))).status).toBe(404);
  });
});
