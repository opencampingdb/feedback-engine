import { findContactDetails } from "./text.js";
import type {
  CheckBody,
  ReportFactName,
  FactValue,
  FeedbackSubmission,
  LatLon,
  OwnerContact,
  OwnerFactName,
  OwnerFacts,
  OwnerSubmission,
  OwnerUpdate,
  PlaceGroup,
  PlaceKind,
  ReportBody,
  ReportKind,
  ReviewBody,
  Submission,
} from "./types.js";

export const FEEDBACK_TYPES = ["report", "review", "check"] as const;
export const OWNER_TYPES = ["owner_claim", "owner_listing", "owner_update"] as const;
const ALL_TYPES: readonly string[] = [...FEEDBACK_TYPES, ...OWNER_TYPES];
export const REPORT_KINDS: readonly ReportKind[] = [
  "closed",
  "reopened",
  "fact",
  "wrong_location",
  "new_place",
  "other",
];
/** Every kind with its group (SPEC "Place record", plus `farm_stay` from "Owners"). */
export const PLACE_GROUPS: Readonly<Record<PlaceKind, PlaceGroup>> = {
  free_camp: "overnight",
  paid_campground: "overnight",
  caravan_park: "overnight",
  national_park_campsite: "overnight",
  state_forest_campsite: "overnight",
  showground: "overnight",
  campground: "overnight",
  farm_stay: "overnight",
  rest_area: "utility",
  dump_point: "utility",
  drinking_water_point: "utility",
  public_toilet: "utility",
  public_shower: "utility",
  laundromat: "utility",
  picnic_site: "utility",
  information_centre: "services",
  fuel: "services",
  lpg_refill_swap: "services",
  mechanic: "services",
  attraction: "attraction",
  lookout: "attraction",
  swimming_spot: "attraction",
  boat_ramp: "attraction",
  hospital_emergency: "emergency",
  ferry_terminal: "transport",
};
export const PLACE_KINDS = Object.keys(PLACE_GROUPS) as PlaceKind[];

export const MAX_TEXT_LENGTH = 2000;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_APP_VERSION_LENGTH = 32;

const isBoolean = (v: unknown): boolean => typeof v === "boolean";

/** Every fact a report may name, with a check for its value. */
export const FACTS: Readonly<Record<ReportFactName, (value: unknown) => boolean>> = {
  fee: isBoolean,
  power: isBoolean,
  tents: isBoolean,
  caravans: isBoolean,
  toilets: isBoolean,
  showers: isBoolean,
  drinking_water: isBoolean,
  dump_station: isBoolean,
  pets: (v) => v === "yes" || v === "no" || v === "leashed",
  access: (v) => v === "2wd" || v === "awd" || v === "4wd" || v === "unknown",
  entry: (v) => v === "public" || v === "customers" || v === "permit" || v === "private",
  max_stay: (v) => typeof v === "string" && /^[1-9]\d{0,2}[hdw]$/.test(v),
  opening_hours: (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 100,
  website: (v) => typeof v === "string" && v.length <= 300 && /^https:\/\/[^\s]+$/.test(v),
  phone: (v) => typeof v === "string" && /^\+?[\d ]{6,20}$/.test(v),
  water_type: (v) => v === "tank_fill" || v === "fountain",
};

const isHttpsUrl = (v: unknown): boolean => typeof v === "string" && v.length <= 300 && /^https:\/\/[^\s]+$/.test(v);

/** Facts a verified owner may set directly (SPEC "Owners"), with a check for each value. */
export const OWNER_FACTS: Readonly<Record<OwnerFactName, (value: unknown) => boolean>> = {
  fee: FACTS.fee,
  power: FACTS.power,
  pets: FACTS.pets,
  tents: FACTS.tents,
  caravans: FACTS.caravans,
  toilets: FACTS.toilets,
  showers: FACTS.showers,
  drinking_water: FACTS.drinking_water,
  dump_station: FACTS.dump_station,
  max_stay: FACTS.max_stay,
  opening_hours: FACTS.opening_hours,
  entry: FACTS.entry,
  phone: FACTS.phone,
  website: FACTS.website,
  booking_url: isHttpsUrl,
};

const PLACE_ID = /^ocdb_[0-9A-HJKMNP-TV-Z]{26}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DATE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TOP_LEVEL_KEYS = new Set([
  "type",
  "place",
  "location",
  "device",
  "app_version",
  "consent",
  "report",
  "review",
  "check",
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
  } else if (value.fact !== undefined || value.value !== undefined) {
    errors.push("report.fact and report.value are only allowed when report.kind is fact");
  }
  const note = checkText(value.note, "report.note", errors, false);
  if (note !== undefined) out.note = note;
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
  return { stars: stars as ReviewBody["stars"], text: text ?? "", visited: visited as string };
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
 * is never stored.
 */
export function validateSubmission(input: unknown): ValidationResult {
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
  for (const other of [...FEEDBACK_TYPES, "terms_accepted", "token", "owner", "claim", "listing", "update"]) {
    if (other !== type && input[other] !== undefined) errors.push(`${other} is not allowed when type is ${type}`);
  }

  if (input.consent !== true) errors.push("consent must be true");

  const device = input.device;
  if (typeof device !== "string" || !UUID.test(device)) errors.push("device must be a UUID");

  const appVersion = input.app_version;
  if (typeof appVersion !== "string" || appVersion.length === 0 || appVersion.length > MAX_APP_VERSION_LENGTH) {
    errors.push(`app_version must be a string of 1 to ${MAX_APP_VERSION_LENGTH} characters`);
  }

  const place = input.place;
  if (place !== null && !isPlaceId(place)) errors.push("place must be an Open Camping DB id (ocdb_<ulid>) or null");

  const location = input.location === undefined ? undefined : checkLocation(input.location, errors);

  const base = {
    place: place as string | null,
    device: device as string,
    app_version: appVersion as string,
    consent: true as const,
    ...(location ? { location } : {}),
  };

  let value: FeedbackSubmission | undefined;
  if (type === "report") {
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
  for (const key of ["report", "review", "check", "token", "owner", "claim", "listing", "update", "location"]) {
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
