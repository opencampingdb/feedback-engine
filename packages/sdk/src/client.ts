import type {
  AcceptedResponse,
  CheckBody,
  FeeBody,
  FeedbackSubmission,
  LatLon,
  OwnerClaimResponse,
  OwnerContact,
  OwnerListingSubmission,
  OwnerUpdate,
  ReportBody,
  ReviewBody,
  ReviewReportReason,
  PhotoReportReason,
} from "./types.js";
import { sha256Hex, sha256HexBytes } from "./sha256.js";
import { MAX_PHOTO_BYTES, MAX_THUMB_BYTES, validateSubmission } from "./validate.js";

/** Storage the client keeps its queue and device id in. AsyncStorage matches this shape. */
export interface StorageAdapter {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export type FetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number; json(): Promise<unknown>; headers: { get(name: string): string | null } }>;

/** The fetch a photo upload uses: the same as FetchLike, with the files as the body. */
export type PhotoFetchLike = (input: string, init: {
  method: string;
  headers: Record<string, string>;
  body: Uint8Array;
}) => ReturnType<FetchLike>;

export interface FeedbackClientOptions {
  /** Base URL of the intake, for example `https://feedback.example.org`. */
  endpoint: string;
  /** App key issued by whoever runs the intake. */
  appKey: string;
  /** Version of the app sending feedback. */
  appVersion: string;
  storage: StorageAdapter;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Fetch for photo uploads. Defaults to the global `fetch`. */
  fetchPhoto?: PhotoFetchLike;
  /** Source of random UUIDs. Defaults to `crypto.randomUUID`. */
  randomUUID?: () => string;
  /** Clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Random number in [0, 1) used for backoff jitter. Defaults to `Math.random`. */
  random?: () => number;
  /** Most items kept in the queue. The oldest are dropped past this. Default 100. */
  maxQueueLength?: number;
  /** Items older than this are dropped unsent. Default 30 days. */
  maxQueueAgeMs?: number;
  /** Prefix for storage keys. Default `ocdb.feedback`. */
  storagePrefix?: string;
  /**
   * Proves the install to an intake whose app key requires attestation.
   * Called each time a report, review, check, review report or fee is sent, with
   * the exact body text and its SHA-256 (lower case hex). Return the
   * attestation headers: on iOS `x-attest-platform: ios`, `x-attest-key-id`
   * and `x-attest-assertion` (an App Attest assertion over the body's
   * SHA-256); on Android `x-attest-platform: android` and `x-attest-token` (a
   * Play Integrity standard token with the body's SHA-256 as its
   * requestHash). If it throws, the item stays queued and is tried later.
   */
  attest?: (request: { body: string; bodySha256: string }) => Promise<Record<string, string>>;
  /**
   * Called when the intake refuses an item's attestation (401
   * `attestation_required` or `attestation_invalid`). The item stays queued and
   * is tried again with backoff. On `attestation_invalid` the second argument
   * carries the intake's `reason` code and readable `details`, when it sent
   * them. Drop the stored key and register a new one only when
   * `keyIsUnusable(refusal.reason)` is true.
   */
  onAttestationRejected?: (error: AttestationError, refusal?: AttestationRefusal) => Promise<void> | void;
  /**
   * Called once for each queued item when it is settled: sent, or dropped
   * without being sent. It runs whether the call that queued the item sent it
   * or a later `flush` did, after the queue is saved. Errors it throws are
   * caught and never stop the queue. Connect the answer to the app's own
   * record with `ref`, not by comparing content.
   */
  onAnswered?: (answer: Answer) => Promise<void> | void;
}

/** Why the intake refused an item's attestation. */
export type AttestationError = "attestation_required" | "attestation_invalid";

/**
 * The intake's codes for a refused key registration or assertion. Adding a
 * code is additive; renaming or removing one is a breaking change.
 */
const REFUSAL_REASONS = [
  "unknown_key",
  "wrong_app",
  "bad_signature",
  "counter_not_increased",
  "category_not_accepted",
  "malformed",
  "integrity_not_met",
] as const;

/** The intake's code for a refused key registration or assertion. */
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

/** What the intake said about a refusal, as passed to `onAttestationRejected`. */
export interface AttestationRefusal {
  /** The refusal's code, when the intake sent one this SDK knows. */
  reason?: RefusalReason;
  /** Readable text about what failed. */
  details?: string[];
}

const KNOWN_REASONS: ReadonlySet<string> = new Set<string>(REFUSAL_REASONS);

const UNUSABLE_KEY_REASONS: ReadonlySet<string> = new Set<RefusalReason>(["unknown_key", "wrong_app", "bad_signature"]);

/**
 * Whether a refusal means the app's key can no longer be used, so the app
 * should drop it and make a new key registration. False for every other
 * reason, and when there is none: the key is kept and the item tried again.
 */
export function keyIsUnusable(reason: RefusalReason | undefined): boolean {
  return reason !== undefined && UNUSABLE_KEY_REASONS.has(reason);
}

/** The attestation error in a `401` answer, or undefined when the answer is not an attestation refusal. */
function attestationErrorIn(status: number, answer: unknown): AttestationError | undefined {
  if (status !== 401) return undefined;
  const error = (answer as { error?: unknown } | null | undefined)?.error;
  return error === "attestation_required" || error === "attestation_invalid" ? error : undefined;
}

/** The reason and details from a refusal's body, or undefined when it has neither. */
function readRefusal(answer: unknown): AttestationRefusal | undefined {
  if (typeof answer !== "object" || answer === null) return undefined;
  const { reason, details } = answer as { reason?: unknown; details?: unknown };
  const refusal: AttestationRefusal = {};
  if (typeof reason === "string" && KNOWN_REASONS.has(reason)) refusal.reason = reason as RefusalReason;
  if (Array.isArray(details) && details.every((d) => typeof d === "string")) refusal.details = details;
  return refusal.reason === undefined && refusal.details === undefined ? undefined : refusal;
}

/** Calls the app's `onAttestationRejected` hook with the error, and the refusal when the intake said why. */
async function callRefusalHook(
  hook: FeedbackClientOptions["onAttestationRejected"],
  error: AttestationError,
  answer: unknown,
): Promise<void> {
  if (!hook) return;
  const refusal = readRefusal(answer);
  try {
    if (refusal) await hook(error, refusal);
    else await hook(error);
  } catch {
    // The app's own clean-up failing must not lose the item or change the answer.
  }
}

export interface ReportInput {
  place: string | null;
  location?: LatLon;
  report: ReportBody;
  /** The signed-in traveller's opaque account id, when there is one. */
  contributor?: string;
  consent: boolean;
  /**
   * The caller's own id for this submission, 1 to 100 characters. Kept with
   * the queued item and passed back to `onAnswered`. Never sent to the intake.
   */
  ref?: string;
}

export interface ReviewInput {
  place: string;
  review: ReviewBody;
  /** The signed-in traveller's opaque account id (a keyed hash, never a name or email). */
  contributor?: string;
  consent: boolean;
  /**
   * The caller's own id for this submission, 1 to 100 characters. Kept with
   * the queued item and passed back to `onAnswered`. Never sent to the intake.
   */
  ref?: string;
}

export interface FeeInput {
  place: string;
  fee: FeeBody;
  /** The signed-in traveller's opaque account id, as for a review. */
  contributor?: string;
  consent: boolean;
  /**
   * The caller's own id for this submission, 1 to 100 characters. Kept with
   * the queued item and passed back to `onAnswered`. Never sent to the intake.
   */
  ref?: string;
}

export interface CheckInput {
  place: string;
  check: CheckBody;
  contributor?: string;
  consent: boolean;
  /**
   * The caller's own id for this submission, 1 to 100 characters. Kept with
   * the queued item and passed back to `onAnswered`. Never sent to the intake.
   */
  ref?: string;
}

export interface WithdrawInput {
  /** The new place's id: `newPlaceId` of the id `report` answered with. */
  place: string;
  contributor?: string;
  consent: boolean;
  /**
   * The caller's own id for this submission, 1 to 100 characters. Kept with
   * the queued item and passed back to `onAnswered`. Never sent to the intake.
   */
  ref?: string;
}

export interface ReviewReportInput {
  /** The review's place. */
  place: string;
  /** Id of the published review, `rev_<ulid>`. */
  review: string;
  reason: ReviewReportReason;
  contributor?: string;
  consent: boolean;
  /**
   * The caller's own id for this submission, 1 to 100 characters. Kept with
   * the queued item and passed back to `onAnswered`. Never sent to the intake.
   */
  ref?: string;
}

export interface PhotoInput {
  place: string;
  /** The signed-in traveller's opaque account id. Required for photos. */
  contributor: string;
  consent: boolean;
  /** Full size JPEG, about 1600 px on the long side, EXIF removed. At most 1.5 MB. */
  full: ArrayBuffer | Uint8Array;
  /** Thumbnail JPEG, about 400 px on the long side. At most 200 KB. */
  thumb: ArrayBuffer | Uint8Array;
}

export interface PhotoReportInput {
  /** The photo's place. */
  place: string;
  /** Id of the published photo, `pho_<ulid>`. */
  photo: string;
  reason: PhotoReportReason;
  contributor?: string;
  consent: boolean;
  /**
   * The caller's own id for this submission, 1 to 100 characters. Kept with
   * the queued item and passed back to `onAnswered`. Never sent to the intake.
   */
  ref?: string;
}

export interface PhotoErasureInput {
  /** The account id whose photos are removed. */
  contributor: string;
  consent: boolean;
  /**
   * The caller's own id for this submission, 1 to 100 characters. Kept with
   * the queued item and passed back to `onAnswered`. Never sent to the intake.
   */
  ref?: string;
}

/**
 * What a photo upload came to. Photos are never queued, because the files are
 * too big for the queue's storage: on `offline` the app keeps the files and
 * calls `photo` again later. `error` is the intake's reason on a refusal, such
 * as `rate_limited`, `attestation_invalid` or `not_jpeg`.
 */
export type PhotoResult =
  | { status: "sent"; id: string }
  | { status: "rejected"; httpStatus: number; error?: string }
  | { status: "offline" };

/**
 * A photo pass for the photo server's `x-photo-pass` header, or why there is
 * none. `expires` is ISO 8601 UTC.
 */
export type PhotoPassResult =
  | { status: "ok"; pass: string; expires: string }
  | { status: "rejected"; httpStatus: number; error?: string }
  | { status: "offline" };

/**
 * What a report, review, check, review report, fee or withdraw came to. On
 * `sent`, `state` and `heldReason` are the intake's decision (`ItemDecision`).
 */
export type SubmitResult =
  | ({ status: "sent"; id: string } & ItemDecision)
  | { status: "queued" }
  | { status: "rejected"; httpStatus: number };

export interface FlushResult {
  sent: number;
  dropped: number;
  remaining: number;
}

export interface OwnerClaimInput {
  place: string;
  owner: OwnerContact;
  /** https page on the owner's own website or Facebook page where they will show the code. */
  proofUrl: string;
  /** The owner ticked the box agreeing to the owner terms. */
  termsAccepted: boolean;
}

export interface OwnerListingInput {
  location: LatLon;
  owner: OwnerContact;
  proofUrl: string;
  listing: OwnerListingSubmission["listing"];
  termsAccepted: boolean;
}

export interface OwnerUpdateInput {
  place: string;
  update: OwnerUpdate;
  termsAccepted: boolean;
}

export interface FeedbackClient {
  report(input: ReportInput): Promise<SubmitResult>;
  review(input: ReviewInput): Promise<SubmitResult>;
  check(input: CheckInput): Promise<SubmitResult>;
  /** Reports what the traveller paid per night. Queued and retried like a review. */
  fee(input: FeeInput): Promise<SubmitResult>;
  /** Reports a published review. Queued and retried like the others. */
  reportReview(input: ReviewReportInput): Promise<SubmitResult>;
  /**
   * Takes back a new place this install sent. Within 24 hours of the report
   * the place comes down; after that the intake counts it as a report.
   * Queued and retried like the others.
   */
  withdraw(input: WithdrawInput): Promise<SubmitResult>;
  /**
   * Claims an existing place for its owner. Sent at once, never queued, because
   * the token in the answer is shown only once. Show `code` and `token` to the
   * owner straight away.
   */
  ownerClaim(input: OwnerClaimInput): Promise<OwnerClaimResponse>;
  /** Lists a private property (farm stay) that is not in the data yet. Sent at once. */
  ownerListing(input: OwnerListingInput): Promise<OwnerClaimResponse>;
  /** Sends an owner's change, with the token from their approved claim. Sent at once. */
  ownerUpdate(token: string, input: OwnerUpdateInput): Promise<AcceptedResponse>;
  /** Sends queued items that are due. Call when the app comes to the foreground or regains a connection. */
  flush(): Promise<FlushResult>;
  /** Number of items waiting to be sent. */
  pending(): Promise<number>;
}

/**
 * The client for an app's own photo service: the Open Camping DB photo kit
 * (packages/intake with a photo bucket, packages/photos and the apply photo
 * rules) run by the app's developer. Open Camping DB itself holds no photos.
 */
export interface PhotoClient {
  /**
   * Uploads a photo of a place, sent at once and never queued. The answer's
   * id is the photo's, `pho_<ulid>`. The photo stays private until a person
   * or the apply rules accept it and its record is merged.
   */
  photo(input: PhotoInput): Promise<PhotoResult>;
  /**
   * A photo pass to send in `x-photo-pass` with every photo request. Kept in
   * memory and reused until five minutes before it expires, so call it before
   * each photo request. Pass `renew: true` after the photo server answers
   * `401 invalid_pass`, to drop the kept pass and get a new one. Needs an app
   * key that requires attestation, or one allowed unattested passes.
   */
  photoPass(options?: { renew?: boolean }): Promise<PhotoPassResult>;
  /** Reports a published photo. Queued and retried, like feedback. */
  reportPhoto(input: PhotoReportInput): Promise<SubmitResult>;
  /**
   * Asks for every photo from the contributor to be removed. Call it before
   * deleting the account. Queued and retried, like feedback.
   */
  erasePhotos(input: PhotoErasureInput): Promise<SubmitResult>;
  /** Sends queued reports and erasures that are due. Call when the app comes to the foreground. */
  flush(): Promise<FlushResult>;
  /** Number of items waiting to be sent. */
  pending(): Promise<number>;
}

/** Options for a photo client: as for feedback, with the photo service's endpoint and app key. */
export type PhotoClientOptions = FeedbackClientOptions;

export class ConsentRequiredError extends Error {
  constructor() {
    super("Sending needs consent: true, given after the user agreed to CONSENT_TEXT, or to the app's own photo terms for photos");
    this.name = "ConsentRequiredError";
  }
}

export class OwnerTermsRequiredError extends Error {
  constructor() {
    super("Owner submissions need termsAccepted: true, given after the owner agreed to the owner terms");
    this.name = "OwnerTermsRequiredError";
  }
}

/** The intake refused an owner submission, or could not be reached (httpStatus 0). Nothing was queued. */
export class OwnerRequestError extends Error {
  readonly httpStatus: number;
  readonly details: string[];
  constructor(httpStatus: number, details: string[] = []) {
    super(
      httpStatus === 0
        ? "The intake could not be reached. Nothing was sent; try again when online."
        : `The intake refused the owner submission with ${httpStatus}${details.length ? `: ${details.join("; ")}` : ""}`,
    );
    this.name = "OwnerRequestError";
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class FeedbackValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Feedback is not valid: ${errors.join("; ")}`);
    this.name = "FeedbackValidationError";
    this.errors = errors;
  }
}

interface QueueItem {
  localId: string;
  /** The caller's own ref, kept here and never sent. Items queued before 0.8.0 have none. */
  ref?: string;
  body: FeedbackSubmission;
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number;
}

/**
 * What became of a queued item. `id` is the intake's id for it (for a new
 * place, the id to pass to `newPlaceId`), and `state` and `heldReason` say
 * whether it went live or is held (`ItemDecision`). `httpStatus` is the intake's refusal,
 * or 0 when the SDK dropped the item unsent because it grew too old or the
 * queue was full.
 */
export type AnswerOutcome = ({ kind: "sent"; id: string } & ItemDecision) | { kind: "dropped"; httpStatus: number };

/**
 * The intake's codes for why it held an item at send time. Adding a code is
 * additive; renaming or removing one is a breaking change.
 *
 * - `not_attested`: the report was not from an attested install, so a person
 *   reads it (a contact) or a second device has to agree (any other fact). On a
 *   doubt or a confirmation of a value doubts took down, none of the reports
 *   counted was attested.
 * - `owner_value`: the place's owner set the value.
 * - `disagreement`: another source sent a different value within 90 days, or as
 *   many sources confirm a doubted fact as doubt it.
 * - `link_check`: a link failed the link rules or the malware check.
 * - `text_check`: free text failed the text checks.
 * - `unconfirmed`: a contact report from one source, or with none attested.
 * - `no_contributor`: a new place sent without a contributor.
 * - `daily_cap`: the contributor has had 50 live changes this UTC day.
 * - `ai_check`: the AI check flagged free text.
 * - `check_unavailable`: a check could not run, so the item waits.
 * - `unknown_place`: the intake does not have the place yet.
 * - `blocked`: the contributor is blocked.
 * - `no_value`: a contact report or doubt about a fact the place does not have.
 * - `invalid_value`: not a valid value for the fact.
 * - `single_doubt`: one traveller doubts the fact, so a reviewer reads it. The fact stays.
 * - `protected_source`: a doubt about a fact from OSM or the owner, which doubts never take down.
 * - `taken_down`: a report of a value doubts took down, which returns when two new travellers confirm it.
 */
export const HELD_REASONS = [
  "not_attested",
  "owner_value",
  "disagreement",
  "link_check",
  "text_check",
  "unconfirmed",
  "no_contributor",
  "daily_cap",
  "ai_check",
  "check_unavailable",
  "unknown_place",
  "blocked",
  "no_value",
  "invalid_value",
  "single_doubt",
  "protected_source",
  "taken_down",
] as const;

/** Why the intake held an item at send time. */
export type HeldReason = (typeof HELD_REASONS)[number];

const KNOWN_HELD_REASONS: ReadonlySet<string> = new Set<string>(HELD_REASONS);

/**
 * What the intake decided about a sent item. `state` is `live` when the change
 * shows at once (on the recent list), or `held` when it waits for a reviewer,
 * with `heldReason`. Both are absent when the intake did not decide the item at
 * send time (the apply decides it later), and from intakes older than 0.10.0.
 * `heldReason` is also absent when the intake sent a code this SDK does not know.
 */
export interface ItemDecision {
  state?: "live" | "held";
  heldReason?: HeldReason;
}

/** The decision in an accepted item's answer, as `ItemDecision`. Empty when the answer has none this SDK can read. */
export function itemDecision(answer: unknown): ItemDecision {
  if (typeof answer !== "object" || answer === null) return {};
  const { state, held_reason } = answer as { state?: unknown; held_reason?: unknown };
  if (state === "live") return { state: "live" };
  if (state !== "held") return {};
  return typeof held_reason === "string" && KNOWN_HELD_REASONS.has(held_reason) ? { state: "held", heldReason: held_reason as HeldReason } : { state: "held" };
}

/** What `onAnswered` is told when a queued item is settled. */
export interface Answer {
  /** The `ref` the caller gave the submission. Absent when it had none. */
  ref?: string;
  /** The submission's type, such as `report` or `check`. */
  type: FeedbackSubmission["type"];
  outcome: AnswerOutcome;
}

type Outcome = AnswerOutcome;

/** Longest `ref` a caller can give a submission. */
export const MAX_REF_LENGTH = 100;

const BASE_DELAY_MS = 30_000;
/** A photo pass is renewed when it has less than this left. */
const PASS_REFRESH_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function defaultRandomUUID(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A JPEG starts with the SOI marker and another marker: FF D8 FF. */
export function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += alphabet[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += alphabet[n & 63]!;
  }
  return out;
}

/** Delay before the next try after `attempts` failures, with jitter between half and all of it. */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

function createClient(options: FeedbackClientOptions): FeedbackClient & PhotoClient {
  const {
    appKey,
    appVersion,
    storage,
    maxQueueLength = 100,
    maxQueueAgeMs = 30 * DAY_MS,
    storagePrefix = "ocdb.feedback",
  } = options;
  const url = `${options.endpoint.replace(/\/+$/, "")}/v1/feedback`;
  const photoUrl = `${options.endpoint.replace(/\/+$/, "")}/v1/photos`;
  const passUrl = `${photoUrl}/pass`;
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => (globalThis.fetch as unknown as FetchLike)(input, init));
  const doFetchPhoto: PhotoFetchLike =
    options.fetchPhoto ?? ((input, init) => (globalThis.fetch as unknown as PhotoFetchLike)(input, init));
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const deviceKey = `${storagePrefix}.device`;
  const queueKey = `${storagePrefix}.queue`;

  if (!appKey) throw new Error("appKey is required");
  if (!appVersion) throw new Error("appVersion is required");

  // Every read-modify-write of the queue runs through this chain, one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  }

  async function device(): Promise<string> {
    const existing = await storage.getItem(deviceKey);
    if (existing) return existing;
    const id = randomUUID();
    await storage.setItem(deviceKey, id);
    return id;
  }

  async function readQueue(): Promise<QueueItem[]> {
    const raw = await storage.getItem(queueKey);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as QueueItem[]) : [];
    } catch {
      return [];
    }
  }

  async function writeQueue(queue: QueueItem[]): Promise<void> {
    if (queue.length === 0) await storage.removeItem(queueKey);
    else await storage.setItem(queueKey, JSON.stringify(queue));
  }

  async function sendOne(item: QueueItem): Promise<"sent" | "drop" | "retry" | "stop"> {
    const body = JSON.stringify(item.body);
    let attestation: Record<string, string> = {};
    if (options.attest) {
      try {
        attestation = await options.attest({ body, bodySha256: sha256Hex(body) });
      } catch {
        return "stop"; // the platform could not attest now, so try again later
      }
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { ...attestation, "content-type": "application/json", "x-app-key": appKey },
        body,
      });
    } catch {
      return "stop"; // offline or the host is unreachable
    }
    if (res.status >= 200 && res.status < 300) {
      let id = "";
      let decision: ItemDecision = {};
      try {
        const body = (await res.json()) as { id?: unknown };
        if (typeof body.id === "string") id = body.id;
        decision = itemDecision(body);
      } catch {
        // A 2xx without a readable body still means the intake has it.
      }
      record(item, { kind: "sent", id, ...decision });
      return "sent";
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) {
        item.attempts += 1;
        item.nextAttemptAt = now() + retryAfter * 1000;
      }
      return "stop";
    }
    if (res.status >= 500 || res.status === 408) return "stop";
    if (res.status === 401) {
      // A refused assertion keeps the item: the next try brings a fresh
      // assertion or token. Any other 401 (an unknown app key) drops it.
      let answer: unknown;
      try {
        answer = await res.json();
      } catch {
        answer = undefined;
      }
      const error = attestationErrorIn(res.status, answer);
      if (error) {
        await callRefusalHook(options.onAttestationRejected, error, answer);
        return "stop";
      }
    }
    record(item, { kind: "dropped", httpStatus: res.status });
    return "drop";
  }

  // Outcomes are kept only for items a report(), review(), check() or reportReview() call is waiting on.
  const waiting = new Set<string>();
  const outcomes = new Map<string, Outcome>();
  // Answers for onAnswered, kept until the queue is saved and then told in order.
  const answers: Answer[] = [];
  function record(item: QueueItem, outcome: Outcome): void {
    if (waiting.has(item.localId)) outcomes.set(item.localId, outcome);
    if (options.onAnswered) answers.push({ ...(item.ref !== undefined ? { ref: item.ref } : {}), type: item.body.type, outcome });
  }

  async function tellAnswers(): Promise<void> {
    const hook = options.onAnswered;
    if (!hook) return;
    for (let answer = answers.shift(); answer; answer = answers.shift()) {
      try {
        await hook(answer);
      } catch {
        // The app's own record keeping failing must not stop the queue.
      }
    }
  }

  async function flushNow(): Promise<FlushResult> {
    const result = await serial(async () => {
      const queue = await readQueue();
      const t = now();
      const kept: QueueItem[] = [];
      let sent = 0;
      let dropped = 0;
      let stopped = false;
      for (const item of queue) {
        if (t - item.queuedAt > maxQueueAgeMs) {
          record(item, { kind: "dropped", httpStatus: 0 });
          dropped += 1;
          continue;
        }
        if (stopped || item.nextAttemptAt > t) {
          kept.push(item);
          continue;
        }
        const before = item.attempts;
        const result = await sendOne(item);
        if (result === "sent") sent += 1;
        else if (result === "drop") dropped += 1;
        else {
          if (item.attempts === before) {
            item.attempts += 1;
            item.nextAttemptAt = t + backoffDelay(item.attempts, random);
          }
          kept.push(item);
          stopped = true;
        }
      }
      await writeQueue(kept);
      return { sent, dropped, remaining: kept.length };
    });
    await tellAnswers();
    return result;
  }

  async function submit(
    { ref, ...input }: { consent: boolean; ref?: string | undefined } & Record<string, unknown>,
    type: FeedbackSubmission["type"],
  ) {
    if (input.consent !== true) throw new ConsentRequiredError();
    if (ref !== undefined && (typeof ref !== "string" || ref.length < 1 || ref.length > MAX_REF_LENGTH)) {
      throw new FeedbackValidationError([`ref must be a string of 1 to ${MAX_REF_LENGTH} characters`]);
    }
    const localId = await serial(async () => {
      const body = { ...input, type, device: await device(), app_version: appVersion, consent: true };
      const checked = validateSubmission(body, new Date(now()));
      if (!checked.ok) throw new FeedbackValidationError(checked.errors);
      const queue = await readQueue();
      const item: QueueItem = {
        localId: randomUUID(),
        ...(ref !== undefined ? { ref } : {}),
        body: checked.value as FeedbackSubmission,
        queuedAt: now(),
        attempts: 0,
        nextAttemptAt: 0,
      };
      queue.push(item);
      while (queue.length > maxQueueLength) record(queue.shift()!, { kind: "dropped", httpStatus: 0 });
      await writeQueue(queue);
      waiting.add(item.localId);
      return item.localId;
    });
    try {
      await flushNow();
    } finally {
      waiting.delete(localId);
    }
    const outcome = outcomes.get(localId);
    outcomes.delete(localId);
    if (!outcome) return { status: "queued" } as const;
    if (outcome.kind === "sent") {
      const { kind: _kind, ...sent } = outcome;
      return { status: "sent", ...sent } as const;
    }
    return { status: "rejected", httpStatus: outcome.httpStatus } as const;
  }

  /** Sends an owner submission straight away and returns the intake's answer. */
  async function sendOwner(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (body.terms_accepted !== true) throw new OwnerTermsRequiredError();
    const full = { ...body, device: await serial(device), app_version: appVersion };
    const checked = validateSubmission(full);
    if (!checked.ok) throw new FeedbackValidationError(checked.errors);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-key": appKey },
        body: JSON.stringify(checked.value),
      });
    } catch {
      throw new OwnerRequestError(0);
    }
    let answer: Record<string, unknown> = {};
    try {
      const parsed: unknown = await res.json();
      if (parsed && typeof parsed === "object") answer = parsed as Record<string, unknown>;
    } catch {
      // Leave the answer empty.
    }
    if (res.status < 200 || res.status >= 300) {
      const details = Array.isArray(answer.details) ? answer.details.map(String) : [];
      throw new OwnerRequestError(res.status, details);
    }
    return answer;
  }

  /** Sends a photo's meta in a header and both files, full then thumb, as the body. */
  async function sendPhoto(input: PhotoInput): Promise<PhotoResult> {
    if (input.consent !== true) throw new ConsentRequiredError();
    const full = input.full instanceof Uint8Array ? input.full : new Uint8Array(input.full);
    const thumb = input.thumb instanceof Uint8Array ? input.thumb : new Uint8Array(input.thumb);
    const problems: string[] = [];
    if (!isJpeg(full)) problems.push("full is not a JPEG");
    if (!isJpeg(thumb)) problems.push("thumb is not a JPEG");
    if (full.length > MAX_PHOTO_BYTES) problems.push(`full is over ${MAX_PHOTO_BYTES} bytes`);
    if (thumb.length > MAX_THUMB_BYTES) problems.push(`thumb is over ${MAX_THUMB_BYTES} bytes`);
    if (problems.length > 0) throw new FeedbackValidationError(problems);
    const meta = {
      type: "photo",
      place: input.place,
      contributor: input.contributor,
      device: await serial(device),
      app_version: appVersion,
      consent: true,
      photo: {
        full_sha256: sha256HexBytes(full),
        full_bytes: full.length,
        thumb_sha256: sha256HexBytes(thumb),
        thumb_bytes: thumb.length,
      },
    };
    const checked = validateSubmission(meta, new Date(now()));
    if (!checked.ok) throw new FeedbackValidationError(checked.errors);
    const text = JSON.stringify(checked.value);
    let attestation: Record<string, string> = {};
    if (options.attest) {
      try {
        attestation = await options.attest({ body: text, bodySha256: sha256Hex(text) });
      } catch {
        return { status: "offline" };
      }
    }
    const body = new Uint8Array(full.length + thumb.length);
    body.set(full);
    body.set(thumb, full.length);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetchPhoto(photoUrl, {
        method: "POST",
        headers: {
          ...attestation,
          "content-type": "application/octet-stream",
          "x-app-key": appKey,
          "x-photo-meta": base64Url(new TextEncoder().encode(text)),
        },
        body,
      });
    } catch {
      return { status: "offline" };
    }
    let answer: { id?: unknown; error?: unknown } = {};
    try {
      answer = ((await res.json()) ?? {}) as typeof answer;
    } catch {
      // Leave the answer empty.
    }
    if (res.status >= 200 && res.status < 300) return { status: "sent", id: typeof answer.id === "string" ? answer.id : "" };
    const refused = attestationErrorIn(res.status, answer);
    if (refused) await callRefusalHook(options.onAttestationRejected, refused, answer);
    return { status: "rejected", httpStatus: res.status, ...(typeof answer.error === "string" ? { error: answer.error } : {}) };
  }

  // The current pass, and a request for a new one already under way.
  let currentPass: { pass: string; expires: string } | undefined;
  let passRequest: Promise<PhotoPassResult> | undefined;

  async function requestPass(): Promise<PhotoPassResult> {
    const body = JSON.stringify({
      type: "photo_pass",
      device: await serial(device),
      app_version: appVersion,
      time: new Date(now()).toISOString(),
    });
    let attestation: Record<string, string> = {};
    if (options.attest) {
      try {
        attestation = await options.attest({ body, bodySha256: sha256Hex(body) });
      } catch {
        return { status: "offline" };
      }
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(passUrl, { method: "POST", headers: { ...attestation, "content-type": "application/json", "x-app-key": appKey }, body });
    } catch {
      return { status: "offline" };
    }
    let answer: { pass?: unknown; expires?: unknown; error?: unknown } = {};
    try {
      answer = ((await res.json()) ?? {}) as typeof answer;
    } catch {
      // Leave the answer empty.
    }
    if (res.status === 200 && typeof answer.pass === "string" && typeof answer.expires === "string") {
      currentPass = { pass: answer.pass, expires: answer.expires };
      return { status: "ok", ...currentPass };
    }
    const refused = attestationErrorIn(res.status, answer);
    if (refused) await callRefusalHook(options.onAttestationRejected, refused, answer);
    return { status: "rejected", httpStatus: res.status, ...(typeof answer.error === "string" ? { error: answer.error } : {}) };
  }

  function photoPass(passOptions: { renew?: boolean } = {}): Promise<PhotoPassResult> {
    if (passOptions.renew) currentPass = undefined;
    if (currentPass && Date.parse(currentPass.expires) - now() > PASS_REFRESH_MS) return Promise.resolve({ status: "ok", ...currentPass });
    passRequest ??= requestPass().finally(() => {
      passRequest = undefined;
    });
    return passRequest;
  }

  const claimResponse = (answer: Record<string, unknown>): OwnerClaimResponse => ({
    id: String(answer.id ?? ""),
    code: String(answer.code ?? ""),
    token: String(answer.token ?? ""),
  });

  return {
    ownerClaim: async (input) =>
      claimResponse(
        await sendOwner({
          type: "owner_claim",
          place: input.place,
          terms_accepted: input.termsAccepted,
          owner: input.owner,
          claim: { proof_url: input.proofUrl },
        }),
      ),
    ownerListing: async (input) =>
      claimResponse(
        await sendOwner({
          type: "owner_listing",
          place: null,
          location: input.location,
          terms_accepted: input.termsAccepted,
          owner: input.owner,
          claim: { proof_url: input.proofUrl },
          listing: input.listing,
        }),
      ),
    ownerUpdate: async (token, input) => {
      const answer = await sendOwner({
        type: "owner_update",
        place: input.place,
        terms_accepted: input.termsAccepted,
        token,
        update: input.update,
      });
      return { id: String(answer.id ?? "") };
    },
    report: (input) => submit({ ...input }, "report"),
    review: (input) => submit({ ...input }, "review"),
    check: (input) => submit({ ...input }, "check"),
    fee: (input) => submit({ ...input }, "fee"),
    reportReview: ({ place, review, reason, contributor, consent, ref }) =>
      submit(
        { place, review_report: { review, reason }, ...(contributor !== undefined ? { contributor } : {}), consent, ref },
        "review_report",
      ),
    withdraw: ({ place, contributor, consent, ref }) =>
      submit({ place, ...(contributor !== undefined ? { contributor } : {}), consent, ref }, "withdraw"),
    photo: sendPhoto,
    photoPass,
    reportPhoto: ({ place, photo, reason, contributor, consent, ref }) =>
      submit(
        { place, photo_report: { photo, reason }, ...(contributor !== undefined ? { contributor } : {}), consent, ref },
        "photo_report",
      ),
    erasePhotos: ({ contributor, consent, ref }) => submit({ place: null, contributor, consent, ref }, "photo_erasure"),
    flush: flushNow,
    pending: () => serial(async () => (await readQueue()).length),
  };
}

/** A client for Open Camping DB's feedback intake: reports, reviews, checks, fees and owner requests. */
export function createFeedbackClient(options: FeedbackClientOptions): FeedbackClient {
  const { photo: _photo, photoPass: _pass, reportPhoto: _report, erasePhotos: _erase, ...feedback } = createClient(options);
  return feedback;
}

/**
 * A client for an app's own photo service. Its storage keys default to the
 * `ocdb.photos` prefix, so its queue stays apart from the feedback client's.
 */
export function createPhotoClient(options: PhotoClientOptions): PhotoClient {
  const client = createClient({ storagePrefix: "ocdb.photos", ...options });
  return {
    photo: client.photo,
    photoPass: client.photoPass,
    reportPhoto: client.reportPhoto,
    erasePhotos: client.erasePhotos,
    flush: client.flush,
    pending: client.pending,
  };
}
