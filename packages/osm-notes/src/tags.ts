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
  wheelchair: "wheelchair",
  motorhomes: "motorhome",
  laundry: "washing_machine",
  kitchen: "kitchen",
  bbq: "bbq",
  picnic_tables: "picnic_table",
  campfires: "openfire",
  cabins: "cabins",
  playground: "playground",
  nudist: "nudism",
};

/** Facts copied from a tag as written: fact name to OSM key. */
const AS_WRITTEN: Readonly<Record<string, string>> = {
  max_stay: "maxstay",
  opening_hours: "opening_hours",
  website: "website",
  phone: "phone",
  email: "email",
  facebook: "contact:facebook",
  instagram: "contact:instagram",
  tiktok: "contact:tiktok",
  x: "contact:twitter",
  name: "name",
};

/** The brand fact as OSM brand=* writes it. Brands without a settled OSM name are not sent. */
const BRAND: Readonly<Record<string, string>> = {
  big4: "BIG4",
  discovery: "Discovery Parks",
  nrma: "NRMA Parks",
  ingenia: "Ingenia Holidays",
  reflections: "Reflections Holiday Parks",
  gday: "G'day Parks",
  family_parks: "Family Parks",
  yha: "YHA",
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
  if (field === "fee" && value === "donation") return "fee=donation";
  if (field === "wifi" && typeof value === "boolean") return `internet_access=${value ? "wlan" : "no"}`;
  if (yesNo) return typeof value === "boolean" ? `${yesNo}=${value ? "yes" : "no"}` : undefined;
  const written = AS_WRITTEN[field];
  if (written) return typeof value === "string" && value.trim() ? `${written}=${value}` : undefined;
  if (typeof value !== "string") return undefined;
  if (field === "pets") return ["yes", "no", "leashed"].includes(value) ? `dog=${value}` : undefined;
  if (field === "access") return ACCESS[value];
  if (field === "entry") return ENTRY[value];
  if (field === "water_type") return WATER_TYPE[value];
  if (field === "brand") return BRAND[value] ? `brand=${BRAND[value]}` : undefined;
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
  wheelchair: ["it is wheelchair accessible", "it is not wheelchair accessible"],
  generators: ["generators are allowed", "generators are not allowed"],
  motorhomes: ["motorhomes can get in", "motorhomes cannot get in"],
  camper_trailers: ["camper trailers can get in", "camper trailers cannot get in"],
  motorbikes: ["motorbikes can get in", "motorbikes cannot get in"],
  big_rigs: ["big rigs can get in and turn around", "big rigs cannot get in"],
  non_drinking_water: ["there is water that is not for drinking", "there is no non-drinking water"],
  laundry: ["there is a laundry", "there is no laundry"],
  kitchen: ["there is a camp kitchen", "there is no camp kitchen"],
  bbq: ["there are barbecues", "there are no barbecues"],
  drive_through: ["there are drive-through sites", "there are no drive-through sites"],
  ensuite_sites: ["there are ensuite sites", "there are no ensuite sites"],
  bins: ["there are rubbish bins", "there are no rubbish bins"],
  picnic_tables: ["there are tables", "there are no tables"],
  campfires: ["campfires are allowed", "campfires are not allowed"],
  cabins: ["there are cabins", "there are no cabins"],
  pub: ["there is a pub on site", "there is no pub on site"],
  swimming: ["you can swim there", "you cannot swim there"],
  fishing: ["you can fish there", "you cannot fish there"],
  walking_tracks: ["there are walking tracks", "there are no walking tracks"],
  playground: ["there is a playground", "there is no playground"],
  games_room: ["there is a games room", "there is no games room"],
  shade: ["the sites have shade", "the sites have no shade"],
  wifi: ["there is Wi-Fi", "there is no Wi-Fi"],
  telstra_signal: ["there is Telstra signal", "there is no Telstra signal"],
  mobile_signal: ["there is mobile signal on other networks", "there is no mobile signal on other networks"],
  self_contained_only: ["only self-contained vehicles may stay", "vehicles need not be self-contained"],
  crocodiles: ["there are crocodiles in the water nearby", "there are no crocodiles nearby"],
  dangerous_when_wet: ["the way in is dangerous when wet", "the way in is fine when wet"],
  over_50s: ["only guests 50 and older may stay", "guests of any age may stay"],
  nudist: ["it is a nudist place", "it is not a nudist place"],
};

const STRING_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  pets: {
    yes: "dogs are allowed",
    leashed: "dogs are allowed on a lead",
    no: "dogs are not allowed",
    seasonal: "dogs are allowed only in some months",
  },
  fee: { donation: "payment is by donation" },
  caravans: { offroad: "only off-road caravans can get in" },
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
  phone_2: "second phone number",
  email: "email address",
  facebook: "Facebook page",
  instagram: "Instagram page",
  tiktok: "TikTok page",
  x: "X page",
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
