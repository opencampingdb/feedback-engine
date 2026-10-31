/**
 * The OSM tag that a fact in a place record corresponds to. These follow the
 * data repository's extract (data/pipeline/extract.py, facts_from_tags), so a
 * value read from OSM and the tag named in a note agree.
 */

/** Facts read from a plain yes/no tag: fact name to OSM key. */
const YES_NO: Readonly<Record<string, string>> = {
  fee: "fee",
  power: "power_supply",
  tents: "tents",
  caravans: "caravans",
  toilets: "toilets",
  showers: "shower",
  drinking_water: "drinking_water",
  dump_station: "sanitary_dump_station",
};

/** Facts copied from a tag as written: fact name to OSM key. */
const AS_WRITTEN: Readonly<Record<string, string>> = {
  max_stay: "maxstay",
  opening_hours: "opening_hours",
  website: "website",
  phone: "phone",
  name: "name",
};

/** The road access fact comes from 4wd_only. `unknown` has no tag. */
const ACCESS: Readonly<Record<string, string>> = {
  "2wd": "4wd_only=no",
  awd: "4wd_only=recommended",
  "4wd": "4wd_only=yes",
};

/** The entry fact comes from access=*. */
const ENTRY: Readonly<Record<string, string>> = {
  public: "access=yes",
  customers: "access=customers",
  permit: "access=permit",
  private: "access=private",
};

const WATER_TYPE: Readonly<Record<string, string>> = {
  tank_fill: "amenity=water_point",
  fountain: "amenity=drinking_water",
};

/** Facts that are never passed to OSM: booking details have no OSM tag we map. */
export const NEVER_SENT = new Set(["booking_url", "booking_required"]);

/** `key=value` for a fact, or undefined when no OSM tag matches the value. */
export function osmTag(field: string, value: boolean | string): string | undefined {
  const yesNo = YES_NO[field];
  if (yesNo) return typeof value === "boolean" ? `${yesNo}=${value ? "yes" : "no"}` : undefined;
  const written = AS_WRITTEN[field];
  if (written) return typeof value === "string" && value.trim() ? `${written}=${value}` : undefined;
  if (typeof value !== "string") return undefined;
  if (field === "pets") return ["yes", "no", "leashed"].includes(value) ? `dog=${value}` : undefined;
  if (field === "access") return ACCESS[value];
  if (field === "entry") return ENTRY[value];
  if (field === "water_type") return WATER_TYPE[value];
  return undefined;
}

/** Plain words for a yes/no fact: [when true, when false]. */
const YES_NO_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  fee: ["there is a fee to stay", "there is no fee to stay"],
  power: ["there are powered sites", "there are no powered sites"],
  tents: ["tents are allowed", "tents are not allowed"],
  caravans: ["caravans are allowed", "caravans are not allowed"],
  toilets: ["there are toilets", "there are no toilets"],
  showers: ["there are showers", "there are no showers"],
  drinking_water: ["there is drinking water", "there is no drinking water"],
  dump_station: ["there is a dump point", "there is no dump point"],
};

const STRING_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  pets: { yes: "dogs are allowed", leashed: "dogs are allowed on a lead", no: "dogs are not allowed" },
  access: { "2wd": "the road is fine for 2WD", awd: "AWD is recommended", "4wd": "the road is 4WD only" },
  entry: {
    public: "anyone may stay",
    customers: "only customers may stay",
    permit: "a permit is needed to stay",
    private: "it is private, not open to the public",
  },
  water_type: { tank_fill: "it is a tap for filling tanks", fountain: "it is a drinking fountain" },
};

const LABELS: Readonly<Record<string, string>> = {
  max_stay: "maximum stay",
  opening_hours: "opening hours",
  website: "website",
  phone: "phone number",
  name: "name",
};

/** Plain words for a field and its value, for the note text. */
export function describe(field: string, value: boolean | string): string {
  if (typeof value === "boolean") {
    const words = YES_NO_WORDS[field];
    if (words) return value ? words[0] : words[1];
    return `${field.replace(/_/g, " ")} is ${value ? "yes" : "no"}`;
  }
  const fixed = STRING_WORDS[field]?.[value];
  if (fixed) return fixed;
  const label = LABELS[field] ?? field.replace(/_/g, " ");
  return `the ${label} is ${value}`;
}
