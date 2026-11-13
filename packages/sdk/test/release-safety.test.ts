import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReleaseUpdater, sha256HexBytes, type ReleaseDatabaseAdapter, type ReleaseFetchLike, type ReleaseUpdaterOptions, type StorageAdapter } from "../src/index.js";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));
const noise = (n: number) => Array.from({ length: n }, (_, i) => ((i * 2654435761) >>> 0).toString(36)).join("");

const V1 = "20261101T000000Z-0000001";
const V2 = "20261105T000000Z-0000002";
const V3 = "20261110T000000Z-0000003";
const HOME = "https://github.com/opencampingdb/data/releases/download/";

/** A database whose files are JSON. `candidate` gives the adapter the optional candidateDataVersion call. */
function fakeDatabase(dataVersion: string | null, { candidate = false } = {}) {
  const state = { dataVersion, layout: 1 as number | null, applies: 0, replaced: [] as string[], candidates: [] as string[] };
  const adapter: ReleaseDatabaseAdapter = {
    currentDataVersion: async () => state.dataVersion,
    currentLayoutVersion: async () => state.layout,
    applyChangesets: async (chain) => {
      state.applies += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      for (const bytes of chain) {
        const { from, to } = decode(bytes) as { from: string; to: string };
        if (from !== state.dataVersion) throw new Error(`changeset from ${from} applied to ${state.dataVersion}`);
        state.dataVersion = to;
      }
    },
    replaceDatabase: async (bytes) => {
      const db = decode(bytes) as { data_version: string };
      state.replaced.push(db.data_version);
      state.dataVersion = db.data_version;
    },
    ...(candidate
      ? {
          candidateDataVersion: async (bytes: Uint8Array) => {
            const version = (decode(bytes) as { data_version: string }).data_version;
            state.candidates.push(version);
            return version;
          },
        }
      : {}),
  };
  return { adapter, state };
}

function file(url: string, content: unknown) {
  const gz = new Uint8Array(gzipSync(encode(content)));
  return { entry: { url, sha256: sha256HexBytes(gz), bytes: gz.length }, gz };
}

function serve(manifest: unknown, files: Map<string, Uint8Array>) {
  const fetched: string[] = [];
  const served = { manifest };
  const fetch: ReleaseFetchLike = async (url) => {
    fetched.push(url);
    if (url.endsWith("manifest.json")) return { status: 200, json: async () => served.manifest, arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = files.get(url);
    if (!bytes) return { status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    return { status: 200, json: async () => ({}), arrayBuffer: async () => bytes.slice().buffer };
  };
  return { fetch, fetched, served };
}

const updater = (adapter: ReleaseDatabaseAdapter, fetch: ReleaseFetchLike, extra: Partial<ReleaseUpdaterOptions> = {}) =>
  createReleaseUpdater({ adapter, fetch, readableLayouts: [1], readableFormats: [1], gunzip: (b) => new Uint8Array(gunzipSync(b)), ...extra });

function memoryStorage() {
  const data = new Map<string, string>();
  const storage: StorageAdapter = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
  return { storage, data };
}

describe("release updater: where changesets come from", () => {
  it("a changeset url with a tab or newline in it cannot leave the database's release downloads", async () => {
    // fetch() and new URL() drop tabs and newlines, so ".\t." is read as "..".
    const db = file(`${HOME}v3/opencampingdb.sqlite.gz`, { data_version: V3, pad: noise(4000) });
    for (const gap of ["\t", "\n", "\r"]) {
      const evil = file(`${HOME}.${gap}./.${gap}./.${gap}./.${gap}./.${gap}./attacker/fork/releases/download/x/cs.gz`, { from: V2, to: V3 });
      const manifest = { data_version: V3, format_version: 1, layout_version: 1, database: db.entry, changesets: [{ ...evil.entry, from: V2, to: V3 }] };
      const { adapter } = fakeDatabase(V2);
      const { fetch, fetched } = serve(manifest, new Map([[db.entry.url, db.gz], [evil.entry.url, evil.gz]]));
      await updater(adapter, fetch).update();
      const outside = fetched
        .filter((u) => !u.endsWith("manifest.json"))
        .map((u) => new URL(u).pathname)
        .filter((p) => !p.startsWith("/opencampingdb/data/releases/download/"));
      expect(outside).toEqual([]);
    }
  });

  it("a changeset url under the release downloads is still used", async () => {
    const db = file(`${HOME}v3/opencampingdb.sqlite.gz`, { data_version: V3, pad: noise(4000) });
    const cs = file(`${HOME}v3/cs.gz`, { from: V2, to: V3 });
    const manifest = { data_version: V3, format_version: 1, layout_version: 1, database: db.entry, changesets: [{ ...cs.entry, from: V2, to: V3 }] };
    const { adapter } = fakeDatabase(V2);
    const { fetch } = serve(manifest, new Map([[db.entry.url, db.gz], [cs.entry.url, cs.gz]]));
    expect(await updater(adapter, fetch).update()).toMatchObject({ status: "updated", dataVersion: V3 });
  });

  it("a database url that is not https is refused as a bad manifest", async () => {
    const db = file("http://mirror.example/v3/opencampingdb.sqlite.gz", { data_version: V3 });
    const manifest = { data_version: V3, format_version: 1, layout_version: 1, database: db.entry, changesets: [] };
    const { adapter, state } = fakeDatabase(V2);
    const { fetch, fetched } = serve(manifest, new Map([[db.entry.url, db.gz]]));
    const result = await updater(adapter, fetch).update();
    expect(fetched.filter((x) => x.startsWith("http://"))).toEqual([]);
    expect(result).toMatchObject({ status: "failed", reason: "manifest", dataVersion: V2 });
    expect(state.dataVersion).toBe(V2);
  });
});

describe("release updater: never going backwards", () => {
  it("a manifest that names a newer release but points at an older database does not roll the app back", async () => {
    const old = file(`${HOME}v1/opencampingdb.sqlite.gz`, { data_version: V1 });
    const manifest = { data_version: V3, format_version: 1, layout_version: 1, database: old.entry, changesets: [] };
    const { adapter, state } = fakeDatabase(V2, { candidate: true });
    const { fetch } = serve(manifest, new Map([[old.entry.url, old.gz]]));
    const result = await updater(adapter, fetch).update();
    expect(result).toMatchObject({ status: "failed", reason: "mismatch", dataVersion: V2, cause: { name: "ReleaseMismatch" } });
    expect(state.candidates).toEqual([V1]);
    expect(state.replaced).toEqual([]);
    expect(state.dataVersion).toBe(V2);
  });

  it("a candidate that holds the manifest's release is swapped in", async () => {
    const db = file(`${HOME}v3/opencampingdb.sqlite.gz`, { data_version: V3 });
    const manifest = { data_version: V3, format_version: 1, layout_version: 1, database: db.entry, changesets: [] };
    const { adapter, state } = fakeDatabase(V2, { candidate: true });
    const { fetch } = serve(manifest, new Map([[db.entry.url, db.gz]]));
    expect(await updater(adapter, fetch).update()).toEqual({ status: "replaced", dataVersion: V3 });
    expect(state.candidates).toEqual([V3]);
  });

  it("a candidateDataVersion that throws stops the update as a read, before the swap", async () => {
    const db = file(`${HOME}v3/opencampingdb.sqlite.gz`, { data_version: V3 });
    const manifest = { data_version: V3, format_version: 1, layout_version: 1, database: db.entry, changesets: [] };
    const { adapter, state } = fakeDatabase(V2);
    const failing: ReleaseDatabaseAdapter = { ...adapter, candidateDataVersion: async () => Promise.reject(new Error("not a database")) };
    const { fetch } = serve(manifest, new Map([[db.entry.url, db.gz]]));
    expect(await updater(failing, fetch).update()).toMatchObject({ status: "failed", reason: "read", dataVersion: V2, cause: { message: "not a database" } });
    expect(state.replaced).toEqual([]);
  });

  it("a manifest whose data_version has no readable time does not replace a dated database", async () => {
    const db = file(`${HOME}x/opencampingdb.sqlite.gz`, { data_version: "rollback" });
    const manifest = { data_version: "rollback", format_version: 1, layout_version: 1, database: db.entry, changesets: [] };
    const { adapter, state } = fakeDatabase(V2);
    const { fetch, fetched } = serve(manifest, new Map([[db.entry.url, db.gz]]));
    const result = await updater(adapter, fetch).update();
    expect(result).toMatchObject({ status: "failed", reason: "manifest", dataVersion: V2 });
    expect(fetched).not.toContain(db.entry.url);
    expect(state.dataVersion).toBe(V2);
  });
});

describe("release updater: a release that never matches", () => {
  const wrong = () => {
    const other = file(`${HOME}v3/opencampingdb.sqlite.gz`, { data_version: "20261110T000000Z-fffffff" });
    const manifest = { data_version: V3, format_version: 1, layout_version: 1, database: other.entry, changesets: [] };
    return { other, manifest };
  };

  it("is not downloaded again on every update()", async () => {
    const { other, manifest } = wrong();
    const { adapter } = fakeDatabase(V2);
    const { fetch, fetched } = serve(manifest, new Map([[other.entry.url, other.gz]]));
    const u = updater(adapter, fetch);
    const results = [await u.update(), await u.update(), await u.update()];
    expect(fetched.filter((x) => x === other.entry.url).length).toBe(1);
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ["failed", "mismatch"],
      ["failed", "mismatch"],
      ["failed", "mismatch"],
    ]);
  });

  it("is not downloaded again after a restart when the updater has storage", async () => {
    const { other, manifest } = wrong();
    const { storage } = memoryStorage();
    const { fetch, fetched } = serve(manifest, new Map([[other.entry.url, other.gz]]));
    await updater(fakeDatabase(V2).adapter, fetch, { storage }).update();
    const again = await updater(fakeDatabase(V2).adapter, fetch, { storage }).update();
    expect(again).toMatchObject({ status: "failed", reason: "mismatch" });
    expect(fetched.filter((x) => x === other.entry.url).length).toBe(1);
  });

  it("is downloaded again once the manifest changes", async () => {
    const { other, manifest } = wrong();
    const fixed = file(`${HOME}v3b/opencampingdb.sqlite.gz`, { data_version: V3 });
    const { adapter } = fakeDatabase(V2);
    const { fetch, served } = serve(manifest, new Map([[other.entry.url, other.gz], [fixed.entry.url, fixed.gz]]));
    const u = updater(adapter, fetch);
    await u.update();
    served.manifest = { ...manifest, database: fixed.entry };
    expect(await u.update()).toEqual({ status: "replaced", dataVersion: V3 });
  });
});

describe("release updater: calls at the same moment", () => {
  it("two update() calls at the same moment share one run and apply one chain", async () => {
    const db = file(`${HOME}v3/opencampingdb.sqlite.gz`, { data_version: V3, pad: noise(4000) });
    const cs = file(`${HOME}v3/cs.gz`, { from: V2, to: V3 });
    const manifest = { data_version: V3, format_version: 1, layout_version: 1, database: db.entry, changesets: [{ ...cs.entry, from: V2, to: V3 }] };
    const { adapter, state } = fakeDatabase(V2);
    const { fetch, fetched } = serve(manifest, new Map([[db.entry.url, db.gz], [cs.entry.url, cs.gz]]));
    const u = updater(adapter, fetch);
    const results = await Promise.all([u.update(), u.update()]);
    expect({ applies: state.applies, wholeDownloads: fetched.filter((x) => x === db.entry.url).length, statuses: results.map((r) => r.status) }).toEqual({
      applies: 1,
      wholeDownloads: 0,
      statuses: ["updated", "updated"],
    });
    // Once the run is over, the next call starts its own.
    expect(await u.update()).toEqual({ status: "up_to_date", dataVersion: V3 });
  });
});

describe("release updater: the data versions it takes", () => {
  // The device clock reads 12:00 UTC on 12 November 2026, two days after V3.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-11-12T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const AHEAD = "20991231T000000Z-fffffff";

  it("refuses a manifest dated more than 7 days ahead of the clock, before any download", async () => {
    const db = file(`${HOME}far/opencampingdb.sqlite.gz`, { data_version: AHEAD });
    const manifest = { data_version: AHEAD, format_version: 1, layout_version: 1, database: db.entry, changesets: [] };
    const { adapter, state } = fakeDatabase(V1, { candidate: true });
    const { fetch, fetched } = serve(manifest, new Map([[db.entry.url, db.gz]]));
    expect(await updater(adapter, fetch).update()).toMatchObject({ status: "failed", reason: "manifest", dataVersion: V1 });
    expect(fetched).not.toContain(db.entry.url);
    expect(state.dataVersion).toBe(V1);
  });

  it("takes a manifest dated less than 7 days ahead of the clock, as a slow device clock reads it", async () => {
    const soon = "20261119T060000Z-abc1234";
    const db = file(`${HOME}soon/opencampingdb.sqlite.gz`, { data_version: soon });
    const manifest = { data_version: soon, format_version: 1, layout_version: 1, database: db.entry, changesets: [] };
    const { adapter } = fakeDatabase(V1, { candidate: true });
    const { fetch } = serve(manifest, new Map([[db.entry.url, db.gz]]));
    expect(await updater(adapter, fetch).update()).toEqual({ status: "replaced", dataVersion: soon });
  });

  for (const name of ["20261105T000000Z", "20261105T000000Z-abc", "20261105T000000Z-ABC1234", "20261105T000000Z-abc1234 ", "20261105T000000Z-abc1234-x", "20261105T000000Z-xyz1234"]) {
    it(`refuses a manifest whose data_version is not a release name, even with no database yet: ${JSON.stringify(name)}`, async () => {
      const db = file(`${HOME}odd/opencampingdb.sqlite.gz`, { data_version: name });
      const manifest = { data_version: name, format_version: 1, layout_version: 1, database: db.entry, changesets: [] };
      const { adapter, state } = fakeDatabase(null, { candidate: true });
      const { fetch, fetched } = serve(manifest, new Map([[db.entry.url, db.gz]]));
      expect(await updater(adapter, fetch).update()).toMatchObject({ status: "failed", reason: "manifest", dataVersion: null });
      expect(fetched).not.toContain(db.entry.url);
      expect(state.replaced).toEqual([]);
    });
  }

  it("moves a database dated far ahead of the clock onto the current release", async () => {
    const db = file(`${HOME}v3/opencampingdb.sqlite.gz`, { data_version: V3 });
    const manifest = { data_version: V3, format_version: 1, layout_version: 1, database: db.entry, changesets: [] };
    const { adapter, state } = fakeDatabase(AHEAD, { candidate: true });
    const { fetch } = serve(manifest, new Map([[db.entry.url, db.gz]]));
    expect(await updater(adapter, fetch).update()).toEqual({ status: "replaced", dataVersion: V3 });
    expect(state.replaced).toEqual([V3]);
  });
});
