/**
 * The major roads in the data repository's geometry sidecar
 * (`pipeline.extract --geometry`), and its rule 2 from `pipeline/geometry.py`:
 * two places are separate when the straight line between them crosses a
 * major road. Pure functions with no Node APIs. Only `road` lines are read;
 * area and signal lines are skipped.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** The road a line crosses, as the sidecar names it. */
export interface RoadCrossed {
  highway: string;
  name?: string;
  ref?: string;
}

export interface MajorRoads {
  /** The first major road the straight line from `a` to `b` crosses, or null when it crosses none. */
  between(a: LatLon, b: LatLon): RoadCrossed | null;
}

/** Grid cell, in degrees, as `pipeline/geometry.py` grids roads. */
const CELL = 0.01;

type Point = [number, number];
interface Segment {
  p: Point;
  q: Point;
  road: RoadCrossed;
}

const cellKey = (row: number, col: number) => `${row},${col}`;

function* cellsOf(x1: number, y1: number, x2: number, y2: number): Generator<string> {
  const row1 = Math.floor(Math.min(y1, y2) / CELL);
  const row2 = Math.floor(Math.max(y1, y2) / CELL);
  const col1 = Math.floor(Math.min(x1, x2) / CELL);
  const col2 = Math.floor(Math.max(x1, x2) / CELL);
  for (let row = row1; row <= row2; row++) for (let col = col1; col <= col2; col++) yield cellKey(row, col);
}

const orientation = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

/** Segment p-q and segment r-s cross at a point inside both. Touching at an end does not count. */
function segmentsCross(p: Point, q: Point, r: Point, s: Point): boolean {
  const d1 = orientation(r, s, p);
  const d2 = orientation(r, s, q);
  const d3 = orientation(p, q, r);
  const d4 = orientation(p, q, s);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** The major roads in the sidecar's lines, gridded for `between`. Lines that are not road lines, or don't parse, are skipped. */
export function majorRoads(lines: Iterable<string>): MajorRoads {
  const grid = new Map<string, Segment[]>();
  for (const line of lines) {
    if (!line.startsWith('{"') || !line.includes('"road"')) continue;
    let value: { road?: unknown; highway?: unknown; name?: unknown; ref?: unknown; coords?: unknown };
    try {
      value = JSON.parse(line) as typeof value;
    } catch {
      continue;
    }
    if (typeof value.road !== "number" || typeof value.highway !== "string" || !Array.isArray(value.coords)) continue;
    const road: RoadCrossed = {
      highway: value.highway,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.ref === "string" ? { ref: value.ref } : {}),
    };
    const coords = (value.coords as unknown[]).filter((c): c is Point => Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number");
    for (let i = 1; i < coords.length; i++) {
      const segment = { p: coords[i - 1]!, q: coords[i]!, road };
      for (const key of cellsOf(segment.p[0], segment.p[1], segment.q[0], segment.q[1])) {
        const list = grid.get(key);
        if (list) list.push(segment);
        else grid.set(key, [segment]);
      }
    }
  }
  return {
    between(a, b) {
      const p: Point = [a.lon, a.lat];
      const q: Point = [b.lon, b.lat];
      const seen = new Set<Segment>();
      for (const key of cellsOf(p[0], p[1], q[0], q[1])) {
        for (const segment of grid.get(key) ?? []) {
          if (seen.has(segment)) continue;
          seen.add(segment);
          if (segmentsCross(p, q, segment.p, segment.q)) return segment.road;
        }
      }
      return null;
    },
  };
}
