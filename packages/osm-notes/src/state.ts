import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SentEntry } from "./types.js";

/**
 * Run state, kept in the private inbox: `osm/cursor` holds the last data
 * commit processed and `osm/sent.ndjson` one line per field of every note
 * posted. Neither holds anything about the people who reported.
 */

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The data commit last processed, or undefined on the first run. */
export async function readCursor(path: string): Promise<string | undefined> {
  const text = (await readText(path))?.trim();
  return text ? text : undefined;
}

export async function writeCursor(path: string, commit: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${commit}\n`, "utf8");
}

export async function readSent(path: string): Promise<SentEntry[]> {
  const text = await readText(path);
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SentEntry);
}

export async function appendSent(path: string, entries: readonly SentEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  const lines = entries.map((e) =>
    JSON.stringify({ field: e.field, note: e.note, place: e.place, sent: e.sent, value: e.value }),
  );
  await appendFile(path, `${lines.join("\n")}\n`, "utf8");
}
