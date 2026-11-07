import { describe, expect, it } from "vitest";
import {
  createReleaseUpdater,
  sha256HexBytes,
  type ReleaseDatabaseAdapter,
  type ReleaseFetchLike,
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
 * apply to any other release, and a whole database is JSON { data_version, layout_version }.
 */
function fakeDatabase(start: { dataVersion: string | null; layout: number | null }, failApplyAt?: string) {
  const state = { dataVersion: start.dataVersion, layout: start.layout, applied: [] as string[], replaced: [] as string[], failApplyAt };
  const adapter: ReleaseDatabaseAdapter = {
    currentDataVersion: async () => state.dataVersion,
    currentLayoutVersion: async () => state.layout,
    applyChangeset: async (bytes) => {
      const { from, to } = decode(bytes) as { from: string; to: string };
      if (from !== state.dataVersion) throw new Error(`changeset from ${from} applied to ${state.dataVersion}`);
      if (to === state.failApplyAt) throw new Error("conflict");
      state.applied.push(`${from}>${to}`);
      state.dataVersion = to;
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

interface Hop {
  from: number;
  to: number;
  day?: boolean;
}

/** A manifest for release `latest` with the given changesets, and the files it points at. */
async function release(latest: number, hops: Hop[], layout = 1) {
  const files = new Map<string, Uint8Array>();
  const entry = async (file: string, raw: Uint8Array) => {
    const gz = await gzip(raw);
    const url = `https://example.org/releases/download/data-${latest}/${file}`;
    files.set(url, gz);
    return { file, url, sha256: sha256HexBytes(gz), bytes: gz.length };
  };
  const manifest = {
    format_version: 12,
    format_minor: 2,
    layout_version: layout,
    data_version: v(latest),
    database: await entry("ocdb.sqlite.gz", encode({ data_version: v(latest), layout_version: layout })),
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
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(3) });
    expect(state.applied).toEqual([`${v(0)}>${v(1)}`, `${v(1)}>${v(2)}`, `${v(2)}>${v(3)}`]);
    expect(state.replaced).toEqual([]);
  });
});

describe("createReleaseUpdater: when to ask", () => {
  it("makes no request when the recent list's release is the one the app has", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch, requests } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(3), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update({ knownDataVersion: v(3) })).toEqual({ status: "up_to_date", dataVersion: v(3) });
    expect(requests).toEqual([]);
  });

  it("asks for the manifest alone when the app turns out to be current", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch, requests } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(3), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

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
    expect(await createReleaseUpdater({ adapter, readableLayouts: [1], fetch }).update()).toEqual({ status: "failed", dataVersion: v(0), reason: "network" });
    expect(urls).toEqual(["https://github.com/opencampingdb/data/releases/latest/download/manifest.json"]);
  });
});

describe("createReleaseUpdater: the whole database", () => {
  it("downloads the whole database when the path is more than 50 changesets", async () => {
    const served = await release(51, chain(0, 51));
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "replaced", dataVersion: v(51) });
    expect(state.applied).toEqual([]);
    expect(requests).toEqual([MANIFEST_URL, served.manifest.database.url]);
  });

  it("applies a path of exactly 50 changesets", async () => {
    const served = await release(50, chain(0, 50));
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(50) });
    expect(state.applied).toHaveLength(50);
  });

  it("downloads the whole database across a layout change", async () => {
    const served = await release(3, [], 2);
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(2), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1, 2], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "replaced", dataVersion: v(3) });
    expect(state.layout).toBe(2);
  });

  it("downloads the whole database when the app's release is older than the changesets listed", async () => {
    const served = await release(5, chain(2, 5));
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "replaced", dataVersion: v(5) });
    expect(state.applied).toEqual([]);
  });

  it("downloads the whole database when the app has none", async () => {
    const served = await release(5, chain(2, 5));
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: null, layout: null });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "replaced", dataVersion: v(5) });
  });
});

describe("createReleaseUpdater: a layout the app can't read", () => {
  it("stays on its release and downloads nothing", async () => {
    const served = await release(3, [], 2);
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(2), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

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
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "checksum" });
    expect(state.applied).toEqual([]);
  });

  it("throws away a whole database whose size is wrong", async () => {
    const served = await release(3, []);
    served.manifest.database.bytes += 1;
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "checksum" });
    expect(state.replaced).toEqual([]);
  });

  it("applies nothing when a download fails partway through the chain", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch } = fakeFetch(served, (url) => (url === served.manifest.changesets[1]!.url ? "throw" : undefined));
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "network" });
    expect(state.applied).toEqual([]);
  });

  it("stops at the last release it reached when an apply fails partway through", async () => {
    const served = await release(3, chain(0, 3));
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 }, v(2));
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(1), reason: "apply" });
    expect(state.applied).toEqual([`${v(0)}>${v(1)}`]);

    // The next run carries on from there.
    state.failApplyAt = undefined;
    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(3) });
    expect(state.applied).toEqual([`${v(0)}>${v(1)}`, `${v(1)}>${v(2)}`, `${v(2)}>${v(3)}`]);
  });

  it("keeps the old database when the replace fails", async () => {
    const served = await release(3, []);
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const failing = { ...adapter, replaceDatabase: async () => Promise.reject(new Error("disk full")) };
    const updater = createReleaseUpdater({ adapter: failing, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "replace" });
  });

  it("fails on a manifest it can't read", async () => {
    const { fetch } = fakeFetch({ manifest: { data_version: v(3) }, files: new Map() });
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "failed", dataVersion: v(0), reason: "manifest" });
  });
});

describe("createReleaseUpdater: the path", () => {
  it("takes a daily changeset when it makes the path shorter", async () => {
    const served = await release(4, [...chain(0, 4), { from: 1, to: 4, day: true }]);
    const { fetch, requests } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(4) });
    expect(state.applied).toEqual([`${v(0)}>${v(1)}`, `${v(1)}>${v(4)}`]);
    expect(requests).toHaveLength(3);
  });

  it("of two paths with as few files, takes the one through a daily changeset", async () => {
    const served = await release(3, [{ from: 0, to: 2 }, { from: 0, to: 1 }, { from: 2, to: 3 }, { from: 1, to: 3, day: true }]);
    const { fetch } = fakeFetch(served);
    const { adapter, state } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const updater = createReleaseUpdater({ adapter, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL });

    expect(await updater.update()).toEqual({ status: "updated", dataVersion: v(3) });
    expect(state.applied).toEqual([`${v(0)}>${v(1)}`, `${v(1)}>${v(3)}`]);
  });
});

describe("createReleaseUpdater: gzip", () => {
  it("hands the adapter the changeset with gzip undone", async () => {
    const served = await release(1, chain(0, 1));
    const { fetch } = fakeFetch(served);
    const seen: unknown[] = [];
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const watching = { ...adapter, applyChangeset: async (bytes: Uint8Array) => (seen.push(decode(bytes)), adapter.applyChangeset(bytes)) };
    await createReleaseUpdater({ adapter: watching, readableLayouts: [1], fetch, manifestUrl: MANIFEST_URL }).update();

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

    expect(await createReleaseUpdater({ adapter, readableLayouts: [1], fetch, gunzip, manifestUrl: MANIFEST_URL }).update()).toEqual({ status: "updated", dataVersion: v(1) });
    expect(calls).toEqual([served.manifest.changesets[0]!.bytes]);
  });

  it("fails on a download that isn't gzip", async () => {
    const served = await release(1, chain(0, 1));
    const { fetch } = fakeFetch(served);
    const { adapter } = fakeDatabase({ dataVersion: v(0), layout: 1 });
    const gunzip = () => {
      throw new Error("incorrect header check");
    };

    expect(await createReleaseUpdater({ adapter, readableLayouts: [1], fetch, gunzip, manifestUrl: MANIFEST_URL }).update()).toEqual({ status: "failed", dataVersion: v(0), reason: "gunzip" });
  });
});
