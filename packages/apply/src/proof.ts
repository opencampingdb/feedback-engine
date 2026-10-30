import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import { isPublicHttpsUrl } from "@opencampingdb/feedback";

/**
 * Checks that an owner's code is on the page they gave as proof. Only https
 * on public host names, a timeout, a size cap, at most three redirects (each
 * checked again), and every resolved address checked before connecting, so a
 * proof page can never make the apply run reach a private network.
 */

export const USER_AGENT = "OpenCampingDB/1.0 (+https://opencampingdb.github.io/owners/; owner claim check)";
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

export interface ProofResult {
  found: boolean;
  /** When the check ran, ISO 8601 UTC. */
  checked: string;
  /** Plain English for the PR body. */
  detail: string;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
}

/** Fetches one URL with no redirect following. Throws on a network error or timeout. */
export type Transport = (url: URL, options: { headers: Record<string, string>; timeoutMs: number }) => Promise<TransportResponse>;

export interface ProofOptions {
  transport?: Transport;
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
}

function parseV4(address: string): number[] | undefined {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255) ? parts : undefined;
}

function privateV4([a, b]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a! >= 224
  );
}

/** True for loopback, private, link-local, shared, multicast and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseV4(address);
  if (v4) return privateV4(v4);
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(.+)$/.exec(lower);
  if (mapped) {
    const tail = mapped[1]!;
    const dotted = parseV4(tail);
    if (dotted) return privateV4(dotted);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return privateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    }
    return true;
  }
  if (lower === "::" || lower === "::1") return true;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

/** A URL the check may fetch: https, a public host name, no IP literal. */
function allowedUrl(url: URL): boolean {
  return isPublicHttpsUrl(url.href) && isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0;
}

/** DNS lookup that fails when any address for the name is private. */
function safeLookup(
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error, "");
    if (addresses.length === 0) return callback(new Error(`${hostname} has no address`), "");
    if (addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error(`${hostname} resolves to a private address`), "");
    }
    if (options.all) return callback(null, addresses);
    const first = addresses[0]!;
    callback(null, first.address, first.family);
  });
}

/** The real transport: node:https with the safe lookup, a timeout and no redirect following. */
export const httpsTransport: Transport = (url, options) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: options.headers,
        lookup: safeLookup as never,
        timeout: options.timeoutMs,
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      (res) => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        resolve({ status: res.statusCode ?? 0, headers, body: res });
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
    req.on("error", reject);
    req.end();
  });

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    const room = maxBytes - total;
    if (room <= 0) break;
    const piece = chunk.length > room ? chunk.slice(0, room) : chunk;
    chunks.push(piece);
    total += piece.length;
    if (total >= maxBytes) break;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

/** Fetches `proofUrl` and reports whether `code` is on the page. Never throws. */
export async function checkProof(proofUrl: string, code: string, options: ProofOptions = {}): Promise<ProofResult> {
  const transport = options.transport ?? httpsTransport;
  const checked = (options.now ?? (() => new Date()))().toISOString().replace(/\.\d{3}Z$/, "Z");
  const result = (found: boolean, detail: string): ProofResult => ({ found, checked, detail });
  const headers = { "user-agent": USER_AGENT, accept: "text/html,text/plain;q=0.9,*/*;q=0.1" };

  let url: URL;
  try {
    url = new URL(proofUrl);
  } catch {
    return result(false, "the proof address is not a valid https address");
  }
  if (!allowedUrl(url)) return result(false, "the proof address must be https on a public website");

  for (let hop = 0; ; hop++) {
    let res: TransportResponse;
    try {
      res = await transport(url, { headers, timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
    } catch (error) {
      const e = error as Error;
      if (e.name === "TimeoutError" || e.name === "AbortError") return result(false, "the page timed out");
      if (/private address/.test(e.message)) return result(false, "the page's address resolves to a private address");
      return result(false, "the page could not be fetched");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= MAX_REDIRECTS) return result(false, "too many redirects");
      let next: URL;
      try {
        next = new URL(res.headers.location, url);
      } catch {
        return result(false, "the page redirected to an address that is not valid");
      }
      if (!allowedUrl(next)) return result(false, "the page redirected to an address that is not public https");
      url = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) return result(false, `the page answered ${res.status}`);
    const text = await readCapped(res.body, options.maxBytes ?? MAX_BYTES);
    return text.toUpperCase().includes(code.toUpperCase())
      ? result(true, `code found at ${url.href}`)
      : result(false, "code not found on the page");
  }
}
