import type {
  FactName,
  FactValue,
  PlaceFacts,
  AcceptedResponse,
  CheckBody,
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
  FirstHand,
} from "./types.js";
import { isFeedbackId, readProgress, type Progress } from "./progress.js";
import { sha256Hex, sha256HexBytes } from "./sha256.js";
import { IDEMPOTENCY_HEADER, MAX_PHOTO_BYTES, MAX_THUMB_BYTES, isIdempotencyKey, isPhotoId, isPlaceId, newPlaceId, validateSubmission } from "./validate.js";

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
  /** Aborted when the request runs past `timeoutMs`. A fetch that ignores it is still given up on. */
  signal?: AbortSignal;
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
  /** Defaults to the global `fetch`. `progress()` calls it with method `GET` and no body. */
  fetch?: FetchLike;
  /** Fetch for photo uploads. Defaults to the global `fetch`. */
  fetchPhoto?: PhotoFetchLike;
  /** Source of random UUIDs. Defaults to `crypto.randomUUID`. */
  randomUUID?: () => string;
  /** Clock, in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /** Random number in [0, 1) used for backoff jitter. Defaults to `Math.random`. */
  random?: () => number;
  /**
   * Longest wait, in milliseconds, for one request to the intake, including
   * reading its answer, and for one attestation. Past it the request is
   * aborted and treated as offline, so the queue moves on. Default 30 000.
   */
  timeoutMs?: number;
  /** Most items kept in the queue. The oldest are dropped past this. Default 100. */
  maxQueueLength?: number;
  /** Items older than this are dropped unsent. Default 30 days. */
  maxQueueAgeMs?: number;
  /** Prefix for storage keys. Default `ocdb.feedback`. */
  storagePrefix?: string;
  /**
   * Most queued items sent together in one `POST /v1/feedback/batch`, with
   * one attestation over the batch, from 1 to MAX_BATCH_SIZE. Default
   * MAX_BATCH_SIZE. A flush sends one item alone to `POST /v1/feedback`, and
   * sends every item alone when the intake has no batch route.
   */
  maxBatchSize?: number;
  /**
   * Proves the install to an intake whose app key requires attestation.
   * Called each time a report, review, check or review report is sent,
   * and once for each batch of them, with the exact body text and its SHA-256
   * (lower case hex). Return the
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

/**
 * A place the traveller has just added and that is still waiting for its id:
 * `newPlace` is the `ref` given to that `new_place` report. Items naming it
 * wait in the queue, unsent, until the new place is sent; then they get its
 * `ocdb_` id and are sent in order. If the new place is dropped, so are they.
 */
export interface NewPlaceRef {
  newPlace: string;
}

/** A released place's `ocdb_` id, or a new place still waiting for its id. */
export type PlaceTarget = string | NewPlaceRef;

export interface ReportInput {
  /** The place, a new place waiting for its id, or null for a `new_place` report. */
  place: PlaceTarget | null;
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

/** A traveller's edit of one released place: every fact they set, in one call. */
export interface FactsInput {
  place: PlaceTarget;
  /** The facts the traveller set, each with its new value. A fact left undefined is skipped. */
  facts: { [F in FactName]?: PlaceFacts[F] | undefined };
  /** The signed-in traveller's opaque account id, when there is one. */
  contributor?: string;
  consent: boolean;
  /**
   * The caller's own id for this edit, 1 to 90 characters. Each fact's report
   * is queued with the ref `<ref>:<fact>`, passed back to `onAnswered`.
   */
  ref?: string;
  /** Marks every fact of the edit first-hand, as `report.first_hand` does on a single report. */
  first_hand?: FirstHand;
}

/** How a queued call resolves. */
export interface SubmitOptions {
  /**
   * `true` (the default) resolves once a send has been tried, with `sent`,
   * `rejected` or `queued`. `false` resolves `{ status: "queued" }` as soon as
   * the item is checked and saved, and starts a send without waiting for it:
   * the outcome reaches `onAnswered`. A refused input still throws first.
   */
  wait?: boolean;
}

/** What one fact of a `reportFacts` edit came to. */
export interface FactResult {
  fact: FactName;
  result: SubmitResult;
}

export interface ReviewInput {
  place: PlaceTarget;
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

export interface CheckInput {
  place: PlaceTarget;
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
  /**
   * The place, or a new place still waiting for its id (`{ newPlace: <ref> }`).
   * For a waiting place the photo is not uploaded yet: the client keeps a small
   * record with `key` and uploads the files `loadPhoto(key)` gives it once the
   * new place has its id (on `flush`).
   */
  place: PlaceTarget;
  /** The app's own key for these files, for `loadPhoto` and `onPhotoSettled`. Required when `place` is a new place. */
  key?: string;
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

export interface PhotoRemovalInput {
  /** The photo's place. */
  place: string;
  /** Id of the contributor's own photo, `pho_<ulid>`. */
  photo: string;
  /** The signed-in traveller's account id: the one that sent the photo. */
  contributor: string;
  /**
   * A proof from your app's server that the signed-in account is this
   * contributor (`signContributorProof`). Needed when the app key has
   * `contributor_proof_key`; the intake answers 401 `proof_required` or
   * `proof_invalid` without it. Make it right before the call: it lives at
   * most an hour, and a queued item sent later than that is refused.
   */
  contributorProof?: string;
  consent: boolean;
  /**
   * The caller's own id for this submission, 1 to 100 characters. Kept with
   * the queued item and passed back to `onAnswered`. Never sent to the intake.
   */
  ref?: string;
}

/** What `eraseReviews` takes: the same as `erasePhotos`. */
export interface ReviewErasureInput {
  /** The account id whose reviews are removed: the `contributor` its reviews were sent with. */
  contributor: string;
  /**
   * A proof from your app's server that the signed-in account is this
   * contributor (`signContributorProof` with action `review_erasure` and
   * photo `"*"`). Needed when the app key has `contributor_proof_key`; the
   * intake answers 401 `proof_required` or `proof_invalid` without it. Make it
   * right before the call: it lives at most an hour, and a queued item sent
   * later than that is refused.
   */
  contributorProof?: string;
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
  /**
   * A proof from your app's server that the signed-in account is this
   * contributor (`signContributorProof`). Needed when the app key has
   * `contributor_proof_key`; the intake answers 401 `proof_required` or
   * `proof_invalid` without it. Make it right before the call: it lives at
   * most an hour, and a queued item sent later than that is refused.
   */
  contributorProof?: string;
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
  /** The place is a new place still waiting for its id. The photo goes on a later `flush`; keep the files until `onPhotoSettled`. */
  | { status: "waiting" }
  | { status: "rejected"; httpStatus: number; error?: string }
  /**
   * The photo service takes photos only from a newer version of the app
   * (`403 app_update_required`). `minimum` is the lowest version it takes,
   * when it says. Ask the traveller to update the app to add photos. A photo
   * waiting for a new place stays waiting, so it goes from the updated app.
   */
  | { status: "update_required"; minimum?: string }
  | { status: "offline" };

/** Where a new place a ref names stands: still `waiting` to be sent, `sent` with its `ocdb_` id, `dropped`, or `unknown`. */
export type NewPlaceStatus = { status: "waiting" } | { status: "sent"; place: string } | { status: "dropped" } | { status: "unknown" };

/**
 * What became of a photo that waited for a new place's id. `sent` carries the
 * photo id. `dropped` says why: `new_place_dropped` (the new place was dropped
 * or refused), `photo_missing` (`loadPhoto` gave null), `rejected` (the photo
 * service refused it, with `httpStatus` and `error`) or `expired` (it waited
 * longer than `maxQueueAgeMs`). Either way the app can delete its files.
 */
export interface PhotoSettled {
  key: string;
  /** The ref of the new place the photo waited for. */
  newPlace: string;
  outcome:
    | { status: "sent"; id: string; place: string }
    | { status: "dropped"; reason: "new_place_dropped" | "photo_missing" | "rejected" | "expired"; httpStatus?: number; error?: string };
}

/**
 * A photo pass for the photo server's `x-photo-pass` header, or why there is
 * none. `expires` is ISO 8601 UTC.
 */
export type PhotoPassResult =
  | { status: "ok"; pass: string; expires: string }
  | { status: "rejected"; httpStatus: number; error?: string }
  | { status: "offline" };

/**
 * What a report, review, check, review report or withdraw came to. On
 * `sent`, `state` and `heldReason` are the intake's decision (`ItemDecision`).
 */
export type SubmitResult =
  | ({ status: "sent"; id: string } & ItemDecision)
  | { status: "queued" }
  | { status: "rejected"; httpStatus: number };

/** How a `flush` picks the items it tries. */
export interface FlushOptions {
  /**
   * `true` tries every item now, skipping the client's own backoff after a
   * failed try. An item still waits out a wait the intake asked for (a 429
   * with `Retry-After`, or a batch item's `retry_after`), and an item waiting
   * for a new place's id still waits for it. Items older than
   * `maxQueueAgeMs` are still dropped.
   */
  ignoreBackoff?: boolean;
}

/**
 * How the queue stands, in counts and times only: never what a traveller
 * wrote, the device or the contributor, so it can go to an error tracker.
 */
export interface QueueSummary {
  items: number;
  /** Items tried at least once. */
  tried: number;
  /** When the oldest item was queued, in milliseconds, or null for an empty queue. */
  oldestQueuedAt: number | null;
  mostAttempts: number;
  /** The submission types in the queue, sorted, each once. */
  types: string[];
  /**
   * When the next item is due, in milliseconds, or null when none is waiting:
   * every item is due now or waits for a new place's id.
   */
  nextAttemptAt: number | null;
  /** The end of the longest wait the intake asked for that is not over yet, or null. */
  intakeWaitUntil: number | null;
  /** Items waiting for a new place's id. */
  waitingForNewPlace: number;
}

/** What `queuedRefs` answers on the feedback client. */
export interface QueuedRefs {
  refs: string[];
}

/** What `queuedRefs` answers on the photo client. */
export interface PhotoQueuedRefs extends QueuedRefs {
  /** The `key` of each photo waiting for a new place's id. */
  waitingPhotoKeys: string[];
}

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
  /**
   * Queues a report and tries to send it. Resolves once the send has been
   * tried, or with `{ wait: false }` as soon as it is saved (`SubmitOptions`).
   */
  report(input: ReportInput, options?: SubmitOptions): Promise<SubmitResult>;
  /**
   * Sends a traveller's edit of one place: one fact report for each fact, in
   * the order given, each queued and retried like `report`. Every fact is
   * checked first, so one refused fact throws before anything is queued. The
   * facts are then queued together and sent in one batch with one
   * attestation. The intake counts an install's reports about one place in a
   * day once against its daily limits, so a full edit costs no more than one
   * fact. Resolves with each fact's result, in the same order.
   */
  reportFacts(input: FactsInput, options?: SubmitOptions): Promise<FactResult[]>;
  review(input: ReviewInput, options?: SubmitOptions): Promise<SubmitResult>;
  check(input: CheckInput, options?: SubmitOptions): Promise<SubmitResult>;
  /** Reports a published review. Queued and retried like the others. */
  reportReview(input: ReviewReportInput): Promise<SubmitResult>;
  /**
   * Asks for every review the contributor sent to be removed from the data,
   * for example when the traveller deletes their account or their data. The
   * next apply run takes their reviews out of the data and its ratings, and
   * drops any still waiting for a person. Queued and retried, like feedback.
   */
  eraseReviews(input: ReviewErasureInput): Promise<SubmitResult>;
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
  /**
   * Sends queued items that are due. Call when the app comes to the foreground
   * or regains a connection. With `ignoreBackoff`, every item is tried now
   * (`FlushOptions`).
   */
  flush(options?: FlushOptions): Promise<FlushResult>;
  /** Number of items waiting to be sent. */
  pending(): Promise<number>;
  /**
   * How this client's queue stands (`QueueSummary`). Sees every item queued
   * by an earlier call, makes no request and writes nothing.
   */
  queueSummary(): Promise<QueueSummary>;
  /**
   * The `ref` of each item still queued, in queue order. An item queued
   * without a ref is left out. Sees every item queued by an earlier call,
   * makes no request and writes nothing.
   */
  queuedRefs(): Promise<QueuedRefs>;
  /**
   * Where the new place a `new_place` report's ref names stands: `waiting`,
   * `sent` with its `ocdb_` id, `dropped`, or `unknown`. Pass it to a photo
   * client as `resolveNewPlace`, so photos of a new place can wait for its id.
   */
  newPlace(ref: string): Promise<NewPlaceStatus>;
  /**
   * Where each contribution is, by the id the intake answered when it was
   * sent (`outcome.id` in `onAnswered`, or `id` in a `sent` result). Asks
   * `GET /v1/feedback/progress` at once, never queued, in calls of up to 100
   * ids, and answers one `Progress` for each id in the order given. An id
   * that is not a feedback id (such as a photo's `pho_` id, which `photos.progress` answers) is answered
   * `unknown` without asking. Throws `ProgressRequestError` when the intake
   * cannot be reached or refuses the call.
   */
  progress(ids: readonly string[]): Promise<Progress[]>;
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
   * Asks for one of the contributor's own photos to be removed. The photo
   * service stops serving it at once when it can confirm the photo is theirs,
   * and the next apply run deletes its record and files. Queued and retried,
   * like feedback.
   */
  removePhoto(input: PhotoRemovalInput): Promise<SubmitResult>;
  /**
   * Asks for every photo from the contributor to be removed. Call it before
   * deleting the account. Queued and retried, like feedback.
   */
  erasePhotos(input: PhotoErasureInput): Promise<SubmitResult>;
  /** Sends queued reports and erasures that are due, as the feedback client's `flush` does. Call when the app comes to the foreground. */
  flush(options?: FlushOptions): Promise<FlushResult>;
  /** Number of items waiting to be sent. */
  pending(): Promise<number>;
  /** How this client's queue stands, as the feedback client's `queueSummary` answers. */
  queueSummary(): Promise<QueueSummary>;
  /**
   * The `ref` of each item still queued, as the feedback client's
   * `queuedRefs` answers, and the `key` of each photo still waiting for a new
   * place's id, in the order they were taken: keep those files.
   */
  queuedRefs(): Promise<PhotoQueuedRefs>;
  /**
   * Where each photo is, by the `pho_` id its upload answered (`id` in a
   * `sent` result or in `onPhotoSettled`). Asks the photo intake's
   * `GET /v1/photos/progress` at once, in calls of up to 100 ids, and answers
   * one `Progress` for each id in the order given, as the feedback client's
   * `progress` does: `received`, `waiting`, `accepted`, `held` (with
   * `held_reason`, one of `PHOTO_HELD_REASONS`), `refused` (with `by` and
   * `reason`), `in_data` (published in the photo records, with `in_data_at`)
   * or `unknown`. Unlike feedback, a photo can leave `in_data`: hidden after
   * reports it is `held`, removed it is `refused`. An id that is not a photo
   * id is answered `unknown` without asking. Throws `ProgressRequestError`
   * when the photo intake cannot be reached or refuses the call.
   */
  progress(ids: readonly string[]): Promise<Progress[]>;
}

/** Options for a photo client: as for feedback, with the photo service's endpoint and app key. */
export interface PhotoClientOptions extends FeedbackClientOptions {
  /**
   * Where a new place stands, for photos of a place still waiting for its id:
   * pass the feedback client's `newPlace`. Needed to photograph a new place.
   */
  resolveNewPlace?: (ref: string) => Promise<NewPlaceStatus>;
  /** The files the app kept under `key`, or null when it no longer has them. Needed to photograph a new place. */
  loadPhoto?: (key: string) => Promise<{ full: ArrayBuffer | Uint8Array; thumb: ArrayBuffer | Uint8Array } | null>;
  /** Called once for each photo that waited for a new place, when it was uploaded or dropped. Errors in it are caught. */
  onPhotoSettled?: (settled: PhotoSettled) => Promise<void> | void;
}

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

/** `progress()` could not ask the intake (httpStatus 0), or the intake refused the call with httpStatus. */
export class ProgressRequestError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number) {
    super(httpStatus === 0 ? "The intake could not be reached. Try again when online." : `The intake refused the progress call with ${httpStatus}`);
    this.name = "ProgressRequestError";
    this.httpStatus = httpStatus;
  }
}

/** Most ids in one `GET /v1/feedback/progress` call. */
export const MAX_PROGRESS_IDS = 100;

export class FeedbackValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Feedback is not valid: ${errors.join("; ")}`);
    this.name = "FeedbackValidationError";
    this.errors = errors;
  }
}

interface QueueItem {
  /** The item's own id, kept across restarts. Sent as its idempotency key, so a send the intake already took is not stored again. */
  localId: string;
  /** The caller's own ref, kept here and never sent. Items queued before 0.8.0 have none. */
  ref?: string;
  body: FeedbackSubmission;
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  /**
   * The end of a wait the intake asked for (a 429 with `Retry-After`, or a
   * batch item's `retry_after`), in milliseconds. `nextAttemptAt` is set to the
   * same time, so a client that does not know this field waits as before.
   * Removed once the wait is over. Items queued before 0.29.0 have none.
   */
  intakeWaitUntil?: number;
  /** The ref of the new place this item waits for. While set, `body.place` is a placeholder and the item is never sent. */
  waitsFor?: string;
}

/** What became of a new place a ref names, kept so items queued later or after a restart can follow it. */
interface NewPlaceRecord {
  place?: string;
  dropped?: true;
  at: number;
}

/** Stands in for a new place's id in a waiting item, so the item validates. Never sent. */
const PENDING_PLACE = "ocdb_00000000000000000000000000";

/**
 * What became of a queued item. `id` is the intake's id for it (for a new
 * place, the id to pass to `newPlaceId`), and `state` and `heldReason` say
 * whether it went live or is held (`ItemDecision`). `httpStatus` is the intake's refusal,
 * or 0 when the SDK dropped the item unsent because it grew too old, the
 * queue was full, or (with `reason`) the new place it waited for was dropped.
 */
export type AnswerOutcome =
  | ({ kind: "sent"; id: string } & ItemDecision)
  | {
      kind: "dropped";
      httpStatus: number;
      /** `new_place_dropped`: the item waited for a new place (`NewPlaceRef`) that was dropped or refused, so it was never sent. */
      reason?: "new_place_dropped";
    };

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
 * - `not_seasonal`: `pets_months` for a place whose `pets` is not `seasonal`, so a person checks it.
 * - `unlikely_charge`: a `charge` or `charge_powered` over 250 AUD a night, or more than 50% above or
 *   below the place's current charge, so a person checks it before it is published.
 * - `commons_report`: a report that a Commons photo is not of the place. The app hides it for the
 *   traveller at once, a reviewer gets the case, and two sources hide it for everyone.
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
  "not_seasonal",
  "unlikely_charge",
  "commons_report",
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

/** Most items in one batch: the intake's limit for `POST /v1/feedback/batch`. */
export const MAX_BATCH_SIZE = 50;

/** Longest `ref` a caller can give a submission. */
export const MAX_REF_LENGTH = 100;

const BASE_DELAY_MS = 30_000;
/** A photo pass is renewed when it has less than this left. */
const PASS_REFRESH_MS = 5 * 60 * 1000;
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Default longest wait for one request or attestation (`timeoutMs`). */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** A request or attestation that ran past `timeoutMs`. */
class RequestTimeoutError extends Error {
  constructor() {
    super("the request ran past its timeout");
    this.name = "RequestTimeoutError";
  }
}

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

/** Whether an answer is the intake's own refusal: JSON with a string `error`. */
function isIntakeRefusal(answer: unknown): boolean {
  return answer !== null && typeof answer === "object" && typeof (answer as { error?: unknown }).error === "string";
}

/** Delay before the next try after `attempts` failures, with jitter between half and all of it. */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

function createClient(
  options: PhotoClientOptions,
): FeedbackClient & Omit<PhotoClient, "progress" | "queuedRefs"> & { photoProgress: PhotoClient["progress"]; photoQueuedRefs: PhotoClient["queuedRefs"] } {
  const {
    appKey,
    appVersion,
    storage,
    maxQueueLength = 100,
    maxQueueAgeMs = 30 * DAY_MS,
    storagePrefix = "ocdb.feedback",
    maxBatchSize = MAX_BATCH_SIZE,
  } = options;
  if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > MAX_BATCH_SIZE) {
    throw new Error(`maxBatchSize must be a whole number from 1 to ${MAX_BATCH_SIZE}`);
  }
  const url = `${options.endpoint.replace(/\/+$/, "")}/v1/feedback`;
  const batchUrl = `${url}/batch`;
  // An intake without the batch route (404 or 405) is sent one item at a time from then on.
  let batchRoute = true;
  const photoUrl = `${options.endpoint.replace(/\/+$/, "")}/v1/photos`;
  const passUrl = `${photoUrl}/pass`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(timeoutMs > 0)) throw new Error("timeoutMs must be above 0");
  /** Runs `work`, aborting it and rejecting with RequestTimeoutError past `timeoutMs`, whether or not it heeds the signal. */
  function withTimeout<T>(work: (signal?: AbortSignal) => Promise<T>): Promise<T> {
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller?.abort();
        reject(new RequestTimeoutError());
      }, timeoutMs);
    });
    return Promise.race([work(controller?.signal), late]).finally(() => clearTimeout(timer));
  }
  const rawFetch: FetchLike =
    options.fetch ?? ((input, init) => (globalThis.fetch as unknown as FetchLike)(input, init));
  const doFetch: FetchLike = (input, init) => withTimeout((signal) => rawFetch(input, signal ? { ...init, signal } : init));
  const doFetchPhoto: PhotoFetchLike =
    options.fetchPhoto ?? ((input, init) => (globalThis.fetch as unknown as PhotoFetchLike)(input, init));
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const deviceKey = `${storagePrefix}.device`;
  const queueKey = `${storagePrefix}.queue`;
  const newPlacesKey = `${storagePrefix}.newplaces`;
  const waitingPhotosKey = `${storagePrefix}.waitingphotos`;

  if (!appKey) throw new Error("appKey is required");
  if (!appVersion) throw new Error("appVersion is required");

  // The parsed queue, read from storage on the first operation, not when the
  // client is made, and kept in step with every save.
  let cachedQueue: QueueItem[] | undefined;

  // Every read-modify-write of the queue runs through this chain, one at a time.
  // A task that fails may have changed the in-memory queue without saving it,
  // so the queue is read from storage again on the next operation.
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task, task);
    chain = run.catch(() => {
      cachedQueue = undefined;
    });
    return run;
  }

  // The device id, read or made on the first operation that needs it, then kept.
  let deviceId: string | undefined;
  async function device(): Promise<string> {
    if (deviceId) return deviceId;
    const existing = await storage.getItem(deviceKey);
    if (existing) {
      deviceId = existing;
      return existing;
    }
    const id = randomUUID();
    await storage.setItem(deviceKey, id);
    deviceId = id;
    return id;
  }

  async function readQueue(): Promise<QueueItem[]> {
    cachedQueue ??= await readQueueFromStorage();
    return cachedQueue;
  }

  async function readQueueFromStorage(): Promise<QueueItem[]> {
    const raw = await storage.getItem(queueKey);
    if (!raw) return [];
    let queue: QueueItem[];
    let changed = false;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      queue = parsed as QueueItem[];
      // Every item needs a key the intake takes. One queued without (or with one it would refuse) gets a new one, kept from now on.
      for (const item of queue) {
        if (!isIdempotencyKey(item.localId)) {
          item.localId = newKey();
          changed = true;
        }
      }
    } catch {
      return [];
    }
    // Saved outside the try, so a failed save rejects the operation and nothing is cached over the stored items.
    if (changed) await writeQueue(queue);
    return queue;
  }

  // What became of new places that items can wait for, by the new place's ref.
  let newPlaces: Map<string, NewPlaceRecord> | undefined;
  async function readNewPlaces(): Promise<Map<string, NewPlaceRecord>> {
    if (newPlaces) return newPlaces;
    const raw = await storage.getItem(newPlacesKey);
    const map = new Map<string, NewPlaceRecord>();
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object") for (const [k, v] of Object.entries(parsed as Record<string, NewPlaceRecord>)) map.set(k, v);
    } catch {
      // An unreadable record is treated as empty.
    }
    newPlaces = map;
    return map;
  }
  async function writeNewPlaces(): Promise<void> {
    if (!newPlaces) return;
    const t = now();
    for (const [k, v] of newPlaces) if (t - v.at > maxQueueAgeMs) newPlaces.delete(k);
    if (newPlaces.size === 0) await storage.removeItem(newPlacesKey);
    else await storage.setItem(newPlacesKey, JSON.stringify(Object.fromEntries(newPlaces)));
  }
  const isNewPlaceItem = (item: QueueItem) =>
    item.ref !== undefined && item.body.type === "report" && (item.body as { report?: { kind?: string } }).report?.kind === "new_place";

  async function writeQueue(items: QueueItem[]): Promise<void> {
    if (items.length === 0) await storage.removeItem(queueKey);
    else await storage.setItem(queueKey, JSON.stringify(items));
    cachedQueue = items;
  }

  type Sent = "sent" | "drop" | "stop";

  /**
   * What one item's answer means: `sent`, `drop`, or `stop` (kept, and the
   * flush stops). Network errors, 408, 429, 5xx and a refused assertion keep
   * it. Any other refusal drops it. A 429 with a retry-after waits that long.
   * The outcome is given back to be recorded, in order, by the caller.
   */
  async function settle(item: QueueItem, status: number, answer: unknown, retryAfter: number): Promise<{ result: Sent; outcome?: Outcome }> {
    if (status >= 200 && status < 300) {
      const id = (answer as { id?: unknown } | null | undefined)?.id;
      // A 2xx without a readable body still means the intake has it.
      return { result: "sent", outcome: { kind: "sent", id: typeof id === "string" ? id : "", ...itemDecision(answer) } };
    }
    if (status === 429) {
      waitForIntake(item, retryAfter);
      return { result: "stop" };
    }
    if (status >= 500 || status === 408) return { result: "stop" };
    // A refused assertion keeps the item: the next try brings a fresh
    // assertion or token. Any other 401 (an unknown app key) drops it.
    const error = attestationErrorIn(status, answer);
    if (error) {
      await callRefusalHook(options.onAttestationRejected, error, answer);
      return { result: "stop" };
    }
    // Only the intake's own refusal (JSON with a string `error`) drops an item. Anything
    // else, such as a firewall's or proxy's HTML page or an unbound route, is kept to try again.
    if (!isIntakeRefusal(answer)) return { result: "stop" };
    return { result: "drop", outcome: { kind: "dropped", httpStatus: status } };
  }

  /** A new idempotency key: a UUID, or 32 random hex characters when `randomUUID` gives something the intake would refuse. */
  function newKey(): string {
    const id = randomUUID();
    if (isIdempotencyKey(id)) return id;
    return sha256Hex(`${id}:${now()}:${Math.random()}`).slice(0, 32);
  }

  /** Posts `body` with its attestation. Undefined when it could not be attested or sent: try again later. */
  async function post(to: string, body: string, key?: string): Promise<{ status: number; answer: unknown; retryAfter: number } | undefined> {
    let attestation: Record<string, string> = {};
    if (options.attest) {
      try {
        const attest = options.attest;
        attestation = await withTimeout(() => Promise.resolve(attest({ body, bodySha256: sha256Hex(body) })));
      } catch {
        return undefined; // the platform could not attest now, so try again later
      }
    }
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(to, {
        method: "POST",
        headers: { ...attestation, "content-type": "application/json", "x-app-key": appKey, ...(key ? { [IDEMPOTENCY_HEADER]: key } : {}) },
        body,
      });
    } catch {
      return undefined; // offline or the host is unreachable
    }
    let answer: unknown;
    try {
      answer = await withTimeout(() => res.json());
    } catch (error) {
      // An answer that stalls part way is treated as no answer at all: try again later.
      if (error instanceof RequestTimeoutError) return undefined;
      answer = undefined;
    }
    return { status: res.status, answer, retryAfter: Number(res.headers.get("retry-after")) };
  }

  /** Sends one item to `POST /v1/feedback`. */
  async function sendOne(item: QueueItem): Promise<{ result: Sent; outcome?: Outcome }> {
    const res = await post(url, JSON.stringify(item.body), item.localId);
    if (!res) return { result: "stop" };
    return settle(item, res.status, res.answer, res.retryAfter);
  }

  /**
   * Sends items together to `POST /v1/feedback/batch`, with one attestation
   * over the whole body, and settles each by its own answer. A failure of
   * the whole batch settles each item as that answer would settle it alone:
   * offline, 408, 429, 5xx and a refused assertion keep them all (the hook
   * is called once), and 401 `invalid_app_key` drops them all. "fallback"
   * when the intake has no batch route (404, 405). "singly" when it refused
   * the batch itself (400, 403, 413), which says nothing of each item: they
   * are sent one at a time so each gets its own answer.
   */
  async function sendBatch(items: readonly QueueItem[]): Promise<{ result: Sent; outcome?: Outcome }[] | "fallback" | "singly"> {
    const res = await post(batchUrl, JSON.stringify({ items: items.map((item) => item.body), keys: items.map((item) => item.localId) }));
    if (!res) return items.map(() => ({ result: "stop" as const }));
    if (res.status === 404 || res.status === 405) return "fallback";
    // A 400, 403 or 413 that is not the intake's own (a firewall's page, say) says nothing about the batch: keep every item.
    if ((res.status === 400 || res.status === 403 || res.status === 413) && !isIntakeRefusal(res.answer)) {
      return items.map(() => ({ result: "stop" as const }));
    }
    if (res.status === 400 || res.status === 403 || res.status === 413) return "singly";
    const answers = (res.answer as { items?: unknown } | null | undefined)?.items;
    if (res.status === 200 && Array.isArray(answers) && answers.length === items.length) {
      const out: { result: Sent; outcome?: Outcome }[] = [];
      for (const [i, item] of items.entries()) {
        const answer = answers[i] as { status?: unknown; retry_after?: unknown } | null;
        const status = typeof answer?.status === "number" ? answer.status : 0;
        out.push(await settle(item, status, answer, Number(answer?.retry_after)));
      }
      return out;
    }
    if (res.status >= 200 && res.status < 300) return Promise.all(items.map((item) => settle(item, res.status, undefined, NaN)));
    const first = await settle(items[0]!, res.status, res.answer, res.retryAfter);
    const rest = await Promise.all(
      items.slice(1).map(async (item) => (first.result === "stop" ? settleKept(item, res.status, res.retryAfter) : settle(item, res.status, res.answer, res.retryAfter))),
    );
    return [first, ...rest];
  }

  /** The rest of a batch kept as a whole: a 429's wait, without calling the refusal hook again. */
  async function settleKept(item: QueueItem, status: number, retryAfter: number): Promise<{ result: Sent }> {
    if (status === 429) waitForIntake(item, retryAfter);
    return { result: "stop" };
  }

  /** Counts a 429 as a try and keeps the item until the wait it asked for is over, when it gave one in seconds. */
  function waitForIntake(item: QueueItem, retryAfter: number): void {
    if (!(Number.isFinite(retryAfter) && retryAfter > 0)) return;
    item.attempts += 1;
    item.nextAttemptAt = now() + retryAfter * 1000;
    item.intakeWaitUntil = item.nextAttemptAt;
  }

  // Outcomes are kept only for items a report(), review(), check() or reportReview() call is waiting on.
  const waiting = new Set<string>();
  const outcomes = new Map<string, Outcome>();
  // Answers for onAnswered, kept until the queue is saved and then told in order.
  const answers: Answer[] = [];
  function record(item: QueueItem, outcome: Outcome): void {
    if (waiting.has(item.localId)) outcomes.set(item.localId, outcome);
    // A new place's answer settles the items waiting for it (`NewPlaceRef`).
    if (isNewPlaceItem(item) && newPlaces) {
      // A new place sent without a readable id can't be followed, so its items are dropped too.
      const place = outcome.kind === "sent" ? newPlaceId(outcome.id) : undefined;
      newPlaces.set(item.ref!, place !== undefined && isPlaceId(place) ? { place, at: now() } : { dropped: true, at: now() });
    }
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

  /**
   * Sends the due items, in queue order, in batches of up to maxBatchSize.
   * An item waiting for a new place's id joins a batch once the id is known,
   * which can be from an earlier batch of the same flush. The flush stops
   * after the first answer that keeps an item to try again.
   */
  async function flushNow(flushOptions: FlushOptions = {}): Promise<FlushResult> {
    const ignoreBackoff = flushOptions.ignoreBackoff === true;
    const result = await serial(async () => {
      const queue = await readQueue();
      const known = await readNewPlaces();
      const t = now();
      const done = new Set<QueueItem>();
      const tried = new Set<QueueItem>();
      let sent = 0;
      let dropped = 0;
      let stopped = false;
      for (;;) {
        // Outcomes are recorded in queue order within each round, as each item is reached.
        const outcomes = new Map<QueueItem, Outcome>();
        const due: QueueItem[] = [];
        for (const item of queue) {
          if (done.has(item) || tried.has(item)) continue;
          if (t - item.queuedAt > maxQueueAgeMs) {
            outcomes.set(item, { kind: "dropped", httpStatus: 0 });
            done.add(item);
            dropped += 1;
            continue;
          }
          if (item.waitsFor !== undefined) {
            const target = known.get(item.waitsFor);
            if (target?.dropped) {
              outcomes.set(item, { kind: "dropped", httpStatus: 0, reason: "new_place_dropped" });
              done.add(item);
              dropped += 1;
              continue;
            }
            // Still waiting for its new place: kept unsent, and never in the way of the items after it.
            if (!target?.place) continue;
            (item.body as { place: string }).place = target.place;
            delete item.waitsFor;
          }
          if (item.intakeWaitUntil !== undefined && item.intakeWaitUntil <= t) delete item.intakeWaitUntil;
          const dueAt = ignoreBackoff ? (item.intakeWaitUntil ?? 0) : item.nextAttemptAt;
          if (stopped || dueAt > t || due.length >= maxBatchSize) continue;
          due.push(item);
        }
        const attemptsBefore = new Map(due.map((item) => [item, item.attempts]));
        const results = new Map<QueueItem, { result: Sent; outcome?: Outcome }>();
        if (due.length === 1 || (due.length > 1 && !batchRoute)) {
          for (const item of due) {
            const one = await sendOne(item);
            results.set(item, one);
            if (one.result === "stop") break;
          }
        } else if (due.length > 1) {
          let batch = await sendBatch(due);
          if (batch === "fallback" || batch === "singly") {
            // Without a batch route, from now on. After a refused batch, only for this round.
            if (batch === "fallback") batchRoute = false;
            batch = [];
            for (const item of due) {
              const one = await sendOne(item);
              batch.push(one);
              if (one.result === "stop") break;
            }
          }
          batch.forEach((one, i) => results.set(due[i]!, one));
        }
        for (const [item, one] of results) {
          tried.add(item);
          if (one.outcome) outcomes.set(item, one.outcome);
          if (one.result === "sent") {
            sent += 1;
            done.add(item);
          } else if (one.result === "drop") {
            dropped += 1;
            done.add(item);
          } else {
            stopped = true;
          }
        }
        for (const item of queue) {
          const outcome = outcomes.get(item);
          if (outcome) record(item, outcome);
        }
        for (const [item, one] of results) {
          if (one.result === "stop" && item.attempts === attemptsBefore.get(item)) {
            item.attempts += 1;
            item.nextAttemptAt = t + backoffDelay(item.attempts, random);
          }
        }
        if (results.size === 0) break;
      }
      const kept = queue.filter((item) => !done.has(item));
      await writeQueue(kept);
      await writeNewPlaces();
      return { sent, dropped, remaining: kept.length };
    });
    await tellAnswers();
    return result;
  }

  type Call = { input: Record<string, unknown> & { consent: boolean }; ref?: string | undefined };

  /** Checks consent and the ref before anything is queued. */
  function checkCall({ input, ref }: Call): void {
    if (input.consent !== true) throw new ConsentRequiredError();
    if (ref !== undefined && (typeof ref !== "string" || ref.length < 1 || ref.length > MAX_REF_LENGTH)) {
      throw new FeedbackValidationError([`ref must be a string of 1 to ${MAX_REF_LENGTH} characters`]);
    }
  }

  /** Validates one call into a queue item, without saving it. Runs inside `serial`, with the queue already read. */
  async function prepareItem(queue: readonly QueueItem[], { input, ref }: Call, type: FeedbackSubmission["type"], deviceId: string): Promise<QueueItem> {
    // A place still waiting for its id: follow its new place, or wait for it in the queue.
    let waitsFor: string | undefined;
    const target = input.place;
    if (target !== null && typeof target === "object") {
      const newPlace = (target as Partial<NewPlaceRef>).newPlace;
      if (typeof newPlace !== "string" || newPlace.length < 1 || newPlace.length > MAX_REF_LENGTH) {
        throw new FeedbackValidationError([`place.newPlace must be the ref of a new_place report, 1 to ${MAX_REF_LENGTH} characters`]);
      }
      const known = (await readNewPlaces()).get(newPlace);
      if (known?.dropped) throw new FeedbackValidationError([`the new place ${newPlace} was dropped, so nothing can be sent about it`]);
      if (known?.place) input = { ...input, place: known.place };
      else if (queue.some((q) => q.ref === newPlace && isNewPlaceItem(q))) {
        waitsFor = newPlace;
        input = { ...input, place: PENDING_PLACE };
      } else throw new FeedbackValidationError([`no new_place report with the ref ${newPlace} is queued or was sent`]);
    }
    const body = { ...input, type, device: deviceId, app_version: appVersion, consent: true };
    const checked = validateSubmission(body, new Date(now()));
    if (!checked.ok) throw new FeedbackValidationError(checked.errors);
    return {
      localId: newKey(),
      ...(ref !== undefined ? { ref } : {}),
      body: checked.value as FeedbackSubmission,
      queuedAt: now(),
      attempts: 0,
      nextAttemptAt: 0,
      ...(waitsFor !== undefined ? { waitsFor } : {}),
    };
  }

  /**
   * Validates every call, then queues them all with one write, and sends
   * them in one flush. Nothing is queued when any call is refused. Resolves
   * with each call's result, in order. With `wait: false`, each is `queued`
   * as soon as it is saved, and the flush runs without being waited for.
   */
  async function submitAll(calls: readonly Call[], type: FeedbackSubmission["type"], wait: boolean): Promise<SubmitResult[]> {
    for (const call of calls) checkCall(call);
    if (calls.length === 0) return [];
    const ids = await serial(async () => {
      const queue = await readQueue();
      await readNewPlaces();
      const deviceId = await device();
      const items: QueueItem[] = [];
      for (const call of calls) items.push(await prepareItem(queue, call, type, deviceId));
      queue.push(...items);
      while (queue.length > maxQueueLength) record(queue.shift()!, { kind: "dropped", httpStatus: 0 });
      await writeQueue(queue);
      await writeNewPlaces();
      if (wait) for (const item of items) waiting.add(item.localId);
      return items.map((item) => item.localId);
    });
    if (!wait) {
      // The answer reaches onAnswered. A failed flush is tried again by the next call or flush().
      void flushNow().catch(() => undefined);
      return ids.map(() => ({ status: "queued" }) as const);
    }
    try {
      await flushNow();
    } finally {
      for (const id of ids) waiting.delete(id);
    }
    return ids.map((localId) => {
      const outcome = outcomes.get(localId);
      outcomes.delete(localId);
      if (!outcome) return { status: "queued" } as const;
      if (outcome.kind === "sent") {
        const { kind: _kind, ...sent } = outcome;
        return { status: "sent", ...sent } as const;
      }
      return { status: "rejected", httpStatus: outcome.httpStatus } as const;
    });
  }

  async function submit(
    { ref, ...input }: { consent: boolean; ref?: string | undefined } & Record<string, unknown>,
    type: FeedbackSubmission["type"],
    submitOptions?: SubmitOptions,
  ): Promise<SubmitResult> {
    const [result] = await submitAll([{ input, ref }], type, submitOptions?.wait !== false);
    return result!;
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
  async function uploadPhoto(input: Omit<PhotoInput, "place" | "key"> & { place: string }): Promise<PhotoResult> {
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
          // The same photo of the same place from this install has the same key, so a resend after a lost answer is not stored again.
          [IDEMPOTENCY_HEADER]: sha256Hex(`photo:${input.place}:${input.contributor}:${meta.device}:${meta.photo.full_sha256}:${meta.photo.thumb_sha256}`),
        },
        body,
      });
    } catch {
      return { status: "offline" };
    }
    let answer: { id?: unknown; error?: unknown; minimum?: unknown } = {};
    try {
      answer = ((await res.json()) ?? {}) as typeof answer;
    } catch {
      // Leave the answer empty.
    }
    if (res.status >= 200 && res.status < 300) return { status: "sent", id: typeof answer.id === "string" ? answer.id : "" };
    if (res.status === 403 && answer.error === "app_update_required") {
      return { status: "update_required", ...(typeof answer.minimum === "string" ? { minimum: answer.minimum } : {}) };
    }
    const refused = attestationErrorIn(res.status, answer);
    if (refused) await callRefusalHook(options.onAttestationRejected, refused, answer);
    return { status: "rejected", httpStatus: res.status, ...(typeof answer.error === "string" ? { error: answer.error } : {}) };
  }

  /** Where the new place `ref` names stands (the feedback client's `newPlace`). */
  function newPlace(ref: string): Promise<NewPlaceStatus> {
    return serial(async () => {
      const known = (await readNewPlaces()).get(ref);
      if (known?.dropped) return { status: "dropped" } as const;
      if (known?.place) return { status: "sent", place: known.place } as const;
      return (await readQueue()).some((q) => q.ref === ref && isNewPlaceItem(q)) ? ({ status: "waiting" } as const) : ({ status: "unknown" } as const);
    });
  }

  function queueSummary(): Promise<QueueSummary> {
    return serial(async () => {
      const queue = await readQueue();
      const t = now();
      const types = new Set<string>();
      const summary: QueueSummary = {
        items: queue.length,
        tried: 0,
        oldestQueuedAt: null,
        mostAttempts: 0,
        types: [],
        nextAttemptAt: null,
        intakeWaitUntil: null,
        waitingForNewPlace: 0,
      };
      for (const item of queue) {
        types.add(item.body.type);
        if (item.attempts > 0) summary.tried += 1;
        summary.mostAttempts = Math.max(summary.mostAttempts, item.attempts);
        summary.oldestQueuedAt = Math.min(summary.oldestQueuedAt ?? item.queuedAt, item.queuedAt);
        if (item.waitsFor !== undefined) {
          summary.waitingForNewPlace += 1;
          continue;
        }
        if (item.nextAttemptAt > t) summary.nextAttemptAt = Math.min(summary.nextAttemptAt ?? item.nextAttemptAt, item.nextAttemptAt);
        if (item.intakeWaitUntil !== undefined && item.intakeWaitUntil > t) {
          summary.intakeWaitUntil = Math.max(summary.intakeWaitUntil ?? item.intakeWaitUntil, item.intakeWaitUntil);
        }
      }
      summary.types = [...types].sort();
      return summary;
    });
  }

  const refsIn = (queue: readonly QueueItem[]) => queue.flatMap((item) => (item.ref !== undefined ? [item.ref] : []));
  const queuedRefs = (): Promise<QueuedRefs> => serial(async () => ({ refs: refsIn(await readQueue()) }));
  const photoQueuedRefs = (): Promise<PhotoQueuedRefs> =>
    serial(async () => ({ refs: refsIn(await readQueue()), waitingPhotoKeys: (await readWaitingPhotos()).map((w) => w.key) }));

  /** A photo kept until its new place has an id: the app keeps the files under `key`. */
  interface WaitingPhoto {
    key: string;
    newPlace: string;
    contributor: string;
    queuedAt: number;
  }
  async function readWaitingPhotos(): Promise<WaitingPhoto[]> {
    try {
      const parsed: unknown = JSON.parse((await storage.getItem(waitingPhotosKey)) ?? "[]");
      return Array.isArray(parsed) ? (parsed as WaitingPhoto[]) : [];
    } catch {
      return [];
    }
  }
  async function writeWaitingPhotos(list: WaitingPhoto[]): Promise<void> {
    if (list.length === 0) await storage.removeItem(waitingPhotosKey);
    else await storage.setItem(waitingPhotosKey, JSON.stringify(list));
  }

  async function settlePhoto(settled: PhotoSettled): Promise<void> {
    try {
      await options.onPhotoSettled?.(settled);
    } catch {
      // The app's own clean-up failing must not stop the others.
    }
  }

  /** Uploads a photo, or keeps it until its new place has an id. */
  async function sendPhoto(input: PhotoInput): Promise<PhotoResult> {
    if (input.consent !== true) throw new ConsentRequiredError();
    const { place, key, ...rest } = input;
    if (typeof place === "string") return uploadPhoto({ ...rest, place });
    const ref = (place as Partial<NewPlaceRef> | null)?.newPlace;
    const problems: string[] = [];
    if (typeof ref !== "string" || ref.length < 1 || ref.length > MAX_REF_LENGTH) problems.push(`place.newPlace must be the ref of a new_place report, 1 to ${MAX_REF_LENGTH} characters`);
    if (typeof key !== "string" || key.length < 1 || key.length > 200) problems.push("key must be the app's own key for the files, 1 to 200 characters, for a new place");
    if (typeof input.contributor !== "string" || input.contributor.length === 0) problems.push("contributor is required for photos");
    if (problems.length > 0) throw new FeedbackValidationError(problems);
    if (!options.resolveNewPlace || !options.loadPhoto) {
      throw new Error("Photos of a new place need the photo client's resolveNewPlace and loadPhoto options");
    }
    const status = await options.resolveNewPlace(ref!);
    if (status.status === "sent") return uploadPhoto({ ...rest, place: status.place });
    if (status.status === "dropped") throw new FeedbackValidationError([`the new place ${ref} was dropped, so its photo can't be sent`]);
    if (status.status === "unknown") throw new FeedbackValidationError([`no new_place report with the ref ${ref} is queued or was sent`]);
    await serial(async () => {
      const list = await readWaitingPhotos();
      if (!list.some((w) => w.key === key)) list.push({ key: key!, newPlace: ref!, contributor: input.contributor, queuedAt: now() });
      await writeWaitingPhotos(list);
    });
    return { status: "waiting" };
  }

  /**
   * Uploads the waiting photos whose new place now has an id, in the order
   * they were taken, and drops those whose new place was dropped, whose files
   * are gone or that waited too long. A photo that can't go now (offline,
   * a passing refusal) stays for the next flush without holding up the rest.
   */
  async function flushWaitingPhotos(): Promise<void> {
    const list = await serial(readWaitingPhotos);
    if (list.length === 0) return;
    const settledKeys = new Set<string>();
    for (const w of list) {
      const drop = async (reason: "new_place_dropped" | "photo_missing" | "rejected" | "expired", extra: { httpStatus?: number; error?: string } = {}) => {
        settledKeys.add(w.key);
        await settlePhoto({ key: w.key, newPlace: w.newPlace, outcome: { status: "dropped", reason, ...extra } });
      };
      if (now() - w.queuedAt > maxQueueAgeMs) {
        await drop("expired");
        continue;
      }
      const status = options.resolveNewPlace ? await options.resolveNewPlace(w.newPlace) : ({ status: "waiting" } as const);
      if (status.status === "dropped" || status.status === "unknown") {
        await drop("new_place_dropped");
        continue;
      }
      if (status.status !== "sent") continue;
      let files: Awaited<ReturnType<NonNullable<PhotoClientOptions["loadPhoto"]>>> = null;
      try {
        files = options.loadPhoto ? await options.loadPhoto(w.key) : null;
      } catch {
        continue; // the app could not read its files now; try again next flush
      }
      if (!files) {
        await drop("photo_missing");
        continue;
      }
      let result: PhotoResult;
      try {
        result = await uploadPhoto({ place: status.place, contributor: w.contributor, consent: true, full: files.full, thumb: files.thumb });
      } catch {
        await drop("rejected", { httpStatus: 0, error: "invalid_files" });
        continue;
      }
      if (result.status === "sent") {
        settledKeys.add(w.key);
        await settlePhoto({ key: w.key, newPlace: w.newPlace, outcome: { status: "sent", id: result.id, place: status.place } });
      } else if (result.status === "rejected" && !(result.httpStatus === 429 || result.httpStatus >= 500 || result.httpStatus === 408 || result.error?.startsWith("attestation"))) {
        await drop("rejected", { httpStatus: result.httpStatus, ...(result.error ? { error: result.error } : {}) });
      }
      // offline, rate limited, busy, a refused assertion or an app too old for photos: it stays for the next flush
    }
    if (settledKeys.size === 0) return;
    await serial(async () => writeWaitingPhotos((await readWaitingPhotos()).filter((w) => !settledKeys.has(w.key))));
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

  /** Each id's progress at `path`, asked for in calls of up to MAX_PROGRESS_IDS ids that `isId` accepts. */
  async function progressAt(path: string, isId: (id: string) => boolean, ids: readonly string[]): Promise<Progress[]> {
    const progressUrl = `${options.endpoint.replace(/\/+$/, "")}${path}`;
    const asked = [...new Set(ids.filter(isId))];
    const found = new Map<string, unknown>();
    for (let start = 0; start < asked.length; start += MAX_PROGRESS_IDS) {
      const part = asked.slice(start, start + MAX_PROGRESS_IDS);
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        // A GET carries no body.
        res = await doFetch(`${progressUrl}?ids=${part.join(",")}`, { method: "GET", headers: { accept: "application/json" } } as unknown as Parameters<FetchLike>[1]);
      } catch {
        throw new ProgressRequestError(0);
      }
      if (res.status < 200 || res.status >= 300) throw new ProgressRequestError(res.status);
      let answer: unknown;
      try {
        answer = await res.json();
      } catch {
        answer = undefined;
      }
      const items = (answer as { items?: unknown } | undefined)?.items;
      if (!Array.isArray(items)) throw new ProgressRequestError(res.status);
      for (const item of items) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id === "string" && part.includes(id)) found.set(id, item);
      }
    }
    return ids.map((id) => readProgress(id, found.get(id)));
  }
  const progress = (ids: readonly string[]) => progressAt("/v1/feedback/progress", isFeedbackId, ids);
  const photoProgress = (ids: readonly string[]) => progressAt("/v1/photos/progress", isPhotoId, ids);

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
    report: (input, submitOptions) => submit({ ...input }, "report", submitOptions),
    reportFacts: async ({ place, facts, contributor, consent, ref, first_hand }, submitOptions) => {
      if (ref !== undefined && (ref.length < 1 || ref.length > 90)) throw new RangeError("ref must be 1 to 90 characters");
      const set = (Object.entries(facts) as [FactName, FactValue | undefined][]).filter(([, value]) => value !== undefined);
      const calls: Call[] = set.map(([fact, value]) => ({
        input: {
          place,
          report: { kind: "fact", fact, value, ...(first_hand !== undefined ? { first_hand } : {}) },
          ...(contributor !== undefined ? { contributor } : {}),
          consent,
        },
        ...(ref !== undefined ? { ref: `${ref}:${fact}` } : {}),
      }));
      const results = await submitAll(calls, "report", submitOptions?.wait !== false);
      return set.map(([fact], i) => ({ fact, result: results[i]! }));
    },
    review: (input, submitOptions) => submit({ ...input }, "review", submitOptions),
    check: (input, submitOptions) => submit({ ...input }, "check", submitOptions),
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
    removePhoto: ({ place, photo, contributor, contributorProof, consent, ref }) =>
      submit({ place, photo_removal: { photo }, contributor, ...(contributorProof !== undefined ? { contributor_proof: contributorProof } : {}), consent, ref }, "photo_removal"),
    eraseReviews: ({ contributor, contributorProof, consent, ref }) =>
      submit({ place: null, contributor, ...(contributorProof !== undefined ? { contributor_proof: contributorProof } : {}), consent, ref }, "review_erasure"),
    erasePhotos: ({ contributor, contributorProof, consent, ref }) =>
      submit({ place: null, contributor, ...(contributorProof !== undefined ? { contributor_proof: contributorProof } : {}), consent, ref }, "photo_erasure"),
    flush: async (flushOptions) => {
      const result = await flushNow(flushOptions);
      await flushWaitingPhotos();
      return result;
    },
    pending: () => serial(async () => (await readQueue()).length),
    queueSummary,
    queuedRefs,
    photoQueuedRefs,
    newPlace,
    progress,
    photoProgress,
  };
}

/** A client for Open Camping DB's feedback intake: reports, reviews, checks and owner requests. */
export function createFeedbackClient(options: FeedbackClientOptions): FeedbackClient {
  const { photo: _photo, photoPass: _pass, reportPhoto: _report, removePhoto: _remove, erasePhotos: _erase, photoQueuedRefs: _refs, ...feedback } = createClient(options as PhotoClientOptions);
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
    removePhoto: client.removePhoto,
    erasePhotos: client.erasePhotos,
    flush: client.flush,
    pending: client.pending,
    queueSummary: client.queueSummary,
    queuedRefs: client.photoQueuedRefs,
    progress: client.photoProgress,
  };
}
