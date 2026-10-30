import type { FactName, PlaceFacts, PlaceGroup, PlaceKind } from "@opencampingdb/feedback";

export type PlaceStatus = "open" | "reported_closed" | "closed" | "temporarily_closed";

/** Where a value in a place record came from. */
export type Source = "osm" | "feedback" | "contributed" | "owner";

/** A place record in the data repository (`places/<last 2 of id, lower case>/<id>.json`). */
export interface Place {
  id: string;
  name: string | null;
  kind: PlaceKind;
  group: PlaceGroup;
  location: { lat: number; lon: number };
  osm: { type: "node" | "way" | "relation"; id: number; version: number } | null;
  facts: PlaceFacts;
  status: PlaceStatus;
  rating: { count: number; mean: number } | null;
  /** Where each fact, the name, the location and the status came from. */
  fact_sources: Partial<Record<FactName | "name" | "location" | "status", Source>>;
  updated: string;
  /** Plain text from a verified owner, at most 500 characters. */
  description?: string;
  /** True once an owner's claim is approved. */
  owner_verified?: boolean;
  /** Day a temporarily closed place reopens, `YYYY-MM-DD`. */
  reopens?: string;
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
