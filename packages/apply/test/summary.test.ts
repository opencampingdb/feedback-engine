import type { StoredFeedback } from "@opencampingdb/feedback";
import { describe, expect, it } from "vitest";
import { contributorRecords, reviewerDecisions } from "../src/summary-cli.js";
import { MAX_BODY_CHARS } from "../src/prbody.js";
import { reviewSummary, SUMMARY_MARKER, type ChangedPlace, type SummaryInput } from "../src/summary.js";
import type { Place, Review } from "../src/types.js";

const place = (over: Partial<Place> & { id: string }): Place => ({
  name: null,
  kind: "campground",
  group: "overnight",
  location: { lat: -36.945527, lon: 147.608044 },
  osm: null,
  facts: {},
  status: "open",
  rating: null,
  fact_sources: {},
  updated: "2026-11-15T00:00:00Z",
  ...over,
} as Place);

const RIVER = "ocdb_01M66ESDHF85ZS2N7N46JQ07SA";
const PARK = "ocdb_01M66ESEQQEK6TFA78PPKV7WE0";
const DAM = "ocdb_01M7M9QQ8T2YY2A0VBVRHV944A";
const FLAT = "ocdb_01M66ESD7BX9HVCQ9VSYBPEAVJ";

const FACTS = ["caravans", "toilets", "swimming", "walking_tracks", "scenery", "wildlife", "shade"] as const;

const capped = (fact: string, n: number): StoredFeedback =>
  ({
    id: `fb_01M7JAGCC${n}000000000000000000`.slice(0, 29),
    received: "2026-11-16T13:59:50Z",
    app: "example-app",
    type: "report",
    place: RIVER,
    origin: "13cc956ad07ab86d",
    contributor: "ctr_deda015170f7cb2e",
    attested: "app_attest",
    attest_key: "ak_58e354533cf99865",
    consent: true,
    report: { kind: "fact", fact, value: true },
    intake: { state: "held", held_reason: "daily_cap" },
    outcome: { result: "needs_review", reason: "the intake held it for daily_cap, so a person checks it", run: "2026-11-16T14:09:56Z" },
  }) as unknown as StoredFeedback;

const kindReport = (id: string, placeId: string, to: string, extra: Record<string, unknown>): StoredFeedback =>
  ({
    id,
    received: "2026-11-18T00:30:00Z",
    app: "example-app",
    type: "report",
    place: placeId,
    origin: "ad59312c8c7b82a5",
    consent: true,
    report: { kind: "kind", place_kind: to },
    outcome: { result: "needs_review", reason: "kind changes are checked by the AI reviewer or a person", run: "2026-11-18T00:39:11Z" },
    ...extra,
  }) as unknown as StoredFeedback;

function input(over: Partial<SummaryInput> = {}): SummaryInput {
  const river: ChangedPlace = {
    before: place({ id: RIVER, name: "Hinnomunjie Bridge Camping Area", kind: "reserve_campsite", osm: { type: "node", id: 11496609544, version: 1 } }),
    after: place({
      id: RIVER,
      name: "Hinnomunjie Bridge Camping Area",
      kind: "reserve_campsite",
      osm: { type: "node", id: 11496609544, version: 1 },
      facts: Object.fromEntries(FACTS.map((f) => [f, true])) as Place["facts"],
    }),
    path: `places/sa/${RIVER}.json`,
    reviews: [],
  };
  const park: ChangedPlace = {
    before: place({ id: PARK, name: "Hawks Nest Holiday Park", osm: { type: "way", id: 31336696, version: 7 } }),
    after: place({ id: PARK, name: "Hawks Nest Holiday Park", kind: "caravan_park", osm: { type: "way", id: 31336696, version: 7 }, rating: { count: 1, mean: 5 } }),
    path: `places/e0/${PARK}.json`,
    reviews: [
      { id: "rev_1", place: PARK, stars: 5, text: "Great park with modern amenities. Lovely spot.", visited: "2026-11", created: "2026-11-19T20:18:51Z", app: "example-app", contributor: "ctr_35f306151a61b34e", visited_nearby: true } as Review,
    ],
  };
  const dam: ChangedPlace = {
    before: null,
    after: place({ id: DAM, name: "Yornaning Dam", kind: "free_camp", standing: "hidden", moderator: { action: "hide", at: "2026-11-17T08:36:29Z" } }),
    path: `places/4a/${DAM}.json`,
    reviews: [],
  };
  const items = [
    ...FACTS.map((f, i) => capped(f, i)),
    kindReport("fb_01M7P16V5QT7ZXVTQD76KMS504", PARK, "caravan_park", { human_checked: true }),
    kindReport("fb_01M7V53PHRMG5C2YT7NNZ0XN1Y", PARK, "caravan_park", {
      contributor: "ctr_deda015170f7cb2e",
      origin: "6496fc02a5d69466",
      received: "2026-11-20T00:19:02Z",
      report: { kind: "kind", place_kind: "caravan_park", first_hand: "seen_nearby" },
    }),
  ];
  return {
    repo: "example/data",
    branch: "feedback/review",
    places: [river, park, dam],
    items,
    forPerson: new Set(items.map((i) => i.id)),
    decisions: [{ case: "place_change", place: PARK, decision: "approve", reviewer: "ai:example-model", reason: "The new kind is a believable change for this place." }],
    osm: new Map([
      [RIVER, { name: "Hinnomunjie Bridge Camping Area", tourism: "camp_site" }],
      [PARK, { tourism: "camp_site", caravans: "yes", static_caravans: "yes" }],
    ]),
    records: new Map([["ctr_deda015170f7cb2e", { applied: 256, toPerson: 41, refused: 4 }]]),
    kindLabels: new Map([
      ["reserve_campsite", "Reserve campsite"],
      ["campground", "Campground"],
      ["caravan_park", "Caravan park"],
      ["free_camp", "Free camp"],
    ]),
    ...over,
  };
}

describe("reviewSummary", () => {
  const body = reviewSummary(input());

  it("starts with the marker and counts the places by whether they need a decision", () => {
    expect(body.startsWith(`${SUMMARY_MARKER}\n`)).toBe(true);
    expect(body).toContain("This PR changes 3 places: 2 need a decision, 1 needs none.");
  });

  it("lists every changed field with its value before and after, a blank as not known, and what OpenStreetMap holds", () => {
    expect(body).toContain("### 1. Hinnomunjie Bridge Camping Area");
    expect(body).toContain("| caravans | not known | yes | not tagged |");
    expect(body).toContain("| shade | not known | yes | n/a |");
    expect(body).toContain("| kind | Campground | Caravan park | tourism=camp\\_site, static_caravans=yes, caravans=yes |");
    expect(body).toContain("| rating | none | 5.0 from 1 review | n/a |");
  });

  it("says why it was held in plain words, and who reported it as counts only", () => {
    expect(body).toContain("**Held because** the contributor passed the intake's daily limit of changes, so no check ran on it.");
    expect(body).toContain("**Reporter** 7 items in an app on 16 Nov, no first-hand mark. No other report agrees. Their record: 256 applied, 41 sent to a person, 4 refused.");
    expect(body).toContain("from a website after its human check on 18 Nov, no first-hand mark. 1 other source agrees.");
    expect(body).toContain("in an app on 20 Nov, marked seen nearby. 1 other source agrees.");
  });

  it("quotes a clean review and the reviewer's decision", () => {
    expect(body).toContain('**Review** 5 stars: "Great park with modern amenities. Lovely spot."');
    expect(body).toContain('**Reviewer** AI approved: "The new kind is a believable change for this place".');
  });

  it("puts a place a moderator hid under No decision needed", () => {
    expect(body).toContain("## No decision needed\n\n- **Yornaning Dam** (`ocdb_01M7M9QQ8T2YY2A0VBVRHV944A`): a moderator hid it on 17 Nov, and it stays hidden.");
    expect(body).not.toContain("### 3.");
  });

  it("writes no contributor, device, network or attestation id", () => {
    for (const secret of ["ctr_", "13cc956ad07ab86d", "6496fc02a5d69466", "ak_58e354533cf99865", "fb_", "example-app"]) expect(body).not.toContain(secret);
  });

  it("withholds a review that fails moderation and a name that reads as abuse", () => {
    const base = input();
    const [river, park, dam] = base.places as [ChangedPlace, ChangedPlace, ChangedPlace];
    const rude = reviewSummary({
      ...base,
      places: [{ ...river, after: { ...river.after, name: "shit hole" } }, { ...park, reviews: [{ ...park.reviews[0]!, text: "call me on 0412 345 678" }] }, dam],
    });
    expect(rude).toContain("(text withheld, read it in the inbox)");
    expect(rude).toContain("### 1. (withheld, read it in the inbox)");
    expect(rude).not.toContain("0412");
  });

  it("does not quote a review an intake check held", () => {
    const base = input();
    const held = { id: "fb_1", type: "review", place: PARK, intake: { state: "held", held_reason: "ai_check" }, outcome: { result: "needs_review", run: "2026-11-19T20:28:51Z" } } as unknown as StoredFeedback;
    const text = reviewSummary({ ...base, items: [...base.items, held], forPerson: new Set([...base.forPerson, "fb_1"]) });
    expect(text).toContain("**Review** 5 stars: (text withheld, read it in the inbox)");
    expect(text).toContain("the intake's content check flagged it");
  });

  it("says when a place is not in OpenStreetMap or its object could not be read", () => {
    const base = input();
    const flat: ChangedPlace = {
      before: place({ id: FLAT, name: "Hat Flat", kind: "reserve_campsite", osm: { type: "node", id: 1, version: 1 } }),
      after: place({ id: FLAT, name: "Hat Flat", kind: "campground", osm: { type: "node", id: 1, version: 1 } }),
      path: `places/vj/${FLAT}.json`,
      reviews: [],
    };
    const text = reviewSummary({ ...base, places: [flat, { ...flat, before: { ...flat.before!, osm: null }, after: { ...flat.after, osm: null } }] });
    expect(text).toContain("| kind | Reserve campsite | Campground | could not be read |");
    expect(text).toContain("| kind | Reserve campsite | Campground | not in OSM |");
  });

  it("stays under the body limit, counting the places it leaves out", () => {
    const base = input();
    const river = base.places[0]!;
    const many = Array.from({ length: 400 }, (_, i) => ({
      ...river,
      after: { ...river.after, id: `ocdb_${String(i).padStart(26, "0")}`, name: `Place ${i} ${"x".repeat(200)}` },
    }));
    const text = reviewSummary({ ...base, places: many });
    expect(text.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(text).toMatch(/And \d+ more places, listed under Files changed\./);
  });
});

describe("reviewerDecisions", () => {
  const line = '- review-decision {"key":"k","case":"place_change","place":"ocdb_1","decision":"approve","reviewer":"ai:m","reason":"fine"}';
  it("reads decisions only from the bot or reviewer App's comments", () => {
    const pr = {
      number: 7,
      state: "OPEN",
      body: line,
      isCrossRepository: false,
      author: { login: "example-bot", type: "Bot" },
      comments: [
        { author: { login: "example-reviewer", type: "Bot" }, body: line },
        { author: { login: "someone", type: "User" }, body: line.replace("approve", "take_down") },
      ],
    };
    expect(reviewerDecisions(pr as never, ["example-bot", "example-reviewer"])).toEqual([
      { place: "ocdb_1", case: "place_change", decision: "approve", reviewer: "ai:m", reason: "fine" },
    ]);
  });
});

describe("contributorRecords", () => {
  it("counts each contributor's items by outcome and skips items with no contributor", () => {
    const item = (contributor: string | undefined, result: string) => ({ contributor, outcome: { result } }) as unknown as StoredFeedback;
    const records = contributorRecords([item("ctr_a", "applied"), item("ctr_a", "needs_review"), item(undefined, "applied")], [item("ctr_a", "refused")]);
    expect([...records]).toEqual([["ctr_a", { applied: 1, toPerson: 1, refused: 1 }]]);
  });
});
