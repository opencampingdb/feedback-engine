/**
 * Payload types for the Open Camping DB feedback submission
 * (`POST /v1/feedback`), matching SPEC.md "Feedback submission".
 */

export type FeedbackType = "report" | "review" | "check";
export type OwnerType = "owner_claim" | "owner_listing" | "owner_update";

export type ReportKind =
  | "closed"
  | "reopened"
  | "fact"
  | "wrong_location"
  | "new_place"
  | "other";

/**
 * Place kinds: the 22 OTWD site types (vocabulary 1.0.0), plus the Open
 * Camping DB extensions `campground`, `picnic_site` and `farm_stay`.
 */
export type PlaceKind =
  | "free_camp"
  | "paid_campground"
  | "caravan_park"
  | "national_park_campsite"
  | "state_forest_campsite"
  | "showground"
  | "campground"
  | "farm_stay"
  | "rest_area"
  | "dump_point"
  | "drinking_water_point"
  | "public_toilet"
  | "public_shower"
  | "laundromat"
  | "picnic_site"
  | "information_centre"
  | "fuel"
  | "lpg_refill_swap"
  | "mechanic"
  | "attraction"
  | "lookout"
  | "swimming_spot"
  | "boat_ramp"
  | "hospital_emergency"
  | "ferry_terminal";

export type PlaceGroup = "overnight" | "utility" | "services" | "attraction" | "emergency" | "transport";

export type PetsValue = "yes" | "no" | "leashed";
export type AccessValue = "2wd" | "awd" | "4wd" | "unknown";
export type EntryValue = "public" | "customers" | "permit" | "private";
export type WaterType = "tank_fill" | "fountain";

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
  /** drinking_water_point only. */
  water_type?: WaterType;
  /** Where to book. https only. */
  booking_url?: string;
  /** Set on private property listings. */
  booking_required?: boolean;
}

export type FactName = keyof PlaceFacts;
/** Facts an app report may name. Booking facts come only from owners. */
export type ReportFactName = Exclude<FactName, "booking_url" | "booking_required">;
export type FactValue = boolean | string;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface ReportBody {
  kind: ReportKind;
  /** Required when `kind` is `fact`. */
  fact?: ReportFactName;
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

/** Contact details of an owner. They stay in the private inbox and are never published. */
export interface OwnerContact {
  name: string;
  email: string;
}

/** Facts a verified owner may set directly. */
export type OwnerFactName =
  | "fee"
  | "power"
  | "pets"
  | "tents"
  | "caravans"
  | "toilets"
  | "showers"
  | "drinking_water"
  | "dump_station"
  | "max_stay"
  | "opening_hours"
  | "entry"
  | "phone"
  | "website"
  | "booking_url";

export type OwnerFacts = Pick<PlaceFacts, OwnerFactName>;

interface OwnerBase {
  device: string;
  app_version: string;
  /** The owner accepted the owner terms. */
  terms_accepted: true;
}

/** "I run this place": a claim on a place already in the data. */
export interface OwnerClaimSubmission extends OwnerBase {
  type: "owner_claim";
  place: string;
  owner: OwnerContact;
  claim: {
    /** https page on the owner's own website or Facebook page where they will show the code. */
    proof_url: string;
  };
}

/** A private property (farm stay) that is not in the data yet. */
export interface OwnerListingSubmission extends OwnerBase {
  type: "owner_listing";
  place: null;
  location: LatLon;
  owner: OwnerContact;
  claim: { proof_url: string };
  listing: {
    name: string;
    /** Plain text, up to 500 characters. */
    description?: string;
    /** Must include `booking_url` or `phone`. */
    facts: OwnerFacts;
  };
}

/** A change from a verified owner, carrying the token from the claim. */
export interface OwnerUpdateSubmission extends OwnerBase {
  type: "owner_update";
  place: string;
  /** The token returned with the approved claim. The intake stores only its SHA-256. */
  token: string;
  update: OwnerUpdate;
}

export interface OwnerUpdate {
  facts?: OwnerFacts;
  /** Plain text, up to 500 characters. An empty string removes it. */
  description?: string;
  /** `temporarily_closed` needs `reopens`. `open` ends a temporary closure early. */
  status?: "open" | "temporarily_closed";
  /** Day the place reopens, `YYYY-MM-DD`. */
  reopens?: string;
  /** A new name goes to a person. */
  name?: string;
  /** A new location goes to a person. */
  location?: LatLon;
}

export type OwnerSubmission = OwnerClaimSubmission | OwnerListingSubmission | OwnerUpdateSubmission;

/** The JSON body an app sends to the intake. */
export type FeedbackSubmission = ReportSubmission | ReviewSubmission | CheckSubmission;

/** Every body the intake accepts. */
export type Submission = FeedbackSubmission | OwnerSubmission;

/**
 * A submission as the intake stores it in `inbox/pending/<yyyy-mm-dd>/fb_<ulid>.json`:
 * the validated submission with `device` replaced by its salted hash, plus the
 * id, the time it arrived and the app name taken from the app key.
 */
export type StoredFeedback = DistributiveOmit<FeedbackSubmission, "device"> & StoredFields;

/**
 * An owner submission as stored. A claim or listing gains the `code` the owner
 * shows on their page. Every owner submission holds `token_sha256`, the
 * SHA-256 (hex) of the owner's token, and never the token itself.
 */
export type StoredOwnerSubmission =
  | (Omit<OwnerClaimSubmission, "device"> & StoredFields & { code: string; token_sha256: string })
  | (Omit<OwnerListingSubmission, "device"> & StoredFields & { code: string; token_sha256: string })
  | (Omit<OwnerUpdateSubmission, "device" | "token"> & StoredFields & { token_sha256: string });

/** Everything that can be in `inbox/pending/`. */
export type StoredSubmission = StoredFeedback | StoredOwnerSubmission;

interface StoredFields {
  id: string;
  /** SHA-256 of salt and device, first 16 hex characters. */
  device: string;
  /** ISO 8601 UTC time the intake accepted it. */
  received: string;
  /** App name from the app key list, for example `camporacle`. */
  app: string;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Success response from the intake. */
export interface AcceptedResponse {
  id: string;
}

/** Response to an owner claim or listing. Keep `token`: it is shown once and never stored. */
export interface OwnerClaimResponse {
  id: string;
  /** Short code to show on the page at `proof_url`, for example `OCDB-7KQ2`. */
  code: string;
  token: string;
}
