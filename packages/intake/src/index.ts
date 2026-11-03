import {
  isJpeg,
  isOwnerSubmission,
  MAX_PHOTO_BYTES,
  MAX_THUMB_BYTES,
  stripContactDetails,
  validateSubmission,
  type FeedbackSubmission,
  type OwnerSubmission,
  type PhotoSubmission,
  type SafeSearchRatings,
  type StoredFeedback,
  type StoredOwnerSubmission,
  firstProblem,
  isPlaceId,
  newPlaceId,
  tidyName,
  tidyText,
} from "@opencampingdb/feedback";
import { AttestError, verifyAssertion, verifyAttestation, type AttestedKey, type IosConfig } from "./appattest.js";
import { refuse, type RefusalBody } from "./refusal.js";
import { fromBase64, hex, sha256, toBase64Url } from "./bytes.js";
import { GitHubApp, type Fetch, type GitHubAppConfig } from "./github.js";
import { IntegrityError, IntegrityUnavailable, PlayIntegrity, type AndroidConfig, type ServiceAccount } from "./playintegrity.js";
import { SafeSearch, verdict } from "./safesearch.js";
import { jpegSize } from "./jpeg.js";
import { PASS_TTL_SECONDS, signPass } from "./pass.js";
import {
  ATTEST_KEY_DAILY_LIMIT,
  checkAndCount,
  CONTRIBUTOR_DAILY_LIMIT,
  PHOTO_CONTRIBUTOR_DAILY_LIMIT,
  type KVLike,
} from "./ratelimit.js";
import {
  getPlace,
  insertEvidence,
  insertPlace,
  listPlaces,
  MAX_BLOCKED_CONTRIBUTORS,
  MAX_REMOVE_IDS,
  NEW_PLACE_DAILY_LIMIT,
  parseBbox,
  RECENT_CACHE_SECONDS,
  removePlaces,
  setBlockList,
  snapBbox,
  WITHDRAW_WINDOW_MS,
  type D1Like,
  type StoredPlace,
} from "./recent.js";
import { ulid } from "./ulid.js";

/** The part of an R2 bucket binding the photo upload uses. */
export interface BucketLike {
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  delete(keys: string | string[]): Promise<void>;
}

export interface Env {
  /**
   * Secret. JSON map of app key to `{ "app": "<name>", "daily_limit": <number> }`,
   * optionally with `owner_daily_limit`, `kinds` (`["feedback"]`, `["owner"]`
   * or both), `requires_attestation`, `ios`, `android`,
   * `requires_visited_nearby` and `contributor_daily_limit`.
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
  /** Registered App Attest keys and open challenges. Needed when an app key has `ios`. */
  ATTEST?: KVLike;
  /** Secret. Google service account key file (JSON) allowed to decode Play Integrity tokens. Needed when an app key has `android`. */
  GOOGLE_SERVICE_ACCOUNT?: string;
  /** Private R2 bucket that holds uploaded photos until their record is merged. Needed for `/v1/photos`. */
  PHOTOS_PENDING?: BucketLike;
  /** Secret, shared with the photo server. Signs photo passes. Needed for `/v1/photos/pass`. */
  PHOTO_PASS_SECRET?: string;
  /**
   * The photo server's STATE namespace. A photo reported as `illegal` gets a
   * `withheld:<photo id>` key there, and the photo server stops serving it.
   */
  PHOTO_STATE?: KVLike;
  /**
   * `on` checks each uploaded photo with Google Cloud Vision SafeSearch, as the
   * GOOGLE_SERVICE_ACCOUNT (its project needs the Cloud Vision API). Very likely
   * adult or violent photos are refused; likely ones wait for a person.
   */
  SAFESEARCH?: string;
  /**
   * The recent list (D1): new places from attested installs, with their
   * evidence and the block list, served by `GET /v1/places/recent` until the
   * apply run has written them into the data. Without it the recent-list
   * routes answer 404.
   */
  RECENT_LIST?: D1Like;
  /** Secret. Lets the apply run remove places from RECENT_LIST and send the block list. */
  PLACES_TOKEN?: string;
}

/** Key in the photo server's STATE that stops one photo being served. */
export const withheldKey = (photo: string) => `withheld:${photo}`;

type SubmissionKind = "feedback" | "owner";

interface AppEntry {
  app: string;
  daily_limit: number;
  /** Daily limit for owner submissions, counted apart from other feedback. Defaults to `daily_limit`. */
  owner_daily_limit?: number;
  /** Kinds of submission the key may send. Every kind when left out. */
  kinds?: SubmissionKind[];
  /**
   * Every report, review, check and review report must carry an App Attest
   * assertion (with `ios`) or a Play Integrity token (with `android`).
   */
  requires_attestation?: boolean;
  ios?: IosConfig;
  android?: AndroidConfig;
  /** Reviews must carry `visited_nearby: true`. */
  requires_visited_nearby?: boolean;
  /** Feedback per contributor per day. Defaults to CONTRIBUTOR_DAILY_LIMIT. */
  contributor_daily_limit?: number;
  /**
   * Photo passes without attestation, for a development key used on
   * simulators, which cannot attest. Give the key an app name of its own
   * with a small daily limit in the photo server's PHOTO_KEYS, and never
   * ship it in a store build.
   */
  photo_pass_unattested?: boolean;
}

const isLimit = (v: unknown): v is number => typeof v === "number" && v > 0;

export const MAX_BODY_BYTES = 16 * 1024;
/** Largest photo upload body: both files. The meta travels in the `x-photo-meta` header. */
export const MAX_PHOTO_BODY_BYTES = MAX_PHOTO_BYTES + MAX_THUMB_BYTES;
/** Longest `x-photo-meta` header, base64url. */
export const MAX_PHOTO_META_CHARS = 4096;
/** Photo passes per hashed device per day, and per hashed client network per day. */
export const PASS_DEVICE_DAILY_LIMIT = 48;
export const PASS_ORIGIN_DAILY_LIMIT = 500;
/** How far a pass request's `time` may be from the intake's clock. */
const PASS_CLOCK_SKEW_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface Deps {
  fetch: Fetch;
  now: () => number;
  randomBytes?: (n: number) => Uint8Array;
  /** App Attest root certificate (PEM). Apple's by default; tests pass their own. */
  appAttestRoot?: string;
  /** Edge cache for the recent places list. Workers' default cache in production; none when left out. */
  cache?: CacheLike;
}

/** The part of the Workers Cache API the recent list uses. */
export interface CacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
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
    const iosValid =
      entry.ios === undefined ||
      (typeof entry.ios?.app_id === "string" &&
        /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/.test(entry.ios.app_id) &&
        (entry.ios.environment === undefined || entry.ios.environment === "production" || entry.ios.environment === "development"));
    const androidValid =
      entry.android === undefined ||
      (typeof entry.android?.package === "string" &&
        /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(entry.android.package) &&
        (entry.android.certificate_sha256 === undefined ||
          (Array.isArray(entry.android.certificate_sha256) && entry.android.certificate_sha256.every((d) => typeof d === "string"))));
    // An app key that requires attestation must say how its apps attest.
    const attestValid =
      entry.requires_attestation === undefined ||
      entry.requires_attestation === false ||
      (entry.requires_attestation === true && (entry.ios !== undefined || entry.android !== undefined));
    if (
      key.length >= 16 &&
      typeof entry.app === "string" &&
      APP_NAME.test(entry.app) &&
      isLimit(entry.daily_limit) &&
      (entry.owner_daily_limit === undefined || isLimit(entry.owner_daily_limit)) &&
      (entry.contributor_daily_limit === undefined || isLimit(entry.contributor_daily_limit)) &&
      (entry.requires_visited_nearby === undefined || typeof entry.requires_visited_nearby === "boolean") &&
      (entry.photo_pass_unattested === undefined || typeof entry.photo_pass_unattested === "boolean") &&
      kindsValid &&
      iosValid &&
      androidValid &&
      attestValid
    ) {
      out.set(key, {
        app: entry.app,
        daily_limit: entry.daily_limit,
        ...(entry.owner_daily_limit !== undefined ? { owner_daily_limit: entry.owner_daily_limit } : {}),
        ...(entry.kinds !== undefined ? { kinds: [...entry.kinds] } : {}),
        ...(entry.requires_attestation ? { requires_attestation: true } : {}),
        ...(entry.ios ? { ios: { app_id: entry.ios.app_id, ...(entry.ios.environment ? { environment: entry.ios.environment } : {}) } } : {}),
        ...(entry.android
          ? {
              android: {
                package: entry.android.package,
                ...(entry.android.certificate_sha256 ? { certificate_sha256: [...entry.android.certificate_sha256] } : {}),
              },
            }
          : {}),
        ...(entry.requires_visited_nearby ? { requires_visited_nearby: true } : {}),
        ...(entry.contributor_daily_limit !== undefined ? { contributor_daily_limit: entry.contributor_daily_limit } : {}),
        ...(entry.photo_pass_unattested ? { photo_pass_unattested: true } : {}),
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

/**
 * SHA-256 of salt and `text`, first 16 hex characters. Case is kept: a
 * contributor id or key id is compared exactly.
 */
export async function saltedHash(salt: string, text: string): Promise<string> {
  return hex((await sha256(`${salt}:${text}`)).subarray(0, 8));
}

/** The stored contributor id for the id an app sent: `ctr_` and 16 hex characters, different for each app. */
export async function hashContributor(salt: string, app: string, contributor: string): Promise<string> {
  return `ctr_${await saltedHash(salt, `contributor:${app}:${contributor}`)}`;
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

/** Seconds an App Attest challenge stays usable. */
export const CHALLENGE_TTL_SECONDS = 300;
/** App Attest registrations per hashed client network per day. */
export const REGISTER_ORIGIN_DAILY_LIMIT = 500;

type Attested =
  | { attested: "app_attest" | "play_integrity"; keyId?: string }
  | { error: "attestation_required" }
  | RefusalBody
  | { error: "unavailable" };

/** A storage error or an outage at Google: not a refusal, so the app keeps its key and tries again later. */
function unavailable(cors: Record<string, string>): Response {
  return json(503, { error: "unavailable" }, { ...cors, "retry-after": "60" });
}

/** The answer to an item whose assertion was missing or refused (401), or could not be checked (503). */
function refusedOrUnavailable(result: Exclude<Attested, { attested: string }>, cors: Record<string, string>): Response {
  if (result.error === "unavailable") return unavailable(cors);
  return json(401, result, cors);
}

/** A read or write on the key store that failed. */
class StorageError extends Error {}

/** Runs a read or write on the key store, marking a failure as a storage error. */
async function inKeyStore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new StorageError(error instanceof Error ? error.message : String(error));
  }
}

/** A stored key record, or undefined when the stored text is not one. */
function readKeyRecord(saved: string): AttestedKey | undefined {
  let record: unknown;
  try {
    record = JSON.parse(saved);
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const { app, public_key, counter } = record as Record<string, unknown>;
  if (typeof app !== "string" || typeof public_key !== "string" || typeof counter !== "number") return undefined;
  return { app, public_key, counter };
}

export function createHandler(deps: Deps) {
  const github = new GitHubApp(deps.fetch, deps.now);
  const integrity = new PlayIntegrity(deps.fetch, deps.now);
  const safeSearch = new SafeSearch(deps.fetch, deps.now);
  const random = deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));

  /** Checks the attestation headers against the exact body text. */
  async function attest(request: Request, env: Env, app: AppEntry, body: string): Promise<Attested> {
    const platform = request.headers.get("x-attest-platform");
    if (platform === "ios" && app.ios && env.ATTEST) {
      const kv = env.ATTEST;
      const keyId = request.headers.get("x-attest-key-id") ?? "";
      const assertion = fromBase64(request.headers.get("x-attest-assertion") ?? "");
      if (!keyId || !assertion) return { error: "attestation_required" };
      try {
        const saved = await inKeyStore(() => kv.get(`aa:${keyId}`));
        if (saved === null) return refuse(request, app.app, { reason: "unknown_key", details: ["key is not registered"] });
        const key = readKeyRecord(saved);
        if (!key) return refuse(request, app.app, { reason: "unknown_key", details: ["stored key record cannot be read"] });
        if (key.app !== app.app) return refuse(request, app.app, { reason: "wrong_app", details: ["key is registered for another app key"] });
        const { counter } = await verifyAssertion({ assertion, clientData: new TextEncoder().encode(body), key, config: app.ios });
        await inKeyStore(() => kv.put(`aa:${keyId}`, JSON.stringify({ ...key, counter })));
      } catch (error) {
        if (error instanceof StorageError) return { error: "unavailable" };
        if (error instanceof AttestError) return refuse(request, app.app, { reason: error.reason, details: [error.message] });
        throw error;
      }
      return { attested: "app_attest", keyId };
    }
    if (platform === "android" && app.android && env.GOOGLE_SERVICE_ACCOUNT) {
      const token = request.headers.get("x-attest-token");
      if (!token) return { error: "attestation_required" };
      try {
        await integrity.verify({
          token,
          requestHash: hex(await sha256(body)),
          config: app.android,
          account: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT) as ServiceAccount,
        });
      } catch (error) {
        // Google failing, or a service account that cannot be read, is not the app's fault.
        if (error instanceof IntegrityUnavailable || error instanceof SyntaxError) return { error: "unavailable" };
        if (error instanceof IntegrityError) return refuse(request, app.app, { reason: error.reason, details: [error.message] });
        throw error;
      }
      return { attested: "play_integrity" };
    }
    return { error: "attestation_required" };
  }

  /** `POST /v1/attest/challenge`: a one-time challenge for an App Attest attestation. */
  async function challenge(env: Env, app: AppEntry, cors: Record<string, string>): Promise<Response> {
    if (!app.ios || !env.ATTEST) return json(404, { error: "not_found" }, cors);
    const value = toBase64Url(random(32));
    await env.ATTEST.put(`ac:${value}`, app.app, { expirationTtl: CHALLENGE_TTL_SECONDS });
    return json(200, { challenge: value }, cors);
  }

  /** `POST /v1/attest/register`: checks an install's attestation and keeps its key. */
  async function register(request: Request, env: Env, app: AppEntry, text: string, cors: Record<string, string>): Promise<Response> {
    if (!app.ios || !env.ATTEST) return json(404, { error: "not_found" }, cors);
    let body: { key_id?: unknown; attestation?: unknown; challenge?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return json(400, { error: "invalid", details: ["body must be JSON"] }, cors);
    }
    const { key_id: keyId, challenge: given } = body;
    const attestation = typeof body.attestation === "string" ? fromBase64(body.attestation) : undefined;
    if (typeof keyId !== "string" || !/^[A-Za-z0-9+/=_-]{40,64}$/.test(keyId) || typeof given !== "string" || !attestation) {
      return json(400, { error: "invalid", details: ["key_id, attestation (base64) and challenge are required"] }, cors);
    }
    const network = networkPrefix(request.headers.get("cf-connecting-ip") ?? "");
    if (network !== undefined) {
      const day = new Date(deps.now()).toISOString().slice(0, 10);
      const origin = await hashDevice(env.DEVICE_SALT, `ip:${network}`);
      const counted = Number((await env.RATE_LIMIT.get(`r:${day}:${origin}`)) ?? 0);
      if (counted >= REGISTER_ORIGIN_DAILY_LIMIT) return json(429, { error: "rate_limited" }, cors);
      await env.RATE_LIMIT.put(`r:${day}:${origin}`, String(counted + 1), { expirationTtl: 2 * 24 * 60 * 60 });
    }
    const kv = env.ATTEST;
    try {
      // A challenge is used once, by the app it was issued to.
      const issuedTo = await inKeyStore(() => kv.get(`ac:${given}`));
      await inKeyStore(() => kv.delete(`ac:${given}`));
      if (issuedTo !== app.app) return json(401, refuse(request, app.app, { reason: "malformed", details: ["unknown or used challenge"] }), cors);
      // A key is registered once, so a key cannot be moved to another install's record.
      if ((await inKeyStore(() => kv.get(`aa:${keyId}`))) !== null) {
        return json(409, refuse(request, app.app, { reason: "malformed", details: ["key is already registered"] }), cors);
      }
      const { publicKey } = await verifyAttestation({
        attestation,
        keyId,
        challenge: given,
        config: app.ios,
        now: deps.now(),
        ...(deps.appAttestRoot ? { rootPem: deps.appAttestRoot } : {}),
      });
      const key: AttestedKey = { app: app.app, public_key: publicKey, counter: 0 };
      await inKeyStore(() => kv.put(`aa:${keyId}`, JSON.stringify(key)));
    } catch (error) {
      if (error instanceof StorageError) return unavailable(cors);
      if (error instanceof AttestError) return json(401, refuse(request, app.app, { reason: error.reason, details: [error.message] }), cors);
      throw error;
    }
    return json(201, { key_id: keyId }, cors);
  }

  /**
   * `POST /v1/photos`: a photo of a place. The meta (a `photo` submission) is
   * the base64url `x-photo-meta` header, and the attestation covers its text.
   * The body is the full size JPEG followed by the thumbnail, with the sizes
   * and SHA-256 the meta gives. Both files go to the private pending bucket,
   * and the stored item to the inbox like any other feedback.
   */
  async function photo(request: Request, env: Env, app: AppEntry, cors: Record<string, string>): Promise<Response> {
    if (!env.PHOTOS_PENDING) return json(404, { error: "not_found" }, cors);
    if (app.kinds && !app.kinds.includes("feedback")) return json(403, { error: "type_not_allowed_for_app_key" }, cors);
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_PHOTO_BODY_BYTES) return json(413, { error: "too_large" }, cors);
    const header = request.headers.get("x-photo-meta") ?? "";
    const metaBytes = header.length <= MAX_PHOTO_META_CHARS ? fromBase64(header) : undefined;
    if (!metaBytes) return json(400, { error: "invalid", details: ["x-photo-meta must be base64url JSON"] }, cors);
    const text = new TextDecoder().decode(metaBytes);
    let meta: unknown;
    try {
      meta = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid", details: ["x-photo-meta must be base64url JSON"] }, cors);
    }
    const nowMs = deps.now();
    const checked = validateSubmission(meta, new Date(nowMs));
    if (!checked.ok) return json(400, { error: "invalid", details: checked.errors }, cors);
    if (checked.value.type !== "photo") return json(400, { error: "invalid", details: ["type must be photo"] }, cors);
    const submission = checked.value as PhotoSubmission;

    let proof: { attested: "app_attest" | "play_integrity"; keyId?: string } | undefined;
    if (app.requires_attestation) {
      const result = await attest(request, env, app, text);
      if ("error" in result) return refusedOrUnavailable(result, cors);
      proof = result;
    }

    const body = new Uint8Array(await request.arrayBuffer());
    const { full_bytes, thumb_bytes, full_sha256, thumb_sha256 } = submission.photo;
    if (body.length > MAX_PHOTO_BODY_BYTES) return json(413, { error: "too_large" }, cors);
    if (body.length !== full_bytes + thumb_bytes) {
      return json(400, { error: "invalid", details: ["body length must be photo.full_bytes plus photo.thumb_bytes"] }, cors);
    }
    const full = body.subarray(0, full_bytes);
    const thumb = body.subarray(full_bytes);
    const size = jpegSize(full);
    if (!isJpeg(full) || !isJpeg(thumb) || !size || !jpegSize(thumb)) return json(400, { error: "not_jpeg" }, cors);
    if (hex(await sha256(full)) !== full_sha256 || hex(await sha256(thumb)) !== thumb_sha256) {
      return json(400, { error: "sha256_mismatch" }, cors);
    }

    const received = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const day = received.slice(0, 10);
    const device = await hashDevice(env.DEVICE_SALT, submission.device);
    const network = networkPrefix(request.headers.get("cf-connecting-ip") ?? "");
    const origin = network === undefined ? undefined : await hashDevice(env.DEVICE_SALT, `ip:${network}`);
    const contributor = await hashContributor(env.DEVICE_SALT, app.app, submission.contributor!);
    const attestKey = proof?.keyId ? `ak_${await saltedHash(env.DEVICE_SALT, `key:${proof.keyId}`)}` : undefined;
    const limit = await checkAndCount(env.RATE_LIMIT, day, device, app.app, app.daily_limit, nowMs, "feedback", origin, [
      { prefix: "c", id: contributor, limit: app.contributor_daily_limit ?? CONTRIBUTOR_DAILY_LIMIT },
      { prefix: "p", id: contributor, limit: PHOTO_CONTRIBUTOR_DAILY_LIMIT },
      ...(attestKey ? [{ prefix: "k", id: attestKey, limit: ATTEST_KEY_DAILY_LIMIT }] : []),
    ]);
    if (!limit.allowed) return json(429, { error: "rate_limited" }, { ...cors, "retry-after": String(limit.retryAfter) });

    // After the limits, so a flood of uploads can't run up the Vision bill.
    let ratings: SafeSearchRatings | "unchecked" | undefined;
    if (env.SAFESEARCH === "on") {
      let account: ServiceAccount | undefined;
      try {
        account = env.GOOGLE_SERVICE_ACCOUNT ? (JSON.parse(env.GOOGLE_SERVICE_ACCOUNT) as ServiceAccount) : undefined;
      } catch {
        account = undefined;
      }
      ratings = account ? await safeSearch.rate(full, account) : "unchecked";
      if (verdict(ratings) === "refuse") return json(422, { error: "photo_not_allowed" }, cors);
    }

    const ulidText = ulid(nowMs, deps.randomBytes);
    const id = `fb_${ulidText}`;
    const photoId = `pho_${ulidText}`;
    const keys = [`${photoId}/full.jpg`, `${photoId}/thumb.jpg`];
    const stored = {
      id,
      received,
      app: app.app,
      type: "photo",
      place: submission.place,
      device,
      ...(origin ? { origin } : {}),
      contributor,
      ...(proof ? { attested: proof.attested } : {}),
      ...(attestKey ? { attest_key: attestKey } : {}),
      app_version: submission.app_version,
      consent: true,
      photo: { full_sha256, full_bytes, thumb_sha256, thumb_bytes, width: size.width, height: size.height, ...(ratings ? { safesearch: ratings } : {}) },
    } as StoredFeedback;
    const customMetadata = { place: submission.place, contributor };
    try {
      await env.PHOTOS_PENDING.put(keys[0]!, full, { httpMetadata: { contentType: "image/jpeg" }, customMetadata });
      await env.PHOTOS_PENDING.put(keys[1]!, thumb, { httpMetadata: { contentType: "image/jpeg" }, customMetadata });
      await github.createFile(
        {
          appId: env.GH_APP_ID,
          privateKeyPem: env.GH_APP_PRIVATE_KEY,
          installationId: env.GH_INSTALLATION_ID,
          repo: env.INBOX_REPO,
        },
        env.INBOX_BRANCH ?? "main",
        `pending/${day}/${id}.json`,
        `${JSON.stringify(stored, null, 2)}\n`,
        `Add ${id}`,
      );
    } catch {
      // Files without an inbox item would never be reviewed, so they go too.
      await env.PHOTOS_PENDING.delete(keys).catch(() => undefined);
      return json(503, { error: "storage_unavailable" }, { ...cors, "retry-after": "60" });
    }
    return json(202, { id: photoId }, cors);
  }

  /**
   * `POST /v1/photos/pass`: a photo pass for an attested install. The body is
   * `{ "type": "photo_pass", "device", "app_version", "time" }`, with `time`
   * the phone's clock, so a captured request stops working within minutes.
   * Only app keys that require attestation get passes, and development keys
   * with `photo_pass_unattested`.
   */
  async function photoPass(request: Request, env: Env, app: AppEntry, text: string, cors: Record<string, string>): Promise<Response> {
    if (!env.PHOTO_PASS_SECRET || !env.PHOTOS_PENDING) return json(404, { error: "not_found" }, cors);
    if (!app.requires_attestation && !app.photo_pass_unattested) {
      return json(403, { error: "attestation_not_required_for_app_key" }, cors);
    }
    let body: { type?: unknown; device?: unknown; app_version?: unknown; time?: unknown };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return json(400, { error: "invalid", details: ["body must be JSON"] }, cors);
    }
    const nowMs = deps.now();
    const sent = typeof body.time === "string" ? Date.parse(body.time) : NaN;
    if (
      body.type !== "photo_pass" ||
      typeof body.device !== "string" ||
      !UUID.test(body.device) ||
      typeof body.app_version !== "string" ||
      body.app_version.length === 0 ||
      body.app_version.length > 32
    ) {
      return json(400, { error: "invalid", details: ["type photo_pass, device (a UUID), app_version and time are required"] }, cors);
    }
    if (!Number.isFinite(sent) || Math.abs(sent - nowMs) > PASS_CLOCK_SKEW_MS) return json(400, { error: "clock_skew" }, cors);
    if (app.requires_attestation) {
      const proof = await attest(request, env, app, text);
      if ("error" in proof) return refusedOrUnavailable(proof, cors);
    }

    const day = new Date(nowMs).toISOString().slice(0, 10);
    const device = await hashDevice(env.DEVICE_SALT, body.device);
    const network = networkPrefix(request.headers.get("cf-connecting-ip") ?? "");
    const counters = [{ key: `pp:${day}:${device}`, limit: PASS_DEVICE_DAILY_LIMIT }];
    if (network !== undefined) counters.push({ key: `ppn:${day}:${await hashDevice(env.DEVICE_SALT, `ip:${network}`)}`, limit: PASS_ORIGIN_DAILY_LIMIT });
    const counts = await Promise.all(counters.map((c) => env.RATE_LIMIT.get(c.key).then((v) => Number(v ?? 0))));
    if (counts.some((n, i) => n >= counters[i]!.limit)) return json(429, { error: "rate_limited" }, cors);
    await Promise.all(counters.map((c, i) => env.RATE_LIMIT.put(c.key, String(counts[i]! + 1), { expirationTtl: 2 * 24 * 60 * 60 })));

    const expires = Math.floor(nowMs / 1000) + PASS_TTL_SECONDS;
    const pass = await signPass(env.PHOTO_PASS_SECRET, app.app, expires);
    return json(200, { pass, expires: new Date(expires * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") }, cors);
  }

  /**
   * `GET /v1/places/recent`: new places that are `shown` or `confirmed`,
   * optionally within `bbox=west,south,east,north` grown out to whole
   * degrees. Public, like the data, and cached at the edge by that box, so the
   * recent list is read at most once per cache period for each box in each location.
   * The cached copy has no CORS headers; they are added here.
   */
  async function recentPlaces(request: Request, env: Env, url: URL, cors: Record<string, string>): Promise<Response> {
    if (!env.RECENT_LIST) return json(404, { error: "not_found" }, cors);
    const box = url.searchParams.get("bbox");
    const parsed = box === null ? undefined : parseBbox(box);
    if (box !== null && !parsed) return json(400, { error: "invalid", details: ["bbox must be west,south,east,north in degrees"] }, cors);
    const bbox = parsed && snapBbox(parsed);
    const withCors = (response: Response) => {
      const out = new Response(response.body, response);
      for (const [name, value] of Object.entries(cors)) out.headers.set(name, value);
      return out;
    };
    // Keyed by the snapped box alone, so other query parameters can't split the cache.
    const cacheKey = new Request(`${url.origin}${url.pathname}${bbox ? `?bbox=${bbox.join(",")}` : ""}`, { method: "GET" });
    const hit = await deps.cache?.match(cacheKey);
    if (hit) return withCors(hit);
    const places = await listPlaces(env.RECENT_LIST, new Date(deps.now()).toISOString(), bbox);
    const response = json(200, { places }, { "cache-control": `public, max-age=${RECENT_CACHE_SECONDS}` });
    await deps.cache?.put(cacheKey, response.clone());
    return withCors(response);
  }

  /**
   * Reads the body of a call from the apply run, after checking its
   * `authorization: Bearer <PLACES_TOKEN>`. A Response when the call is refused.
   */
  async function placesCall(
    request: Request,
    env: Env,
    cors: Record<string, string>,
    maxBytes: number,
  ): Promise<{ db: D1Like; body: Record<string, unknown> } | Response> {
    if (!env.RECENT_LIST || !env.PLACES_TOKEN) return json(404, { error: "not_found" }, cors);
    const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
    // Compared as hashes, so the time taken says nothing about the token.
    if (hex(await sha256(given)) !== hex(await sha256(env.PLACES_TOKEN))) return json(401, { error: "unauthorised" }, cors);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > maxBytes) return json(413, { error: "too_large" }, cors);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { db: env.RECENT_LIST, body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {} };
  }

  /**
   * `POST /v1/places/recent/remove`, for the apply run once the places are in
   * the data: `{ "ids": [...] }` with `authorization: Bearer <PLACES_TOKEN>`.
   */
  async function removeRecent(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
    const call = await placesCall(request, env, cors, MAX_BODY_BYTES * 4);
    if (call instanceof Response) return call;
    const ids = call.body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_REMOVE_IDS || !ids.every(isPlaceId)) {
      return json(400, { error: "invalid", details: [`ids must be 1 to ${MAX_REMOVE_IDS} place ids`] }, cors);
    }
    await removePlaces(call.db, ids as string[]);
    return json(200, { removed: ids.length }, cors);
  }

  /**
   * `POST /v1/places/recent/block`, for the apply run: `{ "contributors": [...] }`,
   * the whole block list as hashed contributor ids, with `authorization: Bearer
   * <PLACES_TOKEN>`. It replaces the list the intake keeps.
   */
  async function blockRecent(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
    // Each id is 20 characters, and a little more in JSON.
    const call = await placesCall(request, env, cors, MAX_BLOCKED_CONTRIBUTORS * 24 + 1024);
    if (call instanceof Response) return call;
    const contributors = call.body.contributors;
    const isHashed = (c: unknown) => typeof c === "string" && /^ctr_[0-9a-f]{16}$/.test(c);
    if (!Array.isArray(contributors) || contributors.length > MAX_BLOCKED_CONTRIBUTORS || !contributors.every(isHashed)) {
      return json(400, { error: "invalid", details: [`contributors must be up to ${MAX_BLOCKED_CONTRIBUTORS} hashed contributor ids`] }, cors);
    }
    await setBlockList(call.db, contributors as string[]);
    return json(200, { blocked: new Set(contributors).size }, cors);
  }

  return async function handle(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, x-app-key, x-attest-platform, x-attest-key-id, x-attest-assertion, x-attest-token, x-photo-meta",
          "access-control-max-age": "86400",
        },
      });
    }
    const route = url.pathname;
    if (route === "/v1/places/recent") {
      if (request.method !== "GET") return json(405, { error: "method_not_allowed" }, { ...cors, allow: "GET, OPTIONS" });
      return recentPlaces(request, env, url, cors);
    }
    if (route === "/v1/places/recent/remove") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { ...cors, allow: "POST, OPTIONS" });
      return removeRecent(request, env, cors);
    }
    if (route === "/v1/places/recent/block") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { ...cors, allow: "POST, OPTIONS" });
      return blockRecent(request, env, cors);
    }
    if (
      route !== "/v1/feedback" &&
      route !== "/v1/photos" &&
      route !== "/v1/photos/pass" &&
      route !== "/v1/attest/challenge" &&
      route !== "/v1/attest/register"
    ) {
      return json(404, { error: "not_found" }, cors);
    }
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, { ...cors, allow: "POST, OPTIONS" });

    let apps: Map<string, AppEntry>;
    try {
      apps = parseAppKeys(env.APP_KEYS);
    } catch {
      return json(500, { error: "misconfigured" }, cors);
    }
    const app = apps.get(request.headers.get("x-app-key") ?? "");
    if (!app) return json(401, { error: "invalid_app_key" }, cors);

    if (route === "/v1/photos") return photo(request, env, app, cors);
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return json(413, { error: "too_large" }, cors);
    if (route === "/v1/attest/challenge") return challenge(env, app, cors);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(413, { error: "too_large" }, cors);
    if (route === "/v1/attest/register") return register(request, env, app, text, cors);
    if (route === "/v1/photos/pass") return photoPass(request, env, app, text, cors);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "invalid", details: ["body must be JSON"] }, cors);
    }
    const nowMs = deps.now();
    const checked = validateSubmission(body, new Date(nowMs));
    if (!checked.ok) return json(400, { error: "invalid", details: checked.errors }, cors);

    const received = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    const day = received.slice(0, 10);
    const device = await hashDevice(env.DEVICE_SALT, checked.value.device);
    // Cloudflare sets CF-Connecting-IP to the client address. Only a salted hash of its network is kept.
    const network = networkPrefix(request.headers.get("cf-connecting-ip") ?? "");
    const origin = network === undefined ? undefined : await hashDevice(env.DEVICE_SALT, `ip:${network}`);

    const submission = checked.value;
    if (submission.type === "photo") return json(400, { error: "invalid", details: ["photos are sent to /v1/photos"] }, cors);
    // Photo reports and erasures belong to a photo service: an intake with a photo bucket.
    if ((submission.type === "photo_report" || submission.type === "photo_erasure") && !env.PHOTOS_PENDING) {
      return json(404, { error: "photos_not_served_here" }, cors);
    }
    const isOwner = isOwnerSubmission(submission);
    const kind: SubmissionKind = isOwner ? "owner" : "feedback";
    if (app.kinds && !app.kinds.includes(kind)) return json(403, { error: "type_not_allowed_for_app_key" }, cors);

    let proof: { attested: "app_attest" | "play_integrity"; keyId?: string } | undefined;
    let contributor: string | undefined;
    let attestKey: string | undefined;
    let target: StoredPlace | undefined;
    const extra: { prefix: string; id: string; limit: number }[] = [];
    if (!isOwner) {
      const feedback = submission as FeedbackSubmission;
      if (app.requires_attestation) {
        const result = await attest(request, env, app, text);
        if ("error" in result) return refusedOrUnavailable(result, cors);
        proof = result;
      }
      if (feedback.contributor !== undefined) contributor = await hashContributor(env.DEVICE_SALT, app.app, feedback.contributor);
      else if (proof?.keyId) contributor = `ctr_${await saltedHash(env.DEVICE_SALT, `contributor-key:${proof.keyId}`)}`;
      if (proof?.keyId) attestKey = `ak_${await saltedHash(env.DEVICE_SALT, `key:${proof.keyId}`)}`;
      // A signed-out install attested by Play Integrity has neither. Its new places still need a
      // contributor to list and block them by, so the hashed install stands in.
      if (contributor === undefined && proof && feedback.type === "report" && feedback.report.kind === "new_place") {
        contributor = `ctr_${await saltedHash(env.DEVICE_SALT, `contributor-device:${device}`)}`;
      }
      if (contributor === undefined && ["review", "review_report", "fee", "photo_report", "photo_erasure"].includes(feedback.type)) {
        return json(400, { error: "contributor_required" }, cors);
      }
      if (feedback.type === "review" && app.requires_visited_nearby && feedback.review.visited_nearby !== true) {
        return json(400, { error: "visited_nearby_required" }, cors);
      }
      if (contributor) extra.push({ prefix: "c", id: contributor, limit: app.contributor_daily_limit ?? CONTRIBUTOR_DAILY_LIMIT });
      if (attestKey) extra.push({ prefix: "k", id: attestKey, limit: ATTEST_KEY_DAILY_LIMIT });
      if (feedback.type === "report" && feedback.report.kind === "new_place") {
        extra.push({ prefix: "np", id: contributor ?? device, limit: NEW_PLACE_DAILY_LIMIT });
      }
      if (env.RECENT_LIST && feedback.place !== null && ["check", "report", "withdraw"].includes(feedback.type)) {
        target = await getPlace(env.RECENT_LIST, feedback.place).catch(() => undefined);
      }
      // A withdraw is checked against the new place when the recent list has it. Otherwise the apply run checks it.
      if (feedback.type === "withdraw" && target) {
        if (target.device !== device || (target.attest_key !== undefined && target.attest_key !== attestKey)) {
          return json(403, { error: "not_your_place" }, cors);
        }
        if (nowMs - Date.parse(target.added) > WITHDRAW_WINDOW_MS) return json(409, { error: "withdraw_window_closed" }, cors);
      }
    }
    const limit = await checkAndCount(
      env.RATE_LIMIT,
      day,
      device,
      app.app,
      isOwner ? (app.owner_daily_limit ?? app.daily_limit) : app.daily_limit,
      nowMs,
      kind,
      origin,
      extra,
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
      ...(contributor ? { contributor } : {}),
      ...(proof ? { attested: proof.attested } : {}),
      ...(attestKey ? { attest_key: attestKey } : {}),
      app_version,
      consent,
      ...("report" in rest ? { report: rest.report } : {}),
      ...("review" in rest ? { review: rest.review } : {}),
      ...("check" in rest ? { check: rest.check } : {}),
      ...("review_report" in rest ? { review_report: rest.review_report } : {}),
      ...("fee" in rest ? { fee: rest.fee } : {}),
      ...("photo_report" in rest ? { photo_report: rest.photo_report } : {}),
    } as StoredFeedback;

    try {
      await write(stored);
    } catch {
      return json(503, { error: "storage_unavailable" }, { ...cors, "retry-after": "60" });
    }
    // The item is in the inbox already, so a failed store write still reaches the apply run.
    if (env.RECENT_LIST) {
      await updateRecent(env.RECENT_LIST, submission as FeedbackSubmission, { id, received, device, contributor, attestKey, proof, target }).catch(
        () => undefined,
      );
    }
    // An illegal-content report withholds the photo before a person sees it. The
    // report is in the inbox already, so a failed write here still reaches a person.
    if (stored.type === "photo_report" && stored.photo_report.reason === "illegal" && env.PHOTO_STATE) {
      const value = JSON.stringify({ feedback: id, at: received });
      await env.PHOTO_STATE.put(withheldKey(stored.photo_report.photo), value).catch(() => undefined);
    }
    return json(202, { id }, cors);
  };
}

/**
 * Keeps the recent list up to date with an accepted item: a new place
 * from an attested install whose note passes the text checks once its contact
 * details are stripped (as the inbox stores it) goes in, and a check, removal
 * report or withdraw on a stored place is added as evidence of its own.
 */
async function updateRecent(
  db: D1Like,
  submission: FeedbackSubmission,
  item: {
    id: string;
    received: string;
    device: string;
    contributor: string | undefined;
    attestKey: string | undefined;
    proof: { attested: string } | undefined;
    target: StoredPlace | undefined;
  },
): Promise<void> {
  const { id, received, device, contributor, attestKey, proof, target } = item;
  if (submission.type === "report" && submission.report.kind === "new_place") {
    const { note, place_kind, name } = submission.report;
    if (!proof || !contributor || !submission.location || firstProblem(note === undefined ? undefined : tidyText(stripContactDetails(note)))) return;
    await insertPlace(db, {
      id: newPlaceId(id),
      location: submission.location,
      kind: place_kind ?? null,
      name: name === undefined ? null : tidyName(name),
      added: received,
      contributor,
      device,
      ...(attestKey ? { attest_key: attestKey } : {}),
    });
    return;
  }
  if (!target) return;
  if (submission.type === "check") {
    // A check carries no location: only the app's word that the phone was near the place.
    const check = { device, stillThere: submission.check.still_there, nearby: submission.check.nearby === true, day: received };
    await insertEvidence(db, target.id, id, { kind: "check", check });
  } else if (submission.type === "report" && submission.report.kind === "remove" && submission.report.reason) {
    const report = { device, reason: submission.report.reason, day: received };
    await insertEvidence(db, target.id, id, { kind: "removal_report", report });
  } else if (submission.type === "withdraw") {
    await insertEvidence(db, target.id, id, { kind: "withdraw", at: received });
  }
}

const handle = createHandler({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  ...(typeof caches === "undefined" ? {} : { cache: (caches as unknown as { default: CacheLike }).default }),
});

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handle(request, env);
  },
};
