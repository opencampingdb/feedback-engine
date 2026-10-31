/**
 * Writes place records and review lines in the data repository's canonical
 * form, which its CI checks byte for byte. That form is Python's
 * `json.dumps(record, sort_keys=True, indent=2, ensure_ascii=False) + "\n"`
 * for place files and `json.dumps(obj, sort_keys=True, separators=(",", ":"),
 * ensure_ascii=False)` for review lines.
 */

import type { Place, Review } from "./types.js";

/** Paths in a place record whose numbers are floats in Python, so 4 is written 4.0. */
const PLACE_FLOATS = new Set(["location.lat", "location.lon", "rating.mean"]);

/** Formats a number the way Python's `repr(float)` does. */
export function pythonFloat(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`cannot write ${x} as JSON`);
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa, exp] = x.toExponential().split("e") as [string, string];
  const e = Number(exp);
  if (e < -4 || e >= 16) return `${mantissa}e${e < 0 ? "-" : "+"}${String(Math.abs(e)).padStart(2, "0")}`;
  const fixed = String(x);
  return /[.e]/.test(fixed) ? fixed : `${fixed}.0`;
}

function dump(value: unknown, path: string, floats: ReadonlySet<string>, indent: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    return floats.has(path) || !Number.isInteger(value) ? pythonFloat(value) : String(value);
  }
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `${inner}${dump(v, `${path}[]`, floats, inner)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
    if (keys.length === 0) return "{}";
    const items = keys.map((k) => {
      const child = path ? `${path}.${k}` : k;
      return `${inner}${JSON.stringify(k)}: ${dump((value as Record<string, unknown>)[k], child, floats, inner)}`;
    });
    return `{\n${items.join(",\n")}\n${indent}}`;
  }
  throw new Error(`cannot write ${typeof value} as JSON`);
}

/** Canonical text of a place record file, with the trailing newline. */
export function dumpPlace(place: Place): string {
  return `${dump(place, "", PLACE_FLOATS, "")}\n`;
}

/** Canonical one-line text of a review, without the newline. */
export function dumpReviewLine(review: Review): string {
  const sorted = Object.fromEntries(Object.entries(review).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return JSON.stringify(sorted);
}

const PLACE_ID = /^ocdb_[0-9A-HJKMNP-TV-Z]{26}$/;

function checkPlaceId(id: string): void {
  if (!PLACE_ID.test(id)) throw new Error(`refusing place id ${JSON.stringify(id)}`);
}

/**
 * Where the data repository keeps a place record: `places/<last 2 characters of id, lower case>/<id>.json`.
 * Throws for an id that is not `ocdb_<ulid>`.
 */
export function placePath(id: string): string {
  checkPlaceId(id);
  return `places/${id.slice(-2).toLowerCase()}/${id}.json`;
}

/** Rounds a coordinate to the 6 decimal places the data stores. */
export function roundCoord(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** `reviews/<place id>.ndjson`. Throws for an id that is not `ocdb_<ulid>`. */
export function reviewPath(placeId: string): string {
  checkPlaceId(placeId);
  return `reviews/${placeId}.ndjson`;
}
