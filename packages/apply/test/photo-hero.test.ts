import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyRules, type RulesInput } from "../src/rules.js";
import { run } from "../src/run.js";
import { dumpPhotoLine, dumpPlace } from "../src/serialise.js";
import type { CommonsCounts, Photo, Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const NOW = "2026-11-03T00:00:00Z";
const LAKE = "Lake Eppalock camp 2019.jpg";
const JETTY = "Eppalock jetty.jpg";

const place = (id = PLACE): Place => ({
  id,
  name: "Lake Eppalock Camp",
  kind: "free_camp",
  group: "overnight",
  location: { lat: -36.85, lon: 144.55 },
  osm: { type: "node", id: 123456, version: 7 },
  facts: {},
  status: "open",
  rating: null,
  fact_sources: {},
  updated: "2026-06-01T00:00:00Z",
});
const photoLine = (n: number, extra: Partial<Photo> = {}): Photo => ({
  id: `pho_01JA00000000000000000000${String(n).padStart(2, "0")}`,
  place: PLACE,
  contributor: "ctr_0123456789abcdef",
  created: "2026-10-01T00:00:00Z",
  app: "example-app",
  licence: "CC-BY-4.0",
  width: 1600,
  height: 1200,
  sha256: String(n).repeat(64).slice(0, 64),
  ...extra,
});
const A = photoLine(1).id;
const kept = (who: string) => ({ feedback: `fb_01JC${who.padStart(22, "0")}`, at: "2026-10-01T00:00:00Z", vote: "helpful" as const, contributor: `ctr_${who.padStart(16, "0")}`, device: `dev-${who}` });
const B = photoLine(2).id;

let seq = 0;
const hero = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}): StoredFeedback =>
  ({
    id: `fb_01JH${String(++seq).padStart(22, "0")}`,
    received: `2026-11-02T10:00:${String(seq % 60).padStart(2, "0")}Z`,
    app: "example-app",
    place: PLACE,
    device: "dev-owner",
    app_version: "1.0.0",
    consent: true,
    type: "photo_hero",
    photo_hero: choice,
    owner_checked: true,
    ...extra,
  }) as StoredFeedback;

function rules(pending: StoredFeedback[], extra: Partial<RulesInput> = {}, matches: ReadonlyMap<string, ReadonlySet<string>> | null = new Map([[PLACE, new Set([LAKE, JETTY])]])) {
  const out = applyRules({
    now: NOW,
    pending,
    history: [],
    places: new Map([place(), place(OTHER)].map((p) => [p.id, p])),
    reviews: () => [],
    photos: [photoLine(1), photoLine(2)],
    ...(matches ? { commonsMatches: matches } : {}),
    ...extra,
  });
  const decision = (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id);
  const line = (id: string) => [...out.photos.values()].flat().find((p) => p.id === id);
  return { ...out, outcome: (item: StoredFeedback) => decision(item)?.outcome, reason: (item: StoredFeedback) => decision(item)?.reason, line };
}

describe("an owner's hero photo", () => {
  it("marks the chosen traveller photo, and clears any other hero of the place", () => {
    const choice = hero({ photo: B });
    const out = rules([choice], { photos: [photoLine(1, { hero: true }), photoLine(2)], commonsCounts: [{ place: PLACE, file: LAKE, hero: true }] });
    expect(out.reason(choice)).toBe("hero photo set");
    expect(out.line(B)!.hero).toBe(true);
    expect(out.line(A)).not.toHaveProperty("hero");
    expect(out.commonsCounts.get(PLACE)).toEqual([]);
    expect(out.changes).toContainEqual(expect.objectContaining({ place: PLACE, automatic: true, summary: `hero photo set to ${B}` }));
  });

  it("marks a matched Commons file, on its count line or a new one", () => {
    const choice = hero({ commons: JETTY });
    const out = rules([choice], { photos: [photoLine(1, { hero: true }), photoLine(2)], commonsCounts: [{ place: PLACE, file: LAKE, helpful: 1, helpful_12m: 1 }], commonsVotes: { places: { [PLACE]: { [LAKE]: [kept("1")] } } } });
    expect(out.reason(choice)).toBe("hero photo set");
    expect(out.commonsCounts.get(PLACE)).toEqual([
      { place: PLACE, file: JETTY, hero: true },
      { place: PLACE, file: LAKE, helpful: 1, helpful_12m: 1 },
    ]);
    expect(out.line(A)).not.toHaveProperty("hero");
  });

  it("clears the hero with none, and the latest choice wins", () => {
    const first = hero({ photo: A });
    const clear = hero({ none: true });
    const out = rules([first, clear], {
      commonsCounts: [{ place: PLACE, file: LAKE, helpful: 2, helpful_12m: 2, hero: true }],
      commonsVotes: { places: { [PLACE]: { [LAKE]: [kept("1"), kept("2")] } } },
    });
    expect(out.reason(clear)).toBe("hero photo cleared");
    expect(out.line(A)).not.toHaveProperty("hero");
    expect(out.commonsCounts.get(PLACE)).toEqual([{ place: PLACE, file: LAKE, helpful: 2, helpful_12m: 2 }]);
  });

  it("ignores an older choice run again after a newer one", () => {
    const newer = { ...hero({ photo: B }), outcome: { result: "applied", reason: "hero photo set", run: NOW } } as unknown as StoredFeedback;
    const older = { ...hero({ photo: A }), received: "2026-11-01T00:00:00Z" } as StoredFeedback;
    const out = rules([older], { history: [newer], photos: [photoLine(1), photoLine(2, { hero: true })] });
    expect(out.outcome(older)).toBe("applied");
    expect(out.reason(older)).toBe("a later choice of the owner already counts");
    expect(out.photos.size).toBe(0);
  });

  it("refuses a photo or Commons file not of the place, and an item the owner check did not pass", () => {
    const missing = hero({ photo: photoLine(9).id });
    const elsewhere = hero({ commons: "Mount Buffalo gorge.jpg" });
    const listed = hero({ commons: JETTY });
    const unchecked = hero({ photo: A }, { owner_checked: undefined });
    const out = rules([missing, elsewhere, listed, unchecked], { doNotMatch: [{ place: PLACE, file: JETTY }] });
    expect(out.reason(missing)).toBe(`photo ${photoLine(9).id} is not in the data for this place`);
    expect(out.reason(elsewhere)).toBe("Commons file Mount Buffalo gorge.jpg is not matched to this place");
    expect(out.reason(listed)).toBe(`Commons file ${JETTY} is on the do-not-match list for this place`);
    expect(out.reason(unchecked)).toBe("the owner check did not pass");
    expect([missing, elsewhere, listed, unchecked].map(out.outcome)).toEqual(["refused", "refused", "refused", "refused"]);
  });

  it("waits on a Commons choice without the matches", () => {
    const choice = hero({ commons: LAKE });
    expect(rules([choice], {}, null).outcome(choice)).toBe("waiting");
  });

  it("drops a Commons hero whose file is no longer matched", () => {
    const counts: CommonsCounts[] = [{ place: PLACE, file: LAKE, hero: true }];
    const out = rules([], { commonsCounts: counts, commonsVotes: { places: {} } }, new Map([[PLACE, new Set([JETTY])]]));
    expect(out.commonsCounts.get(PLACE)).toEqual([]);
  });

  it("drops the hero with a photo removed in the run", () => {
    const remove = {
      id: "fb_01JH9999999999999999999999",
      received: "2026-11-02T11:00:00Z",
      app: "example-app",
      place: PLACE,
      device: "dev-sam",
      contributor: "ctr_0123456789abcdef",
      app_version: "1.0.0",
      consent: true,
      type: "photo_removal",
      photo_removal: { photo: A },
    } as StoredFeedback;
    const out = rules([remove], { photos: [photoLine(1, { hero: true }), photoLine(2)] });
    expect(out.line(A)).toBeUndefined();
    expect(out.photos.get(PLACE)!.some((p) => p.hero)).toBe(false);
  });
});

describe("an owner's hero photo in a photo repository run", () => {
  let root: string;

  async function put(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "photo-hero-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("moves the hero from a photo line to a Commons count line", async () => {
    const inbox = join(root, "inbox");
    const photos = join(root, "photos");
    const ocdb = join(root, "ocdb");
    await put(join(ocdb, "places", "za", `${PLACE}.json`), dumpPlace(place()));
    await put(join(ocdb, "commons", "matches.ndjson"), `${JSON.stringify({ checked: "2026-11-01", files: [{ file: LAKE }], place: PLACE, rules: 2 })}\n`);
    await put(join(photos, "photos", `${PLACE}.ndjson`), `${dumpPhotoLine(photoLine(1, { hero: true }))}\n`);
    const choice = hero({ commons: LAKE });
    await put(join(inbox, "pending", "2026-11-02", `${choice.id}.json`), JSON.stringify(choice));
    const summary = await run({ inbox, data: photos, places: ocdb, now: new Date(NOW) });
    expect(summary.auto_files.sort()).toEqual([`commons/${PLACE}.ndjson`, `photos/${PLACE}.ndjson`]);
    expect(await readFile(join(photos, "commons", `${PLACE}.ndjson`), "utf8")).toBe(`${JSON.stringify({ file: LAKE, hero: true, place: PLACE })}\n`);
    expect(JSON.parse(await readFile(join(photos, "photos", `${PLACE}.ndjson`), "utf8"))).not.toHaveProperty("hero");
  });
});
