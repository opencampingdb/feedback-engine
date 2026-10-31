import { findContactDetails, findContactDetailsInHours } from "@opencampingdb/feedback";
import { NEVER_SENT } from "./tags.js";
import type { NoteChange, Place } from "./types.js";

/**
 * Which changes between two versions of a place record may be passed to OSM.
 *
 * Only values that changed and whose source is now `feedback` or `owner`
 * count. Values from OSM (the nightly sync) are never echoed back, and
 * contributed values never leave Open Camping DB. Description, location,
 * booking details, ratings, temporary closures and reopening dates are
 * never sent, and nothing is sent for a place that is not in OSM or is a
 * merged tombstone. A text value holding an email address, phone number or
 * link is never sent, except a website or phone fact.
 */

/** Facts whose value is itself a contact detail. */
const CONTACT_FACTS: ReadonlySet<string> = new Set(["website", "phone"]);

function sendable(field: string, value: unknown): boolean {
  if (typeof value !== "string" || CONTACT_FACTS.has(field)) return true;
  return (field === "opening_hours" ? findContactDetailsInHours(value) : findContactDetails(value)).length === 0;
}

function sourceOf(place: Place, field: string): "feedback" | "owner" | undefined {
  const source = place.fact_sources?.[field];
  return source === "feedback" || source === "owner" ? source : undefined;
}

/** True for a record whose changes may become a note at all. */
export function mayNote(previous: Place | null, next: Place): boolean {
  if (!previous) return false; // a new record has no approved change to check
  if (!next.osm || !previous.osm) return false; // not in OSM, or contributed
  if (next.osm.type !== previous.osm.type || next.osm.id !== previous.osm.id) return false;
  if (next.status === "merged" || previous.status === "merged" || next.merged_into) return false;
  return true;
}

/** The changes in `next` that a note may ask OSM mappers to check. */
export function noteChanges(previous: Place | null, next: Place): NoteChange[] {
  if (!previous || !mayNote(previous, next)) return [];
  const out: NoteChange[] = [];

  const facts = Object.keys(next.facts ?? {}).sort();
  for (const fact of facts) {
    if (NEVER_SENT.has(fact)) continue;
    const value = next.facts[fact];
    if (value === undefined) continue;
    if (fact === "access" && value === "unknown") continue;
    const before = previous.facts?.[fact];
    if (before === value) continue;
    const source = sourceOf(next, fact);
    if (!source || !sendable(fact, value)) continue;
    out.push({ field: fact, value, previous: before ?? null, source });
  }

  if (next.name && next.name !== previous.name) {
    const source = sourceOf(next, "name");
    if (source && sendable("name", next.name)) out.push({ field: "name", value: next.name, previous: previous.name, source });
  }

  // Only a permanent closure. OSM does not map temporary closures.
  if (next.status === "closed" && previous.status !== "closed") {
    const source = sourceOf(next, "status");
    if (source) out.push({ field: "status", value: "closed", previous: previous.status, source });
  }

  return out;
}
