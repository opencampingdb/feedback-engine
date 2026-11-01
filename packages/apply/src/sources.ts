/**
 * Keeps `fact_sources` and `fact_dates` in step. The data repository's
 * validation requires a date for exactly the values that are not from OSM,
 * none later than the record's `updated`.
 */

import type { Place, Source, SourceKey } from "./types.js";

/** Records where a value came from and, unless that is OSM, when it was accepted. */
export function setSource(place: Place, key: SourceKey, source: Source, at: string): void {
  place.fact_sources[key] = source;
  if (source === "osm") {
    dropDate(place, key);
  } else {
    place.fact_dates = { ...place.fact_dates, [key]: at };
  }
}

/** Removes a value's source and its date, for a value that has been removed. */
export function dropSource(place: Place, key: SourceKey): void {
  delete place.fact_sources[key];
  dropDate(place, key);
}

function dropDate(place: Place, key: SourceKey): void {
  if (!place.fact_dates) return;
  delete place.fact_dates[key];
  if (Object.keys(place.fact_dates).length === 0) delete place.fact_dates;
}
