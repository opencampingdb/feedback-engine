/**
 * Whether a new place's location is plausible: not in the sea or a lake, not
 * on a major road's carriageway and not inside a building footprint. Pure
 * functions with no Node APIs, so the intake's Worker uses them too.
 * Remoteness is never a reason: a point with no geometry near it passes.
 *
 * The geometry comes from the data repository as JSON lines (one object per
 * line, coordinates as [lon, lat]), the format docs/self-hosting.md
 * describes:
 *
 *   {"water": "sea" | "lake", "name": "...", "polygons": [[[[lon, lat], ...], ...], ...]}
 *   {"building": "way/123", "polygons": [[[[lon, lat], ...], ...], ...]}
 *   {"road": 123, "highway": "trunk", "name": "...", "ref": "...", "coords": [[lon, lat], ...]}
 *
 * Each polygon is an outer ring followed by its holes, as the geometry
 * sidecar writes an area. Road lines are the sidecar's own. Lines of any
 * other kind, and lines that don't parse, are skipped.
 */

import { distanceM, type LatLon, type RoadCrossed } from "./roads.js";

export type WaterKind = "sea" | "lake";

/** The water a point is in. */
export interface WaterHit {
  water: WaterKind;
  name?: string;
}

/** Sea and lakes. */
export interface LandMask {
  /** The water `p` is in, at least `WATER_EDGE_M` from its shore, or null when it is on land or near the shore. */
  waterAt(p: LatLon): WaterHit | null;
}

/** Building footprints. */
export interface Buildings {
  /** The OSM id of the building whose footprint holds `p`, or null. */
  at(p: LatLon): string | null;
}

/** The carriageways of major roads, from the geometry sidecar's road lines. */
export interface Carriageways {
  /** The major road whose centre line is within `ROAD_BUFFER_M` of `p`, or null. */
  at(p: LatLon): RoadCrossed | null;
}

/** The geometry a plausibility check reads. A layer left out is not checked, and the check passes. */
export interface PlaceGeometry {
  water?: LandMask;
  buildings?: Buildings;
  roads?: Carriageways;
}

/** What a new place hit: water, a road's carriageway or a building, or `intake` when only the intake's answer says so. */
export type ImplausibleHit = "water" | "road" | "building" | "intake";

/** Why a location is implausible, in the engine's own words. */
export interface Implausible {
  hit: ImplausibleHit;
  problem: string;
}

/** A point in water closer than this to the shore passes: a beach camp, or a pin a few metres out. */
export const WATER_EDGE_M = 25;
/** A point this close to a major road's centre line is on its carriageway. */
export const ROAD_BUFFER_M = 6;

/** Kinds that are in the water by nature, so water never holds them. */
export const IN_WATER_KINDS: readonly string[] = ["boat_ramp", "swimming_spot", "ferry_terminal"];
/**
 * Kinds that are open ground, the only ones a building footprint holds. Every
 * other kind may be a building, or is often pinned on its office.
 */
export const OPEN_GROUND_KINDS: readonly string[] = [
  "free_camp",
  "national_park_campsite",
  "state_forest_campsite",
  "reserve_campsite",
  "rest_area",
  "dump_point",
  "drinking_water_point",
  "picnic_site",
  "long_vehicle_parking",
  "lookout",
  "swimming_spot",
  "boat_ramp",
  "recreation_area",
];

/** The layers `geometry` lacks, by the name the logs give them. */
export function missingLayers(geometry: PlaceGeometry | undefined): string[] {
  const out: string[] = [];
  if (!geometry?.water) out.push("land mask");
  if (!geometry?.roads) out.push("major roads");
  if (!geometry?.buildings) out.push("building footprints");
  return out;
}

/**
 * Why a new place of kind `kind` (its `place_kind`, when it has one) at `p`
 * is implausible, or null when it is plausible or the geometry to tell is
 * missing.
 */
export function implausibleLocation(p: LatLon, kind: string | undefined, geometry: PlaceGeometry | undefined): Implausible | null {
  if (!geometry) return null;
  if (kind === undefined || !IN_WATER_KINDS.includes(kind)) {
    const water = geometry.water?.waterAt(p);
    if (water) return { hit: "water", problem: water.water === "sea" ? "in the sea" : water.name ? `in ${water.name}` : "in a lake" };
  }
  const road = geometry.roads?.at(p);
  if (road) {
    const label = road.name ?? road.ref;
    return { hit: "road", problem: label ? `on the carriageway of ${label} (${road.highway})` : `on the carriageway of a ${road.highway} road` };
  }
  if (kind !== undefined && OPEN_GROUND_KINDS.includes(kind)) {
    const building = geometry.buildings?.at(p);
    if (building !== null && building !== undefined) return { hit: "building", problem: `inside a building (${building})` };
  }
  return null;
}

type Point = [number, number];
type Ring = Point[];
interface Shape<T> {
  rings: Ring[];
  value: T;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Grid cell, in degrees, for polygons. The data repository cuts the sea into pieces no larger than this. */
const POLYGON_CELL = 0.1;
/** Grid cell, in degrees, for road segments, as roads.ts grids them. */
const ROAD_CELL = 0.01;
const cellKey = (row: number, col: number) => `${row},${col}`;

function* cells(minX: number, minY: number, maxX: number, maxY: number, size: number): Generator<string> {
  for (let row = Math.floor(minY / size); row <= Math.floor(maxY / size); row++) {
    for (let col = Math.floor(minX / size); col <= Math.floor(maxX / size); col++) yield cellKey(row, col);
  }
}

const isPoint = (c: unknown): c is Point => Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number";

/** The rings of each polygon in a `polygons` field, skipping any that are not rings. */
function polygonsOf(value: unknown): Ring[][] {
  if (!Array.isArray(value)) return [];
  const out: Ring[][] = [];
  for (const polygon of value) {
    if (!Array.isArray(polygon)) continue;
    const rings = polygon.filter((r): r is unknown[] => Array.isArray(r)).map((r) => r.filter(isPoint)).filter((r) => r.length >= 3);
    if (rings.length > 0) out.push(rings);
  }
  return out;
}

function parse(line: string, key: string): Record<string, unknown> | null {
  if (!line.startsWith('{"') || !line.includes(`"${key}"`)) return null;
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null && !Array.isArray(value) && key in value ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Polygons gridded by the cells their bounds touch. */
class PolygonGrid<T> {
  private readonly grid = new Map<string, Shape<T>[]>();

  add(rings: Ring[], value: T): void {
    const outer = rings[0]!;
    const xs = outer.map((c) => c[0]);
    const ys = outer.map((c) => c[1]);
    const shape: Shape<T> = { rings, value, minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    for (const key of cells(shape.minX, shape.minY, shape.maxX, shape.maxY, POLYGON_CELL)) {
      const list = this.grid.get(key);
      if (list) list.push(shape);
      else this.grid.set(key, [shape]);
    }
  }

  /** The value of the first polygon holding `p`, or undefined. */
  find(p: Point): T | undefined {
    for (const shape of this.grid.get(cellKey(Math.floor(p[1] / POLYGON_CELL), Math.floor(p[0] / POLYGON_CELL))) ?? []) {
      if (p[0] < shape.minX || p[0] > shape.maxX || p[1] < shape.minY || p[1] > shape.maxY) continue;
      if (inside(p, shape.rings)) return shape.value;
    }
    return undefined;
  }
}

/** Whether `p` is inside the polygon: an odd number of ring crossings to its east, so a hole counts as outside. */
function inside(p: Point, rings: Ring[]): boolean {
  let odd = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) odd = !odd;
    }
  }
  return odd;
}

/** The point `metres` from `p` on a compass bearing, on a flat projection, which is close enough at these distances. */
function offset(p: Point, metres: number, bearingDeg: number): Point {
  const rad = (bearingDeg * Math.PI) / 180;
  const north = metres * Math.cos(rad);
  const east = metres * Math.sin(rad);
  return [p[0] + east / (111_320 * Math.cos((p[1] * Math.PI) / 180)), p[1] + north / 110_574];
}

/** Sea and lake polygons from water lines. */
export function landMask(lines: Iterable<string>): LandMask {
  const grid = new PolygonGrid<WaterHit>();
  for (const line of lines) {
    const value = parse(line, "water");
    if (!value || (value.water !== "sea" && value.water !== "lake")) continue;
    const hit: WaterHit = { water: value.water, ...(typeof value.name === "string" && value.name !== "" ? { name: value.name } : {}) };
    for (const rings of polygonsOf(value.polygons)) grid.add(rings, hit);
  }
  return {
    waterAt(p) {
      const at: Point = [p.lon, p.lat];
      const hit = grid.find(at);
      if (!hit) return null;
      // Water all round, WATER_EDGE_M away in eight directions, so a point near the shore passes.
      // Any water counts, so the edges where the sea is cut into pieces are not a shore.
      for (let bearing = 0; bearing < 360; bearing += 45) {
        if (grid.find(offset(at, WATER_EDGE_M, bearing)) === undefined) return null;
      }
      return hit;
    },
  };
}

/** Building footprints from building lines. */
export function buildingFootprints(lines: Iterable<string>): Buildings {
  const grid = new PolygonGrid<string>();
  for (const line of lines) {
    const value = parse(line, "building");
    if (!value || typeof value.building !== "string") continue;
    for (const rings of polygonsOf(value.polygons)) grid.add(rings, value.building);
  }
  return { at: (p) => grid.find([p.lon, p.lat]) ?? null };
}

interface Segment {
  p: Point;
  q: Point;
  road: RoadCrossed;
}

/** Distance in metres from `c` to segment p-q, on a flat projection around `c`. */
function toSegmentM(c: Point, p: Point, q: Point): number {
  const kx = 111_320 * Math.cos((c[1] * Math.PI) / 180);
  const ky = 110_574;
  const ax = (p[0] - c[0]) * kx;
  const ay = (p[1] - c[1]) * ky;
  const bx = (q[0] - c[0]) * kx;
  const by = (q[1] - c[1]) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** The carriageways of the major roads in the geometry sidecar's road lines. */
export function carriageways(lines: Iterable<string>): Carriageways {
  const grid = new Map<string, Segment[]>();
  for (const line of lines) {
    const value = parse(line, "road");
    if (!value || typeof value.road !== "number" || typeof value.highway !== "string" || !Array.isArray(value.coords)) continue;
    const road: RoadCrossed = {
      highway: value.highway,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    };
    const coords = value.coords.filter(isPoint);
    for (let i = 1; i < coords.length; i++) {
      const segment = { p: coords[i - 1]!, q: coords[i]!, road };
      const [p, q] = [segment.p, segment.q];
      for (const key of cells(Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1]), ROAD_CELL)) {
        const list = grid.get(key);
        if (list) list.push(segment);
        else grid.set(key, [segment]);
      }
    }
  }
  return {
    at(p) {
      const c: Point = [p.lon, p.lat];
      // The cells within the buffer of the point: a segment near a cell's edge is listed in the cell it is in.
      const [west, south] = offset(offset(c, ROAD_BUFFER_M, 180), ROAD_BUFFER_M, 270);
      const [east, north] = offset(offset(c, ROAD_BUFFER_M, 0), ROAD_BUFFER_M, 90);
      const seen = new Set<Segment>();
      for (const key of cells(west, south, east, north, ROAD_CELL)) {
        for (const segment of grid.get(key) ?? []) {
          if (seen.has(segment)) continue;
          seen.add(segment);
          if (toSegmentM(c, segment.p, segment.q) <= ROAD_BUFFER_M) return segment.road;
        }
      }
      return null;
    },
  };
}

/** Whether the bounds come within `metres` of any of `points`, to keep only the geometry near the places a run checks. */
export function boundsNear(bounds: { minX: number; minY: number; maxX: number; maxY: number }, points: readonly LatLon[], metres: number): boolean {
  return points.some((p) => {
    const x = Math.min(Math.max(p.lon, bounds.minX), bounds.maxX);
    const y = Math.min(Math.max(p.lat, bounds.minY), bounds.maxY);
    return distanceM(p, { lat: y, lon: x }) <= metres;
  });
}
