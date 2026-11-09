/**
 * Settings and checks a photo service sets on its intake: the app version
 * photo uploads need, the report reasons that withhold a photo at once, and
 * whether a photo is the contributor's own.
 */

import { PHOTO_REPORT_REASONS, type PhotoReportReason } from "@opencampingdb/feedback";

/**
 * A version's leading numbers and its build number: `1.4.0` reads as [1, 4, 0]
 * with no build, and `1.4.0 (52)` or `1.4.0+52` as [1, 4, 0] with build 52.
 */
function versionParts(version: string): { parts: number[]; build?: number } | undefined {
  const match = /^\s*v?(\d+(?:\.\d+)*)(?:\s*\((\d+)\)|\+(\d+))?/.exec(version);
  if (!match) return undefined;
  const build = match[2] ?? match[3];
  return { parts: match[1]!.split(".").map(Number), ...(build !== undefined ? { build: Number(build) } : {}) };
}

/**
 * Whether `version` is at least `minimum`. The leading numbers are compared
 * part by part (`1.10.0` is above `1.9.2`, and a missing part counts as 0).
 * When they are equal and the minimum has a build number (`1.0.0 (36)`), the
 * build numbers decide, and a version without one is below it. A version
 * with no leading number is below any minimum.
 */
export function appVersionAtLeast(version: string, minimum: string): boolean {
  const have = versionParts(version);
  const need = versionParts(minimum);
  if (!need) return true;
  if (!have) return false;
  for (let i = 0; i < Math.max(have.parts.length, need.parts.length); i++) {
    const a = have.parts[i] ?? 0;
    const b = need.parts[i] ?? 0;
    if (a !== b) return a > b;
  }
  if (need.build === undefined) return true;
  return have.build !== undefined && have.build >= need.build;
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
 * How long a removal's or an erasure's withhold key lasts. The apply run takes
 * the photos out within hours, and the photo sync deletes their files, so the
 * key only has to outlast that and the edge cache's day.
 */
export const REMOVAL_WITHHOLD_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * The photo server's state key that stops every photo from one contributor
 * (the stored, hashed id): set by an erasure. The photo server knows a
 * photo's contributor from the `contributor` metadata its files carry from
 * the upload.
 */
export const withheldContributorKey = (contributor: string) => `withheld-contributor:${contributor}`;
