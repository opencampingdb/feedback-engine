import type { NewPlaceStanding } from "./standing.js";
import type { ContactFactName, FactValue, FeeValue, LatLon } from "./types.js";

/**
 * A new place on the recent list (`GET /v1/places/recent`), shown until a data
 * release has it. Never the note. The description, fee and contacts are there
 * only when the report carried them and they passed the checks.
 */
export interface RecentPlace {
  id: string;
  location: LatLon;
  kind: string | null;
  /** The name the traveller gave, or null when the report carried none. */
  name: string | null;
  standing: NewPlaceStanding;
  added: string;
  /** The hashed contributor id, so apps can hide what a hidden contributor added. */
  contributor: string;
  /** The description, tidied. */
  description?: string;
  fee?: FeeValue;
  /** The contact facts and the address. */
  contacts?: Partial<Record<ContactFactName, FactValue>>;
}

/**
 * A recent change: a change to a released place that went live at send time,
 * for apps to lay over their release with `withRecentChanges`. The recent list
 * has the latest change for each place and fact.
 */
export interface RecentChange {
  place: string;
  fact: string;
  /** The fact's new value, or null when the change takes it down. */
  value: FactValue | null;
  /** When the intake accepted it, ISO 8601 UTC. */
  accepted: string;
  /** When the apply put it into the data, ISO 8601 UTC, or null until it has. */
  in_data_at: string | null;
}

/** What `GET /v1/places/recent` answers. */
export interface RecentList {
  places: RecentPlace[];
  /** Absent from intakes older than SDK 0.10.0. */
  changes?: RecentChange[];
}

/** The part of a release place record (`places.ndjson.gz`) that `withRecentChanges` reads and writes. */
export interface ReleasePlace {
  id: string;
  facts: object;
  fact_sources?: object;
  fact_dates?: object;
}

const DATA_VERSION = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:-|$)/;

/**
 * The time a data release's `data_version` (`<commit time>-<short sha>`, such
 * as `20261030T160000Z-abc1234`) names, in milliseconds since 1970, or
 * undefined when it is not in that form.
 */
export function dataVersionTime(dataVersion: string): number | undefined {
  const match = DATA_VERSION.exec(dataVersion);
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(ms);
  // Date.UTC rolls over out-of-range parts (month 13, 25 o'clock), so read them back to refuse those.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day || back.getUTCHours() !== hour || back.getUTCMinutes() !== minute || back.getUTCSeconds() !== second) return undefined;
  return ms;
}

/**
 * A release place with the recent changes to it laid over, in the order they
 * were accepted. A change sets the fact, its `fact_sources` entry to
 * `feedback` and its `fact_dates` entry to when it was accepted; a change with
 * value null takes the fact and both entries off. Changes to other places are
 * ignored, and so are changes the release already has: those whose
 * `in_data_at` is earlier than the time in `releaseDataVersion`, the
 * `data_version` of the app's release. When the version is not in the
 * `<commit time>-<short sha>` form, every change is laid over.
 *
 * Returns a new record and leaves `place` as it was, or `place` itself when no
 * change applies.
 */
export function withRecentChanges<P extends ReleasePlace>(place: P, changes: readonly RecentChange[], releaseDataVersion: string): P {
  const release = dataVersionTime(releaseDataVersion);
  const applying = changes
    .filter((change) => change.place === place.id && !(release !== undefined && change.in_data_at !== null && Date.parse(change.in_data_at) < release))
    .sort((a, b) => (a.accepted < b.accepted ? -1 : a.accepted > b.accepted ? 1 : 0));
  if (applying.length === 0) return place;
  const facts: Record<string, unknown> = { ...place.facts };
  const sources: Record<string, unknown> = { ...place.fact_sources };
  const dates: Record<string, unknown> = { ...place.fact_dates };
  for (const change of applying) {
    if (change.value === null) {
      delete facts[change.fact];
      delete sources[change.fact];
      delete dates[change.fact];
    } else {
      facts[change.fact] = change.value;
      sources[change.fact] = "feedback";
      dates[change.fact] = change.accepted;
    }
  }
  return { ...place, facts, fact_sources: sources, fact_dates: dates };
}
