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
  /** Secret. JSON map of app key to `{ "app": "<name>", "daily_limit": <number> }`. */
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

interface AppEntry {
  app: string;
  daily_limit: number;
}

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
    if (
      key.length >= 16 &&
      typeof entry.app === "string" &&
      APP_NAME.test(entry.app) &&
      typeof entry.daily_limit === "number" &&
      entry.daily_limit > 0
    ) {
      out.set(key, { app: entry.app, daily_limit: entry.daily_limit });
    }
  }
  return out;
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

    const submission = checked.value;
    const isOwner = isOwnerSubmission(submission);
    const limit = await checkAndCount(
      env.RATE_LIMIT,
      day,
      device,
      app.app,
      app.daily_limit,
      nowMs,
      isOwner ? "owner" : "feedback",
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
