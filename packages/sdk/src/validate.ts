import type {
  CheckBody,
  FactName,
  FactValue,
  FeedbackSubmission,
  LatLon,
  ReportBody,
  ReportKind,
  ReviewBody,
} from "./types.js";

export const FEEDBACK_TYPES = ["report", "review", "check"] as const;
export const REPORT_KINDS: readonly ReportKind[] = [
  "closed",
  "reopened",
  "fact",
  "wrong_location",
  "new_place",
  "other",
];
export const PLACE_KINDS = [
  "camp_site",
  "caravan_site",
  "rest_area",
  "dump_station",
  "drinking_water",
  "toilets",
  "shower",
  "picnic_site",
] as const;

export const MAX_TEXT_LENGTH = 2000;
export const MAX_APP_VERSION_LENGTH = 32;

const isBoolean = (v: unknown): boolean => typeof v === "boolean";

/** Every fact a report may name, with a check for its value. */
export const FACTS: Readonly<Record<FactName, (value: unknown) => boolean>> = {
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
};

const PLACE_ID = /^ocdb_[0-9A-HJKMNP-TV-Z]{26}$/;
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
]);

export type ValidationResult =
  | { ok: true; value: FeedbackSubmission }
  | { ok: false; errors: string[] };

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

export function isFactName(value: unknown): value is FactName {
  return typeof value === "string" && Object.hasOwn(FACTS, value);
}

export function isValidFactValue(fact: FactName, value: unknown): value is FactValue {
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
  if (typeof type !== "string" || !(FEEDBACK_TYPES as readonly string[]).includes(type)) {
    errors.push("type must be report, review or check");
    return { ok: false, errors };
  }
  for (const other of FEEDBACK_TYPES) {
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
