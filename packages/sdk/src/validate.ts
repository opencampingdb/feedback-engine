import { findContactDetails, findContactDetailsInHours } from "./text.js";
import type {
  BrandValue,
  CheckBody,
  FactName,
  FeeBody,
  FeeSite,
  ReportFactName,
  FactValue,
  FeedbackSubmission,
  LatLon,
  NewPlaceContacts,
  NewPlaceReportReason,
  OwnerContact,
  OwnerFactName,
  OwnerFacts,
  OwnerSubmission,
  OwnerUpdate,
  PhotoFiles,
  PhotoReportBody,
  PhotoReportReason,
  ReportBody,
  ReportKind,
  ReviewBody,
  ReviewReportBody,
  ReviewReportReason,
  Submission,
} from "./types.js";

export const FEEDBACK_TYPES = [
  "report",
  "review",
  "check",
  "review_report",
  "fee",
  "photo",
  "photo_report",
  "photo_erasure",
  "withdraw",
] as const;
export const OWNER_TYPES = ["owner_claim", "owner_listing", "owner_update"] as const;
const ALL_TYPES: readonly string[] = [...FEEDBACK_TYPES, ...OWNER_TYPES];
export const REPORT_KINDS: readonly ReportKind[] = [
  "closed",
  "reopened",
  "fact",
  "wrong_location",
  "new_place",
  "other",
  "name",
  "description",
  "kind",
  "remove",
];
export const NEW_PLACE_REPORT_REASONS: readonly NewPlaceReportReason[] = [
  "not_there",
  "fake",
  "offensive",
  "private_land",
  "duplicate",
];
/** Longest name a `name` report may propose. */
export const MAX_NAME_LENGTH = 300;
export const BRANDS: readonly BrandValue[] = [
  "aspen",
  "big4",
  "discovery",
  "family_parks",
  "gday",
  "ingenia",
  "kui",
  "nrma",
  "reflections",
  "tawk",
  "yha",
  "acc",
];
/** Site features: facts that are true or false. */
export const SITE_FEATURES = [
  "wheelchair",
  "generators",
  "motorhomes",
  "camper_trailers",
  "motorbikes",
  "big_rigs",
  "non_drinking_water",
  "laundry",
  "kitchen",
  "bbq",
  "drive_through",
  "ensuite_sites",
  "bins",
  "picnic_tables",
  "campfires",
  "cabins",
  "pub",
  "swimming",
  "fishing",
  "walking_tracks",
  "scenery",
  "wildlife",
  "playground",
  "games_room",
  "shade",
  "cycling_tracks",
  "offroad_tracks",
  "boat_ramp_nearby",
  "near_road",
  "telstra_signal",
  "mobile_signal",
  "wifi",
  "tv_reception",
  "pet_sitting",
  "fuel",
  "lpg",
  "car_wash",
  "vehicle_storage",
  "self_contained_only",
  "crocodiles",
  "seasonal_closure",
  "dangerous_when_wet",
  "over_50s",
  "nudist",
] as const satisfies readonly FactName[];
export const REVIEW_REPORT_REASONS: readonly ReviewReportReason[] = [
  "spam_ad",
  "offensive",
  "off_topic",
  "fake",
  "personal_details",
];
export const PHOTO_REPORT_REASONS: readonly PhotoReportReason[] = [
  "spam_ad",
  "offensive",
  "off_topic",
  "not_this_place",
  "personal_details",
  "copyright",
  "illegal",
];
/** Largest full size photo the intake takes, in bytes. */
export const MAX_PHOTO_BYTES = 1_500_000;
/** Largest thumbnail the intake takes, in bytes. */
export const MAX_THUMB_BYTES = 200_000;
export const FEE_SITES: readonly FeeSite[] = ["unpowered", "powered", "cabin"];
/** Highest fee per night, in Australian dollars. */
export const MAX_FEE_AMOUNT = 1000;
/** How many months back a fee may have been paid. */
export const MAX_FEE_AGE_MONTHS = 24;
/** Shape of a kind code. The list itself is `data/schema/kinds.json`. */
const KIND_CODE = /^[a-z][a-z_]{1,39}$/;

export const MAX_TEXT_LENGTH = 2000;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_APP_VERSION_LENGTH = 32;

const isBoolean = (v: unknown): boolean => typeof v === "boolean";
/** An https link to a page, as for the website and social pages. */
const isHttpsPage = (max: number) => (v: unknown): boolean =>
  typeof v === "string" && v.length <= max && /^https:\/\/[^\s]+$/.test(v);
const isPhone = (v: unknown): boolean => typeof v === "string" && /^\+?[\d ]{6,20}$/.test(v);
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

/** Every fact a report may name, with a check for its value. */
export const FACTS: Readonly<Record<ReportFactName, (value: unknown) => boolean>> = {
  fee: (v) => isBoolean(v) || v === "donation",
  power: isBoolean,
  tents: isBoolean,
  caravans: (v) => isBoolean(v) || v === "offroad",
  toilets: isBoolean,
  showers: isBoolean,
  drinking_water: isBoolean,
  dump_station: isBoolean,
  pets: (v) => v === "yes" || v === "no" || v === "leashed" || v === "seasonal",
  access: (v) => v === "2wd" || v === "awd" || v === "4wd" || v === "unknown",
  entry: (v) => v === "public" || v === "customers" || v === "permit" || v === "private",
  max_stay: (v) => typeof v === "string" && /^[1-9]\d{0,2}[hdw]$/.test(v),
  // Free text, so it must hold no email address, phone number or link.
  opening_hours: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 100 && findContactDetailsInHours(v).length === 0,
  website: isHttpsPage(300),
  phone: isPhone,
  water_type: (v) => v === "tank_fill" || v === "fountain",
  booking_required: isBoolean,
  ...(Object.fromEntries(SITE_FEATURES.map((f) => [f, isBoolean])) as Record<(typeof SITE_FEATURES)[number], (v: unknown) => boolean>),
  brand: (v) => typeof v === "string" && (BRANDS as readonly string[]).includes(v),
  email: (v) => typeof v === "string" && v.length <= 254 && EMAIL.test(v),
  phone_2: isPhone,
  facebook: isHttpsPage(500),
  instagram: isHttpsPage(500),
  tiktok: isHttpsPage(500),
  x: isHttpsPage(500),
};

const isHttpsUrl = (v: unknown): boolean => typeof v === "string" && v.length <= 300 && /^https:\/\/[^\s]+$/.test(v);

/** Facts a verified owner may set directly (SPEC "Owners"), with a check for each value. */
export const OWNER_FACTS: Readonly<Record<OwnerFactName, (value: unknown) => boolean>> = (() => {
  const { access: _access, water_type: _waterType, ...owned } = FACTS;
  return { ...owned, booking_url: isHttpsUrl };
})();

const PLACE_ID = /^ocdb_[0-9A-HJKMNP-TV-Z]{26}$/;
const REVIEW_ID = /^rev_[0-9A-HJKMNP-TV-Z]{26}$/;
const PHOTO_ID = /^pho_[0-9A-HJKMNP-TV-Z]{26}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTRIBUTOR = /^[A-Za-z0-9_-]{16,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TOP_LEVEL_KEYS = new Set([
  "type",
  "place",
  "location",
  "device",
  "contributor",
  "app_version",
  "consent",
  "report",
  "review",
  "check",
  "review_report",
  "fee",
  "photo",
  "photo_report",
  "terms_accepted",
  "token",
  "owner",
  "claim",
  "listing",
  "update",
]);

export type ValidationResult =
  | { ok: true; value: Submission }
  | { ok: false; errors: string[] };

/** True for owner_claim, owner_listing and owner_update. */
export function isOwnerSubmission<T extends { type: string }>(
  value: T,
): value is Extract<T, { type: OwnerSubmission["type"] }> {
  return (OWNER_TYPES as readonly string[]).includes(value.type);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return d.getUTCDate() === Number(m[3]);
}

export function isPlaceId(value: unknown): value is string {
  return typeof value === "string" && PLACE_ID.test(value);
}

/** A published review id, `rev_<ulid>`. */
/**
 * The id a new place has once its `new_place` report is sent: `ocdb_` and the
 * feedback id (`fb_<ulid>`) the intake answered with, as the apply run makes it.
 */
export function newPlaceId(feedbackId: string): string {
  return `ocdb_${feedbackId.replace(/^fb_/, "")}`;
}

export function isReviewId(value: unknown): value is string {
  return typeof value === "string" && REVIEW_ID.test(value);
}

/** A published photo id, `pho_<ulid>`. */
export function isPhotoId(value: unknown): value is string {
  return typeof value === "string" && PHOTO_ID.test(value);
}

/** A contributor id as an app sends it: 16 to 128 characters of `A-Z a-z 0-9 _ -`. */
export function isContributor(value: unknown): value is string {
  return typeof value === "string" && CONTRIBUTOR.test(value);
}

export function isFactName(value: unknown): value is ReportFactName {
  return typeof value === "string" && Object.hasOwn(FACTS, value);
}

export function isValidFactValue(fact: ReportFactName, value: unknown): value is FactValue {
  return FACTS[fact](value);
}

function checkText(value: unknown, field: string, errors: string[], required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return undefined;
  }
  if (value.length > MAX_TEXT_LENGTH) errors.push(`${field} must be at most ${MAX_TEXT_LENGTH} characters`);
  return value;
}

function checkLocation(value: unknown, errors: string[]): LatLon | undefined {
  if (!isObject(value)) {
    errors.push("location must be an object with lat and lon");
    return undefined;
  }
  const { lat, lon } = value;
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    errors.push("location.lat must be a number from -90 to 90");
  }
  if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    errors.push("location.lon must be a number from -180 to 180");
  }
  return typeof lat === "number" && typeof lon === "number"
    ? { lat: Math.round(lat * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 }
    : undefined;
}

function checkReport(value: unknown, errors: string[]): ReportBody | undefined {
  if (!isObject(value)) {
    errors.push("report must be an object");
    return undefined;
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !(REPORT_KINDS as readonly string[]).includes(kind)) {
    errors.push(`report.kind must be one of ${REPORT_KINDS.join(", ")}`);
    return undefined;
  }
  const out: ReportBody = { kind: kind as ReportKind };
  if (kind === "fact") {
    if (!isFactName(value.fact)) {
      errors.push(`report.fact must be one of ${Object.keys(FACTS).join(", ")}`);
    } else if (!isValidFactValue(value.fact, value.value)) {
      errors.push(`report.value is not a valid value for ${value.fact}`);
    } else {
      out.fact = value.fact;
      out.value = value.value as FactValue;
    }
  } else if (kind === "name" || kind === "description") {
    const max = kind === "name" ? MAX_NAME_LENGTH : MAX_DESCRIPTION_LENGTH;
    const text = value.value;
    if (value.fact !== undefined) errors.push("report.fact is only allowed when report.kind is fact");
    if (typeof text !== "string" || text.trim().length === 0 || text.length > max) {
      errors.push(`report.value must be the ${kind}, 1 to ${max} characters`);
    } else if (findContactDetails(text).length > 0) {
      errors.push(`report.value must not hold an email address, phone number or link`);
    } else {
      out.value = text.trim();
    }
  } else if (value.fact !== undefined || value.value !== undefined) {
    errors.push("report.fact and report.value are only allowed when report.kind is fact, name or description");
  }
  const note = checkText(value.note, "report.note", errors, false);
  if (note !== undefined) out.note = note;
  if (kind === "kind" && value.place_kind === undefined) {
    errors.push("report.place_kind is required when report.kind is kind");
  }
  if (value.place_kind !== undefined) {
    if (kind !== "new_place" && kind !== "kind") errors.push("report.place_kind is only allowed when report.kind is new_place or kind");
    else if (typeof value.place_kind !== "string" || !KIND_CODE.test(value.place_kind)) {
      errors.push("report.place_kind must be a kind code from data/schema/kinds.json");
    } else out.place_kind = value.place_kind;
  }
  if (kind === "remove") {
    if (typeof value.reason !== "string" || !(NEW_PLACE_REPORT_REASONS as readonly string[]).includes(value.reason)) {
      errors.push(`report.reason must be one of ${NEW_PLACE_REPORT_REASONS.join(", ")}`);
    } else out.reason = value.reason as NewPlaceReportReason;
  } else if (value.reason !== undefined) {
    errors.push("report.reason is only allowed when report.kind is remove");
  }
  if (value.contacts !== undefined) {
    if (kind !== "new_place") errors.push("report.contacts is only allowed when report.kind is new_place");
    else {
      const contacts = checkContacts(value.contacts, errors);
      if (contacts) out.contacts = contacts;
    }
  }
  return out;
}

const CONTACT_FACTS = ["phone", "website", "email"] as const;

function checkContacts(value: unknown, errors: string[]): NewPlaceContacts | undefined {
  const names = isObject(value) ? Object.keys(value) : [];
  if (!isObject(value) || names.some((name) => !(CONTACT_FACTS as readonly string[]).includes(name))) {
    errors.push("report.contacts may hold only phone, website and email");
    return undefined;
  }
  if (names.length === 0) {
    errors.push("report.contacts must hold at least one of phone, website and email");
    return undefined;
  }
  const out: NewPlaceContacts = {};
  for (const name of CONTACT_FACTS) {
    if (value[name] === undefined) continue;
    if (!FACTS[name](value[name])) errors.push(`report.contacts.${name} is not a valid value for ${name}`);
    else out[name] = value[name] as string;
  }
  return out;
}

function checkReview(value: unknown, errors: string[]): ReviewBody | undefined {
  if (!isObject(value)) {
    errors.push("review must be an object");
    return undefined;
  }
  const { stars, visited } = value;
  if (typeof stars !== "number" || !Number.isInteger(stars) || stars < 1 || stars > 5) {
    errors.push("review.stars must be a whole number from 1 to 5");
  }
  const text = checkText(value.text ?? "", "review.text", errors, true);
  if (typeof visited !== "string" || !YEAR_MONTH.test(visited)) {
    errors.push("review.visited must be YYYY-MM");
  }
  if (value.visited_nearby !== undefined && value.visited_nearby !== true) {
    errors.push("review.visited_nearby must be true, or left out");
  }
  return {
    stars: stars as ReviewBody["stars"],
    text: text ?? "",
    visited: visited as string,
    ...(value.visited_nearby === true ? { visited_nearby: true as const } : {}),
  };
}

function checkReviewReport(value: unknown, errors: string[]): ReviewReportBody | undefined {
  if (!isObject(value)) {
    errors.push("review_report must be an object");
    return undefined;
  }
  if (!isReviewId(value.review)) errors.push("review_report.review must be a review id (rev_<ulid>)");
  if (typeof value.reason !== "string" || !(REVIEW_REPORT_REASONS as readonly string[]).includes(value.reason)) {
    errors.push(`review_report.reason must be one of ${REVIEW_REPORT_REASONS.join(", ")}`);
  }
  return { review: value.review as string, reason: value.reason as ReviewReportReason };
}

function checkPhotoReport(value: unknown, errors: string[]): PhotoReportBody | undefined {
  if (!isObject(value)) {
    errors.push("photo_report must be an object");
    return undefined;
  }
  if (!isPhotoId(value.photo)) errors.push("photo_report.photo must be a photo id (pho_<ulid>)");
  if (typeof value.reason !== "string" || !(PHOTO_REPORT_REASONS as readonly string[]).includes(value.reason)) {
    errors.push(`photo_report.reason must be one of ${PHOTO_REPORT_REASONS.join(", ")}`);
  }
  return { photo: value.photo as string, reason: value.reason as PhotoReportReason };
}

function checkPhotoFiles(value: unknown, errors: string[]): PhotoFiles | undefined {
  if (!isObject(value)) {
    errors.push("photo must be an object");
    return undefined;
  }
  const { full_sha256, full_bytes, thumb_sha256, thumb_bytes } = value;
  for (const key of Object.keys(value)) {
    if (!["full_sha256", "full_bytes", "thumb_sha256", "thumb_bytes"].includes(key)) errors.push(`unknown field photo.${key}`);
  }
  if (typeof full_sha256 !== "string" || !SHA256.test(full_sha256)) errors.push("photo.full_sha256 must be a lower case hex SHA-256");
  if (typeof thumb_sha256 !== "string" || !SHA256.test(thumb_sha256)) errors.push("photo.thumb_sha256 must be a lower case hex SHA-256");
  if (!Number.isInteger(full_bytes) || (full_bytes as number) < 1 || (full_bytes as number) > MAX_PHOTO_BYTES) {
    errors.push(`photo.full_bytes must be a whole number from 1 to ${MAX_PHOTO_BYTES}`);
  }
  if (!Number.isInteger(thumb_bytes) || (thumb_bytes as number) < 1 || (thumb_bytes as number) > MAX_THUMB_BYTES) {
    errors.push(`photo.thumb_bytes must be a whole number from 1 to ${MAX_THUMB_BYTES}`);
  }
  return {
    full_sha256: full_sha256 as string,
    full_bytes: full_bytes as number,
    thumb_sha256: thumb_sha256 as string,
    thumb_bytes: thumb_bytes as number,
  };
}

/** Months since year 0, for comparing `YYYY-MM` values. */
function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

function checkFee(value: unknown, now: Date, errors: string[]): FeeBody | undefined {
  if (!isObject(value)) {
    errors.push("fee must be an object");
    return undefined;
  }
  const { amount, site, paid } = value;
  if (
    typeof amount !== "number" ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > MAX_FEE_AMOUNT ||
    Math.abs(Math.round(amount * 100) - amount * 100) > 1e-6
  ) {
    errors.push(`fee.amount must be more than 0 and at most ${MAX_FEE_AMOUNT} dollars, with at most 2 decimal places`);
  }
  if (typeof site !== "string" || !(FEE_SITES as readonly string[]).includes(site)) {
    errors.push(`fee.site must be one of ${FEE_SITES.join(", ")}`);
  }
  const m = typeof paid === "string" ? YEAR_MONTH.exec(paid) : null;
  if (!m) {
    errors.push("fee.paid must be YYYY-MM");
  } else {
    // The latest month is the one already started somewhere (UTC+14), so a
    // traveller ahead of UTC can report this month on its first day.
    const ahead = new Date(now.getTime() + 14 * 3_600_000);
    const latest = monthIndex(ahead.getUTCFullYear(), ahead.getUTCMonth() + 1);
    const earliest = monthIndex(now.getUTCFullYear(), now.getUTCMonth() + 1) - MAX_FEE_AGE_MONTHS;
    const month = monthIndex(Number(m[1]), Number(m[2]));
    if (month > latest) errors.push("fee.paid must not be in the future");
    else if (month < earliest) errors.push(`fee.paid must be within the last ${MAX_FEE_AGE_MONTHS} months`);
  }
  return { amount: amount as number, site: site as FeeSite, paid: paid as string };
}

function checkCheck(value: unknown, errors: string[]): CheckBody | undefined {
  if (!isObject(value)) {
    errors.push("check must be an object");
    return undefined;
  }
  const { visited, still_there } = value;
  if (typeof visited !== "string" || !isValidDate(visited)) errors.push("check.visited must be YYYY-MM-DD");
  if (typeof still_there !== "boolean") errors.push("check.still_there must be true or false");
  return { visited: visited as string, still_there: still_there as boolean };
}

/**
 * Validates an incoming submission against the SPEC schema. On success the
 * returned value holds only the known fields, so anything extra an app sent
 * is never stored. `now` is the clock a fee's `paid` month is checked against.
 */
export function validateSubmission(input: unknown, now: Date = new Date()): ValidationResult {
  const errors: string[] = [];
  if (!isObject(input)) return { ok: false, errors: ["body must be a JSON object"] };

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown field ${key}`);
  }

  const type = input.type;
  if (typeof type !== "string" || !ALL_TYPES.includes(type)) {
    errors.push(`type must be one of ${ALL_TYPES.join(", ")}`);
    return { ok: false, errors };
  }
  if ((OWNER_TYPES as readonly string[]).includes(type)) return validateOwner(input, type as OwnerSubmission["type"]);
  for (const other of ["report", "review", "check", "review_report", "fee", "photo", "photo_report", "terms_accepted", "token", "owner", "claim", "listing", "update"]) {
    if (other !== type && input[other] !== undefined) errors.push(`${other} is not allowed when type is ${type}`);
  }

  if (input.consent !== true) errors.push("consent must be true");

  const device = input.device;
  if (typeof device !== "string" || !UUID.test(device)) errors.push("device must be a UUID");

  const appVersion = input.app_version;
  if (typeof appVersion !== "string" || appVersion.length === 0 || appVersion.length > MAX_APP_VERSION_LENGTH) {
    errors.push(`app_version must be a string of 1 to ${MAX_APP_VERSION_LENGTH} characters`);
  }

  const contributor = input.contributor;
  if (contributor !== undefined && !isContributor(contributor)) {
    errors.push("contributor must be 16 to 128 characters of letters, digits, _ and -");
  }

  const place = input.place;
  if (place !== null && !isPlaceId(place)) errors.push("place must be an Open Camping DB id (ocdb_<ulid>) or null");

  const location = input.location === undefined ? undefined : checkLocation(input.location, errors);

  const base = {
    place: place as string | null,
    device: device as string,
    ...(contributor !== undefined ? { contributor: contributor as string } : {}),
    app_version: appVersion as string,
    consent: true as const,
    ...(location ? { location } : {}),
  };

  let value: FeedbackSubmission | undefined;
  if ((type === "photo" || type === "photo_erasure") && contributor === undefined) {
    errors.push(`contributor is required for a ${type}`);
  }
  if (type === "photo_erasure") {
    if (place !== null) errors.push("place must be null for a photo_erasure");
    if (input.location !== undefined) errors.push("location is not allowed on a photo_erasure");
    value = { ...base, place: null, type: "photo_erasure" };
  } else if (type === "report") {
    const report = checkReport(input.report, errors);
    if (report) {
      const isNew = report.kind === "new_place";
      if (isNew && place !== null) errors.push("place must be null for a new_place report");
      if (isNew && input.location === undefined) errors.push("location is required for a new_place report");
      if (!isNew && place === null) errors.push("place is required unless report.kind is new_place");
      if (input.location !== undefined && report.kind !== "new_place" && report.kind !== "wrong_location") {
        errors.push("location is only allowed on new_place and wrong_location reports");
      }
      value = { ...base, type: "report", report };
    }
  } else {
    if (place === null) errors.push(`place is required for a ${type}`);
    if (input.location !== undefined) errors.push(`location is not allowed on a ${type}`);
    if (type === "review") {
      const review = checkReview(input.review, errors);
      if (review) value = { ...base, place: place as string, type: "review", review };
    } else if (type === "review_report") {
      const reviewReport = checkReviewReport(input.review_report, errors);
      if (reviewReport) value = { ...base, place: place as string, type: "review_report", review_report: reviewReport };
    } else if (type === "photo") {
      const photo = checkPhotoFiles(input.photo, errors);
      if (photo) value = { ...base, place: place as string, type: "photo", photo };
    } else if (type === "photo_report") {
      const photoReport = checkPhotoReport(input.photo_report, errors);
      if (photoReport) value = { ...base, place: place as string, type: "photo_report", photo_report: photoReport };
    } else if (type === "withdraw") {
      value = { ...base, place: place as string, type: "withdraw" };
    } else if (type === "fee") {
      const fee = checkFee(input.fee, now, errors);
      if (fee) value = { ...base, place: place as string, type: "fee", fee };
    } else {
      const check = checkCheck(input.check, errors);
      if (check) value = { ...base, place: place as string, type: "check", check };
    }
  }

  if (errors.length > 0 || !value) return { ok: false, errors };
  return { ok: true, value };
}

function checkOwnerContact(value: unknown, errors: string[]): OwnerContact | undefined {
  if (!isObject(value)) {
    errors.push("owner must be an object with name and email");
    return undefined;
  }
  const { name, email } = value;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 100) {
    errors.push("owner.name must be 1 to 100 characters");
  }
  if (typeof email !== "string" || email.length > 254 || !EMAIL.test(email)) {
    errors.push("owner.email must be an email address");
  }
  return { name: String(name ?? "").trim(), email: String(email ?? "").trim() };
}

/** An https URL on a public host name. IP addresses and local names are refused. */
export function isPublicHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (!host.includes(".") || /\.(local|localhost|internal|home|lan)$/.test(host)) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false;
  return true;
}

function checkOwnerFacts(value: unknown, field: string, errors: string[]): OwnerFacts {
  const out: Record<string, FactValue> = {};
  if (!isObject(value)) {
    errors.push(`${field} must be an object`);
    return out;
  }
  for (const [name, v] of Object.entries(value)) {
    const valid = Object.hasOwn(OWNER_FACTS, name) ? OWNER_FACTS[name as OwnerFactName] : undefined;
    if (!valid) errors.push(`${field}.${name} is not a fact an owner can set`);
    else if (!valid(v)) errors.push(`${field}.${name} is not a valid value`);
    else out[name] = v as FactValue;
  }
  return out as OwnerFacts;
}

function checkDescription(value: unknown, field: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`${field} must be text of at most ${MAX_DESCRIPTION_LENGTH} characters`);
    return undefined;
  }
  if (findContactDetails(value).length > 0) {
    errors.push(`${field} must not hold an email address, phone number or link: use the phone, website and booking_url fields`);
  }
  return value;
}

function checkName(value: unknown, field: string, errors: string[]): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 100) {
    errors.push(`${field} must be 1 to 100 characters`);
    return undefined;
  }
  return value.trim();
}

const UPDATE_KEYS = ["facts", "description", "status", "reopens", "name", "location"];

function checkUpdate(value: unknown, errors: string[]): OwnerUpdate | undefined {
  if (!isObject(value)) {
    errors.push("update must be an object");
    return undefined;
  }
  const out: OwnerUpdate = {};
  for (const key of Object.keys(value)) if (!UPDATE_KEYS.includes(key)) errors.push(`unknown field update.${key}`);
  if (Object.keys(value).length === 0) errors.push("update must change something");
  if (value.facts !== undefined) out.facts = checkOwnerFacts(value.facts, "update.facts", errors);
  const description = checkDescription(value.description, "update.description", errors);
  if (description !== undefined) out.description = description;
  if (value.status !== undefined) {
    if (value.status === "open" || value.status === "temporarily_closed") out.status = value.status;
    else errors.push("update.status must be open or temporarily_closed");
  }
  if (value.status === "temporarily_closed" && value.reopens === undefined) {
    errors.push("update.reopens is required when status is temporarily_closed");
  }
  if (value.reopens !== undefined) {
    if (value.status !== "temporarily_closed") errors.push("update.reopens is only allowed with status temporarily_closed");
    else if (typeof value.reopens !== "string" || !isValidDate(value.reopens)) errors.push("update.reopens must be YYYY-MM-DD");
    else out.reopens = value.reopens;
  }
  if (value.name !== undefined) {
    const name = checkName(value.name, "update.name", errors);
    if (name !== undefined) out.name = name;
  }
  if (value.location !== undefined) {
    const location = checkLocation(value.location, errors);
    if (location) out.location = location;
  }
  return out;
}

const OWNER_FIELDS: Record<OwnerSubmission["type"], string[]> = {
  owner_claim: ["owner", "claim"],
  owner_listing: ["owner", "claim", "listing", "location"],
  owner_update: ["token", "update"],
};

/** Validates the three owner submission types (SPEC "Owners"). */
function validateOwner(input: Record<string, unknown>, type: OwnerSubmission["type"]): ValidationResult {
  const errors: string[] = [];
  for (const key of ["report", "review", "check", "review_report", "fee", "photo", "photo_report", "contributor", "token", "owner", "claim", "listing", "update", "location"]) {
    if (input[key] !== undefined && !OWNER_FIELDS[type].includes(key)) errors.push(`${key} is not allowed when type is ${type}`);
  }
  if (input.terms_accepted !== true) errors.push("terms_accepted must be true");
  const device = input.device;
  if (typeof device !== "string" || !UUID.test(device)) errors.push("device must be a UUID");
  const appVersion = input.app_version;
  if (typeof appVersion !== "string" || appVersion.length === 0 || appVersion.length > MAX_APP_VERSION_LENGTH) {
    errors.push(`app_version must be a string of 1 to ${MAX_APP_VERSION_LENGTH} characters`);
  }
  const base = { device: device as string, app_version: appVersion as string, terms_accepted: true as const };

  let value: OwnerSubmission | undefined;
  if (type === "owner_update") {
    if (!isPlaceId(input.place)) errors.push("place is required: an Open Camping DB id (ocdb_<ulid>)");
    if (typeof input.token !== "string" || !TOKEN.test(input.token)) {
      errors.push("token must be the 43 character token from the claim");
    }
    const update = checkUpdate(input.update, errors);
    if (update) value = { ...base, type, place: input.place as string, token: input.token as string, update };
  } else {
    const owner = checkOwnerContact(input.owner, errors);
    const claimInput = isObject(input.claim) ? input.claim : {};
    if (!isPublicHttpsUrl(claimInput.proof_url)) {
      errors.push("claim.proof_url must be an https address on a public website, up to 500 characters");
    }
    const claim = { proof_url: claimInput.proof_url as string };
    if (type === "owner_claim") {
      if (!isPlaceId(input.place)) errors.push("place is required: an Open Camping DB id (ocdb_<ulid>)");
      if (owner) value = { ...base, type, place: input.place as string, owner, claim };
    } else {
      if (input.place !== null) errors.push("place must be null for an owner_listing");
      if (input.location === undefined) errors.push("location is required for an owner_listing");
      const location = input.location === undefined ? undefined : checkLocation(input.location, errors);
      const listingInput = isObject(input.listing) ? input.listing : undefined;
      if (!listingInput) errors.push("listing must be an object");
      const name = checkName(listingInput?.name, "listing.name", errors);
      const description = checkDescription(listingInput?.description, "listing.description", errors);
      const facts = checkOwnerFacts(listingInput?.facts ?? {}, "listing.facts", errors);
      if (facts.booking_url === undefined && facts.phone === undefined) {
        errors.push("listing.facts needs a booking_url or phone so guests can book with the owner");
      }
      if (owner && location && name !== undefined) {
        const listing = { name, ...(description !== undefined ? { description } : {}), facts };
        value = { ...base, type, place: null, location, owner, claim, listing };
      }
    }
  }
  if (errors.length > 0 || !value) return { ok: false, errors };
  return { ok: true, value };
}
