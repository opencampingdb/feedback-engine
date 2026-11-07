import { sha256HexBytes } from "./sha256.js";

/** Where the data repository publishes the newest release's manifest. */
export const DEFAULT_MANIFEST_URL = "https://github.com/opencampingdb/data/releases/latest/download/manifest.json";

/** The most changesets one update applies. A longer path downloads the whole database instead. */
export const MAX_CHANGESET_CHAIN = 50;

/**
 * The app's copy of the release database, which the updater reads and moves
 * forward. Each call works on the app's own SQLite library.
 */
export interface ReleaseDatabaseAdapter {
  /** The `data_version` in the database's `release` table, or null when the app has no database yet. */
  currentDataVersion(): Promise<string | null>;
  /** The `layout_version` in the database's `release` table, or null when the app has no database yet. */
  currentLayoutVersion(): Promise<number | null>;
  /**
   * Apply one changeset (already checked and decompressed) inside a
   * transaction, all or nothing: when it throws, the database must be as it
   * was before the call.
   */
  applyChangeset(bytes: Uint8Array): Promise<void>;
  /**
   * Swap in a whole database file (already checked and decompressed) in one
   * step: when it throws, the app must still read its old database.
   */
  replaceDatabase(bytes: Uint8Array): Promise<void>;
}

/** The fetch the updater uses: `globalThis.fetch` fits, and must follow redirects. */
export type ReleaseFetchLike = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<{
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Undoes gzip. */
export type Gunzip = (bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array;

export interface ReleaseUpdaterOptions {
  adapter: ReleaseDatabaseAdapter;
  /** The database layouts (`layout_version`) this build can read. */
  readableLayouts: readonly number[];
  /** Defaults to `DEFAULT_MANIFEST_URL`. */
  manifestUrl?: string;
  /** Defaults to `globalThis.fetch`. */
  fetch?: ReleaseFetchLike;
  /**
   * Defaults to `DecompressionStream("gzip")`. Pass one where that is missing,
   * such as in React Native.
   */
  gunzip?: Gunzip;
}

export type ReleaseUpdateStatus = "up_to_date" | "updated" | "replaced" | "layout_unsupported" | "failed";

/**
 * Why an update stopped. `network`: a request failed or answered other than
 * 2xx. `manifest`: the manifest is not one the updater can read. `checksum`: a
 * download's size or SHA-256 is not the manifest's. `gunzip`: a download did
 * not decompress. `read`, `apply`, `replace`: that adapter call threw.
 * `mismatch`: after the update, the database names another release than the
 * manifest's.
 */
export type ReleaseUpdateReason = "network" | "manifest" | "checksum" | "gunzip" | "read" | "apply" | "replace" | "mismatch";

export interface ReleaseUpdateResult {
  status: ReleaseUpdateStatus;
  /** The release the app's database holds after the run, or null when it has none. */
  dataVersion: string | null;
  /** Set when `status` is `failed`. */
  reason?: ReleaseUpdateReason;
}

export interface ReleaseUpdater {
  /**
   * Bring the app's database to the newest release. `knownDataVersion` is the
   * newest release the app has heard of (the recent list's
   * `release.data_version`): when it is the database's own, the update makes
   * no request. Never throws: every outcome is in the result.
   */
  update(options?: { knownDataVersion?: string }): Promise<ReleaseUpdateResult>;
}

interface ReleaseFile {
  url: string;
  sha256: string;
  bytes: number;
}

interface ChangesetEntry extends ReleaseFile {
  from: string;
  to: string;
  day: boolean;
}

interface Manifest {
  data_version: string;
  layout_version: number;
  database: ReleaseFile;
  changesets: ChangesetEntry[];
}

class Stop extends Error {
  constructor(readonly reason: ReleaseUpdateReason) {
    super(reason);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isFile = (value: unknown): value is ReleaseFile =>
  isRecord(value) && typeof value.url === "string" && typeof value.sha256 === "string" && Number.isInteger(value.bytes);

function readManifest(value: unknown): Manifest {
  if (!isRecord(value) || typeof value.data_version !== "string" || !Number.isInteger(value.layout_version) || !isFile(value.database)) {
    throw new Stop("manifest");
  }
  const changesets = Array.isArray(value.changesets)
    ? value.changesets.filter((entry: unknown): entry is ChangesetEntry => isFile(entry) && typeof (entry as unknown as Record<string, unknown>).from === "string" && typeof (entry as unknown as Record<string, unknown>).to === "string")
    : [];
  return {
    data_version: value.data_version,
    layout_version: value.layout_version as number,
    database: value.database,
    changesets: changesets.map((entry) => ({ ...entry, day: entry.day === true })),
  };
}

/**
 * The fewest changesets that lead from `from` to `to`, or null when none do.
 * Of two paths with as few files, the one with more daily changesets wins.
 * A breadth-first search, one level of files at a time.
 */
function changesetPath<C extends { from: string; to: string; day: boolean }>(changesets: readonly C[], from: string, to: string): C[] | null {
  if (from === to) return [];
  // For each release reached: the changeset into it and how many of the path's files are not daily.
  const best = new Map<string, { via: C | null; plain: number }>([[from, { via: null, plain: 0 }]]);
  let frontier = [from];
  while (frontier.length > 0 && !best.has(to)) {
    const level = new Map<string, { via: C; plain: number }>();
    for (const at of frontier) {
      const here = best.get(at)!;
      for (const edge of changesets) {
        if (edge.from !== at || best.has(edge.to)) continue;
        const plain = here.plain + (edge.day ? 0 : 1);
        const known = level.get(edge.to);
        if (!known || plain < known.plain) level.set(edge.to, { via: edge, plain });
      }
    }
    for (const [release, step] of level) best.set(release, step);
    frontier = [...level.keys()];
  }
  if (!best.has(to)) return null;
  const path: C[] = [];
  for (let step = best.get(to)!; step.via; step = best.get(step.via.from)!) path.unshift(step.via);
  return path;
}

async function decompressionStreamGunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The release updater: keeps the app's copy of the Open Camping DB release
 * database current from the data repository's manifest, by applying
 * changesets in order or, when that is not possible, downloading the whole
 * database. See docs/integration.md, "Keeping the data current".
 */
export function createReleaseUpdater(options: ReleaseUpdaterOptions): ReleaseUpdater {
  const { adapter, readableLayouts } = options;
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
  const doFetch: ReleaseFetchLike = options.fetch ?? ((url, init) => (globalThis.fetch as unknown as ReleaseFetchLike)(url, init));
  let gunzip = options.gunzip;
  if (!gunzip) {
    if (typeof globalThis.DecompressionStream !== "function") {
      throw new TypeError("createReleaseUpdater: this runtime has no DecompressionStream, so pass a gunzip option");
    }
    gunzip = decompressionStreamGunzip;
  }
  const undo = gunzip;

  async function get(url: string, accept: string) {
    let res: Awaited<ReturnType<ReleaseFetchLike>>;
    try {
      res = await doFetch(url, { method: "GET", headers: { accept } });
    } catch {
      throw new Stop("network");
    }
    if (res.status < 200 || res.status >= 300) throw new Stop("network");
    return res;
  }

  async function download(file: ReleaseFile): Promise<Uint8Array> {
    const res = await get(file.url, "application/octet-stream");
    let gz: Uint8Array;
    try {
      gz = new Uint8Array(await res.arrayBuffer());
    } catch {
      throw new Stop("network");
    }
    if (gz.length !== file.bytes || sha256HexBytes(gz) !== file.sha256.toLowerCase()) throw new Stop("checksum");
    try {
      return await undo(gz);
    } catch {
      throw new Stop("gunzip");
    }
  }

  async function call<T>(reason: ReleaseUpdateReason, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch {
      throw new Stop(reason);
    }
  }

  return {
    async update(updateOptions = {}) {
      let dataVersion: string | null = null;
      try {
        dataVersion = await call("read", () => adapter.currentDataVersion());
        if (updateOptions.knownDataVersion !== undefined && updateOptions.knownDataVersion === dataVersion) {
          return { status: "up_to_date", dataVersion };
        }
        const res = await get(manifestUrl, "application/json");
        const manifest = readManifest(await res.json().catch(() => undefined));
        if (!readableLayouts.includes(manifest.layout_version)) return { status: "layout_unsupported", dataVersion };
        const layout = dataVersion === null ? null : await call("read", () => adapter.currentLayoutVersion());
        if (manifest.data_version === dataVersion && manifest.layout_version === layout) return { status: "up_to_date", dataVersion };

        const path = dataVersion !== null && layout === manifest.layout_version ? changesetPath(manifest.changesets, dataVersion, manifest.data_version) : null;
        let status: ReleaseUpdateStatus;
        if (path && path.length > 0 && path.length <= MAX_CHANGESET_CHAIN) {
          // Download and check every file before touching the database, so a
          // failed download leaves it on its release.
          const changesets: Uint8Array[] = [];
          for (const entry of path) changesets.push(await download(entry));
          for (const changeset of changesets) {
            await call("apply", () => adapter.applyChangeset(changeset));
          }
          status = "updated";
        } else {
          const database = await download(manifest.database);
          await call("replace", () => adapter.replaceDatabase(database));
          status = "replaced";
        }
        dataVersion = await call("read", () => adapter.currentDataVersion());
        if (dataVersion !== manifest.data_version) return { status: "failed", dataVersion, reason: "mismatch" };
        return { status, dataVersion };
      } catch (error) {
        const reason = error instanceof Stop ? error.reason : "read";
        // After a failed step the database is on the last release it reached.
        const now = await adapter.currentDataVersion().catch(() => dataVersion);
        return { status: "failed", dataVersion: now, reason };
      }
    },
  };
}
