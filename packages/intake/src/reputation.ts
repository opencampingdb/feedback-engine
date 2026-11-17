import type { Fetch } from "./github.js";
import type { KVLike } from "./ratelimit.js";

/**
 * Network reputation: a copy of a public IP blocklist, held inside the
 * intake. The scheduled job fetches the list once a day from a CrowdSec
 * blocklist integration (plain text, one address or CIDR range per line,
 * paged with `page` and `page_size`, HTTP Basic auth with the integration's
 * own credentials) and keeps it in KV as sorted, merged integer ranges, IPv4
 * and IPv6 apart. Each request looks its address up in that table, read from
 * KV at most once every few minutes per Worker, with no outside call. A fetch
 * that fails keeps the last good list. The first fetch runs on the scheduled
 * job's first minute, and until a list exists every address is `unknown`.
 */

/** The KV key (in RATE_LIMIT) that holds the ranges. */
export const BLOCKLIST_KEY = "reputation:ranges";
/** The KV key (in RATE_LIMIT) that says when the list was fetched and last tried. */
export const BLOCKLIST_STATE_KEY = "reputation:state";
/** How old the list may be before the scheduled job fetches it again. */
export const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;
/** How long a failed fetch waits before it is tried again. The last good list is used meanwhile. */
export const RETRY_AFTER_MS = 60 * 60 * 1000;
/** How long a failed fetch waits while there is no list yet, and attested items are held for want of one. */
export const FIRST_RETRY_AFTER_MS = 5 * 60 * 1000;
/** Lines asked for per page. The integration truncates an uncompressed page of about 5 MB, some 300,000 lines. */
export const PAGE_SIZE = 100_000;
/** Pages fetched at most, so a list that never ends cannot use up the job's subrequests. */
export const MAX_PAGES = 20;
/** How long one page may take. */
export const PAGE_TIMEOUT_MS = 30_000;
/** How long a Worker keeps the ranges in memory before it reads KV again. */
export const MEMORY_TTL_MS = 5 * 60 * 1000;

/** The list's ranges: IPv4 as pairs of 32-bit numbers, IPv6 as pairs of 128-bit numbers, each sorted and merged. */
export interface Ranges {
  v4: number[];
  v6: bigint[];
}

/** What the scheduled job keeps about the list. */
interface State {
  /** When the list in KV was fetched, in ms. Absent before the first good fetch. */
  fetched?: number;
  /** When a fetch was last tried, in ms. */
  attempted: number;
}

/** Whether the request's address is on the list: `unknown` when the list could not be read. */
export type Standing = "listed" | "clear" | "unknown";

/** The list's settings: on only with both the integration's URL and its credentials. */
export interface ReputationConfig {
  url: string;
  credentials: string;
}

export function reputationConfig(env: { CROWDSEC_BLOCKLIST_URL?: string; CROWDSEC_BLOCKLIST_CREDENTIALS?: string }): ReputationConfig | undefined {
  const url = env.CROWDSEC_BLOCKLIST_URL?.trim();
  const credentials = env.CROWDSEC_BLOCKLIST_CREDENTIALS?.trim();
  return url && credentials ? { url, credentials } : undefined;
}

/** An IPv4 address as a 32-bit number, or undefined. */
function parseV4(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    value = value * 256 + n;
  }
  return value;
}

/** An IPv6 address as a 128-bit number, or undefined. Takes `::` and a dotted IPv4 tail. */
function parseV6(text: string): bigint | undefined {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return undefined;
  let words: number[] = [];
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const group = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [i, piece] of pieces.entries()) {
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseV4(piece);
        if (v4 === undefined) return undefined;
        out.push(Math.floor(v4 / 65536), v4 % 65536);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        out.push(parseInt(piece, 16));
      } else {
        return undefined;
      }
    }
    return out;
  };
  const head = group(halves[0]!);
  const tail = halves.length === 2 ? group(halves[1]!) : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 2) {
    if (head.length + tail.length > 7) return undefined;
    words = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  } else {
    words = head;
  }
  if (words.length !== 8) return undefined;
  return words.reduce((acc, w) => (acc << 16n) | BigInt(w), 0n);
}

const V6_ALL = (1n << 128n) - 1n;
/** ::ffff:0:0/96, where IPv6 carries an IPv4 address. */
const V4_MAPPED = 0xffffn << 32n;

/** One line of the list as a range, or undefined for a line that is neither an address nor a CIDR range. */
export function parseEntry(line: string): { family: 4; start: number; end: number } | { family: 6; start: bigint; end: bigint } | undefined {
  const text = line.trim();
  if (text === "") return undefined;
  const [address, prefix, ...rest] = text.split("/");
  if (rest.length > 0 || address === undefined) return undefined;
  if (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) return undefined;
  const v4 = parseV4(address);
  if (v4 !== undefined) {
    const bits = prefix === undefined ? 32 : Number(prefix);
    if (bits > 32) return undefined;
    const size = 2 ** (32 - bits);
    const start = v4 - (v4 % size);
    return { family: 4, start, end: start + size - 1 };
  }
  const v6 = parseV6(address);
  if (v6 === undefined) return undefined;
  const bits = prefix === undefined ? 128 : Number(prefix);
  if (bits > 128) return undefined;
  const host = bits === 128 ? 0n : V6_ALL >> BigInt(bits);
  return { family: 6, start: v6 & (V6_ALL ^ host), end: (v6 & (V6_ALL ^ host)) | host };
}

/** Sorts `[start, end]` pairs and merges the ones that overlap or touch, flattened. */
function merge<T extends number | bigint>(pairs: [T, T][], next: (end: T) => T): T[] {
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out: T[] = [];
  for (const [start, end] of pairs) {
    const last = out.length - 1;
    if (last >= 0 && start <= next(out[last]!)) {
      if (end > out[last]!) out[last] = end;
    } else {
      out.push(start, end);
    }
  }
  return out;
}

/** The list's lines as sorted, merged ranges, and how many lines were neither an address nor a range. */
export function buildRanges(lines: Iterable<string>): { ranges: Ranges; entries: number; skipped: number } {
  const v4: [number, number][] = [];
  const v6: [bigint, bigint][] = [];
  let entries = 0;
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const entry = parseEntry(line);
    if (entry === undefined) {
      skipped += 1;
      continue;
    }
    entries += 1;
    if (entry.family === 4) v4.push([entry.start, entry.end]);
    else if (entry.start >= V4_MAPPED && entry.end <= (V4_MAPPED | 0xffffffffn)) v4.push([Number(entry.start - V4_MAPPED), Number(entry.end - V4_MAPPED)]);
    else v6.push([entry.start, entry.end]);
  }
  return { ranges: { v4: merge(v4, (n) => n + 1), v6: merge(v6, (n) => n + 1n) }, entries, skipped };
}

/** Ranges as KV keeps them: base64 of big-endian 4-byte (IPv4) and 16-byte (IPv6) numbers. */
function encode(ranges: Ranges, fetched: number): string {
  const v4 = new Uint8Array(ranges.v4.length * 4);
  const view = new DataView(v4.buffer);
  ranges.v4.forEach((n, i) => view.setUint32(i * 4, n));
  const v6 = new Uint8Array(ranges.v6.length * 16);
  const view6 = new DataView(v6.buffer);
  ranges.v6.forEach((n, i) => {
    view6.setBigUint64(i * 16, n >> 64n);
    view6.setBigUint64(i * 16 + 8, n & 0xffffffffffffffffn);
  });
  return JSON.stringify({ fetched, v4: toBase64(v4), v6: toBase64(v6) });
}

function decode(text: string): Ranges {
  const stored = JSON.parse(text) as { v4: string; v6: string };
  const v4 = fromBase64(stored.v4);
  const v6 = fromBase64(stored.v6);
  if (v4.length % 8 !== 0 || v6.length % 32 !== 0) throw new Error("the stored blocklist is damaged");
  const view = new DataView(v4.buffer, v4.byteOffset, v4.byteLength);
  const view6 = new DataView(v6.buffer, v6.byteOffset, v6.byteLength);
  return {
    v4: Array.from({ length: v4.length / 4 }, (_, i) => view.getUint32(i * 4)),
    v6: Array.from({ length: v6.length / 16 }, (_, i) => (view6.getBigUint64(i * 16) << 64n) | view6.getBigUint64(i * 16 + 8)),
  };
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Whether `value` falls in one of the sorted `[start, end]` pairs. */
function within<T extends number | bigint>(pairs: readonly T[], value: T): boolean {
  let low = 0;
  let high = pairs.length / 2 - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (value < pairs[mid * 2]!) high = mid - 1;
    else if (value > pairs[mid * 2 + 1]!) low = mid + 1;
    else return true;
  }
  return false;
}

/** Whether `address` (IPv4, or IPv6 with IPv4-mapped addresses read as IPv4) is in `ranges`. */
export function isListed(ranges: Ranges, address: string): boolean {
  const v4 = parseV4(address);
  if (v4 !== undefined) return within(ranges.v4, v4);
  const v6 = parseV6(address);
  if (v6 === undefined) return false;
  if (v6 >= V4_MAPPED && v6 <= (V4_MAPPED | 0xffffffffn)) return within(ranges.v4, Number(v6 - V4_MAPPED));
  return within(ranges.v6, v6);
}

/**
 * Looks addresses up in the list KV holds. Each Worker keeps the ranges in
 * memory for MEMORY_TTL_MS, so most requests read nothing at all. Until the
 * first list is fetched every address is `unknown`, and KV is read again on
 * each request, so the list counts as soon as it is there. A list that
 * cannot be read gives `unknown` too.
 */
export function createReputation(now: () => number) {
  let cached: { ranges: Ranges; at: number } | undefined;
  return async function standing(kv: KVLike, address: string): Promise<Standing> {
    const nowMs = now();
    if (!cached || nowMs - cached.at >= MEMORY_TTL_MS) {
      try {
        const text = await kv.get(BLOCKLIST_KEY);
        if (text === null) return "unknown";
        cached = { ranges: decode(text), at: nowMs };
      } catch (error) {
        console.warn(`reading the blocklist failed: ${String(error)}`);
        return "unknown";
      }
    }
    if (address === "") return "clear";
    return isListed(cached.ranges, address) ? "listed" : "clear";
  };
}

/** Reads one page: its lines, or throws for a status other than 200 or 204. */
async function fetchPage(fetchFn: Fetch, config: ReputationConfig, page: number): Promise<string[]> {
  const url = new URL(config.url);
  url.searchParams.set("page", String(page));
  url.searchParams.set("page_size", String(PAGE_SIZE));
  const response = await fetchFn(url.toString(), {
    headers: { authorization: `Basic ${btoa(config.credentials)}`, accept: "text/plain" },
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (response.status === 204) return [];
  if (response.status !== 200) throw new Error(`the blocklist answered ${response.status}`);
  return (await response.text()).split(/\r?\n/).filter((line) => line.trim() !== "");
}

/**
 * Fetches the list when it is a day old (or was never fetched) and the last
 * failed try was at least RETRY_AFTER_MS ago (FIRST_RETRY_AFTER_MS while
 * there is no list yet), and stores its ranges. A fetch
 * that fails, or that finds no address at all, keeps the last good list.
 * Never throws. Returns what it did.
 */
export async function refreshBlocklist(
  deps: { fetch: Fetch; now: () => number },
  env: { RATE_LIMIT: KVLike; CROWDSEC_BLOCKLIST_URL?: string; CROWDSEC_BLOCKLIST_CREDENTIALS?: string },
): Promise<"off" | "fresh" | "waiting" | "refreshed" | "failed"> {
  const config = reputationConfig(env);
  if (!config) return "off";
  const kv = env.RATE_LIMIT;
  const nowMs = deps.now();
  let state: State | undefined;
  try {
    const text = await kv.get(BLOCKLIST_STATE_KEY);
    state = text === null ? undefined : (JSON.parse(text) as State);
  } catch (error) {
    console.warn(`reading the blocklist state failed: ${String(error)}`);
    return "failed";
  }
  if (state?.fetched !== undefined && nowMs - state.fetched < REFRESH_EVERY_MS) return "fresh";
  const retryAfter = state?.fetched === undefined ? FIRST_RETRY_AFTER_MS : RETRY_AFTER_MS;
  if (state && state.attempted !== state.fetched && nowMs - state.attempted < retryAfter) return "waiting";
  try {
    const lines: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const got = await fetchPage(deps.fetch, config, page);
      lines.push(...got);
      if (got.length < PAGE_SIZE) break;
      if (page === MAX_PAGES) console.warn(`the blocklist has more than ${MAX_PAGES} pages of ${PAGE_SIZE}, so only those are kept`);
    }
    const { ranges, entries, skipped } = buildRanges(lines);
    if (entries === 0) throw new Error("the blocklist had no addresses");
    if (skipped > 0) console.warn(`the blocklist had ${skipped} line(s) that are not addresses, left out`);
    await kv.put(BLOCKLIST_KEY, encode(ranges, nowMs));
    await kv.put(BLOCKLIST_STATE_KEY, JSON.stringify({ fetched: nowMs, attempted: nowMs } satisfies State));
    return "refreshed";
  } catch (error) {
    const age = state?.fetched === undefined ? "no list yet" : `keeping the list from ${new Date(state.fetched).toISOString()}`;
    console.warn(`fetching the blocklist failed, ${age}: ${String(error)}`);
    await kv
      .put(BLOCKLIST_STATE_KEY, JSON.stringify({ ...(state?.fetched !== undefined ? { fetched: state.fetched } : {}), attempted: nowMs } satisfies State))
      .catch(() => undefined);
    return "failed";
  }
}
