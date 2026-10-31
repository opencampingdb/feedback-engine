/**
 * The parts of a data place record and of an inbox item that the notes read.
 * The full shapes are in packages/apply/src/types.ts and packages/sdk.
 */

/** Where a value in a place record came from. */
export type Source = "osm" | "feedback" | "contributed" | "owner";

export type OsmType = "node" | "way" | "relation";

/** A place record in the data repository (`places/<last 2 of id, lower case>/<id>.json`). */
export interface Place {
  id: string;
  name: string | null;
  kind: string;
  location: { lat: number; lon: number };
  osm: { type: OsmType; id: number; version?: number } | null;
  facts: Record<string, boolean | string | undefined>;
  status: string;
  fact_sources: Record<string, Source | undefined>;
  merged_into?: string;
}

/** The fields of an item in `inbox/applied/<day>/` that count as evidence. Device is a salted hash. */
export interface AppliedItem {
  type: string;
  place: string | null;
  device: string;
  received: string;
  report?: { kind: string; fact?: string; value?: boolean | string };
  check?: { still_there: boolean };
  update?: { facts?: Record<string, boolean | string> };
  outcome?: { result: string };
}

/** One change a note asks OSM mappers to check. */
export interface NoteChange {
  /** A fact name, `name` or `status`. */
  field: string;
  /** The new value. For `status` always `closed`. */
  value: boolean | string;
  /** The value before, when there was one. */
  previous?: boolean | string | null;
  source: "feedback" | "owner";
  /** Independent reports agreeing on the value, when the inbox shows them. */
  reports?: number;
  /** First and last day of those reports, `YYYY-MM-DD`. */
  from?: string;
  to?: string;
}

/** A note for one place. */
export interface Note {
  place: string;
  name: string | null;
  osm: { type: OsmType; id: number };
  lat: number;
  lon: number;
  /** Path of the place file in the data repository. */
  path: string;
  changes: NoteChange[];
}

/** One line of the sent log: one field of one note we posted. */
export interface SentEntry {
  place: string;
  field: string;
  value: boolean | string;
  /** OSM note id. */
  note: number;
  /** When it was posted, ISO 8601 UTC. */
  sent: string;
}
