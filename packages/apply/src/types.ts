import type { FactName, PlaceFacts, PlaceGroup, PlaceKind } from "@opencampingdb/feedback";

/** `merged` marks a tombstone: the record was merged into `merged_into` by a person. */
export type PlaceStatus = "open" | "reported_closed" | "closed" | "temporarily_closed" | "merged";

/** Where a value in a place record came from. */
export type Source = "osm" | "feedback" | "contributed" | "owner";

/** Keys of `fact_sources` and `fact_dates`: every fact, plus the name, location, status and description. */
export type SourceKey = FactName | "name" | "location" | "status" | "description";

/** A place record in the data repository (`places/<last 2 of id, lower case>/<id>.json`). */
export interface Place {
  id: string;
  name: string | null;
  kind: PlaceKind;
  group: PlaceGroup;
  location: { lat: number; lon: number };
  /** `timestamp`: when this version of the OSM object was saved, UTC. Missing on records not yet synced with it. */
  osm: { type: "node" | "way" | "relation"; id: number; version: number; timestamp?: string } | null;
  facts: PlaceFacts;
  status: PlaceStatus;
  rating: { count: number; mean: number } | null;
  /** Where each fact, the name, the location and the status came from. */
  fact_sources: Partial<Record<SourceKey, Source>>;
  /**
   * When each value not from OSM was accepted, UTC: one entry for every
   * `fact_sources` entry that is `feedback`, `contributed` or `owner`.
   * Left out when there are none. Set it with `setSource`.
   */
  fact_dates?: Partial<Record<SourceKey, string>>;
  /**
   * When a traveller last checked the place and found it there, UTC: the time
   * of the apply run that accepted the check. Set only while the place is open,
   * and does not move `updated`. Missing when no check has confirmed it.
   */
  last_confirmed?: string;
  updated: string;
  /** Plain text from a verified owner, at most 500 characters. */
  description?: string;
  /** True once an owner's claim is approved. */
  owner_verified?: boolean;
  /** Day a temporarily closed place reopens, `YYYY-MM-DD`. */
  reopens?: string;
  /** Only on a tombstone: the record this one was merged into. */
  merged_into?: string;
  /** Only on a record that absorbed others: their OSM objects. */
  merged_osm?: { type: "node" | "way" | "relation"; id: number }[];
}

/** One entry of `data/schema/kinds.json`. */
export interface KindEntry {
  code: string;
  label: string;
  group: string;
}

/** One line of `reviews/<place id>.ndjson`. */
export interface Review {
  id: string;
  place: string;
  stars: number;
  text: string;
  visited: string;
  created: string;
  app: string;
}
