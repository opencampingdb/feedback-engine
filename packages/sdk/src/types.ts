import type { HeldReason } from "./client.js";

/**
 * Payload types for the Open Camping DB feedback submission
 * (`POST /v1/feedback`), matching SPEC.md "Feedback submission".
 */

export type FeedbackType =
  | "report"
  | "review"
  | "check"
  | "review_report"
  | "fee"
  | "photo"
  | "photo_report"
  | "photo_erasure"
  | "withdraw";
export type OwnerType = "owner_claim" | "owner_listing" | "owner_update";

export type ReportKind =
  | "closed"
  | "reopened"
  | "fact"
  | "wrong_location"
  | "new_place"
  | "other"
  /** A better name. `value` is the name. A person checks it. */
  | "name"
  /** A short description. `value` is the text. A person checks it. */
  | "description"
  /** What the place is. `place_kind` is the kind code. A person checks it. */
  | "kind"
  /** A new place should come down. `reason` says why. */
  | "remove"
  /**
   * A contact on a place is wrong or spam. `fact` names the contact and
   * `reason` says which. One report goes to a person. Reports from two
   * different sources within 90 days, at least one attested, take it down.
   */
  | "contact"
  /**
   * One fact on a place is wrong, and the traveller does not know the right
   * value. `fact` names it (a `DoubtFactName`) and there is no value; the
   * note is kept for reviewers and never published. One doubt goes to a
   * person. Doubts from two different sources within 90 days, at least one
   * attested, take the fact down until two new sources confirm it or someone
   * reports a new value. Facts from OSM or the owner stay up.
   */
  | "doubt"
  /**
   * A Wikimedia Commons photo shown for a place is not of it. `file` names
   * the photo as the place's line in `commons.ndjson.gz` does. The app hides
   * the photo for the traveller who sent it at once, and the intake answers
   * `held` (`commons_report`): a reviewer gets the case. Reports from two
   * different sources within 90 days, at least one attested, add the place
   * and file to the data's do-not-match list, so the photo is never matched
   * to the place again.
   */
  | "commons_mismatch";

/** Why a contact on a place is reported: `wrong` (it reaches someone else, or nobody) or `spam`. */
export type ContactReportReason = "wrong" | "spam";

/** Why a new place should come down. */
export type NewPlaceReportReason = "not_there" | "fake" | "offensive" | "private_land" | "duplicate";

/**
 * A place kind code from `data/schema/kinds.json` in the data repository (the
 * OTWD site types plus the Open Camping DB extensions). The list lives there,
 * not here, so this package does not need a release when it changes.
 */
export type PlaceKind = string;

/** A kind's group, also from `data/schema/kinds.json`. */
export type PlaceGroup = string;

export type PetsValue = "yes" | "no" | "leashed" | "seasonal";
/** true when there is a charge, false when free, donation when payment is by donation. */
export type FeeValue = boolean | "donation";
/** offroad: only off-road caravans get in. */
export type CaravansValue = boolean | "offroad";
/** The park chain or club a place belongs to. */
export type BrandValue =
  | "aspen"
  | "big4"
  | "discovery"
  | "family_parks"
  | "gday"
  | "ingenia"
  | "kui"
  | "nrma"
  | "reflections"
  | "tawk"
  | "yha"
  | "acc";
export type AccessValue = "2wd" | "awd" | "4wd" | "unknown";
/**
 * Who may use a place by the vehicle they drive. `heavy_vehicles_only`: only
 * heavy vehicles (trucks), and others may be fined for stopping there. More
 * values may be added later, such as cars only.
 */
export type VehicleAccessValue = "heavy_vehicles_only";
export type EntryValue = "public" | "customers" | "permit" | "private";
export type WaterType = "tank_fill" | "fountain";
/** An Australian state or territory, as its abbreviation. */
export type AddressState = "NSW" | "VIC" | "QLD" | "SA" | "WA" | "TAS" | "NT" | "ACT";

/**
 * A place's street address, as `schema/place.schema.json` in the data
 * repository has it (OSM addr:*). It has a `street` or, for a rural address,
 * a named `place` instead. Each text field is 1 to 100 characters.
 */
export interface PlaceAddress {
  unit?: string;
  housenumber?: string;
  street?: string;
  /** A named rural place used instead of a street (OSM addr:place). */
  place?: string;
  suburb?: string;
  state?: AddressState;
  /** Four digits. */
  postcode?: string;
}

/** Facts a place record can hold, with the value type of each. */
export interface PlaceFacts {
  fee?: FeeValue;
  power?: boolean;
  pets?: PetsValue;
  /**
   * The months dogs are allowed, when `pets` is `seasonal`: one OSM month
   * range such as `May-Sep`, which may wrap the year end (`Dec-Feb`). It is
   * OSM's `dog:conditional=yes @ (May-Sep)`. `monthsInRange` reads it.
   */
  pets_months?: string;
  tents?: boolean;
  caravans?: CaravansValue;
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
  /** Who may use the place by vehicle, from OSM's hgv and access tags or a traveller. */
  vehicle_access?: VehicleAccessValue;
  /** drinking_water_point only. */
  water_type?: WaterType;
  /** Where to book. https only. */
  booking_url?: string;
  /** Bookings are needed before arriving. */
  booking_required?: boolean;
  // Who can get in.
  wheelchair?: boolean;
  generators?: boolean;
  motorhomes?: boolean;
  camper_trailers?: boolean;
  motorbikes?: boolean;
  /** Big rigs and buses 10 m and longer can get in and turn around. */
  big_rigs?: boolean;
  // What is there.
  non_drinking_water?: boolean;
  laundry?: boolean;
  kitchen?: boolean;
  bbq?: boolean;
  drive_through?: boolean;
  ensuite_sites?: boolean;
  bins?: boolean;
  picnic_tables?: boolean;
  campfires?: boolean;
  cabins?: boolean;
  pub?: boolean;
  // What to do.
  swimming?: boolean;
  fishing?: boolean;
  walking_tracks?: boolean;
  scenery?: boolean;
  wildlife?: boolean;
  playground?: boolean;
  games_room?: boolean;
  shade?: boolean;
  cycling_tracks?: boolean;
  offroad_tracks?: boolean;
  boat_ramp_nearby?: boolean;
  near_road?: boolean;
  // Services.
  telstra_signal?: boolean;
  mobile_signal?: boolean;
  wifi?: boolean;
  tv_reception?: boolean;
  pet_sitting?: boolean;
  fuel?: boolean;
  lpg?: boolean;
  car_wash?: boolean;
  vehicle_storage?: boolean;
  // Warnings.
  self_contained_only?: boolean;
  crocodiles?: boolean;
  sharks?: boolean;
  /** Box jellyfish, Irukandji or other dangerous jellyfish, at least in season. */
  marine_stingers?: boolean;
  seasonal_closure?: boolean;
  dangerous_when_wet?: boolean;
  over_50s?: boolean;
  nudist?: boolean;
  // Brand and contacts.
  brand?: BrandValue;
  /** A person checks it, as they check phones and links. */
  address?: PlaceAddress;
  email?: string;
  phone_2?: string;
  /** https only. */
  facebook?: string;
  /** https only. */
  instagram?: string;
  /** https only. */
  tiktok?: string;
  /** https only. */
  x?: string;
}

export type FactName = keyof PlaceFacts;
/** Facts an app report may name. booking_url comes only from owners. */
export type ReportFactName = Exclude<FactName, "booking_url">;
/** The contact facts and the address: checked with `contactProblem`, and what a `contact` report may name. */
export type ContactFactName = Extract<FactName, "website" | "phone" | "phone_2" | "email" | "facebook" | "instagram" | "tiktok" | "x" | "address">;
/** Facts a `doubt` report may name: any reportable fact except the contact facts and the address, which use the `contact` kind. */
export type DoubtFactName = Exclude<ReportFactName, ContactFactName>;
export type FactValue = boolean | string | PlaceAddress;

export interface LatLon {
  lat: number;
  lon: number;
}

export interface ReportBody {
  kind: ReportKind;
  /**
   * Required when `kind` is `fact`. Required on `contact` too, where it is one
   * of the contact facts (`ContactFactName`), and on `doubt`, where it is any
   * other fact (`DoubtFactName`).
   */
  fact?: ReportFactName;
  /** Required when `kind` is `fact`, `name` (the name) or `description` (the text). */
  value?: FactValue;
  /** Free text, up to 2,000 characters. */
  note?: string;
  /**
   * On `new_place` only: the place's name, 1 to 300 characters, checked as a
   * `name` report's value is and with the text checks. The note keeps the
   * traveller's other words.
   */
  name?: string;
  /**
   * On `new_place`: the kind the user picked, a code from
   * `data/schema/kinds.json`. Apply falls back to `campground` for a code the
   * data does not know. Required on `kind`: the kind the place should be.
   */
  place_kind?: string;
  /** Required on `remove` (a `NewPlaceReportReason`) and `contact` (a `ContactReportReason`), and allowed only there. */
  reason?: NewPlaceReportReason | ContactReportReason;
  /**
   * On `new_place` only: how to reach the place, each checked as a fact
   * report of that name is. Each is published with the place when it passes
   * `contactProblem`, and a person checks it otherwise.
   */
  contacts?: NewPlaceContacts;
  /**
   * On `new_place` only: the place's address, checked as an `address` fact
   * report's value is. It is published with the place when it passes
   * `contactProblem`, and a person checks it otherwise.
   */
  address?: PlaceAddress;
  /**
   * On `new_place` only: a short description, 1 to 500 characters, checked
   * as a `description` report's value is, then trimmed. It is published with
   * the place when it passes the text checks, and a person checks it otherwise.
   */
  description?: string;
  /** On `new_place` only: whether there is a charge, checked as a `fee` fact report's value is. Published with the place. */
  fee?: FeeValue;
  /** Required on `commons_mismatch`, and allowed only there: the Commons file name, as `file` in `commons.ndjson.gz`, 1 to 255 characters on one line. */
  file?: string;
}

/** The contact facts a new place may carry. */
export type NewPlaceContacts = Partial<Pick<PlaceFacts, "phone" | "website" | "email">>;

export interface ReviewBody {
  stars: 1 | 2 | 3 | 4 | 5;
  /** Up to 2,000 characters. May be empty. */
  text: string;
  /** Month of the visit, `YYYY-MM`. */
  visited: string;
  /**
   * The app saw the phone within its set distance of the place in the 60 days
   * before the review. Only `true` is sent; leave it out otherwise. The
   * location itself is never sent.
   */
  visited_nearby?: true;
}

/** Why a traveller reports a published review. */
export type ReviewReportReason = "spam_ad" | "offensive" | "off_topic" | "fake" | "personal_details";

export interface ReviewReportBody {
  /** Id of the published review, `rev_<ulid>`. */
  review: string;
  reason: ReviewReportReason;
}

/**
 * Why a traveller reports a published photo. `illegal` is for child sexual
 * abuse material, an intimate image shared without consent, or terrorist or
 * violent extremist material: the photo stops being served at once and a
 * person decides.
 */
export type PhotoReportReason = "spam_ad" | "offensive" | "off_topic" | "not_this_place" | "personal_details" | "copyright" | "illegal";

export interface PhotoReportBody {
  /** Id of the published photo, `pho_<ulid>`. */
  photo: string;
  reason: PhotoReportReason;
}

/**
 * The files of a photo upload, as the meta part of `POST /v1/photos` names
 * them. The intake checks the bytes it receives against these.
 */
export interface PhotoFiles {
  /** SHA-256 (lower case hex) of the full size JPEG. */
  full_sha256: string;
  /** Size of the full size JPEG in bytes, at most 1.5 MB. */
  full_bytes: number;
  /** SHA-256 (lower case hex) of the thumbnail JPEG. */
  thumb_sha256: string;
  /** Size of the thumbnail in bytes, at most 200 KB. */
  thumb_bytes: number;
}

/** A stored photo upload: the files as the intake checked them. */
export interface StoredPhotoFiles extends PhotoFiles {
  /** Pixel size of the full size JPEG, read from the file. */
  width: number;
  height: number;
  /**
   * Google Cloud Vision SafeSearch's ratings of the full size file, when the
   * intake checks photos. `"unchecked"` when the check failed, so a person looks.
   */
  safesearch?: SafeSearchRatings | "unchecked";
}

/** How likely Google Cloud Vision SafeSearch rates each kind of content. */
export type Likelihood = "UNKNOWN" | "VERY_UNLIKELY" | "UNLIKELY" | "POSSIBLE" | "LIKELY" | "VERY_LIKELY";

export interface SafeSearchRatings {
  adult: Likelihood;
  violence: Likelihood;
  racy: Likelihood;
  medical: Likelihood;
  spoof: Likelihood;
}

export interface CheckBody {
  /** Day of the visit, `YYYY-MM-DD`. */
  visited: string;
  still_there: boolean;
  /**
   * The app saw the phone near the place at the time. Only `true` is sent;
   * leave it out otherwise. The location itself is never sent.
   */
  nearby?: true;
}

/** The kind of site a reported fee was for. */
export type FeeSite = "unpowered" | "powered" | "cabin";

/** What a traveller paid for one night at a place. */
export interface FeeBody {
  /** Australian dollars per night, more than 0 and at most 1,000, with at most 2 decimal places. */
  amount: number;
  site: FeeSite;
  /** Month it was paid, `YYYY-MM`. Not in the future and not more than 24 months ago. */
  paid: string;
}

interface SubmissionBase {
  /** Place id (`ocdb_<ulid>`), or null for a new place. */
  place: string | null;
  /** Required for a new place. Allowed only on `new_place` and `wrong_location` reports. */
  location?: LatLon;
  /** Random per-install UUID. The intake hashes it before storage. */
  device: string;
  /**
   * Opaque id of the traveller's account: a keyed hash made by the app, never
   * a name or email. 16 to 128 characters of `A-Z a-z 0-9 _ -`. Reviews,
   * review reports and fees need it unless the app key proves the install
   * with App Attest. The intake hashes it again (`ctr_` and 16 hex) before storage.
   */
  contributor?: string;
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

/** What a traveller paid to stay at a place. */
export interface FeeSubmission extends SubmissionBase {
  type: "fee";
  place: string;
  fee: FeeBody;
}

/** A traveller's report of a published review. `place` is the review's place. */
export interface ReviewReportSubmission extends SubmissionBase {
  type: "review_report";
  place: string;
  review_report: ReviewReportBody;
}

/**
 * The meta part of a photo upload (`POST /v1/photos`). The JPEG files travel
 * beside it in the same request. Needs a contributor.
 */
export interface PhotoSubmission extends SubmissionBase {
  type: "photo";
  place: string;
  photo: PhotoFiles;
}

/** A traveller's report of a published photo. `place` is the photo's place. */
export interface PhotoReportSubmission extends SubmissionBase {
  type: "photo_report";
  place: string;
  photo_report: PhotoReportBody;
}

/**
 * Asks for every photo from the contributor to be removed, before their
 * account is deleted. `place` is null. Needs a contributor.
 */
export interface PhotoErasureSubmission extends SubmissionBase {
  type: "photo_erasure";
  place: null;
}

/**
 * Takes back a new place the same install sent. `place` is the new place's id
 * (`newPlaceId`). Within 24 hours of the report the place is withdrawn. After
 * that it counts as one more report.
 */
export interface WithdrawSubmission extends SubmissionBase {
  type: "withdraw";
  place: string;
}

/** Contact details of an owner. They stay in the private inbox and are never published. */
export interface OwnerContact {
  name: string;
  email: string;
}

/** Facts a verified owner may set directly: every fact except road access and water_type. */
export type OwnerFactName = Exclude<FactName, "access" | "water_type">;

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
export type FeedbackSubmission =
  | ReportSubmission
  | ReviewSubmission
  | CheckSubmission
  | ReviewReportSubmission
  | FeeSubmission
  | PhotoSubmission
  | PhotoReportSubmission
  | PhotoErasureSubmission
  | WithdrawSubmission;

/** Every body the intake accepts. */
export type Submission = FeedbackSubmission | OwnerSubmission;

/**
 * A submission as the intake stores it in `inbox/pending/<yyyy-mm-dd>/fb_<ulid>.json`:
 * the validated submission with `device` replaced by its salted hash, plus the
 * id, the time it arrived and the app name taken from the app key.
 */
export type StoredFeedback =
  | (DistributiveOmit<Exclude<FeedbackSubmission, PhotoSubmission>, "device" | "contributor"> & StoredFields)
  | (Omit<PhotoSubmission, "device" | "contributor" | "photo"> & StoredFields & { photo: StoredPhotoFiles });

/**
 * An owner submission as stored. A claim or listing gains the `code` the owner
 * shows on their page. Every owner submission holds `token_sha256`, the
 * SHA-256 (hex) of the owner's token, and never the token itself.
 */
export type StoredOwnerSubmission =
  | (Omit<OwnerClaimSubmission, "device"> & OwnerStoredFields & { code: string; token_sha256: string })
  | (Omit<OwnerListingSubmission, "device"> & OwnerStoredFields & { code: string; token_sha256: string })
  | (Omit<OwnerUpdateSubmission, "device" | "token"> & OwnerStoredFields & { token_sha256: string });

type OwnerStoredFields = Omit<StoredFields, "contributor" | "attested" | "attest_key" | "intake">;

/** Everything that can be in `inbox/pending/`. */
export type StoredSubmission = StoredFeedback | StoredOwnerSubmission;

interface StoredFields {
  id: string;
  /** SHA-256 of salt and device, first 16 hex characters. */
  device: string;
  /**
   * SHA-256 of salt and the client's network (IPv4 /24 or IPv6 /48), first 16
   * hex characters. Absent when the intake saw no client address.
   */
  origin?: string;
  /** ISO 8601 UTC time the intake accepted it. */
  received: string;
  /** App name from the app key list, for example `example-app`. */
  app: string;
  /**
   * In place of the app's own value: `ctr_` and the first 16 hex characters of
   * SHA-256 of salt, app name and the contributor the app sent. On an iOS
   * submission without one, the same hash of the attested key id. Published
   * with reviews.
   */
  contributor?: string;
  /**
   * How the install was proven: `app_attest` or `play_integrity`. Absent when
   * the app key does not require attestation.
   */
  attested?: "app_attest" | "play_integrity";
  /** `ak_` and 16 hex characters of the salted App Attest key id: a second signal beside the contributor. */
  attest_key?: string;
  /**
   * What the intake decided at send time, on the fact reports, contact
   * reports and new places it decides. An item it held for a check
   * (`text_check`, `link_check`, `ai_check`, `daily_cap` or
   * `check_unavailable`) goes to a person, never into the data on its own.
   * Absent on other items and on items stored before the intake decided any.
   */
  intake?: StoredIntakeDecision;
}

/** The intake's send-time decision, as the inbox stores it. */
export type StoredIntakeDecision = { state: "live" } | { state: "held"; held_reason: HeldReason };

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
