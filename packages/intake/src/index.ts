import {
  isOwnerSubmission,
  stripContactDetails,
  validateSubmission,
  type FeedbackSubmission,
  type OwnerSubmission,
  type StoredFeedback,
  type StoredOwnerSubmission,
} from "@opencampingdb/feedback";
import { GitHubApp, type Fetch, type GitHubAppConfig } from "./github.js";
import { checkAndCount, type KVLike } from "./ratelimit.js";
import { ulid } from "./ulid.js";

export interface Env {
  /**
   * Secret. JSON map of app key to `{ "app": "<name>", "daily_limit": <number> }`,
   * optionally with `owner_daily_limit` and `kinds` (`["feedback"]`, `["owner"]` or both).
   */
  APP_KEYS: string;
  /** Secret. Salt for hashing device ids. */
  DEVICE_SALT: string;
  GH_APP_ID: string;
  GH_APP_PRIVATE_KEY: string;
  GH_INSTALLATION_ID: string;
  /** `owner/name` of the private inbox repository. */
  INBOX_REPO: string;
  INBOX_BRANCH?: string;
  /** Comma separated list of allowed web origins, or `*`. */
  ALLOWED_ORIGINS?: string;
  RATE_LIMIT: KVLike;
}

type SubmissionKind = "feedback" | "owner";

interface AppEntry {
  app: string;
  daily_limit: number;
  /** Daily limit for owner submissions, counted apart from other feedback. Defaults to `daily_limit`. */
  owner_daily_limit?: number;
  /** Kinds of submission the key may send. Every kind when left out. */
  kinds?: SubmissionKind[];
}

const isLimit = (v: unknown): v is number => typeof v === "number" && v > 0;

export const MAX_BODY_BYTES = 16 * 1024;
const APP_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface Deps {
  fetch: Fetch;
  now: () => number;
  randomBytes?: (n: number) => Uint8Array;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const allowed = (env.ALLOWED_ORIGINS ?? "*").split(",").map((o) => o.trim()).filter(Boolean);
  if (allowed.includes("*")) return { "access-control-allow-origin": "*" };
  if (allowed.includes(origin)) return { "access-control-allow-origin": origin, vary: "Origin" };
  return {};
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });
}

export function parseAppKeys(raw: string): Map<string, AppEntry> {
  const parsed: unknown = JSON.parse(raw);
  const out = new Map<string, AppEntry>();
  if (typeof parsed !== "object" || parsed === null) return out;
  for (const [key, value] of Object.entries(parsed)) {
    const entry = value as Partial<AppEntry>;
    const kindsValid =
      entry.kinds === undefined ||
      (Array.isArray(entry.kinds) && entry.kinds.length > 0 && entry.kinds.every((k) => k === "feedback" || k === "owner"));
    if (
      key.length >= 16 &&
      typeof entry.app === "string" &&
      APP_NAME.test(entry.app) &&
      isLimit(entry.daily_limit) &&
      (entry.owner_daily_limit === undefined || isLimit(entry.owner_daily_limit)) &&
      kindsValid
    ) {
      out.set(key, {
        app: entry.app,
        daily_limit: entry.daily_limit,
        ...(entry.owner_daily_limit !== undefined ? { owner_daily_limit: entry.owner_daily_limit } : {}),
        ...(entry.kinds !== undefined ? { kinds: [...entry.kinds] } : {}),
      });
    }
  }
  return out;
}

/**
 * The client's network: an IPv4 address cut to its /24 (`203.0.113`), an IPv6
 * address to its /48 (`2001:db8:1`). Undefined when `ip` is not an address.
 */
export function networkPrefix(ip: string): string | undefined {
  const text = ip.trim().toLowerCase();
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    return parts.every((p) => p <= 255) ? parts.slice(0, 3).join(".") : undefined;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  return groups.slice(0, 3).map((g) => parseInt(g, 16).toString(16)).join(":");
}

/** SHA-256 of salt and device id, first 16 hex characters. */
export async function hashDevice(salt: string, device: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${device.toLowerCase()}`));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 of the token text, as lower case hex. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Code and token for a claim or listing. The code (`OCDB-` and 4 Crockford
 * characters) goes on the owner's own page. The token is 32 random bytes,
 * base64url, returned once and stored only as its SHA-256.
 */
export function newOwnerSecrets(randomBytes: (n: number) => Uint8Array): { code: string; token: string } {
  const codeBytes = randomBytes(4);
  const code = `OCDB-${[...codeBytes].map((b) => CROCKFORD[b % 32]).join("")}`;
  return { code, token: base64url(randomBytes(32)) };
}

/**
 * The stored form of an owner submission. Contact details stay (the inbox is
 * private). A claim or listing gains the code and token hash; an update has its
 * token replaced by the hash.
 */
async function storeOwner(
  submission: OwnerSubmission,
  fields: { id: string; received: string; app: string; device: string },
  secrets: { code: string; token: string } | undefined,
): Promise<StoredOwnerSubmission> {
  const { device: _device, ...rest } = submission;
  if (rest.type === "owner_update") {
    const { token, ...withoutToken } = rest;
    return { ...fields, ...withoutToken, token_sha256: await hashToken(token) };
  }
  return { ...fields, ...rest, code: secrets!.code, token_sha256: await hashToken(secrets!.token) };
}

/** Removes contact details from every free text field. */
export function sanitise(submission: FeedbackSubmission): FeedbackSubmission {
  if (submission.type === "report" && submission.report.note !== undefined) {
    return { ...submission, report: { ...submission.report, note: stripContactDetails(submission.report.note) } };
  }
  if (submission.type === "review") {
    return { ...submission, review: { ...submission.review, text: stripContactDetails(submission.review.text) } };
  }
  return submission;
}

export function createHandler(deps: Deps) {
  const github = new GitHubApp(deps.fetch, deps.now);

  return async function handle(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-app-key",
          "access-control-max-age": "86400",
        },
      });
    }
    if (url.pathname !== "/v1/feedback") return json(404, { error: "not_found" }, cors);
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { ...cors, allow: "POST, OPTIONS" });

    let apps: Map<string, AppEntry>;
    try {
      apps = parseAppKeys(env.APP_KEYS);
    } catch {
      return json(500, { error: "misconfigured" }, cors);
    }
    const app = apps.get(request.headers.get("x-app-key") ?? "");
    if (!app) return json(401, { error: "invalid_app_key" }, cors);

    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, { error: "too_large" }, cors);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(413, { error: "too_large" }, cors);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid", details: ["body must be JSON"] }, cors);
    }
    const checked = validateSubmission(body);
    if (!checked.ok) return json(400, { error: "invalid", details: checked.errors }, cors);

    const nowMs = deps.now();
    const received = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const day = received.slice(0, 10);
    const device = await hashDevice(env.DEVICE_SALT, checked.value.device);
    // Cloudflare sets CF-Connecting-IP to the client address. Only a salted hash of its network is kept.
    const network = networkPrefix(request.headers.get("cf-connecting-ip") ?? "");
    const origin = network === undefined ? undefined : await hashDevice(env.DEVICE_SALT, `ip:${network}`);

    const submission = checked.value;
    const isOwner = isOwnerSubmission(submission);
    const kind: SubmissionKind = isOwner ? "owner" : "feedback";
    if (app.kinds && !app.kinds.includes(kind)) return json(403, { error: "type_not_allowed_for_app_key" }, cors);
    const limit = await checkAndCount(
      env.RATE_LIMIT,
      day,
      device,
      app.app,
      isOwner ? (app.owner_daily_limit ?? app.daily_limit) : app.daily_limit,
      nowMs,
      kind,
      origin,
    );
    if (!limit.allowed) return json(429, { error: "rate_limited" }, { ...cors, "retry-after": String(limit.retryAfter) });

    const id = `fb_${ulid(nowMs, deps.randomBytes)}`;
    const config: GitHubAppConfig = {
      appId: env.GH_APP_ID,
      privateKeyPem: env.GH_APP_PRIVATE_KEY,
      installationId: env.GH_INSTALLATION_ID,
      repo: env.INBOX_REPO,
    };
    const write = (stored: unknown) =>
      github.createFile(
        config,
        env.INBOX_BRANCH ?? "main",
        `pending/${day}/${id}.json`,
        `${JSON.stringify(stored, null, 2)}\n`,
        `Add ${id}`,
      );

    if (isOwner) {
      const random = deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
      const secrets = submission.type === "owner_update" ? undefined : newOwnerSecrets(random);
      const stored = await storeOwner(submission, { id, received, app: app.app, device }, secrets);
      try {
        await write(stored);
      } catch {
        return json(503, { error: "storage_unavailable" }, { ...cors, "retry-after": "60" });
      }
      // The token is in this answer only. It is never stored or logged.
      return json(202, secrets ? { id, code: secrets.code, token: secrets.token } : { id }, cors);
    }

    const { type, place, location, app_version, consent, ...rest } = sanitise(submission as FeedbackSubmission);
    const stored = {
      id,
      received,
      app: app.app,
      type,
      place,
      ...(location ? { location } : {}),
      device,
      ...(origin ? { origin } : {}),
      app_version,
      consent,
      ...("report" in rest ? { report: rest.report } : {}),
      ...("review" in rest ? { review: rest.review } : {}),
      ...("check" in rest ? { check: rest.check } : {}),
    } as StoredFeedback;

    try {
      await write(stored);
    } catch {
      return json(503, { error: "storage_unavailable" }, { ...cors, "retry-after": "60" });
    }
    return json(202, { id }, cors);
  };
}

const handle = createHandler({ fetch: (input, init) => fetch(input, init), now: () => Date.now() });

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
