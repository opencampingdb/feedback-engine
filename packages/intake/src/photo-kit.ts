/**
 * Settings and checks a photo service sets on its intake: the app version
 * photo uploads need, the report reasons that withhold a photo at once, and
 * whether a photo is the contributor's own.
 */

import { PHOTO_REPORT_REASONS, type PhotoReportReason } from "@opencampingdb/feedback";

/** A version's leading numbers: `1.4.0` and `1.4.0 (52)` read as [1, 4, 0]. */
function versionParts(version: string): number[] | undefined {
  const match = /^\s*v?(\d+(?:\.\d+)*)/.exec(version);
  return match ? match[1]!.split(".").map(Number) : undefined;
}

/**
 * Whether `version` is at least `minimum`, comparing the leading numbers part
 * by part (`1.10.0` is above `1.9.2`, and a missing part counts as 0). A
 * version with no leading number is below any minimum.
 */
export function appVersionAtLeast(version: string, minimum: string): boolean {
  const have = versionParts(version);
  const need = versionParts(minimum);
  if (!need) return true;
  if (!have) return false;
  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** The minimum from `PHOTO_MIN_APP_VERSION`, or undefined when it is unset or has no leading number. */
export function minimumAppVersion(setting: string | undefined): string | undefined {
  const value = setting?.trim();
  return value && versionParts(value) ? value : undefined;
}

/**
 * The report reasons that withhold a photo at the photo server on the first
 * report: `illegal` always, and those `PHOTO_WITHHOLD_REASONS` names
 * (comma separated). Names that are not report reasons are left out.
 */
export function withholdReasons(setting: string | undefined): ReadonlySet<PhotoReportReason> {
  const named = (setting ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter((r): r is PhotoReportReason => (PHOTO_REPORT_REASONS as readonly string[]).includes(r));
  return new Set<PhotoReportReason>(["illegal", ...named]);
}

/** The part of the serving bucket the owner check reads. */
export interface ServedBucketLike {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

/**
 * Who sent a served photo, from the place's records file in the serving
 * bucket (`records/<place id>.ndjson`, written by the photo sync):
 * `mine` when its line names this contributor, `theirs` when it names
 * another, and `unknown` when the photo is not served for that place or the
 * file can't be read. A photo that is not served needs no withholding.
 */
export async function photoOwner(bucket: ServedBucketLike, place: string, photo: string, contributor: string): Promise<"mine" | "theirs" | "unknown"> {
  let text: string;
  try {
    const object = await bucket.get(`records/${place}.ndjson`);
    if (!object) return "unknown";
    text = await object.text();
  } catch {
    return "unknown";
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record: { id?: unknown; contributor?: unknown };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    if (record.id === photo) return record.contributor === contributor ? "mine" : "theirs";
  }
  return "unknown";
}

/**
 * How long a removal's `withheld:` key lasts. The apply run takes the photo
 * out within hours, and the photo sync deletes its files, so the key only has
 * to outlast that and the edge cache's day.
 */
export const REMOVAL_WITHHOLD_TTL_SECONDS = 30 * 24 * 60 * 60;
