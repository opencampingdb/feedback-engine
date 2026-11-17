import { buildingFootprints, carriageways, landMask, type PlaceGeometry } from "@opencampingdb/apply/plausible";

/**
 * The geometry for the plausibility check on a new place at send time, read
 * from tiles in an R2 bucket (`PLACE_GEOMETRY`). The data repository cuts its
 * land mask, building footprints and major roads into tiles and uploads them,
 * so the intake reads one small file of each layer per new place and never
 * holds a whole country:
 *
 *   water/<row>/<col>.ndjson      sea and lake lines, tiles of 0.1 degree
 *   roads/<row>/<col>.ndjson      the geometry sidecar's road lines, tiles of 0.1 degree
 *   buildings/<row>/<col>.ndjson  building lines, tiles of 0.01 degree
 *
 * `row` is floor(lat * n) and `col` floor(lon * n), with n 10 for a 0.1
 * degree tile and 100 for a 0.01 degree tile, worked in double precision. A
 * tile holds every line whose shape comes within `TILE_MARGIN_M` of it, so a
 * point near a tile's edge finds the shore, road or building just over it. A
 * missing tile means nothing of that layer is there, and the check passes.
 */

export type GeometryLayer = "water" | "roads" | "buildings";

/** Tiles per degree, by layer. */
export const TILES_PER_DEGREE: Record<GeometryLayer, number> = { water: 10, roads: 10, buildings: 100 };
/** A tile holds every line whose shape comes this close to it. */
export const TILE_MARGIN_M = 100;
/** A tile larger than this is not read, and that layer passes: the data repository has to cut it smaller. */
export const MAX_TILE_BYTES = 4 * 1024 * 1024;

/** The part of an R2 binding the check reads. */
export interface GeometryBucket {
  get?(key: string): Promise<{ body: ReadableStream; size: number } | null>;
}

const METRES_PER_DEGREE_LAT = 110_574;

/**
 * The keys of every tile of `layer` that holds a shape with these bounds:
 * the tiles the bounds, grown by `TILE_MARGIN_M`, touch. The data repository
 * cuts its tiles by the same rule.
 */
export function tileKeys(layer: GeometryLayer, bounds: { minLat: number; minLon: number; maxLat: number; maxLon: number }): string[] {
  const n = TILES_PER_DEGREE[layer];
  const dLat = TILE_MARGIN_M / METRES_PER_DEGREE_LAT;
  const widest = Math.max(Math.abs(bounds.minLat), Math.abs(bounds.maxLat)) + dLat;
  const dLon = TILE_MARGIN_M / (111_320 * Math.cos((Math.min(widest, 89) * Math.PI) / 180));
  const keys: string[] = [];
  for (let row = Math.floor((bounds.minLat - dLat) * n); row <= Math.floor((bounds.maxLat + dLat) * n); row++) {
    for (let col = Math.floor((bounds.minLon - dLon) * n); col <= Math.floor((bounds.maxLon + dLon) * n); col++) keys.push(tileKey(layer, row, col));
  }
  return keys;
}

const tileKey = (layer: GeometryLayer, row: number, col: number) => `${layer}/${row}/${col}.ndjson`;

/** The key of the tile of `layer` that holds the point. */
export const tileAt = (layer: GeometryLayer, p: { lat: number; lon: number }) =>
  tileKey(layer, Math.floor(p.lat * TILES_PER_DEGREE[layer]), Math.floor(p.lon * TILES_PER_DEGREE[layer]));

/** The geometry could not be read. The item is held for the apply, which checks it with its own copy. */
export class GeometryUnavailable extends Error {}

/** One tile's lines: none when the tile is missing, null when it is too large to read. */
async function tileLines(bucket: GeometryBucket, key: string): Promise<string[] | null> {
  let object: { body: ReadableStream; size: number } | null;
  try {
    object = (await bucket.get!(key)) ?? null;
  } catch (error) {
    throw new GeometryUnavailable(`${key}: ${String(error)}`);
  }
  if (object === null) return [];
  if (object.size > MAX_TILE_BYTES) {
    await object.body.cancel().catch(() => {});
    console.warn(`place geometry tile ${key} is ${object.size} bytes, over ${MAX_TILE_BYTES}, so it is not checked`);
    return null;
  }
  try {
    return (await new Response(object.body).text()).split("\n");
  } catch (error) {
    throw new GeometryUnavailable(`${key}: ${String(error)}`);
  }
}

/**
 * The geometry around `p`, from one tile of each layer. Without a bucket it
 * is undefined, so the check passes, and that is logged. Throws
 * `GeometryUnavailable` when a tile cannot be read.
 */
export async function geometryAt(bucket: GeometryBucket | undefined, p: { lat: number; lon: number }): Promise<PlaceGeometry | undefined> {
  if (bucket?.get === undefined) {
    console.warn("no PLACE_GEOMETRY binding, so new places are not checked for plausible locations");
    return undefined;
  }
  const [water, roads, buildings] = await Promise.all((["water", "roads", "buildings"] as const).map((layer) => tileLines(bucket, tileAt(layer, p))));
  return {
    ...(water ? { water: landMask(water) } : {}),
    ...(roads ? { roads: carriageways(roads) } : {}),
    ...(buildings ? { buildings: buildingFootprints(buildings) } : {}),
  };
}
