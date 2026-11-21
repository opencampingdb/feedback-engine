import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { COMMONS_VOTES_FILE } from "../src/io.js";
import { applyRules, type RulesInput } from "../src/rules.js";
import { run } from "../src/run.js";
import { dumpPlace } from "../src/serialise.js";
import type { CommonsCounts, CommonsVotes, Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const NOW = "2026-11-03T00:00:00Z";
const LAKE = "Lake Eppalock camp 2019.jpg";
const JETTY = "Eppalock jetty.jpg";
const ELSEWHERE = "Mount Buffalo gorge.jpg";

const place = (id = PLACE, extra: Partial<Place> = {}): Place => ({
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
  ...extra,
});

const ctr = (name: string) => `ctr_${Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16)}`;
let seq = 0;
const vote = (who: string, commons: string, value: "helpful" | "not_helpful" | "none" = "helpful", extra: Record<string, unknown> = {}): StoredFeedback =>
  ({
    id: `fb_01JE${String(++seq).padStart(22, "0")}`,
    received: "2026-11-02T10:00:00Z",
    app: "example-app",
    place: PLACE,
    device: `dev-${who}`,
    contributor: ctr(who),
    app_version: "1.0.0",
    consent: true,
    type: "photo_vote",
    photo_vote: { commons, vote: value },
    ...extra,
  }) as StoredFeedback;
const kept = (who: string, value: "helpful" | "not_helpful" | "none", at = "2026-10-01T00:00:00Z") => ({
  feedback: `fb_01JC${String(++seq).padStart(22, "0")}`,
  at,
  vote: value,
  contributor: ctr(who),
  device: `dev-${who}`,
});

const MATCHES = new Map([[PLACE, new Set([LAKE, JETTY])]]);

/** Runs the rules, with the Commons matches unless `matches` is null. */
function rules(pending: StoredFeedback[], extra: Partial<RulesInput> = {}, matches: ReadonlyMap<string, ReadonlySet<string>> | null = MATCHES) {
  const out = applyRules({
    now: NOW,
    pending,
    history: [],
    places: new Map([place(), place(OTHER)].map((p) => [p.id, p])),
    reviews: () => [],
    ...(matches ? { commonsMatches: matches } : {}),
    ...extra,
  });
  const decision = (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id);
  return { ...out, outcome: (item: StoredFeedback) => decision(item)?.outcome, reason: (item: StoredFeedback) => decision(item)?.reason };
}

describe("votes on Commons files", () => {
  it("counts helpful and not helpful votes per file, and publishes a count line for each file with votes", () => {
    const a = vote("kim", LAKE, "helpful");
    const b = vote("lee", LAKE, "not_helpful");
    const c = vote("amy", JETTY, "helpful");
    const d = vote("joe", JETTY, "none");
    const out = rules([a, b, c, d]);
    expect(out.reason(a)).toBe("Commons file marked helpful");
    expect(out.reason(b)).toBe("Commons file marked not helpful");
    expect(out.reason(d)).toBe("no vote to take back");
    expect(out.commonsCounts.get(PLACE)).toEqual([
      { place: PLACE, file: JETTY, helpful: 1, helpful_12m: 1 },
      { place: PLACE, file: LAKE, helpful: 1, helpful_12m: 1, not_helpful: 1, not_helpful_12m: 1 },
    ]);
    expect(out.commonsVotes.places[PLACE]![LAKE]!.map((v) => v.vote)).toEqual(["helpful", "not_helpful"]);
    expect(out.changes).toContainEqual(
      expect.objectContaining({ place: PLACE, automatic: true, summary: `Commons file ${LAKE} marked helpful by 1 (1 in the last 12 months), not helpful by 1 (1 in the last 12 months)` }),
    );
  });

  it("refuses a vote for a file not matched to the place, or on the do-not-match list", () => {
    const unmatched = vote("kim", ELSEWHERE);
    const listed = vote("lee", JETTY);
    const out = rules([unmatched, listed], { doNotMatch: [{ place: PLACE, file: JETTY }] });
    expect(out.reason(unmatched)).toBe(`Commons file ${ELSEWHERE} is not matched to this place`);
    expect(out.reason(listed)).toBe(`Commons file ${JETTY} is on the do-not-match list for this place`);
    expect(out.outcome(listed)).toBe("refused");
    expect(out.commonsVotes.places).toEqual({});
  });

  it("leaves votes waiting, and the counts as they are, when the run has no Commons matches", () => {
    const v = vote("kim", LAKE);
    const votes: CommonsVotes = { places: { [PLACE]: { [LAKE]: [kept("lee", "helpful", "2025-01-01T00:00:00Z")] } } };
    const counts: CommonsCounts[] = [{ place: PLACE, file: LAKE, helpful: 1, helpful_12m: 1 }];
    const out = rules([v], { commonsVotes: votes, commonsCounts: counts }, null);
    expect(out.outcome(v)).toBe("waiting");
    expect(out.reason(v)).toBe("the Commons matches are not in this checkout");
    expect(out.commonsCounts.size).toBe(0);
    expect(out.commonsVotes).toEqual(votes);
  });

  it("replaces a traveller's earlier vote on the same file, and removes the line when no votes count", () => {
    const votes: CommonsVotes = { places: { [PLACE]: { [LAKE]: [kept("kim", "not_helpful")] } } };
    const back = vote("kim", LAKE, "none");
    const out = rules([back], { commonsVotes: votes, commonsCounts: [{ place: PLACE, file: LAKE, not_helpful: 1, not_helpful_12m: 1 }] });
    expect(out.reason(back)).toBe("vote taken back");
    expect(out.commonsCounts.get(PLACE)).toEqual([]);
    expect(out.commonsVotes.places[PLACE]![LAKE]).toEqual([expect.objectContaining({ feedback: back.id, vote: "none" })]);
  });

  it("recounts as votes age, and stops counting a blocked contributor's votes", () => {
    const votes: CommonsVotes = { places: { [PLACE]: { [LAKE]: [kept("kim", "helpful", "2025-10-01T00:00:00Z"), kept("bad", "helpful")] } } };
    const out = rules([], { commonsVotes: votes, commonsCounts: [{ place: PLACE, file: LAKE, helpful: 2, helpful_12m: 2 }], blocked: new Set([ctr("bad")]) });
    expect(out.commonsCounts.get(PLACE)).toEqual([{ place: PLACE, file: LAKE, helpful: 1 }]);
    expect(out.commonsVotes.places[PLACE]![LAKE]!.map((v) => v.contributor)).toEqual([ctr("kim")]);
  });

  it("publishes no line for a file no longer matched or put on the do-not-match list, and keeps its votes", () => {
    const votes: CommonsVotes = { places: { [PLACE]: { [LAKE]: [kept("kim", "helpful")], [JETTY]: [kept("lee", "helpful")] } } };
    const counts: CommonsCounts[] = [
      { place: PLACE, file: JETTY, helpful: 1, helpful_12m: 1 },
      { place: PLACE, file: LAKE, helpful: 1, helpful_12m: 1 },
    ];
    const out = rules([], { commonsVotes: votes, commonsCounts: counts, commonsMatches: new Map([[PLACE, new Set([JETTY])]]), doNotMatch: [{ place: PLACE, file: JETTY }] });
    expect(out.commonsCounts.get(PLACE)).toEqual([]);
    expect(out.commonsVotes).toEqual(votes);
  });

  it("moves the votes of a place merged into another to that place", () => {
    const votes: CommonsVotes = { places: { [OTHER]: { [LAKE]: [kept("kim", "helpful")] } } };
    const out = rules([], {
      places: new Map([
        [PLACE, place()],
        [OTHER, place(OTHER, { status: "merged", merged_into: PLACE })],
      ]),
      commonsVotes: votes,
      commonsCounts: [{ place: OTHER, file: LAKE, helpful: 1, helpful_12m: 1 }],
    });
    expect(Object.keys(out.commonsVotes.places)).toEqual([PLACE]);
    expect(out.commonsCounts.get(PLACE)).toEqual([{ place: PLACE, file: LAKE, helpful: 1, helpful_12m: 1 }]);
    expect(out.commonsCounts.get(OTHER)).toEqual([]);
  });
});

describe("votes on Commons files in a photo repository run", () => {
  let root: string;
  let inbox: string;
  let photos: string;
  let ocdb: string;

  async function put(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "commons-votes-"));
    inbox = join(root, "inbox");
    photos = join(root, "photos");
    ocdb = join(root, "ocdb");
    await mkdir(photos, { recursive: true });
    await put(join(ocdb, "places", "za", `${PLACE}.json`), dumpPlace(place()));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the votes in the inbox and writes the place's count lines to the photo repository", async () => {
    await put(join(ocdb, "commons", "matches.ndjson"), `${JSON.stringify({ checked: "2026-11-01", files: [{ file: LAKE }, { file: JETTY }], place: PLACE, rules: 2 })}\n`);
    await put(join(ocdb, "moderation", "commons-do-not-match.json"), `${JSON.stringify({ pairs: [{ added: "2026-10-01T00:00:00Z", file: JETTY, place: PLACE, source: "reports" }] })}\n`);
    const v = vote("kim", LAKE, "not_helpful");
    const listed = vote("lee", JETTY);
    for (const item of [v, listed]) await put(join(inbox, "pending", "2026-11-02", `${item.id}.json`), JSON.stringify(item));
    const summary = await run({ inbox, data: photos, places: ocdb, now: new Date(NOW) });
    expect(summary.refused).toEqual([listed.id]);
    expect(summary.inbox_changed).toBe(true);
    expect(summary.auto_files).toEqual([`commons/${PLACE}.ndjson`]);
    expect(await readFile(join(photos, "commons", `${PLACE}.ndjson`), "utf8")).toBe(
      `${JSON.stringify({ file: LAKE, not_helpful: 1, not_helpful_12m: 1, place: PLACE })}\n`,
    );
    const ledger = JSON.parse(await readFile(join(inbox, COMMONS_VOTES_FILE), "utf8")) as CommonsVotes;
    expect(ledger.places[PLACE]![LAKE]).toEqual([{ feedback: v.id, at: v.received, vote: "not_helpful", contributor: ctr("kim"), device: "dev-kim" }]);
  });

  it("leaves a vote pending when the places checkout has no Commons matches", async () => {
    const v = vote("kim", LAKE);
    await put(join(inbox, "pending", "2026-11-02", `${v.id}.json`), JSON.stringify(v));
    const summary = await run({ inbox, data: photos, places: ocdb, now: new Date(NOW) });
    expect(summary.decisions).toEqual([expect.objectContaining({ id: v.id, outcome: "waiting" })]);
    expect(summary.auto_files).toEqual([]);
    await expect(readFile(join(inbox, "pending", "2026-11-02", `${v.id}.json`), "utf8")).resolves.toContain(LAKE);
  });
});
