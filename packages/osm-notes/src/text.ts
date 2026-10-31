import { describe, osmTag } from "./tags.js";
import type { Note, NoteChange } from "./types.js";

/**
 * Note text. Plain, short and in Australian English. It names the source, what
 * travellers or the owner report, how many independent reports and when, the
 * OSM object and the place file, and never anyone's identity or device.
 */

export const DATA_REPO_URL = "https://github.com/opencampingdb/data";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function parts(day: string): { d: number; m: string; y: string } {
  const [y, m, d] = day.split("-");
  return { d: Number(d), m: MONTHS[Number(m) - 1] ?? "", y: y ?? "" };
}

/** `2 to 20 October 2026`, `28 September to 3 October 2026` or `20 October 2026`. */
export function dayRange(from: string, to: string): string {
  const a = parts(from);
  const b = parts(to);
  if (from === to) return `${b.d} ${b.m} ${b.y}`;
  if (a.y !== b.y) return `${a.d} ${a.m} ${a.y} to ${b.d} ${b.m} ${b.y}`;
  if (a.m !== b.m) return `${a.d} ${a.m} to ${b.d} ${b.m} ${b.y}`;
  return `${a.d} to ${b.d} ${b.m} ${b.y}`;
}

/** Keeps a value from the data on one line and short. */
function clean(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat;
}

function what(change: NoteChange): string {
  if (change.field === "status") {
    return "the place has closed permanently (OSM has no single tag for this, a lifecycle prefix such as disused: is common)";
  }
  const value = typeof change.value === "string" ? clean(change.value) : change.value;
  const tag = osmTag(change.field, value);
  const words = describe(change.field, value);
  return tag ? `${words} (${tag})` : words;
}

function changeLine(change: NoteChange): string {
  const who = change.source === "owner" ? "The owner reports" : "Travellers report";
  let line = `- ${who} ${what(change)}.`;
  if (change.reports && change.from && change.to) {
    const reports = change.reports === 1 ? "1 report" : `${change.reports} independent reports`;
    line += ` ${reports}, ${dayRange(change.from, change.to)}.`;
  }
  return line;
}

export function placeUrl(note: Pick<Note, "path">): string {
  return `${DATA_REPO_URL}/blob/main/${note.path}`;
}

/** The text posted to OSM. */
export function noteText(note: Note): string {
  const object = `${note.osm.type}/${note.osm.id}`;
  const name = note.name ? ` (${clean(note.name)})` : "";
  return [
    `Open Camping DB, an open list of places to camp and stop in Australia, has accepted a change to ${object}${name}:`,
    "",
    ...note.changes.map(changeLine),
    "",
    `Open Camping DB record: ${placeUrl(note)}`,
    "",
    "Please check before editing. Open Camping DB does not edit OpenStreetMap itself.",
  ].join("\n");
}
