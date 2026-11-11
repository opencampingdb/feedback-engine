import { sha256HexBytes } from "./sha256.js";
import { dataVersionTime } from "./recent.js";

/** Where the data repository publishes the newest release's manifest. */
export const DEFAULT_MANIFEST_URL = "https://github.com/opencampingdb/data/releases/latest/download/manifest.json";

/**
 * The most changesets one update applies. A longer path downloads the whole
 * database instead, as does a chain whose files add up to at least the
 * database's own `bytes`.
 */
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
   * Apply the chain of changesets (each already checked and decompressed) in
   * order, inside one exclusive transaction, all or nothing: when it throws,
   * the database must be on the release it started from.
   */
  applyChangesets(chain: Uint8Array[]): Promise<void>;
  /**
   * Swap in a whole database file (already checked and decompressed) in one
   * step: when it throws, the app must still read its old database. The
   * updater holds no other copy of `bytes` and drops the download before the
   * call, so writing them to a file straight away keeps the phone's memory
   * to this one copy.
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
  /**
   * The record formats (`format_version`) this build can read. A release of
   * a format higher than all of them is not downloaded (`format_unsupported`).
   * A lower one is read, as CONNECTING.md says.
   */
  readableFormats: readonly number[];
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

/**
 * What an update did. `older_release`: the latest manifest names an older
 * release than the database holds, so nothing was downloaded or changed.
 */
export type ReleaseUpdateStatus = "up_to_date" | "updated" | "replaced" | "older_release" | "layout_unsupported" | "format_unsupported" | "failed";

/**
 * Why an update stopped. `network`: a request failed or answered other than
 * 2xx. `manifest`: the manifest is not one the updater can read. `checksum`: a
 * download's size or SHA-256 is not the manifest's. `gunzip`: a download did
 * not decompress. `read`, `apply`, `replace`: that adapter call threw.
 * `mismatch`: after the update, even after a whole database replaced a chain
 * that left the wrong release, the database names another release than the
 * manifest's.
 */
export type ReleaseUpdateReason = "network" | "manifest" | "checksum" | "gunzip" | "read" | "apply" | "replace" | "mismatch";

export interface ReleaseUpdateResult {
  status: ReleaseUpdateStatus;
  /** The release the app's database holds after the run, or null when it has none. */
  dataVersion: string | null;
  /** Set when `status` is `failed`. */
  reason?: ReleaseUpdateReason;
  /** Set when `status` is `failed`: what went wrong behind `reason`, such as the error an adapter call threw. */
  cause?: ReleaseUpdateCause;
}

/**
 * What went wrong behind a failed update's `reason`. For a thrown error, its
 * `name` and `message`. Otherwise the updater's own name for the problem
 * (`HttpStatus`, `SizeMismatch`, `ChecksumMismatch`, `ManifestInvalid`,
 * `ReleaseMismatch`) and what it found. `message` is cut to
 * `MAX_CAUSE_MESSAGE` characters. It carries no stack.
 */
export interface ReleaseUpdateCause {
  name: string;
  message: string;
}

/** The longest `cause.message` an update answers. */
export const MAX_CAUSE_MESSAGE = 500;

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
  format_version: number;
  layout_version: number;
  database: ReleaseFile;
  changesets: ChangesetEntry[];
}

class UpdateStopped extends Error {
  constructor(
    readonly reason: ReleaseUpdateReason,
    readonly detail: ReleaseUpdateCause,
  ) {
    super(reason);
  }
}

const shorten = (message: string) => (message.length > MAX_CAUSE_MESSAGE ? `${message.slice(0, MAX_CAUSE_MESSAGE - 1)}…` : message);

/** The name and message of something thrown, without its stack. */
function causeOf(error: unknown): ReleaseUpdateCause {
  if (error instanceof Error) return { name: error.name || "Error", message: shorten(String(error.message)) };
  let message: string;
  try {
    message = typeof error === "string" ? error : JSON.stringify(error) ?? String(error);
  } catch {
    message = String(error);
  }
  return { name: typeof error, message: shorten(message) };
}

const stopped = (reason: ReleaseUpdateReason, name: string, message: string) => new UpdateStopped(reason, { name, message: shorten(message) });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isFile = (value: unknown): value is ReleaseFile =>
  isRecord(value) && typeof value.url === "string" && typeof value.sha256 === "string" && Number.isInteger(value.bytes);

/**
 * The release downloads a database url sits in: the url without its last two
 * path parts (the release tag and the file), ending in "/". A shorter path,
 * as a mirror serving every file from one folder has, gives its origin.
 * Undefined for a url that is not https.
 */
function downloadsOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:") return undefined;
  const parts = parsed.pathname.split("/").slice(1, -2);
  return `${parsed.origin}/${parts.map((part) => `${part}/`).join("")}`;
}

function readManifest(value: unknown): Manifest {
  if (
    !isRecord(value) ||
    typeof value.data_version !== "string" ||
    !Number.isInteger(value.format_version) ||
    !Number.isInteger(value.layout_version) ||
    !isFile(value.database)
  ) {
    throw stopped("manifest", "ManifestInvalid", "the manifest lacks data_version, format_version, layout_version or database");
  }
  // A changeset is downloaded only from where the database is: the same release downloads
  // (for GitHub, https://github.com/<owner>/<repo>/releases/download/), so a bad entry
  // cannot send the app to another host or repository.
  const home = downloadsOf(value.database.url);
  const changesets = Array.isArray(value.changesets)
    ? value.changesets.filter(
        (entry: unknown): entry is ChangesetEntry =>
          isFile(entry) &&
          typeof (entry as unknown as Record<string, unknown>).from === "string" &&
          typeof (entry as unknown as Record<string, unknown>).to === "string" &&
          home !== undefined &&
          entry.url.startsWith(home) &&
          !/\.\.|%2e/i.test(entry.url.slice(home.length)),
      )
    : [];
  return {
    data_version: value.data_version,
    format_version: value.format_version as number,
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
  const best = new Map<string, { via: C | null; nonDaily: number }>([[from, { via: null, nonDaily: 0 }]]);
  let frontier = [from];
  while (frontier.length > 0 && !best.has(to)) {
    const level = new Map<string, { via: C; nonDaily: number }>();
    for (const at of frontier) {
      const here = best.get(at)!;
      for (const edge of changesets) {
        if (edge.from !== at || best.has(edge.to)) continue;
        const nonDaily = here.nonDaily + (edge.day ? 0 : 1);
        const known = level.get(edge.to);
        if (!known || nonDaily < known.nonDaily) level.set(edge.to, { via: edge, nonDaily });
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
  const { adapter, readableLayouts, readableFormats } = options;
  const wholeNumbers = (list: readonly number[] | undefined) => Array.isArray(list) && list.length > 0 && list.every(Number.isInteger);
  if (!wholeNumbers(readableLayouts)) throw new TypeError("createReleaseUpdater: readableLayouts must list the layout versions this build reads");
  if (!wholeNumbers(readableFormats)) throw new TypeError("createReleaseUpdater: readableFormats must list the format versions this build reads");
  const newestFormat = Math.max(...readableFormats);
  const manifestUrl = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
  const doFetch: ReleaseFetchLike = options.fetch ?? ((url, init) => (globalThis.fetch as unknown as ReleaseFetchLike)(url, init));
  let gunzipFn: Gunzip;
  if (options.gunzip) gunzipFn = options.gunzip;
  else if (typeof globalThis.DecompressionStream === "function") gunzipFn = decompressionStreamGunzip;
  else throw new TypeError("createReleaseUpdater: this runtime has no DecompressionStream, so pass a gunzip option");

  async function get(url: string, accept: string) {
    let res: Awaited<ReturnType<ReleaseFetchLike>>;
    try {
      res = await doFetch(url, { method: "GET", headers: { accept } });
    } catch (error) {
      throw new UpdateStopped("network", causeOf(error));
    }
    if (res.status < 200 || res.status >= 300) throw stopped("network", "HttpStatus", `${url} answered ${res.status}`);
    return res;
  }

  /**
   * Downloads a file, checks its size and SHA-256, and undoes gzip. The
   * download is hashed in place and is unreachable once this returns, so a
   * whole database is held at most twice (compressed and not) while gunzip
   * runs, and once after.
   */
  async function download(file: ReleaseFile): Promise<Uint8Array> {
    const res = await get(file.url, "application/octet-stream");
    let gz: Uint8Array;
    try {
      gz = new Uint8Array(await res.arrayBuffer());
    } catch (error) {
      throw new UpdateStopped("network", causeOf(error));
    }
    if (gz.length !== file.bytes) throw stopped("checksum", "SizeMismatch", `${file.url} is ${gz.length} bytes, the manifest says ${file.bytes}`);
    if (sha256HexBytes(gz) !== file.sha256.toLowerCase()) throw stopped("checksum", "ChecksumMismatch", `${file.url} does not match the manifest's SHA-256`);
    try {
      return await gunzipFn(gz);
    } catch (error) {
      throw new UpdateStopped("gunzip", causeOf(error));
    }
  }

  /** Runs an adapter call, stopping the update with `reason` when it throws. */
  async function orStop<T>(reason: ReleaseUpdateReason, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw new UpdateStopped(reason, causeOf(error));
    }
  }

  /** Downloads the whole database and swaps it in, then reads back the release it holds. */
  async function replaceWhole(manifest: Manifest): Promise<string | null> {
    const database = await download(manifest.database);
    await orStop("replace", () => adapter.replaceDatabase(database));
    return orStop("read", () => adapter.currentDataVersion());
  }

  return {
    async update(updateOptions = {}) {
      let dataVersion: string | null = null;
      try {
        dataVersion = await orStop("read", () => adapter.currentDataVersion());
        if (updateOptions.knownDataVersion !== undefined && updateOptions.knownDataVersion === dataVersion) {
          return { status: "up_to_date", dataVersion };
        }
        const res = await get(manifestUrl, "application/json");
        let body: unknown;
        try {
          body = await res.json();
        } catch (error) {
          throw new UpdateStopped("manifest", causeOf(error));
        }
        const manifest = readManifest(body);
        if (manifest.format_version > newestFormat) return { status: "format_unsupported", dataVersion };
        if (!readableLayouts.includes(manifest.layout_version)) return { status: "layout_unsupported", dataVersion };
        const layout = dataVersion === null ? null : await orStop("read", () => adapter.currentLayoutVersion());
        if (manifest.data_version === dataVersion && manifest.layout_version === layout) return { status: "up_to_date", dataVersion };
        // A manifest older than the database the app has (an older release marked latest) is never applied:
        // rolling back would bring back everything later releases took out.
        const manifestTime = dataVersionTime(manifest.data_version);
        const localTime = dataVersion === null ? undefined : dataVersionTime(dataVersion);
        if (manifestTime !== undefined && localTime !== undefined && manifestTime < localTime) return { status: "older_release", dataVersion };

        const path = dataVersion !== null && layout === manifest.layout_version ? changesetPath(manifest.changesets, dataVersion, manifest.data_version) : null;
        const chainBytes = path?.reduce((sum, entry) => sum + entry.bytes, 0) ?? 0;
        if (path && path.length > 0 && path.length <= MAX_CHANGESET_CHAIN && chainBytes < manifest.database.bytes) {
          // Download and check every file before touching the database, so a
          // failed download leaves it on its release.
          const chain: Uint8Array[] = [];
          for (const entry of path) chain.push(await download(entry));
          await orStop("apply", () => adapter.applyChangesets(chain));
          dataVersion = await orStop("read", () => adapter.currentDataVersion());
          if (dataVersion === manifest.data_version) return { status: "updated", dataVersion };
          // The chain left another release than the manifest's, as an apply
          // that settles conflicts by replacing rows can: start again from the
          // whole database.
        }
        dataVersion = await replaceWhole(manifest);
        if (dataVersion !== manifest.data_version) {
          const cause = { name: "ReleaseMismatch", message: shorten(`the database holds ${dataVersion ?? "no release"} after the replace, the manifest names ${manifest.data_version}`) };
          return { status: "failed", dataVersion, reason: "mismatch", cause };
        }
        return { status: "replaced", dataVersion };
      } catch (error) {
        const reason = error instanceof UpdateStopped ? error.reason : "read";
        const cause = error instanceof UpdateStopped ? error.detail : causeOf(error);
        // A failed chain or replace leaves the database on the release it had.
        const now = await adapter.currentDataVersion().catch(() => dataVersion);
        return { status: "failed", dataVersion: now, reason, cause };
      }
    },
  };
}
