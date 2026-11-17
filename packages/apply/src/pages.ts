import { websiteHost } from "@opencampingdb/feedback";

/**
 * Reading other people's web pages: the one path the contact checks, the AI
 * reviewer's look at a place's own website and the Overture candidate check
 * share. Pure functions over an injected `fetch`, with no Node APIs, so both
 * the apply run and the intake's Worker use them. The fetch decides which
 * addresses can be reached: in the apply it is `transportFetch` in proof.ts,
 * which checks every resolved address and never reaches a private network.
 */

/** A fetch as Workers and Node have it. Pages are only ever fetched with these options. */
export type Fetch = (url: string, init: { signal: AbortSignal; redirect: "manual"; headers: Record<string, string> }) => Promise<Response>;

/** Redirects a page may take, each on the same host. */
export const MAX_REDIRECTS = 3;

/** Names for hosts on a local or private network, never on the public web. */
const PRIVATE_NAMES = ["localhost", "local", "internal", "home.arpa"];

/** `text` with every character a regular expression gives a meaning to escaped. */
export const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The URL when it is an http or https address on a public host name and the
 * default port, with no user name or password, or null. An IP address, a
 * name without a dot and a name of a local network are never public.
 */
export function publicUrl(text: string, base?: URL): URL | null {
  let url: URL;
  try {
    url = new URL(text, base);
  } catch {
    return null;
  }
  // A trailing dot names the same host ("localhost." is localhost).
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.port) return null;
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)) return null;
  if (PRIVATE_NAMES.some((name) => host === name || host.endsWith(`.${name}`))) return null;
  return url;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  commat: "@",
  period: ".",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
};

/** `text` with numeric character references and the common named ones decoded. A control character's reference becomes a space. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** `html` without comments, scripts, styles and other parts a visitor never reads. Tags are kept. */
export function withoutHidden(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

/** What a visitor reads of `html`: `withoutHidden`, tags replaced with spaces, entities decoded and spacing folded. */
export function visibleText(html: string): string {
  return decodeEntities(withoutHidden(html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Reads at most `max` bytes of a response's body, and stops the rest. */
export async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, max - size));
    size += Math.min(value.byteLength, max - size);
  }
  await reader.cancel().catch(() => undefined);
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Why a page could not be read, in plain words for a review PR or a model. */
export class PageProblem extends Error {}

export interface PageOptions {
  signal: AbortSignal;
  userAgent: string;
  maxBytes: number;
  /** Refuse an answer that is not HTML or plain text. */
  pagesOnly?: boolean;
}

/**
 * The text of the page at `start`, following redirects on the same host
 * (with or without `www.`), at most MAX_REDIRECTS. Throws PageProblem with
 * why it could not be read, or the fetch's own error.
 */
export async function fetchPage(fetch: Fetch, start: URL, options: PageOptions): Promise<string> {
  const host = websiteHost(start);
  let url = start;
  for (let hops = 0; ; hops++) {
    const res = await fetch(url.href, {
      redirect: "manual",
      signal: options.signal,
      headers: { accept: "text/html,text/plain;q=0.9", "user-agent": options.userAgent },
    });
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get("location");
      const next = location ? publicUrl(location, url) : null;
      if (!next || websiteHost(next) !== host) throw new PageProblem("it redirects to another host");
      if (hops >= MAX_REDIRECTS) throw new PageProblem("it redirects too many times");
      url = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new PageProblem(`it answered ${res.status}`);
    }
    if (options.pagesOnly) {
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!type.includes("text/html") && !type.includes("text/plain") && !type.includes("application/xhtml")) {
        await res.body?.cancel().catch(() => undefined);
        throw new PageProblem("it is not a web page");
      }
    }
    return readLimited(res, options.maxBytes);
  }
}

/** What `timeLimit` rejects with when the time runs out. */
export class TimedOut extends Error {
  constructor() {
    super("timed out");
    this.name = "TimeoutError";
  }
}

/**
 * `work`, given an abort signal that fires after `ms`, or a rejection with
 * TimedOut when the time runs out first. The signal is aborted once it is
 * done either way, so nothing is left running.
 */
export async function timeLimit<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimedOut());
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), late]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** `timeLimit`, giving what `timedOut` makes when the time runs out and what `failed` makes of an error `work` throws. */
export async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>, timedOut: () => T, failed: (error: unknown) => T): Promise<T> {
  try {
    return await timeLimit(ms, work);
  } catch (error) {
    return error instanceof TimedOut ? timedOut() : failed(error);
  }
}
