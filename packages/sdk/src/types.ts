/**
 * Payload types for the Open Camping DB feedback submission
 * (`POST /v1/feedback`), matching SPEC.md "Feedback submission".
 */

export type FeedbackType = "report" | "review" | "check";

export type ReportKind =
  | "closed"
  | "reopened"
  | "fact"
  | "wrong_location"
  | "new_place"
  | "other";

export type PlaceKind =
  | "camp_site"
  | "caravan_site"
  | "rest_area"
  | "dump_station"
  | "drinking_water"
  | "toilets"
  | "shower"
  | "picnic_site";

export type PetsValue = "yes" | "no" | "leashed";
export type AccessValue = "2wd" | "awd" | "4wd" | "unknown";
export type EntryValue = "public" | "customers" | "permit" | "private";

/** Facts a place record can hold, with the value type of each. */
export interface PlaceFacts {
  fee?: boolean;
  power?: boolean;
  pets?: PetsValue;
  tents?: boolean;
  caravans?: boolean;
  toilets?: boolean;
  showers?: boolean;
  drinking_water?: boolean;
  dump_station?: boolean;
  max_stay?: string;
  opening_hours?: string;
  website?: string;
  phone?: string;
  /** Road access. */
  access?: AccessValue;
  /** Who may stay (OSM access=*). */
  entry?: EntryValue;
}

export type FactName = keyof PlaceFacts;
export type FactValue = boolean | string;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface ReportBody {
  kind: ReportKind;
  /** Required when `kind` is `fact`. */
  fact?: FactName;
  /** Required when `kind` is `fact`. */
  value?: FactValue;
  /** Free text, up to 2,000 characters. */
  note?: string;
}

export interface ReviewBody {
  stars: 1 | 2 | 3 | 4 | 5;
  /** Up to 2,000 characters. May be empty. */
  text: string;
  /** Month of the visit, `YYYY-MM`. */
  visited: string;
}

export interface CheckBody {
  /** Day of the visit, `YYYY-MM-DD`. */
  visited: string;
  still_there: boolean;
}

interface SubmissionBase {
  /** Place id (`ocdb_<ulid>`), or null for a new place. */
  place: string | null;
  /** Required for a new place. Allowed only on `new_place` and `wrong_location` reports. */
  location?: LatLon;
  /** Random per-install UUID. The intake hashes it before storage. */
  device: string;
  app_version: string;
  /** The user accepted the ODbL/DbCL contribution terms. */
  consent: true;
}

export interface ReportSubmission extends SubmissionBase {
  type: "report";
  report: ReportBody;
}

export interface ReviewSubmission extends SubmissionBase {
  type: "review";
  place: string;
  review: ReviewBody;
}

export interface CheckSubmission extends SubmissionBase {
  type: "check";
  place: string;
  check: CheckBody;
}

/** The JSON body an app sends to the intake. */
export type FeedbackSubmission = ReportSubmission | ReviewSubmission | CheckSubmission;

/**
 * A submission as the intake stores it in `inbox/pending/<yyyy-mm-dd>/fb_<ulid>.json`:
 * the validated submission with `device` replaced by its salted hash, plus the
 * id, the time it arrived and the app name taken from the app key.
 */
export type StoredFeedback = DistributiveOmit<FeedbackSubmission, "device"> & {
  id: string;
  /** SHA-256 of salt and device, first 16 hex characters. */
  device: string;
  /** ISO 8601 UTC time the intake accepted it. */
  received: string;
  /** App name from the app key list, for example `camporacle`. */
  app: string;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Success response from the intake. */
export interface AcceptedResponse {
  id: string;
}
