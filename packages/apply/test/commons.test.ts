import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyRules, type RulesInput } from "../src/rules.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const FILE = "Brunswick River and Pool Precinct 6.jpg";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

const place: Place = {
  id: PLACE,
  name: "Brunswick Heads Caravan Park",
  kind: "caravan_park",
  group: "overnight",
  location: { lat: -28.54, lon: 153.55 },
  osm: { type: "way", id: 9, version: 4 },
  facts: {},
  status: "open",
  rating: null,
  fact_sources: {},
  updated: "2026-10-01T00:00:00Z",
};

let seq = 0;
function mismatch(day: number, origin: string, extra: Record<string, unknown> = {}): StoredFeedback {
  seq += 1;
  return {
    id: `fb_01JF${String(seq).padStart(22, "0")}`,
    received: at(day),
    app: "example-app",
    place: PLACE,
    device: `dev-${origin}`,
    origin,
    app_version: "1.0.0",
    consent: true,
    type: "report",
    report: { kind: "commons_mismatch", file: FILE },
    intake: { state: "held", held_reason: "commons_report" },
    ...extra,
  } as StoredFeedback;
}
const attested = (item: StoredFeedback) => ({ ...item, attested: "app_attest", contributor: "ctr_00000000000000aa" }) as StoredFeedback;
const applied = (item: StoredFeedback) => ({ ...item, outcome: { result: "needs_review", reason: "", run: at(0) } }) as unknown as StoredFeedback;
const run = (pending: StoredFeedback[], extra: Partial<RulesInput> = {}) =>
  applyRules({ now: at(1), pending, history: [], places: new Map([[PLACE, place]]), reviews: () => [], ...extra });

describe("a Commons photo that is not of this place", () => {
  it("is a case for a reviewer when one traveller reports it", () => {
    const item = attested(mismatch(0, "net-a"));
    const out = run([item]);
    expect(out.decisions).toEqual([{ id: item.id, place: PLACE, outcome: "needs_review", reason: "one source reports the Commons photo, so a reviewer looks" }]);
    expect(out.held).toEqual([{ case: "commons_mismatch", place: PLACE, location: place.location, kind: "caravan_park", file: FILE, sources: 1, feedback: [item.id] }]);
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: item.id }]);
    expect(out.doNotMatch).toEqual([]);
  });

  it("goes on the do-not-match list when two sources within 90 days report it, one attested", () => {
    const first = mismatch(-20, "net-a");
    const second = attested(mismatch(0, "net-b"));
    const out = run([second], { history: [applied(first)] });
    expect(out.doNotMatch).toEqual([{ place: PLACE, file: FILE, added: at(1).slice(0, 10), source: "reports" }]);
    expect(out.decisions).toEqual([{ id: second.id, place: PLACE, outcome: "applied", reason: "the Commons photo goes on the do-not-match list after reports from 2 sources" }]);
    expect(out.changes).toEqual([expect.objectContaining({ place: PLACE, automatic: true, feedback: [first.id, second.id] })]);
    expect(out.held).toEqual([]);
  });

  it("waits for a reviewer when the sources are one network, none is attested, or the first is older than 90 days", () => {
    const cases: [StoredFeedback[], StoredFeedback][] = [
      [[applied(mismatch(-2, "net-a"))], attested(mismatch(0, "net-a"))],
      [[applied(mismatch(-2, "net-a"))], mismatch(0, "net-b")],
      [[applied(attested(mismatch(-95, "net-a")))], mismatch(0, "net-b")],
    ];
    for (const [history, item] of cases) {
      const out = run([item], { history });
      expect(out.doNotMatch).toEqual([]);
      expect(out.decisions[0]!.outcome).toBe("needs_review");
      expect(out.held[0]).toMatchObject({ case: "commons_mismatch", file: FILE });
    }
  });

  it("changes nothing for a pair already on the list", () => {
    const item = attested(mismatch(0, "net-a"));
    const out = run([item], { doNotMatch: [{ place: PLACE, file: FILE }] });
    expect(out.decisions[0]).toMatchObject({ outcome: "applied", reason: "the Commons photo is on the do-not-match list already" });
    expect(out.held).toEqual([]);
    expect(out.doNotMatch).toEqual([]);
  });
});

describe("commons_mismatch cases for a reviewer", async () => {
  const { allowedDecisions, applyDecision, heldCaseKey, parseHeldCases, settleByRules, withDoNotMatch } = await import("../src/review.js");
  const { reviewPrBody } = await import("../src/prbody.js");
  const c = { case: "commons_mismatch" as const, place: PLACE, location: place.location, kind: "caravan_park", file: FILE, sources: 1, feedback: ["fb_01JF0000000000000000000001"] };

  it("reads back from the review PR body, keyed by its file", () => {
    expect(parseHeldCases(reviewPrBody(at(1), [], new Map(), [], [c]))).toEqual([c]);
    expect(parseHeldCases(`- held-case ${JSON.stringify({ ...c, file: "" })}`)).toEqual([]);
    expect(heldCaseKey(c)).not.toBe(heldCaseKey({ ...c, file: "Other.jpg" }));
  });

  it("lets a reviewer confirm the photo is not of the place, dismiss the report, or leave it", () => {
    expect(allowedDecisions(c)).toEqual(["confirm", "dismiss", "leave"]);
    expect(settleByRules(c, place)).toBeNull();
    expect(applyDecision(place, c, "confirm", at(1))).toBeNull();
  });

  it("leaves a pair already on the list", () => {
    expect(settleByRules(c, place, { doNotMatch: [{ place: PLACE, file: FILE }] })).toEqual({ decision: "leave", reason: "the Commons photo is on the do-not-match list already" });
  });

  it("writes the do-not-match list sorted, with the keys in order, keeping what is there", () => {
    const first = withDoNotMatch(undefined, [{ place: PLACE, file: "B.jpg", added: "2026-11-05", source: "reports" }]);
    const text = withDoNotMatch(first, [
      { place: PLACE, file: "A.jpg", added: "2026-11-06", source: "reviewer" },
      { place: PLACE, file: "B.jpg", added: "2026-11-06", source: "reviewer" },
    ]);
    expect(text).toBe(
      `${JSON.stringify(
        {
          pairs: [
            { added: "2026-11-06", file: "A.jpg", place: PLACE, source: "reviewer" },
            { added: "2026-11-05", file: "B.jpg", place: PLACE, source: "reports" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    expect(withDoNotMatch(text, [{ place: PLACE, file: "A.jpg", added: "2026-11-07", source: "reports" }])).toBe(text);
  });
});

describe("the do-not-match list in a run", async () => {
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { dirname, join } = await import("node:path");
  const { run } = await import("../src/run.js");
  const { dumpPlace } = await import("../src/serialise.js");
  const put = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
  };

  it("adds the pair to moderation/commons-do-not-match.json in the automatic checkout after two sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocdb-commons-"));
    try {
      const inbox = join(root, "inbox");
      const data = join(root, "data");
      await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace(place));
      for (const item of [mismatch(0, "net-a"), attested(mismatch(0.5, "net-b"))]) {
        await put(join(inbox, "pending", item.received.slice(0, 10), `${item.id}.json`), JSON.stringify(item));
      }
      const summary = await run({ inbox, data, now: new Date(at(1)) });
      expect(summary.auto_files).toEqual(["moderation/commons-do-not-match.json"]);
      expect(JSON.parse(await readFile(join(data, "moderation", "commons-do-not-match.json"), "utf8"))).toEqual({
        pairs: [{ added: at(1).slice(0, 10), file: FILE, place: PLACE, source: "reports" }],
      });
      expect(summary.auto_changed).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
