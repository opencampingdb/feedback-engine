import type {
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
} from "./types.js";
import { validateSubmission } from "./validate.js";

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
}

export interface ReportInput {
  place: string | null;
  location?: LatLon;
  report: ReportBody;
  consent: boolean;
}

export interface ReviewInput {
  place: string;
  review: ReviewBody;
  consent: boolean;
}

export interface CheckInput {
  place: string;
  check: CheckBody;
  consent: boolean;
}

export type SubmitResult =
  | { status: "sent"; id: string }
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

export class ConsentRequiredError extends Error {
  constructor() {
    super("Feedback needs consent: true, given after the user agreed to CONSENT_TEXT");
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
  body: FeedbackSubmission;
  queuedAt: number;
  attempts: number;
  nextAttemptAt: number;
}

type Outcome = { kind: "sent"; id: string } | { kind: "dropped"; httpStatus: number };

const BASE_DELAY_MS = 30_000;
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

/** Delay before the next try after `attempts` failures, with jitter between half and all of it. */
export function backoffDelay(attempts: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export function createFeedbackClient(options: FeedbackClientOptions): FeedbackClient {
  const {
    appKey,
    appVersion,
    storage,
    maxQueueLength = 100,
    maxQueueAgeMs = 30 * DAY_MS,
    storagePrefix = "ocdb.feedback",
  } = options;
  const url = `${options.endpoint.replace(/\/+$/, "")}/v1/feedback`;
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => (globalThis.fetch as unknown as FetchLike)(input, init));
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
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-app-key": appKey },
        body: JSON.stringify(item.body),
      });
    } catch {
      return "stop"; // offline or the host is unreachable
    }
    if (res.status >= 200 && res.status < 300) {
      let id = "";
      try {
        const body = (await res.json()) as { id?: unknown };
        if (typeof body.id === "string") id = body.id;
      } catch {
        // A 2xx without a readable body still means the intake has it.
      }
      record(item.localId, { kind: "sent", id });
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
    record(item.localId, { kind: "dropped", httpStatus: res.status });
    return "drop";
  }

  // Outcomes are kept only for items a report(), review() or check() call is waiting on.
  const waiting = new Set<string>();
  const outcomes = new Map<string, Outcome>();
  function record(localId: string, outcome: Outcome): void {
    if (waiting.has(localId)) outcomes.set(localId, outcome);
  }

  function flushNow(): Promise<FlushResult> {
    return serial(async () => {
      const queue = await readQueue();
      const t = now();
      const kept: QueueItem[] = [];
      let sent = 0;
      let dropped = 0;
      let stopped = false;
      for (const item of queue) {
        if (t - item.queuedAt > maxQueueAgeMs) {
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
  }

  async function submit(input: { consent: boolean } & Record<string, unknown>, type: FeedbackSubmission["type"]) {
    if (input.consent !== true) throw new ConsentRequiredError();
    const localId = await serial(async () => {
      const body = { ...input, type, device: await device(), app_version: appVersion, consent: true };
      const checked = validateSubmission(body);
      if (!checked.ok) throw new FeedbackValidationError(checked.errors);
      const queue = await readQueue();
      const item: QueueItem = {
        localId: randomUUID(),
        body: checked.value as FeedbackSubmission,
        queuedAt: now(),
        attempts: 0,
        nextAttemptAt: 0,
      };
      queue.push(item);
      while (queue.length > maxQueueLength) queue.shift();
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
    if (outcome.kind === "sent") return { status: "sent", id: outcome.id } as const;
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
    flush: flushNow,
    pending: () => serial(async () => (await readQueue()).length),
  };
}
