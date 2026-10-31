import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AppliedItem, NoteChange } from "./types.js";

/**
 * Counts the independent reports behind a change from the items the apply
 * workflow accepted (`inbox/applied/<yyyy-mm-dd>/fb_*.json`). Only the number
 * of different devices and the first and last day are used. Device hashes,
 * app names and notes never leave this module.
 */

const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_FILE = /^fb_[0-9A-HJKMNP-TV-Z]{26}\.json$/;
/** Reports older than this before the newest one did not decide the change. */
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Accepted items, by place id. */
export async function readApplied(inbox: string): Promise<Map<string, AppliedItem[]>> {
  const root = join(inbox, "applied");
  const byPlace = new Map<string, AppliedItem[]>();
  if (!(await isDir(root))) return byPlace;
  for (const day of (await readdir(root)).sort()) {
    if (!DAY_FOLDER.test(day) || !(await isDir(join(root, day)))) continue;
    for (const name of (await readdir(join(root, day))).sort()) {
      if (!ITEM_FILE.test(name)) continue;
      const item = JSON.parse(await readFile(join(root, day, name), "utf8")) as AppliedItem;
      if (!item.place || (item.outcome && item.outcome.result !== "applied")) continue;
      byPlace.set(item.place, [...(byPlace.get(item.place) ?? []), item]);
    }
  }
  return byPlace;
}

function supports(item: AppliedItem, change: NoteChange): boolean {
  if (change.field === "status") {
    return (
      (item.type === "report" && item.report?.kind === "closed") ||
      (item.type === "check" && item.check?.still_there === false)
    );
  }
  return (
    item.type === "report" &&
    item.report?.kind === "fact" &&
    item.report.fact === change.field &&
    item.report.value === change.value
  );
}

/** Adds the report count and date range to a traveller change when the inbox shows them. */
export function withEvidence(change: NoteChange, items: readonly AppliedItem[], now: Date): NoteChange {
  if (change.source !== "feedback") return change;
  const matching = items
    .filter((i) => supports(i, change) && Date.parse(i.received) <= now.getTime())
    .sort((a, b) => Date.parse(a.received) - Date.parse(b.received));
  const newest = matching.at(-1);
  if (!newest) return change;
  const recent = matching.filter((i) => Date.parse(newest.received) - Date.parse(i.received) <= WINDOW_MS);
  return {
    ...change,
    reports: new Set(recent.map((i) => i.device)).size,
    from: recent[0]!.received.slice(0, 10),
    to: newest.received.slice(0, 10),
  };
}
