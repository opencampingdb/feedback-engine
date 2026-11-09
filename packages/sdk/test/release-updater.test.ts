import { describe, expect, it } from "vitest";
import {
  createReleaseUpdater,
  sha256HexBytes,
  type ReleaseDatabaseAdapter,
  type ReleaseFetchLike,
  type ReleaseUpdaterOptions,
} from "../src/index.js";

const MANIFEST_URL = "https://example.org/releases/latest/download/manifest.json";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes));

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A release's data version, numbered so tests read as "release 3". */
const v = (n: number) => `202611${String(1 + Math.floor(n / 24)).padStart(2, "0")}T${String(n % 24).padStart(2, "0")}0000Z-${String(n).padStart(7, "0")}`;

/**
 * A fake release database: a changeset is JSON { from, to } and refuses to
 * apply to any other release, and a whole database is JSON { data_version,
 * layout_version }. A chain is applied all or nothing, as one transaction.
 */
function fakeDatabase(start: { dataVersion: string | null; layout: number | null }, failApplyAt?: string) {
  const state = { dataVersion: start.dataVersion, layout: start.layout, applied: [] as string[], chains: [] as number[], replaced: [] as string[], failApplyAt };
  const adapter: ReleaseDatabaseAdapter = {
    currentDataVersion: async () => state.dataVersion,
    currentLayoutVersion: async () => state.layout,
    applyChangesets: async (chain) => {
      state.chains.push(chain.length);
      let at = state.dataVersion;
      const applied: string[] = [];
      for (const bytes of chain) {
        const { from, to } = decode(bytes) as { from: string; to: string };
        if (from !== at) throw new Error(`changeset from ${from} applied to ${at}`);
        if (to === state.failApplyAt) throw new Error("conflict");
        applied.push(`${from}>${to}`);
        at = to;
      }
      state.applied.push(...applied);
      state.dataVersion = at;
    },
    replaceDatabase: async (bytes) => {
      const db = decode(bytes) as { data_version: string; layout_version: number };
      state.replaced.push(db.data_version);
      state.dataVersion = db.data_version;
      state.layout = db.layout_version;
    },
  };
  return { adapter, state };
}

/** A run of `length` bytes that gzip can't shrink, so a test database is larger than its changesets. */
function noise(length: number): string {
  let x = 2463534242;
  let out = "";
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += String.fromCharCode(33 + ((x >>> 0) % 94)).replace(/["\\]/, "x");
  }
  return out;
}

interface Hop {
  from: number;
  to: number;
  day?: boolean;
}

interface ReleaseShape {
  layout?: number;
  format?: number;
  /** Undefined leaves format_version out. */
  formatVersion?: number | null;
  /** Bytes of noise in the whole database, so it is larger than a chain. Default 20,000. */
  databaseNoise?: number;
  /** Serve the files as they are, without gzip, padded to these sizes (for an updater with `gunzip: (b) => b`). */
  plain?: { databaseBytes: number };
  /** The data_version the whole database holds. Defaults to the manifest's. */
  databaseVersion?: string;
}

/** A manifest for release `latest` with the given changesets, and the files it points at. */
async function release(latest: number, hops: Hop[], shape: ReleaseShape | number = {}) {
  const opts: ReleaseShape = typeof shape === "number" ? { layout: shape } : shape;
  const layout = opts.layout ?? 1;
  const files = new Map<string, Uint8Array>();
  const entry = async (file: string, raw: Uint8Array, size?: number) => {
    const padded = size === undefined ? raw : new Uint8Array([...raw, ...new Array(Math.max(0, size - raw.length)).fill(0x20)]);
    const served = opts.plain ? padded : await gzip(padded);
    const url = `https://example.org/releases/download/data-${latest}/${file}`;
    files.set(url, served);
    return { file, url, sha256: sha256HexBytes(served), bytes: served.length };
  };
  const database = { data_version: opts.databaseVersion ?? v(latest), layout_version: layout, ...(opts.plain ? {} : { noise: noise(opts.databaseNoise ?? 20_000) }) };
  const manifest = {
    ...(opts.formatVersion === null ? {} : { format_version: opts.formatVersion ?? opts.format ?? 12 }),
    format_minor: 2,
    layout_version: layout,
    data_version: v(latest),
    database: await entry("ocdb.sqlite.gz", encode(database), opts.plain?.databaseBytes),
    changesets: await Promise.all(
      hops.map(async (hop) => ({
        ...(await entry(`changeset-${hop.day ? "day-" : ""}${hop.from}-${hop.to}.bin.gz`, encode({ from: v(hop.from), to: v(hop.to) }))),
        from: v(hop.from),
        to: v(hop.to),
        day: hop.day ?? false,
      })),
    ),
  };
  return { manifest, files };
}

/** An updater over the fake manifest URL, reading layout 1 and format 12. */
const updaterFor = (adapter: ReleaseDatabaseAdapter, fetch: ReleaseFetchLike, extra: Partial<ReleaseUpdaterOptions> = {}) =>
  createReleaseUpdater({ adapter, readableLayouts: [1], readableFormats: [12], fetch, manifestUrl: MANIFEST_URL, ...extra });

/** A fake fetch serving a manifest and its files, recording every URL asked for. */
function fakeFetch(served: { manifest: unknown; files: Map<string, Uint8Array> }, broken: (url: string) => "throw" | "404" | "corrupt" | undefined = () => undefined) {
  const requests: string[] = [];
  const fetch: ReleaseFetchLike = async (url) => {
    requests.push(url);
    const fault = broken(url);
    if (fault === "throw") throw new TypeError("Network request failed");
    const body = url === MANIFEST_URL ? encode(served.manifest) : served.files.get(url);
    if (!body || fault === "404") return { status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = fault === "corrupt" ? body.map((b, i) => (i === body.length - 1 ? b ^ 0xff : b)) : body;
    return { status: 200, json: async () => decode(bytes), arrayBuffer: async () => bytes.slice().buffer };
  };
  return { fetch, requests };
}

const chain = (from: number, to: number): Hop[] => Array.from({ length: to - from }, (_, i) => ({ from: from + i, to: from + i + 1 }));

describe("createReleaseUpdater", () => {
  it("applies a chain of three changesets in order and reports the new release", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(3) });
    expect(state.applied).toEqual([`${v(0)}>${v(1)}`, `${v(1)}>${v(2)}`, `${v(2)}>${v(3)}`]);
    // The whole chain goes to the adapter in one call, to apply in one transaction.
    expect(state.chains).toEqual([3]);
    expect(state.replaced).toEqual([]);
  });

  it("never replaces the database with an older release than the one it has", async () => {
    const served = await release(1, []);
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(5), layout: 1 });
    expect(await updaterFor(adapter, fetch).update()).toEqual({ status: "older_release", dataVersion: v(5) });
    expect(state.replaced).toEqual([]);
    expect(requests).toEqual([MANIFEST_URL]);
  });

  it("refuses options without a readable layout or format", () => {
    const { adapter } = fakeDatabase({ dataVersion: null, layout: null });
    const fetch: ReleaseFetchLike = async () => ({ status: 503, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
    expect(() => updaterFor(adapter, fetch, { readableFormats: [] })).toThrow(/readableFormats/);
    expect(() => updaterFor(adapter, fetch, { readableLayouts: [] })).toThrow(/readableLayouts/);
    expect(() => updaterFor(adapter, fetch, { readableFormats: [12.5] })).toThrow(/readableFormats/);
  });
});

describe("createReleaseUpdater: changesets from elsewhere (audit run-2 OCDB-NV-02)", () => {
  for (const foreign of ["https://evil.example/releases/download/data-3/x.bin.gz", "https://example.org/someone-else/download/data-3/x.bin.gz"]) {
    it(`never downloads a changeset from outside the database's own release downloads: ${foreign}`, async () => {
      const served = await release(3, chain(0, 3));
      // A forged entry with a valid checksum that makes the path one file long.
      const bytes = served.files.get(served.manifest.changesets[0]!.url)!;
      served.files.set(foreign, await gzip(encode({ from: v(0), to: v(3) })));
      const forged = { ...served.manifest.changesets[0]!, url: foreign, to: v(3), sha256: sha256HexBytes(served.files.get(foreign)!), bytes: served.files.get(foreign)!.length };
      served.manifest.changesets.push(forged);
      expect(bytes).toBeDefined();
      const { fetch, requests } = fakeFetch(served);
      const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
      expect(await updaterFor(adapter, fetch).update()).toEqual({ status: "updated", dataVersion: v(3) });
      expect(requests).not.toContain(foreign);
      expect(state.applied).toEqual([`${v(0)}>${v(1)}`, `${v(1)}>${v(2)}`, `${v(2)}>${v(3)}`]);
    });
  }
});

describe("createReleaseUpdater: when to ask", () => {
  it("makes no request when the recent list's release is the one the app has", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch, requests } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(3), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update({ knownDataVersion: v(3) })).toEqual({ status: "up_to_date", dataVersion: v(3) });
    expect(requests).toEqual([]);
  });

  it("asks for the manifest alone when the app turns out to be current", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch, requests } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(3), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update({ knownDataVersion: v(4) })).toEqual({ status: "up_to_date", dataVersion: v(3) });
    expect(requests).toEqual([MANIFEST_URL]);
  });

  it("uses the data repository's latest manifest unless told otherwise", async () => {
    const urls: string[] = [];
    const fetch: ReleaseFetchLike = async (url) => {
      urls.push(url);
      return { status: 503, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    expect(await createReleaseUpdater({ adapter, readableLayouts: [1], readableFormats: [12], fetch }).update()).toEqual({ status: "failed", dataVersion: v(0), reason: "network" });
    expect(urls).toEqual(["https://github.com/opencampingdb/data/releases/latest/download/manifest.json"]);
  });
});

describe("createReleaseUpdater: the whole database", () => {
  it("downloads the whole database when the path is more than 50 changesets", async () => {
    const served = await release(51, chain(0, 51));
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "replaced", dataVersion: v(51) });
    expect(state.applied).toEqual([]);
    expect(requests).toEqual([MANIFEST_URL, served.manifest.database.url]);
  });

  it("applies a path of exactly 50 changesets", async () => {
    const served = await release(50, chain(0, 50));
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(50) });
    expect(state.applied).toHaveLength(50);
  });

  it("downloads the whole database across a layout change", async () => {
    const served = await release(3, [], 2);
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(2), layout: 1 });
    const updater = updaterFor(adapter, fetch, { readableLayouts: [1, 2] });

    expect(await updater.update()).toEqual({ status: "replaced", dataVersion: v(3) });
    expect(state.layout).toBe(2);
  });

  it("downloads the whole database when the app's release is older than the changesets listed", async () => {
    const served = await release(5, chain(2, 5));
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "replaced", dataVersion: v(5) });
    expect(state.applied).toEqual([]);
  });

  it("downloads the whole database when the app has none", async () => {
    const served = await release(5, chain(2, 5));
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: null, layout: null });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "replaced", dataVersion: v(5) });
  });
});

describe("createReleaseUpdater: a layout the app can't read", () => {
  it("stays on its release and downloads nothing", async () => {
    const served = await release(3, [], 2);
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(2), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "layout_unsupported", dataVersion: v(2) });
    expect(requests).toEqual([MANIFEST_URL]);
    expect(state).toMatchObject({ dataVersion: v(2), layout: 1, applied: [], replaced: [] });
  });
});

describe("createReleaseUpdater: failures leave the release", () => {
  it("throws away a changeset whose checksum is wrong, before applying any", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch } = fakeFetch(served, (url) => (url === served.manifest.changesets[2]!.url ? "corrupt" : undefined));
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "checksum" });
    expect(state.applied).toEqual([]);
  });

  it("throws away a whole database whose size is wrong", async () => {
    const served = await release(3, []);
    served.manifest.database.bytes += 1;
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "checksum" });
    expect(state.replaced).toEqual([]);
  });

  it("applies nothing when a download fails partway through the chain", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch } = fakeFetch(served, (url) => (url === served.manifest.changesets[1]!.url ? "throw" : undefined));
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "network" });
    expect(state.applied).toEqual([]);
  });

  it("stays on the release it started from when a changeset partway through the chain fails", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 }, v(2));
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "apply" });
    expect(state.applied).toEqual([]);

    // The next run tries the whole chain again.
    state.failApplyAt = undefined;
    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(3) });
    expect(state.applied).toEqual([`${v(0)}>${v(1)}`, `${v(1)}>${v(2)}`, `${v(2)}>${v(3)}`]);
    expect(state.chains).toEqual([3, 3]);
  });

  it("keeps the old database when the replace fails", async () => {
    const served = await release(3, []);
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const failing = { ...adapter, replaceDatabase: async () => Promise.reject(new Error("disk full")) };
    const updater = updaterFor(failing, fetch);

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "replace" });
  });

  it("fails on a manifest it can't read", async () => {
    const { fetch } = fakeFetch({ manifest: { data_version: v(3) }, files: new Map() });
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "manifest" });
  });
});

describe("createReleaseUpdater: the path", () => {
  it("takes a daily changeset when it makes the path shorter", async () => {
    const served = await release(4, [...chain(0, 4), { from: 1, to: 4, day: true }]);
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(4) });
    expect(state.applied).toEqual([`${v(0)}>${v(1)}`, `${v(1)}>${v(4)}`]);
    expect(requests).toHaveLength(3);
  });

  it("of two paths with as few files, takes the one through a daily changeset", async () => {
    const served = await release(3, [{ from: 0, to: 2 }, { from: 0, to: 1 }, { from: 2, to: 3 }, { from: 1, to: 3, day: true }]);
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = updaterFor(adapter, fetch);

    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(3) });
    expect(state.applied).toEqual([`${v(0)}>${v(1)}`, `${v(1)}>${v(3)}`]);
  });
});

describe("createReleaseUpdater: a format the app can't read", () => {
  it("stays on its release and downloads nothing when the format is newer than any it reads", async () => {
    const served = await release(3, chain(0, 3), { format: 13 });
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });

    expect(await updaterFor(adapter, fetch, { readableFormats: [11, 12] }).update()).toEqual({ status: "format_unsupported", dataVersion: v(0) });
    expect(requests).toEqual([MANIFEST_URL]);
    expect(state).toMatchObject({ dataVersion: v(0), applied: [], replaced: [] });
  });

  it("reads a release of a format older than the newest it reads", async () => {
    const served = await release(1, chain(0, 1), { format: 11 });
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });

    expect(await updaterFor(adapter, fetch).update()).toEqual({ status: "updated", dataVersion: v(1) });
  });

  it("fails on a manifest without a format_version", async () => {
    const served = await release(1, chain(0, 1), { formatVersion: null });
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });

    expect(await updaterFor(adapter, fetch).update()).toEqual({ status: "failed", dataVersion: v(0), reason: "manifest" });
  });
});

describe("createReleaseUpdater: a chain as large as the database", () => {
  const sizes = async (databaseBytes: number) => {
    const plain = await release(3, chain(0, 3), { plain: { databaseBytes: 1 } });
    const chainBytes = plain.manifest.changesets.reduce((sum, c) => sum + c.bytes, 0);
    return release(3, chain(0, 3), { plain: { databaseBytes: databaseBytes === 0 ? chainBytes : chainBytes + databaseBytes } });
  };
  const identity = (bytes: Uint8Array) => bytes;

  it("downloads the whole database when the chain's files add up to as many bytes", async () => {
    const served = await sizes(0);
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });

    expect(await updaterFor(adapter, fetch, { gunzip: identity }).update()).toEqual({ status: "replaced", dataVersion: v(3) });
    expect(requests).toEqual([MANIFEST_URL, served.manifest.database.url]);
    expect(state.applied).toEqual([]);
  });

  it("applies the chain when its files add up to fewer bytes than the database", async () => {
    const served = await sizes(1);
    const { fetch, requests } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });

    expect(await updaterFor(adapter, fetch, { gunzip: identity }).update()).toEqual({ status: "updated", dataVersion: v(3) });
    expect(requests).not.toContain(served.manifest.database.url);
  });
});

describe("createReleaseUpdater: a release other than the manifest's", () => {
  it("replaces the whole database when the chain leaves the database on another release", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    // An adapter whose apply settles conflicts by replacing rows can end anywhere.
    const drifting = { ...adapter, applyChangesets: async () => void (state.dataVersion = v(2)) };

    expect(await updaterFor(drifting, fetch).update()).toEqual({ status: "replaced", dataVersion: v(3) });
    expect(state.replaced).toEqual([v(3)]);
    expect(requests.at(-1)).toBe(served.manifest.database.url);
  });

  it("fails with mismatch, once, when the whole database names another release", async () => {
    const served = await release(3, chain(0, 3), { databaseVersion: v(2) });
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const drifting = { ...adapter, applyChangesets: async () => void (state.dataVersion = v(1)) };

    expect(await updaterFor(drifting, fetch).update()).toEqual({ status: "failed", dataVersion: v(2), reason: "mismatch" });
    expect(requests.filter((url) => url === served.manifest.database.url)).toHaveLength(1);
  });

  it("fails with mismatch when a whole database downloaded at the start names another release", async () => {
    const served = await release(3, [], { databaseVersion: v(2) });
    const { fetch, requests } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: null, layout: null });

    expect(await updaterFor(adapter, fetch).update()).toEqual({ status: "failed", dataVersion: v(2), reason: "mismatch" });
    expect(requests).toEqual([MANIFEST_URL, served.manifest.database.url]);
  });

  it("keeps the database the chain left when the replace after it fails", async () => {
    const served = await release(3, chain(0, 3));
    served.manifest.database.bytes += 1;
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const drifting = { ...adapter, applyChangesets: async () => void (state.dataVersion = v(2)) };

    expect(await updaterFor(drifting, fetch).update()).toEqual({ status: "failed", dataVersion: v(2), reason: "checksum" });
  });
});

describe("createReleaseUpdater: memory", () => {
  it("hands the adapter the whole database exactly as gunzip gave it, without a copy", async () => {
    const served = await release(3, []);
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: null, layout: null });
    const given: Uint8Array[] = [];
    const received: Uint8Array[] = [];
    const gunzip = (bytes: Uint8Array) => {
      const out = encode({ data_version: v(3), layout_version: 1 });
      given.push(out);
      return out;
    };
    const watching = { ...adapter, replaceDatabase: async (bytes: Uint8Array) => (received.push(bytes), adapter.replaceDatabase(bytes)) };

    expect(await updaterFor(watching, fetch, { gunzip }).update()).toEqual({ status: "replaced", dataVersion: v(3) });
    expect(given).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(given[0]);
  });
});

describe("createReleaseUpdater: gzip", () => {
  it("hands the adapter the changeset with gzip undone", async () => {
    const served = await release(1, chain(0, 1));
    const { fetch } = fakeFetch(served);
    const seen: unknown[] = [];
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const watching = { ...adapter, applyChangesets: async (chain: Uint8Array[]) => (seen.push(...chain.map(decode)), adapter.applyChangesets(chain)) };
    await updaterFor(watching, fetch).update();

    expect(seen).toEqual([{ from: v(0), to: v(1) }]);
  });

  it("uses the gunzip the app passes", async () => {
    const served = await release(1, chain(0, 1));
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const calls: number[] = [];
    const gunzip = async (bytes: Uint8Array) => {
      calls.push(bytes.length);
      return encode({ from: v(0), to: v(1) });
    };

    expect(await updaterFor(adapter, fetch, { gunzip }).update()).toEqual({ status: "updated", dataVersion: v(1) });
    expect(calls).toEqual([served.manifest.changesets[0]!.bytes]);
  });

  it("fails on a download that isn't gzip", async () => {
    const served = await release(1, chain(0, 1));
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const gunzip = () => {
      throw new Error("incorrect header check");
    };

    expect(await updaterFor(adapter, fetch, { gunzip }).update()).toEqual({ status: "failed", dataVersion: v(0), reason: "gunzip" });
  });
});
