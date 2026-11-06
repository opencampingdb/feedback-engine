import { newPlaceId, type RefusedBy, type StoredFeedback } from "@opencampingdb/feedback";

/**
 * What the apply sends the intake about each contribution
 * (`POST /v1/feedback/progress`), shared by both. No file or network access,
 * so the intake's Worker can import it.
 */

/** The states the apply sends. `received` and `live` come only from the intake, at send time. */
export const PROGRESS_UPDATE_STATES = ["waiting", "accepted", "held", "refused", "in_data"] as const;
export type ProgressUpdateState = (typeof PROGRESS_UPDATE_STATES)[number];

/** One item of the intake's `POST /v1/feedback/progress`. */
export interface ProgressUpdate {
  id: string;
  state: ProgressUpdateState;
  /** The engine's own words for the decision. Never a traveller's. */
  reason?: string;
  /** Only on `refused`, where it is required. */
  by?: RefusedBy;
  place?: string;
  /** The run that decided it. */
  decided_at?: string;
  /**
   * Required on `in_data`: when main got the change, as the commit time of
   * the last commit on main that touched the file it is in. The intake keeps
   * the first it is sent.
   */
  in_data_at?: string;
}

/** The place an item is about: a new place's own id for a `new_place` report, otherwise its `place`. */
export function placeOf(item: Pick<StoredFeedback, "id" | "type" | "place"> & { report?: { kind?: string } }): string | null {
  return item.type === "report" && item.report?.kind === "new_place" ? newPlaceId(item.id) : item.place;
}
