import type { FactName, FactSource, PhotoVoteValue, PlaceFacts, PlaceGroup, PlaceKind } from "@opencampingdb/feedback";

/** `merged` marks a tombstone: the record was merged into `merged_into` by a person. */
export type PlaceStatus = "open" | "reported_closed" | "closed" | "temporarily_closed" | "merged";

/**
 * Where a value in a place record came from, as the SDK lists them. `rule`:
 * set by a rule in the data release (named in its `fact_rules`), so it is in
 * the release and the place index but never in `places/`. `overture`: an
 * Overture Maps gap fill, which has none of the protection an `osm` or
 * `owner` value has: doubts and contact reports take it down, and a
 * traveller's report replaces it.
 */
export type Source = FactSource;

/** Keys of `fact_sources` and `fact_dates`: every fact, plus the name, location, kind, status and description. */
export type SourceKey = FactName | "name" | "location" | "kind" | "status" | "description";

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
   * `fact_sources` entry that is not `osm` or `rule`.
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
  /**
   * Only on a place a traveller added: where it stands, from the SDK's
   * `newPlaceStanding`. `shown` is not checked yet, `confirmed` has been
   * checked by travellers near it, `held` waits for a person (a possible
   * duplicate) and `hidden` is left out of releases and apps.
   */
  standing?: "shown" | "confirmed" | "held" | "hidden";
  /**
   * Only on a place a traveller added: a person's latest decision on it,
   * written on the review PR or in the data. `restore` sets aside reports up
   * to `at` and `hide` keeps it hidden. `at` is a UTC time or `YYYY-MM-DD`.
   */
  moderator?: { action: "restore" | "hide"; at: string };
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
  /** Opaque id of the account or attested install that wrote it, `ctr_` and 16 hex characters. */
  contributor: string;
  /** The app saw the phone near the place in the 60 days before the review. */
  visited_nearby?: true;
  /**
   * Left out of the release and the rating. `reported`: three contributors
   * reported it and a person has not decided. `moderator`: a person hid it.
   */
  hidden?: "reported" | "moderator";
}

/**
 * One line of `photos/<place id>.ndjson`: a traveller's photo of a place. The
 * files are served as `<id>/full.jpg` and `<id>/thumb.jpg`.
 */
export interface Photo {
  /** `pho_` and the ulid of the feedback item. */
  id: string;
  place: string;
  /** Opaque id of the account that took it, `ctr_` and 16 hex characters. */
  contributor: string;
  created: string;
  app: string;
  /** Licence id the photo service sets, for example `CC-BY-4.0`. */
  licence: string;
  /** Pixel size of the full size file. */
  width: number;
  height: number;
  /** Point of interest the sending app worked out, each value 0 to 1 from the top left. Absent when it sent none. */
  focus?: { x: number; y: number };
  /** The traveller's caption, tidied, when it passed the text checks a review gets. Absent otherwise. */
  caption?: string;
  /** The month the photo was taken, `YYYY-MM`, from its Exif. Absent when the app sent none. */
  taken?: string;
  /** Travellers who marked the photo helpful. Absent when none have. */
  helpful?: number;
  /** Of those, the ones who marked it in the last 12 months, for a sort that favours recent votes. Absent when none. */
  helpful_12m?: number;
  /** Travellers who marked the photo not helpful. Absent when none have. */
  not_helpful?: number;
  /** Of those, the ones who marked it in the last 12 months. Absent when none. */
  not_helpful_12m?: number;
  /** SHA-256 of the full size file, lower case hex, to spot one photo sent for several places. */
  sha256: string;
  /** Left out of the release and not served. As for reviews. */
  hidden?: "reported" | "moderator";
}

/**
 * One traveller's vote on a photo, as the apply run keeps it in the private
 * inbox. Every id it was sent with is kept, so a later vote from the same
 * contributor, install or attested key replaces it.
 */
export interface PhotoVote {
  /** The feedback id of the vote. */
  feedback: string;
  /** When the intake received it, ISO 8601 UTC. */
  at: string;
  /** The vote. `none` is a take-back, kept so an older vote run again can't undo it. Absent on older entries: see `helpful`. */
  vote?: PhotoVoteValue;
  /** Older entries only, before `vote`: false is a take-back (`none`), true or absent is `helpful`. */
  helpful?: boolean;
  contributor: string;
  device: string;
  attest_key?: string;
}

/**
 * `votes/photos.json` in the inbox: each source's latest vote or take-back,
 * by photo id.
 */
export interface PhotoVotes {
  photos: Record<string, PhotoVote[]>;
}

/**
 * `moderation/removed_photos.json` in the data repository: photos whose files
 * are deleted from both buckets. A removed id never comes back.
 */
export interface RemovedPhotos {
  /** `removed`: the photo's own contributor asked for this one photo to be removed. */
  photos: { photo: string; removed: string; reason: "refused" | "erased" | "removed" | "moderator" }[];
}

/** `moderation/blocked_contributors.json` in the data repository. */
export interface BlockedList {
  contributors: { contributor: string; added: string; reason: string }[];
}
