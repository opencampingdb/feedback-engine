import { describe, expect, it } from "vitest";
import { listChanges } from "../src/decide.js";
import { listPlaces } from "../src/recent.js";
import { fakeD1 } from "./fake-d1.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const A = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const B = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const C = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZC";

/** Recent changes as the send-time decision writes them, with a contributor the apply blocked. */
function fixture() {
  const store = fakeD1();
  const add = (id: string, place: string, fact: string, value: unknown, accepted: string, extra: { inData?: string; cell?: [number, number]; contributor?: string } = {}) =>
    store.db
      .prepare(
        "INSERT INTO recent_changes (feedback_id, place, fact, value, accepted, in_data_at, cell_lon, cell_lat, contributor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, place, fact, value === null ? null : JSON.stringify(value), accepted, extra.inData ?? null, extra.cell?.[0] ?? 146, extra.cell?.[1] ?? -37, extra.contributor ?? "ctr_0000000000000001");
  // A's toilets: three changes, the newest wins.
  add("fb_01", A, "toilets", false, "2026-11-06T10:00:00Z");
  add("fb_02", A, "toilets", true, "2026-11-07T09:00:00Z");
  add("fb_03", A, "toilets", null, "2026-11-05T09:00:00Z");
  // A's water: two at the same second, the larger feedback id wins.
  add("fb_10", A, "water", "potable", "2026-11-07T08:00:00Z");
  add("fb_11", A, "water", "none", "2026-11-07T08:00:00Z");
  // B's fee: the newest is from a blocked contributor, so the one before it is the latest shown.
  add("fb_20", B, "dogs", "on_lead", "2026-11-06T08:00:00Z");
  add("fb_21", B, "dogs", "no", "2026-11-07T08:00:00Z", { contributor: "ctr_00000000000000bb" });
  // B's toilets: in the data more than 7 days ago, so it is gone, and the older one with it.
  add("fb_30", B, "toilets", true, "2026-10-20T08:00:00Z", { inData: "2026-10-25T00:00:00Z" });
  // C, in another map cell: in the data within the 7 days, so still listed.
  add("fb_40", C, "toilets", true, "2026-11-04T08:00:00Z", { inData: "2026-11-05T00:00:00Z", cell: [150, -33] });
  store.db.prepare("INSERT INTO blocked_contributors (contributor) VALUES (?)").run("ctr_00000000000000bb");
  return store;
}

describe("the recent changes query", () => {
  it("lists the latest visible change for each place and fact, everywhere and within a box", async () => {
    const store = fixture();
    expect(await listChanges(store, NOW)).toEqual([
      { place: A, fact: "toilets", value: true, accepted: "2026-11-07T09:00:00Z", in_data_at: null },
      { place: A, fact: "water", value: "none", accepted: "2026-11-07T08:00:00Z", in_data_at: null },
      { place: B, fact: "dogs", value: "on_lead", accepted: "2026-11-06T08:00:00Z", in_data_at: null },
      { place: C, fact: "toilets", value: true, accepted: "2026-11-04T08:00:00Z", in_data_at: "2026-11-05T00:00:00Z" },
    ]);
    expect((await listChanges(store, NOW, [149.2, -33.8, 150.5, -32.9])).map((c) => c.place)).toEqual([C]);
    expect((await listChanges(store, NOW, [145.5, -37.5, 146.5, -36.5])).map((c) => `${c.place} ${c.fact}`)).toEqual([`${A} toilets`, `${A} water`, `${B} dogs`]);
  });

  it("reads each change once, through the place index or the cell index, with no search per row", async () => {
    const store = fixture();
    const plan = async (bbox?: [number, number, number, number]) => {
      const before = store.statements.length;
      await listChanges(store, NOW, bbox);
      const sql = store.statements[before]!;
      const args = bbox ? ["2026-10-31T12:00:00Z", 146, 146, -37, -37] : ["2026-10-31T12:00:00Z"];
      return (store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[]).map((r) => r.detail);
    };
    const everywhere = await plan();
    expect(everywhere).toContain("SCAN c USING INDEX recent_changes_place");
    expect(everywhere.filter((d) => /\b(SCAN|SEARCH) [cd]\b/.test(d))).toHaveLength(1);
    const inBox = await plan([145.5, -37.5, 146.5, -36.5]);
    expect(inBox.some((d) => d.startsWith("SEARCH c USING INDEX recent_changes_cell"))).toBe(true);
    expect(inBox.filter((d) => /\b(SCAN|SEARCH) [cd]\b/.test(d))).toHaveLength(1);
  });

  it("reads the new places once, with their evidence and the block list through their indexes", async () => {
    const store = fixture();
    const before = store.statements.length;
    await listPlaces(store, new Date(NOW).toISOString());
    const plan = (store.db.prepare(`EXPLAIN QUERY PLAN ${store.statements[before]!}`).all() as { detail: string }[]).map((r) => r.detail);
    // Every new place is in the answer, so the list reads them all, once, in id order.
    expect(plan).toContain("SCAN p USING INDEX sqlite_autoindex_new_places_1");
    expect(plan).toContain("SEARCH e USING INDEX evidence_place (place_id=?) LEFT-JOIN");
    expect(plan).toContain("SEARCH b USING COVERING INDEX sqlite_autoindex_blocked_contributors_1 (contributor=?)");
  });
});
