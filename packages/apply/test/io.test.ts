import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ open: 0, most: 0 }));

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      reads.open++;
      reads.most = Math.max(reads.most, reads.open);
      try {
        return await fs.readFile(...args);
      } finally {
        reads.open--;
      }
    },
  };
});

const { DataRepo } = await import("../src/io.js");

const id = (n: number) => `ocdb_01M66ESF${String(n).padStart(18, "0")}`;

describe("allPlaces", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ocdb-io-"));
    reads.open = 0;
    reads.most = 0;
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("reads every place, a few files at a time", async () => {
    for (const folder of ["nsw", "nt", "wa"])
      await mkdir(join(root, "places", folder), { recursive: true });
    const folders = ["nsw", "nt", "wa"];
    for (let n = 0; n < 900; n++)
      await writeFile(
        join(root, "places", folders[n % 3]!, `${id(n)}.json`),
        JSON.stringify({ id: id(n), name: `Place ${n}` }),
      );

    const places = await new DataRepo(root).allPlaces();

    expect(places).toHaveLength(900);
    expect(new Set(places.map((p) => p.id)).size).toBe(900);
    expect(reads.most).toBeLessThanOrEqual(64);
  });

  it("is empty when the checkout has no places", async () => {
    expect(await new DataRepo(root).allPlaces()).toEqual([]);
  });
});
