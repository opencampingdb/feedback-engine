import { describe, expect, it } from "vitest";
import { sha256Hex, sha256HexBytes } from "../src/index.js";

const subtle = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");

describe("sha256HexBytes", () => {
  it("gives the standard digests", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("matches Web Crypto at every length around the 64-byte blocks", async () => {
    for (let length = 0; length <= 200; length++) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + length) & 255);
      expect(sha256HexBytes(bytes), `length ${length}`).toBe(await subtle(bytes));
    }
  });

  it("hashes a view into a larger buffer by its own bytes", async () => {
    const buffer = Uint8Array.from({ length: 300 }, (_, i) => i & 255);
    const view = buffer.subarray(7, 207);
    expect(sha256HexBytes(view)).toBe(await subtle(view.slice()));
  });

  it("hashes a megabyte without changing it", async () => {
    const bytes = Uint8Array.from({ length: 1 << 20 }, (_, i) => (i * 7) & 255);
    const before = bytes.slice();
    expect(sha256HexBytes(bytes)).toBe(await subtle(bytes));
    expect(bytes).toEqual(before);
  });
});
