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
    ["charge", "57 AUD/night", "charge=57 AUD/night"],
    ["charge_conditional", "75 AUD/night @ (Dec-Jan)", "charge:conditional=75 AUD/night @ (Dec-Jan)"],
    ["access", "4wd", "4wd_only=yes"],
    ["access", "awd", "4wd_only=recommended"],
    ["entry", "customers", "access=customers"],
    ["water_type", "tank_fill", "amenity=water_point"],
    ["name", "Lake Eppalock Camp", "name=Lake Eppalock Camp"],
    ["fee", "donation", "fee=donation"],
    ["wifi", true, "internet_access=wlan"],
    ["wifi", false, "internet_access=no"],
    ["laundry", true, "washing_machine=yes"],
    ["campfires", false, "openfire=no"],
    ["picnic_tables", true, "picnic_table=yes"],
    ["motorhomes", true, "motorhome=yes"],
    ["nudist", true, "nudism=yes"],
    ["brand", "big4", "brand=BIG4"],
    ["email", "stay@example.com.au", "email=stay@example.com.au"],
    ["facebook", "https://www.facebook.com/lakebend", "contact:facebook=https://www.facebook.com/lakebend"],
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

describe("site features", () => {
  it("has no tag for values OSM cannot say", () => {
    expect(osmTag("caravans", "offroad")).toBeUndefined();
    expect(osmTag("pets", "seasonal")).toBeUndefined();
    expect(osmTag("scenery", true)).toBeUndefined();
    expect(osmTag("brand", "tawk")).toBeUndefined();
  });

  it("describes them in plain words", () => {
    expect(words("fee", "donation")).toBe("payment is by donation");
    expect(words("campfires", true)).toBe("campfires are allowed");
    expect(words("crocodiles", true)).toBe("there are crocodiles in the water nearby");
    expect(words("caravans", "offroad")).toBe("only off-road caravans can get in");
    expect(words("email", "stay@example.com.au")).toBe("the email address is stay@example.com.au");
  });
});
