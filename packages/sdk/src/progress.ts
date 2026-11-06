import { HELD_REASONS, type HeldReason } from "./client.js";
import { dataVersionTime } from "./recent.js";

/**
 * Where a contribution is, as `GET /v1/feedback/progress` answers it:
 *
 * - `received`: the intake has it, and nothing is decided yet.
 * - `live`: the intake put it live when it was sent (it shows through the
 *   recent list), and it is not in the data yet.
 * - `waiting`: it needs more reports, or its place is not in the data yet.
 * - `accepted`: the apply accepted it, and it is on its way into the data.
 * - `held`: a reviewer decides it.
 * - `refused`: it was refused, with `reason` and `by`.
 * - `in_data`: its change is in the data, with `in_data_at`.
 * - `unknown`: the intake has no record of it.
 *
 * Adding a state is additive. Renaming or removing one is a breaking change.
 */
export const PROGRESS_STATES = ["received", "live", "waiting", "accepted", "held", "refused", "in_data", "unknown"] as const;

/** Where a contribution is. See `PROGRESS_STATES`. */
export type ProgressState = (typeof PROGRESS_STATES)[number];

/** Who refused a contribution: the apply's `rules`, or a `reviewer` who merged or closed the review PR without its change. */
export type RefusedBy = "rules" | "reviewer";

/** One contribution's progress. It never carries the traveller's words, a device or a contributor. */
export interface Progress {
  /** The id the intake answered when the item was sent (`outcome.id` in `onAnswered`). */
  id: string;
  state: ProgressState;
  /** The engine's own words for the decision, such as why it was refused. */
  reason?: string;
  /**
   * For feedback, why the intake held the item when it was sent, one of
   * `HELD_REASONS`. For a photo, why it is held now, one of
   * `PHOTO_HELD_REASONS`, and only on `held`.
   */
  held_reason?: HeldReason | PhotoHeldReason;
  /** Only on `refused`. */
  by?: RefusedBy;
  /** The place it is about. For a new place merged into another, the place it was merged into. */
  place?: string;
  /** When the intake received it, ISO 8601 UTC. */
  received?: string;
  /** When the apply last decided it, ISO 8601 UTC. */
  decided_at?: string;
  /** When its change reached the data: the time of the data commit that brought it in, ISO 8601 UTC. Only on `in_data`. */
  in_data_at?: string;
}

/**
 * Why a photo is held, in `photos.progress()`:
 *
 * - `first_photo`: the contributor's first photo, which a person looks at before it is published.
 * - `same_file`: the same file was sent for another place.
 * - `safesearch`: SafeSearch rates it likely adult or violent, or very likely racy.
 * - `check_unavailable`: SafeSearch could not check it.
 * - `reported`: hidden after reports (three contributors, or one illegal-content report) until a person decides.
 *
 * Adding a reason is additive.
 */
export const PHOTO_HELD_REASONS = ["first_photo", "same_file", "safesearch", "check_unavailable", "reported"] as const;

/** Why a photo is held. See `PHOTO_HELD_REASONS`. */
export type PhotoHeldReason = (typeof PHOTO_HELD_REASONS)[number];

const STATES: ReadonlySet<string> = new Set(PROGRESS_STATES);
// Read when called: client.ts, which lists HELD_REASONS, imports this module.
const isKnownHeld = (reason: string) => (HELD_REASONS as readonly string[]).includes(reason) || (PHOTO_HELD_REASONS as readonly string[]).includes(reason);
const FEEDBACK_ID = /^fb_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Whether `id` is a feedback id, the only kind of id the intake keeps progress for. */
export const isFeedbackId = (id: unknown): id is string => typeof id === "string" && FEEDBACK_ID.test(id);

/**
 * One item of the intake's answer as `Progress`, keeping only the fields this
 * SDK can read. A state it does not know is answered `unknown`, and a held
 * reason it does not know is left out.
 */
export function readProgress(id: string, raw: unknown): Progress {
  if (typeof raw !== "object" || raw === null) return { id, state: "unknown" };
  const r = raw as Record<string, unknown>;
  const state = typeof r.state === "string" && STATES.has(r.state) ? (r.state as ProgressState) : "unknown";
  if (state === "unknown") return { id, state };
  const text = (key: string) => (typeof r[key] === "string" ? { [key]: r[key] as string } : {});
  return {
    id,
    state,
    ...text("reason"),
    ...(typeof r.held_reason === "string" && isKnownHeld(r.held_reason) ? { held_reason: r.held_reason as HeldReason | PhotoHeldReason } : {}),
    ...(state === "refused" && (r.by === "rules" || r.by === "reviewer") ? { by: r.by } : {}),
    ...text("place"),
    ...text("received"),
    ...text("decided_at"),
    ...text("in_data_at"),
  };
}

/**
 * Whether the app's data release already has a contribution's change: true
 * when it is `in_data` and its `in_data_at`, the time of the data commit that
 * brought it in, is no later than the commit time in `dataVersion`, the
 * release's `data_version`. False when the version is not in the
 * `<commit time>-<short sha>` form.
 */
export function progressInRelease(progress: Progress, dataVersion: string): boolean {
  const release = dataVersionTime(dataVersion);
  if (release === undefined || progress.state !== "in_data" || progress.in_data_at === undefined) return false;
  const at = Date.parse(progress.in_data_at);
  return !Number.isNaN(at) && at <= release;
}
