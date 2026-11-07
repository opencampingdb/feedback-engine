import { dataVersionTime, type RecentRelease } from "@opencampingdb/feedback";
import type { D1Like } from "./recent.js";

/** The body of `POST /v1/release`, or the problems with it. */
export function parseRelease(body: Record<string, unknown>): { data_version: string; layout_version?: number } | { problems: string[] } {
  const { data_version: version, layout_version: layout } = body;
  const problems: string[] = [];
  if (typeof version !== "string" || version.length > 64 || dataVersionTime(version) === undefined) {
    problems.push("data_version must be a release's <yyyymmdd>T<hhmmss>Z-<short sha>");
  }
  if (layout !== undefined && !(Number.isInteger(layout) && (layout as number) > 0 && (layout as number) < 1_000_000)) {
    problems.push("layout_version must be a positive whole number");
  }
  if (problems.length > 0) return { problems };
  return { data_version: version as string, ...(layout !== undefined ? { layout_version: layout as number } : {}) };
}

/**
 * Keeps `release` as the newest, published at `published`, unless the intake
 * has a newer one or this one already. Data versions start with their commit
 * time, so they sort by it as text. Returns the newest release it has.
 */
export async function recordRelease(db: D1Like, release: { data_version: string; layout_version?: number }, published: string): Promise<RecentRelease> {
  await db
    .prepare(
      `INSERT INTO latest_release (id, data_version, published, layout_version) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET data_version = excluded.data_version, published = excluded.published, layout_version = excluded.layout_version
       WHERE excluded.data_version > latest_release.data_version`,
    )
    .bind(release.data_version, published, release.layout_version ?? null)
    .run();
  return (await latestRelease(db))!;
}

/** The newest release the intake was told of, or undefined before the first. */
export async function latestRelease(db: D1Like): Promise<RecentRelease | undefined> {
  const row = await db.prepare("SELECT data_version, published, layout_version FROM latest_release WHERE id = 1").first<{ data_version: string; published: string; layout_version: number | null }>();
  if (!row) return undefined;
  return { data_version: row.data_version, published: row.published, ...(row.layout_version !== null ? { layout_version: row.layout_version } : {}) };
}
