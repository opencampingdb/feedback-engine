import type { FactName, PlaceFacts, PlaceKind } from "@opencampingdb/feedback";

export type PlaceStatus = "open" | "reported_closed" | "closed";

/** A place record in the data repository (`places/<id[0:2]>/<id>.json`). */
export interface Place {
  id: string;
  name: string | null;
  kind: PlaceKind;
  location: { lat: number; lon: number };
  osm: { type: "node" | "way" | "relation"; id: number; version: number } | null;
  facts: PlaceFacts;
  status: PlaceStatus;
  rating: { count: number; mean: number } | null;
  /** Where each fact, the name and the location came from. */
  fact_sources: Partial<Record<FactName | "name" | "location", "osm" | "feedback">>;
  updated: string;
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
