import { describe, expect, it } from "vitest";
import { majorRoads } from "../src/roads.js";

// A north-south trunk road at lon 147.0, and a piece of a minor road the sidecar would never hold.
const sidecar = [
  '{"area":"way/1","polygons":[[[[147.1,-31.1],[147.2,-31.1],[147.2,-31.2],[147.1,-31.1]]]]}',
  '{"signals":"node/2","operator":"Example Council"}',
  '{"coords":[[147.0,-31.6],[147.0,-31.5],[147.0,-31.4]],"highway":"trunk","name":"Example Highway","road":10}',
  "",
];

describe("major roads from the geometry sidecar", () => {
  const roads = majorRoads(sidecar);

  it("says when the straight line between two places crosses a major road", () => {
    expect(roads.between({ lat: -31.45, lon: 146.9998 }, { lat: -31.45, lon: 147.0002 })).toEqual({ highway: "trunk", name: "Example Highway" });
  });

  it("finds no road between two places on the same side, or beyond the road's ends", () => {
    expect(roads.between({ lat: -31.5, lon: 147.0001 }, { lat: -31.5001, lon: 147.0004 })).toBeNull();
    expect(roads.between({ lat: -31.7, lon: 146.9998 }, { lat: -31.7, lon: 147.0002 })).toBeNull();
  });

  it("does not count a place standing on the road's centre line", () => {
    expect(roads.between({ lat: -31.5, lon: 147.0 }, { lat: -31.5, lon: 147.0003 })).toBeNull();
  });
});
