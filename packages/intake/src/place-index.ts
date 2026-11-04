import { isPlaceId } from "@opencampingdb/feedback";
import type { Bbox, D1Like, D1Statement } from "./recent.js";

/**
 * The place index: each released place's facts and who set each one, keyed by
 * place id and filed under its whole-degree map cell. Each data release loads
 * it through `PUT /v1/place-index`, sending only the cells whose hash differs
 * from the one the intake holds (`GET /v1/place-index/cells`), so a release
 * that changes a few places writes a few cells, not every place.
 */

/** A whole-degree map cell: the floor of the longitude, then of the latitude. */
export type Cell = [number, number];

/** A place as the index holds it. */
export interface IndexedPlace {
  id: string;
  cell: Cell;
  facts: Record<string, unknown>;
  /** Where each value came from (osm, feedback, contributed or owner), as in the place record. */
  fact_sources: Record<string, string>;
  /** When each value that did not come from OSM was accepted. Empty when there are none. */
  fact_dates: Record<string, string>;
}

/** A cell the release replaces, with the hash of its lines, or null when the cell no longer holds a place. */
export interface CellUpdate {
  cell: Cell;
  hash: string | null;
}

/** One `PUT /v1/place-index` call, checked. */
export interface PlaceIndexUpdate {
  cells: CellUpdate[];
  /** The place lines, each a JSON array of at most CHUNK_CHARS characters for one insert. */
  chunks: string[];
  places: number;
}

/** Most bytes one call may carry, before and after gzip. */
export const MAX_PLACE_INDEX_BYTES = 4 * 1024 * 1024;
/** Most cells one call may replace. */
export const MAX_PLACE_INDEX_CELLS = 2000;
/** Characters of place lines bound to one insert, well inside the 2 MB D1 allows for one value. */
const CHUNK_CHARS = 900_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((v) => typeof v === "string");
const isCell = (value: unknown): value is Cell =>
  Array.isArray(value) &&
  value.length === 2 &&
  Number.isInteger(value[0]) &&
  Number.isInteger(value[1]) &&
  (value[0] as number) >= -180 &&
  (value[0] as number) <= 179 &&
  (value[1] as number) >= -90 &&
  (value[1] as number) <= 89;
const cellKey = ([lon, lat]: Cell) => `${lon},${lat}`;

/**
 * Reads a call's body: NDJSON, gzipped or not. The first line is
 * `{"cells": [{"cell": [lon, lat], "hash": "<sha256 hex>" | null}, ...]}`, the
 * cells the call replaces. Every other line is a place in one of those cells
 * with a hash: `{"id", "cell", "facts", "fact_sources", "fact_dates"}`, as in
 * the release's place-index.ndjson.gz. The problems, when the body is not that.
 */
export function parsePlaceIndex(text: string): PlaceIndexUpdate | { problems: string[] } {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const parse = (line: string): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  };
  const head = lines.length > 0 ? parse(lines[0]!) : undefined;
  const declared = isObject(head) ? head.cells : undefined;
  const isUpdate = (c: unknown): c is CellUpdate =>
    isObject(c) && isCell(c.cell) && (c.hash === null || (typeof c.hash === "string" && /^[0-9a-f]{64}$/.test(c.hash)));
  if (!Array.isArray(declared) || declared.length === 0 || declared.length > MAX_PLACE_INDEX_CELLS || !declared.every(isUpdate)) {
    return { problems: [`the first line must be {"cells": [...]}, 1 to ${MAX_PLACE_INDEX_CELLS} cells, each {"cell": [lon, lat], "hash": <sha256 hex or null>}`] };
  }
  const filled = new Set<string>();
  const named = new Set<string>();
  for (const { cell, hash } of declared) {
    const key = cellKey(cell);
    if (named.has(key)) return { problems: [`cell ${key} is named twice`] };
    named.add(key);
    if (hash !== null) filled.add(key);
  }

  const ids = new Set<string>();
  const chunks: string[] = [];
  let chunk: string[] = [];
  let size = 0;
  for (let i = 1; i < lines.length; i++) {
    const place = parse(lines[i]!);
    const where = `line ${i + 1}`;
    if (!isObject(place) || !isPlaceId(place.id)) return { problems: [`${where}: id must be an Open Camping DB id`] };
    if (!isCell(place.cell) || !filled.has(cellKey(place.cell))) return { problems: [`${where}: cell must be one the first line names with a hash`] };
    if (!isObject(place.facts) || !isStringMap(place.fact_sources) || !isStringMap(place.fact_dates)) {
      return { problems: [`${where}: facts, fact_sources and fact_dates must be objects`] };
    }
    if (ids.has(place.id)) return { problems: [`${where}: ${place.id} is listed twice`] };
    ids.add(place.id);
    const line = lines[i]!.trim();
    if (chunk.length > 0 && size + line.length + 1 > CHUNK_CHARS) {
      chunks.push(`[${chunk.join(",")}]`);
      chunk = [];
      size = 0;
    }
    chunk.push(line);
    size += line.length + 1;
  }
  if (chunk.length > 0) chunks.push(`[${chunk.join(",")}]`);
  return { cells: declared, chunks, places: ids.size };
}

const CELLS_JSON = (cells: CellUpdate[]) => JSON.stringify(cells.map(({ cell }) => cell));

/**
 * Replaces the named cells in one transaction: their places, then their
 * hashes. A place that moved to another cell is replaced where it now is,
 * whichever of its two cells arrives first.
 */
export async function replaceCells(db: D1Like, update: PlaceIndexUpdate): Promise<void> {
  const inCells = "(cell_lon, cell_lat) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))";
  const statements: D1Statement[] = [
    db.prepare(`DELETE FROM place_index WHERE ${inCells}`).bind(CELLS_JSON(update.cells)),
    ...update.chunks.map((chunk) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO place_index (id, cell_lon, cell_lat, facts, fact_sources, fact_dates)
           SELECT json_extract(value, '$.id'), json_extract(value, '$.cell[0]'), json_extract(value, '$.cell[1]'),
             json_extract(value, '$.facts'), json_extract(value, '$.fact_sources'), json_extract(value, '$.fact_dates')
           FROM json_each(?)`,
        )
        .bind(chunk),
    ),
    db.prepare(`DELETE FROM place_index_cells WHERE ${inCells}`).bind(CELLS_JSON(update.cells)),
    db
      .prepare(
        `INSERT INTO place_index_cells (cell_lon, cell_lat, hash)
         SELECT json_extract(value, '$.cell[0]'), json_extract(value, '$.cell[1]'), json_extract(value, '$.hash')
         FROM json_each(?) WHERE json_extract(value, '$.hash') IS NOT NULL`,
      )
      .bind(JSON.stringify(update.cells)),
  ];
  await db.batch(statements);
}

/** Every cell the index holds, with its hash, in cell order. */
export async function cellHashes(db: D1Like): Promise<{ cell: Cell; hash: string }[]> {
  const { results } = await db
    .prepare("SELECT cell_lon, cell_lat, hash FROM place_index_cells ORDER BY cell_lon, cell_lat")
    .all<{ cell_lon: number; cell_lat: number; hash: string }>();
  return results.map((row) => ({ cell: [row.cell_lon, row.cell_lat], hash: row.hash }));
}

interface IndexRow {
  id: string;
  cell_lon: number;
  cell_lat: number;
  facts: string;
  fact_sources: string;
  fact_dates: string;
}

const fromRow = (row: IndexRow): IndexedPlace => ({
  id: row.id,
  cell: [row.cell_lon, row.cell_lat],
  facts: JSON.parse(row.facts) as Record<string, unknown>,
  fact_sources: JSON.parse(row.fact_sources) as Record<string, string>,
  fact_dates: JSON.parse(row.fact_dates) as Record<string, string>,
});

/** A released place by id, or undefined when the index does not hold it. */
export async function getIndexedPlace(db: D1Like, id: string): Promise<IndexedPlace | undefined> {
  const row = await db.prepare("SELECT * FROM place_index WHERE id = ?").bind(id).first<IndexRow>();
  return row === null ? undefined : fromRow(row);
}

/**
 * Every released place in the whole-degree cells the box covers, in id order.
 * The index keeps cells, not locations, so this is the box grown out to whole
 * degrees, as the recent list serves it.
 */
export async function indexedPlacesInBbox(db: D1Like, [west, south, east, north]: Bbox): Promise<IndexedPlace[]> {
  // A box edge on a whole degree touches the next cell without covering any of it.
  const last = (low: number, high: number) => Math.max(Math.floor(low), Math.ceil(high) - 1);
  const { results } = await db
    .prepare("SELECT * FROM place_index WHERE cell_lon BETWEEN ? AND ? AND cell_lat BETWEEN ? AND ? ORDER BY id")
    .bind(Math.floor(west), last(west, east), Math.floor(south), last(south, north))
    .all<IndexRow>();
  return results.map(fromRow);
}

/**
 * The body as text, gunzipped when it starts with the gzip magic bytes.
 * "too_large" past `maxBytes` before or after gzip, "invalid" when it does not gunzip.
 */
export async function readIndexBody(request: Request, maxBytes: number): Promise<string | "too_large" | "invalid"> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return "too_large";
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > maxBytes) return "too_large";
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  try {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")).getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        return "too_large";
      }
      parts.push(value);
    }
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return parts.map((p) => decoder.decode(p, { stream: true })).join("") + decoder.decode();
  } catch {
    return "invalid";
  }
}
