/**
 * Serves published photos from the serving bucket:
 * `GET /v1/photos/<pho_id>/full.jpg` and `/thumb.jpg`, and a place's visible
 * photo records at `GET /v1/places/<place id>/photos.ndjson`. A request carries a
 * photo pass from the intake in `x-photo-pass` (apps on phones), or a photo
 * key in `x-app-key` (servers, which can keep a key secret). Answers come from the edge cache when they can.
 * Reads that reach R2 are counted per app per day, and above the app's
 * `daily_limit` or the server's `DAILY_READ_CAP` the server answers 503 until
 * midnight UTC. Putting `off` in STATE stops all serving within a minute, and
 * a `withheld:<photo id>` key stops one photo, cache or not, and a
 * `withheld-contributor:<contributor>` key (an erasure) stops every photo
 * from that contributor and leaves their lines out of the records. A
 * `replaced:<photo id>:<place id>:<generation>` key, written when a photo's
 * files are replaced, moves that photo and its place's records to new cache
 * entries within a minute, so the edge serves the new files.
 */

import { isPlaceId } from "@opencampingdb/feedback";
import { verifyPass } from "../../intake/src/pass.js";

/** The parts of an R2 bucket binding the server uses. */
export interface BucketLike {
  get(key: string): Promise<{ body: ReadableStream; httpEtag: string; size: number; customMetadata?: Record<string, string> } | null>;
}

/** The parts of a Workers KV namespace the server uses. */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

/** Prefix of the STATE keys that withhold one photo each (set by the intake or a person). */
export const WITHHELD_PREFIX = "withheld:";
/**
 * Prefix of the STATE keys that withhold every photo from one contributor,
 * set by the intake on an erasure. A photo's contributor is the `contributor`
 * metadata its files carry from the upload.
 */
export const WITHHELD_CONTRIBUTOR_PREFIX = "withheld-contributor:";
/** Header the cached copy of a photo keeps its contributor in. Never sent to the app. */
const CONTRIBUTOR_HEADER = "x-photo-contributor";
/**
 * Prefix of the STATE keys that name a photo whose files were replaced:
 * `replaced:<photo id>:<place id>:<generation>`, written by
 * `ocdb-photos replace` (packages/apply/src/photo-replace.ts).
 */
export const REPLACED_PREFIX = "replaced:";

/** A Workers rate limiting binding. */
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

export interface Env {
  PHOTOS: BucketLike;
  /**
   * Secret. JSON map of photo key to `{ "app": "<name>", "daily_limit": <reads a day> }`.
   * An app that uses passes needs an entry too, for its daily limit.
   */
  PHOTO_KEYS: string;
  /** Secret, the same as the intake's. Checks photo passes. */
  PHOTO_PASS_SECRET?: string;
  STATE: KVLike;
  PER_IP?: RateLimiterLike;
  /** Most R2 reads a day across every app. */
  DAILY_READ_CAP?: string;
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface Deps {
  now: () => number;
  cache: () => CacheLike;
  /** Which of the counter shards this isolate writes. */
  shard?: number;
}

interface PhotoKey {
  app: string;
  daily_limit: number;
}

/** Shards per app per day, so isolates rarely write the same KV key at once. */
export const SHARDS = 16;
/** How long an isolate trusts its copy of the off switch and the day's totals. */
export const STATE_TTL_MS = 60_000;
/** An isolate writes its count after this many reads, or after STATE_TTL_MS. */
export const FLUSH_EVERY = 50;
/** How long the edge and the app may keep a photo. A removed photo stops being served within this. */
export const MAX_AGE_SECONDS = 24 * 60 * 60;

const ROUTE = /^\/v1\/photos\/(pho_[0-9A-HJKMNP-TV-Z]{26})\/(full|thumb)\.jpg$/;
/** A place's visible photo records, as the sync tool writes them to `records/<place id>.ndjson`. */
const RECORDS_ROUTE = /^\/v1\/places\/([A-Za-z0-9_]{1,64})\/photos\.ndjson$/;
/** How long the edge and the app may keep a place's records. */
export const RECORDS_MAX_AGE_SECONDS = 5 * 60;
const APP_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export function parsePhotoKeys(raw: string): Map<string, PhotoKey> {
  const out = new Map<string, PhotoKey>();
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return out;
  for (const [key, value] of Object.entries(parsed)) {
    const entry = value as Partial<PhotoKey>;
    if (key.length >= 16 && typeof entry.app === "string" && APP_NAME.test(entry.app) && typeof entry.daily_limit === "number" && entry.daily_limit > 0) {
      out.set(key, { app: entry.app, daily_limit: entry.daily_limit });
    }
  }
  return out;
}

function answer(status: number, error: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

/** The names after `prefix` of every STATE key that has it. */
async function keysAfter(state: KVLike, prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await state.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const { name } of page.keys) out.push(name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** The latest replacement of each photo and of each place's records, from the `replaced:` keys. */
async function replacements(state: KVLike): Promise<{ photos: Map<string, number>; places: Map<string, number> }> {
  const photos = new Map<string, number>();
  const places = new Map<string, number>();
  for (const name of await keysAfter(state, REPLACED_PREFIX)) {
    const [photo, place, generation] = name.split(":");
    const n = Number(generation);
    if (!photo || !place || !Number.isSafeInteger(n)) continue;
    photos.set(photo, Math.max(photos.get(photo) ?? 0, n));
    places.set(place, Math.max(places.get(place) ?? 0, n));
  }
  return { photos, places };
}

function secondsToMidnightUtc(nowMs: number): number {
  const d = new Date(nowMs);
  return Math.max(1, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - nowMs) / 1000));
}

export function createHandler(deps: Deps) {
  const shard = deps.shard ?? Math.floor(Math.random() * SHARDS);
  // This isolate's view of the state, refreshed every STATE_TTL_MS.
  let checkedAt = -Infinity;
  let day = "";
  let off = false;
  let withheld = new Set<string>();
  let replaced = { photos: new Map<string, number>(), places: new Map<string, number>() };
  let withheldContributors = new Set<string>();
  let totals = new Map<string, number>();
  // Reads this isolate made that are not written to KV yet, per app.
  const unsent = new Map<string, number>();
  // What this isolate has written to its own shard today, per app.
  const written = new Map<string, number>();
  // Reads this isolate made that `totals` does not hold yet, per app.
  let since = new Map<string, number>();
  let lastFlush = 0;

  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const counterKey = (d: string, app: string, s: number) => `reads:${d}:${app}:${s}`;

  async function refresh(env: Env, apps: Iterable<string>, nowMs: number): Promise<void> {
    const today = dayOf(nowMs);
    if (today !== day) {
      day = today;
      written.clear();
      unsent.clear();
      since = new Map();
      totals = new Map();
      checkedAt = -Infinity;
    }
    if (nowMs - checkedAt < STATE_TTL_MS) return;
    checkedAt = nowMs;
    off = (await env.STATE.get("off")) !== null;
    withheld = new Set(await keysAfter(env.STATE, WITHHELD_PREFIX));
    replaced = await replacements(env.STATE);
    withheldContributors = new Set(await keysAfter(env.STATE, WITHHELD_CONTRIBUTOR_PREFIX));
    const next = new Map<string, number>();
    for (const app of new Set(apps)) {
      const counts = await Promise.all(Array.from({ length: SHARDS }, (_, s) => env.STATE.get(counterKey(day, app, s))));
      next.set(app, counts.reduce((n, c) => n + Number(c ?? 0), 0));
    }
    totals = next;
    // Reads not written yet are still missing from the totals just read.
    since = new Map(unsent);
  }

  async function flush(env: Env, nowMs: number): Promise<void> {
    lastFlush = nowMs;
    const batch = [...unsent];
    unsent.clear();
    for (const [app, count] of batch) {
      const total = (written.get(app) ?? 0) + count;
      written.set(app, total);
      // Only this isolate writes its shard, so the total it keeps is the value.
      // Another isolate that picked the same shard can overwrite it: the cap
      // then undercounts, which the per-address limit and the cap's margin allow for.
      await env.STATE.put(counterKey(day, app, shard), String(total), { expirationTtl: 3 * 24 * 60 * 60 }).catch(() => undefined);
    }
  }

  return async function handle(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") return answer(405, "method_not_allowed", { allow: "GET, HEAD" });
    const url = new URL(request.url);
    const photo = ROUTE.exec(url.pathname);
    const records = photo ? null : RECORDS_ROUTE.exec(url.pathname);
    if (!photo && !(records && isPlaceId(records[1]!))) return answer(404, "not_found");

    let keys: Map<string, PhotoKey>;
    try {
      keys = parsePhotoKeys(env.PHOTO_KEYS);
    } catch {
      return answer(500, "misconfigured");
    }
    const nowMs = deps.now();
    let key = keys.get(request.headers.get("x-app-key") ?? "");
    const pass = request.headers.get("x-photo-pass");
    if (!key && pass && env.PHOTO_PASS_SECRET) {
      const checked = await verifyPass(env.PHOTO_PASS_SECRET, pass, nowMs);
      if (!checked) return answer(401, "invalid_pass");
      key = [...keys.values()].find((k) => k.app === checked.app);
    }
    if (!key) return answer(401, "invalid_app_key");

    const address = request.headers.get("cf-connecting-ip") ?? "";
    if (env.PER_IP && address && !(await env.PER_IP.limit({ key: address })).success) return answer(429, "rate_limited", { "retry-after": "60" });

    const apps = [...keys.values()].map((k) => k.app);
    await refresh(env, apps, nowMs);
    if (off) return answer(503, "paused", { "retry-after": "3600" });
    // Checked before the cache, so a withheld photo stops at once, not when its cache entry ends.
    if (photo && withheld.has(photo[1]!)) return answer(404, "not_found");

    // The cache key is the photo alone: no app key, no query string. A replaced photo, and its
    // place's records, get a cache key of their own, so nothing cached before the replacement is used.
    const generation = photo ? replaced.photos.get(photo[1]!) : replaced.places.get(records![1]!);
    const cacheKey = new Request(`${url.origin}${url.pathname}${generation ? `?replaced=${generation}` : ""}`, { method: "GET" });
    const cache = deps.cache();
    const hit = await cache.match(cacheKey);
    if (hit) {
      if (photo && withheldContributors.has(hit.headers.get(CONTRIBUTOR_HEADER) ?? "")) return answer(404, "not_found");
      return send(records ? await withoutWithheld(hit) : hit, request.method);
    }

    const cap = Number(env.DAILY_READ_CAP ?? "0");
    const all = [...totals.values()].reduce((n, c) => n + c, 0) + [...since.values()].reduce((n, c) => n + c, 0);
    const mine = (totals.get(key.app) ?? 0) + (since.get(key.app) ?? 0);
    if ((cap > 0 && all >= cap) || mine >= key.daily_limit) {
      return answer(503, "daily_read_cap", { "retry-after": String(secondsToMidnightUtc(nowMs)) });
    }

    const object = await env.PHOTOS.get(photo ? `${photo[1]}/${photo[2]}.jpg` : `records/${records![1]}.ndjson`);
    unsent.set(key.app, (unsent.get(key.app) ?? 0) + 1);
    since.set(key.app, (since.get(key.app) ?? 0) + 1);
    const pendingReads = [...unsent.values()].reduce((n, c) => n + c, 0);
    if (pendingReads >= FLUSH_EVERY || nowMs - lastFlush >= STATE_TTL_MS) ctx.waitUntil(flush(env, nowMs));
    if (!object && photo) return answer(404, "not_found");
    const contributor = object?.customMetadata?.contributor;

    // A place without a records file has no visible photos: an empty list, cached like any other.
    const response = new Response(object ? object.body : "", {
      status: 200,
      headers: {
        "content-type": photo ? "image/jpeg" : "application/x-ndjson; charset=utf-8",
        "content-length": String(object ? object.size : 0),
        ...(object ? { etag: object.httpEtag } : {}),
        "cache-control": `public, max-age=${photo ? MAX_AGE_SECONDS : RECORDS_MAX_AGE_SECONDS}`,
        "x-content-type-options": "nosniff",
        ...(photo && contributor ? { [CONTRIBUTOR_HEADER]: contributor } : {}),
      },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    if (photo && contributor && withheldContributors.has(contributor)) return answer(404, "not_found");
    return send(records ? await withoutWithheld(response) : response, request.method);
  };

  /** The answer as the app gets it: without the cached copy's contributor, and with no body for HEAD. */
  function send(response: Response, method: string): Response {
    const headers = new Headers(response.headers);
    headers.delete(CONTRIBUTOR_HEADER);
    return new Response(method === "HEAD" ? null : response.body, { status: response.status, headers });
  }

  /** A place's records without the lines of withheld contributors. Unchanged while none are. */
  async function withoutWithheld(response: Response): Promise<Response> {
    if (withheldContributors.size === 0) return response;
    const text = await response.text();
    const kept = text
      .split("\n")
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          return !withheldContributors.has(String((JSON.parse(line) as { contributor?: unknown }).contributor));
        } catch {
          return true;
        }
      })
      .map((line) => `${line}\n`)
      .join("");
    const headers = new Headers(response.headers);
    headers.set("content-length", String(new TextEncoder().encode(kept).length));
    headers.delete("etag");
    return new Response(kept, { status: response.status, headers });
  }
}

const handle = createHandler({
  now: () => Date.now(),
  cache: () => (caches as unknown as { default: CacheLike }).default,
});

export default {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handle(request, env, ctx);
  },
};
