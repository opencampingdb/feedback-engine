import { describe, expect, it } from "vitest";
import { describe as words, osmTag } from "../src/tags.js";

describe("osmTag", () => {
  it.each([
    ["fee", false, "fee=no"],
    ["fee", true, "fee=yes"],
    ["power", true, "power_supply=yes"],
    ["toilets", false, "toilets=no"],
    ["showers", true, "shower=yes"],
    ["drinking_water", true, "drinking_water=yes"],
    ["dump_station", true, "sanitary_dump_station=yes"],
    ["tents", false, "tents=no"],
    ["caravans", true, "caravans=yes"],
    ["pets", "leashed", "dog=leashed"],
    ["max_stay", "48h", "maxstay=48h"],
    ["opening_hours", "24/7", "opening_hours=24/7"],
    ["access", "4wd", "4wd_only=yes"],
    ["access", "awd", "4wd_only=recommended"],
    ["entry", "customers", "access=customers"],
    ["water_type", "tank_fill", "amenity=water_point"],
    ["name", "Lake Eppalock Camp", "name=Lake Eppalock Camp"],
  ] as const)("%s %j is %s", (field, value, tag) => {
    expect(osmTag(field, value)).toBe(tag);
  });

  it("has no tag for values OSM does not map", () => {
    expect(osmTag("access", "unknown")).toBeUndefined();
    expect(osmTag("booking_url", "https://example.org")).toBeUndefined();
    expect(osmTag("fee", "yes")).toBeUndefined();
  });
});

describe("describe", () => {
  it("puts facts in plain words", () => {
    expect(words("fee", false)).toBe("there is no fee to stay");
    expect(words("dump_station", true)).toBe("there is a dump point");
    expect(words("pets", "leashed")).toBe("dogs are allowed on a lead");
    expect(words("max_stay", "48h")).toBe("the maximum stay is 48h");
  });
});
