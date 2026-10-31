import { basename } from "node:path";
import { mayNote, noteChanges } from "./changes.js";
import { readApplied, withEvidence } from "./evidence.js";
import { changedPlaceFiles, hasCommit, headCommit, readBlobs } from "./git.js";
import { postNote, shouldStop, type FetchLike } from "./osm.js";
import { appendSent, readCursor, readSent, writeCursor } from "./state.js";
import { noteText } from "./text.js";
import type { AppliedItem, Note, Place, SentEntry } from "./types.js";

export interface RunOptions {
  /** Checkout of the data repository with full history, at the commit to process up to. */
  data: string;
  /** File holding the data commit last processed (`inbox/osm/cursor`). */
  cursorFile: string;
  /** The sent log (`inbox/osm/sent.ndjson`). */
  sentFile: string;
  /** Inbox checkout, to count the reports behind each change. Optional. */
  inbox?: string;
  /** OSM OAuth 2.0 token with `write_notes`. Without it the run is a dry run. */
  token?: string;
  fetch?: FetchLike;
  apiUrl?: string;
  now?: Date;
  /** Most notes posted in one run. Default 10. */
  maxNotes?: number;
  /** Days after a note before the same place gets another. Default 30. */
  quietDays?: number;
  /** Wait between posts, in milliseconds. Default 2000. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type RunMode = "first_run" | "up_to_date" | "dry_run" | "posted";

export interface RunResult {
  mode: RunMode;
  head: string;
  /** Cursor at the start of the run. */
  cursor: string | undefined;
  /** Notes chosen for this run (posted, or that would be posted in a dry run). */
  notes: Note[];
  posted: { note: Note; id: number }[];
  failed: { note: Note; status: number; detail: string }[];
  skipped: { place: string; reason: string }[];
  /** Notes left for a later run: over the limit, or the place had a note in the quiet period. */
  held: number;
  /** Why the run stopped early, if it did. */
  stopped?: string;
  /** The token was refused: the job should fail. */
  authFailed: boolean;
  /** The cursor or the sent log changed and must be committed. */
  stateChanged: boolean;
  summary: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PLACE_FILE = /^(ocdb_[0-9A-HJKMNP-TV-Z]{26})\.json$/;

function placeId(path: string): string | undefined {
  return PLACE_FILE.exec(basename(path))?.[1];
}

function parsePlace(text: string | undefined): Place | undefined {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Place;
  } catch {
    return undefined;
  }
}

/** Every place whose file changed between the two commits: its version before and after. */
async function changedPlaces(
  data: string,
  from: string,
  to: string,
): Promise<Map<string, { before?: Place; after?: Place; path?: string }>> {
  const files = (await changedPlaceFiles(data, from, to)).filter((f) => placeId(f.path));
  const blobs = await readBlobs(
    data,
    files.flatMap((f) => [f.before, f.after].filter((b): b is string => b !== undefined)),
  );
  const out = new Map<string, { before?: Place; after?: Place; path?: string }>();
  for (const file of files) {
    const id = placeId(file.path)!;
    const entry = out.get(id) ?? {};
    const before = parsePlace(file.before && blobs.get(file.before));
    if (before) entry.before = before;
    const after = parsePlace(file.after && blobs.get(file.after));
    if (after) {
      entry.after = after;
      entry.path = file.path;
    }
    out.set(id, entry);
  }
  return out;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Builds the notes for the changes between `from` and `to`, after the sent log rules. */
async function buildNotes(
  options: RunOptions,
  from: string,
  to: string,
  sent: readonly SentEntry[],
  now: Date,
): Promise<{ notes: Note[]; skipped: RunResult["skipped"]; quiet: RunResult["skipped"] }> {
  const quietMs = (options.quietDays ?? 30) * DAY_MS;
  const applied: Map<string, AppliedItem[]> = options.inbox ? await readApplied(options.inbox) : new Map();
  const notes: Note[] = [];
  const skipped: RunResult["skipped"] = [];
  const quiet: RunResult["skipped"] = [];

  const changed = await changedPlaces(options.data, from, to);
  for (const id of [...changed.keys()].sort()) {
    const { before, after, path } = changed.get(id)!;
    if (!after || !path || !before || !mayNote(before, after) || !after.osm) continue;
    const found = noteChanges(before, after);
    if (found.length === 0) continue;

    const mine = sent.filter((s) => s.place === id);
    const fresh = found.filter((c) => !mine.some((s) => s.field === c.field && sameValue(s.value, c.value)));
    if (fresh.length === 0) {
      skipped.push({ place: id, reason: "already sent" });
      continue;
    }
    if (mine.some((s) => now.getTime() - Date.parse(s.sent) < quietMs)) {
      quiet.push({ place: id, reason: `had a note in the last ${options.quietDays ?? 30} days, waits for a later run` });
      continue;
    }
    notes.push({
      place: id,
      name: after.name,
      osm: { type: after.osm.type, id: after.osm.id },
      lat: after.location.lat,
      lon: after.location.lon,
      path,
      changes: fresh.map((c) => withEvidence(c, applied.get(id) ?? [], now)),
    });
  }
  return { notes, skipped, quiet };
}

function summaryMarkdown(result: Omit<RunResult, "summary">): string {
  const lines = ["## OSM notes", ""];
  const range = result.cursor ? `\`${result.cursor.slice(0, 12)}\` to \`${result.head.slice(0, 12)}\`` : "";
  if (result.mode === "first_run") {
    lines.push(`First run: the cursor is set to data \`${result.head.slice(0, 12)}\` and nothing was sent.`);
  } else if (result.mode === "up_to_date") {
    lines.push(`Nothing new on data since \`${result.head.slice(0, 12)}\`.`);
  } else if (result.mode === "dry_run") {
    lines.push(
      `Dry run (no OSM token), data ${range}. Nothing was posted and the cursor and sent log are unchanged. ` +
        `${result.notes.length} note(s) would be sent:`,
    );
  } else {
    lines.push(`Data ${range}: posted ${result.posted.length} note(s), ${result.failed.length} refused by OSM.`);
  }
  if (result.held > 0) lines.push("", `${result.held} more note(s) wait for a later run, so the cursor stays where it is.`);
  if (result.stopped) lines.push("", `Stopped early: ${result.stopped}. The cursor was not moved, so the rest is tried next run.`);
  for (const f of result.failed) lines.push("", `- OSM refused the note for \`${f.note.place}\` (HTTP ${f.status}): ${f.detail}`);
  if (result.skipped.length > 0) {
    lines.push("", "Skipped:", "", ...result.skipped.map((s) => `- \`${s.place}\`: ${s.reason}`));
  }
  const shown = result.mode === "dry_run" ? result.notes : result.posted.map((p) => p.note);
  for (const note of shown) {
    const id = result.posted.find((p) => p.note === note)?.id;
    const heading = id ? `[note ${id}](https://www.openstreetmap.org/note/${id})` : "Would post";
    lines.push(
      "",
      `### ${heading}: ${note.osm.type}/${note.osm.id} at ${note.lat}, ${note.lon}`,
      "",
      "```text",
      noteText(note),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

function finish(result: Omit<RunResult, "summary">): RunResult {
  return { ...result, summary: summaryMarkdown(result) };
}

/**
 * One run: diff the data place files from the cursor to the checked out
 * commit, build at most one note per place, and post up to `maxNotes`.
 *
 * The cursor moves to the data commit only when every note was dealt with.
 * When the limit holds notes back, or OSM asks us to stop, it stays put and
 * the next run diffs the same range again. The sent log keeps that from
 * posting anything twice.
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const now = options.now ?? new Date();
  const maxNotes = options.maxNotes ?? 10;
  const head = await headCommit(options.data);
  const cursor = await readCursor(options.cursorFile);
  const base = {
    head,
    cursor,
    notes: [] as Note[],
    posted: [] as RunResult["posted"],
    failed: [] as RunResult["failed"],
    skipped: [] as RunResult["skipped"],
    held: 0,
    authFailed: false,
  };

  if (!cursor) {
    // No backlog: start from today's data.
    await writeCursor(options.cursorFile, head);
    return finish({ ...base, mode: "first_run", stateChanged: true });
  }
  if (cursor === head) return finish({ ...base, mode: "up_to_date", stateChanged: false });
  if (!(await hasCommit(options.data, cursor))) {
    throw new Error(`cursor ${cursor} is not a commit in ${options.data}: check data out with full history`);
  }

  const sent = await readSent(options.sentFile);
  const { notes: all, skipped, quiet } = await buildNotes(options, cursor, head, sent, now);
  const notes = all.slice(0, maxNotes);
  const held = all.length - notes.length + quiet.length;
  skipped.push(...quiet);

  if (!options.token) {
    return finish({ ...base, mode: "dry_run", notes, skipped, held, stateChanged: false });
  }

  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const posted: RunResult["posted"] = [];
  const failed: RunResult["failed"] = [];
  let stopped: string | undefined;
  let authFailed = false;

  for (const [i, note] of notes.entries()) {
    if (i > 0) await sleep(options.pauseMs ?? 2000);
    const result = await postNote(fetchFn, options.token, { lat: note.lat, lon: note.lon, text: noteText(note) }, options.apiUrl);
    if (result.ok) {
      posted.push({ note, id: result.id });
      // Written note by note, so a crash later in the run never leads to a resend.
      await appendSent(
        options.sentFile,
        note.changes.map((c) => ({ place: note.place, field: c.field, value: c.value, note: result.id, sent: now.toISOString() })),
      );
      continue;
    }
    if (shouldStop(result.status)) {
      stopped = `OSM answered HTTP ${result.status}`;
      break;
    }
    if (result.status === 401 || result.status === 403) {
      stopped = `OSM refused the token (HTTP ${result.status})`;
      authFailed = true;
      break;
    }
    failed.push({ note, status: result.status, detail: result.detail });
  }

  const advance = !stopped && held === 0;
  if (advance) await writeCursor(options.cursorFile, head);
  return finish({
    ...base,
    mode: "posted",
    notes,
    posted,
    failed,
    skipped,
    held,
    ...(stopped ? { stopped } : {}),
    authFailed,
    stateChanged: advance || posted.length > 0,
  });
}
