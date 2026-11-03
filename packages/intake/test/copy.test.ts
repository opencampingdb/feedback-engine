import { describe, expect, it } from "vitest";
import { copyToD1 } from "../src/copy-to-d1.js";
import { addEvidence, addPlace, setBlocked, type ListableKV } from "../src/recent-kv.js";
import { getPlace, insertEvidence, listPlaces, setBlockList, type StoredPlace } from "../src/recent.js";
import { fakeD1 } from "./fake-d1.js";
import { listableKv } from "./fake-kv.js";
import { listPlacesFromKv } from "./kv-recent-list.js";

const NOW = "2026-11-03T09:00:00Z";

const place = (id: string, lat: number, lon: number, more: Partial<StoredPlace> = {}): StoredPlace => ({
  id,
  location: { lat, lon },
  kind: "campground",
  name: `Place ${id}`,
  added: "2026-11-02T08:00:00Z",
  contributor: `ctr_${id}`,
  device: `dev_${id}`,
  ...more,
});
const check = (device: string, stillThere = true) => ({ device, stillThere, nearby: true, day: "2026-11-03T07:00:00Z" });
const report = (device: string) => ({ device, reason: "not_there" as const, day: "2026-11-03T07:30:00Z" });

/**
 * A KV recent list with one place of each kind: plain, confirmed by checks,
 * hidden by removal reports, withdrawn by its adder, added by a blocked
 * contributor, with a name too long for metadata, attested, and in another
 * state, plus evidence whose place has gone.
 */
async function storeInKv(kv: ListableKV) {
  await addPlace(kv, place("plain", -33.5, 151.2));
  await addPlace(kv, place("checked", -33.6, 151.3));
  await addEvidence(kv, "checked", "fb_c1", { type: "check", check: check("dev_x") });
  await addEvidence(kv, "checked", "fb_c2", { type: "check", check: check("dev_y") });
  await addPlace(kv, place("reported", -33.7, 151.4));
  await addEvidence(kv, "reported", "fb_r1", { type: "report", report: report("dev_x") });
  await addEvidence(kv, "reported", "fb_r2", { type: "report", report: report("dev_y") });
  await addPlace(kv, place("withdrawn", -33.8, 151.5));
  await addEvidence(kv, "withdrawn", "fb_w1", { type: "withdraw", at: "2026-11-02T09:00:00Z" });
  await addPlace(kv, place("blocked", -33.9, 151.6, { contributor: "ctr_bad" }));
  await setBlocked(kv, ["ctr_bad", "ctr_other"]);
  await addPlace(kv, place("long", -34.0, 151.7, { name: "N".repeat(1100) }));
  await addPlace(kv, place("attested", -34.1, 151.8, { attest_key: "att_1" }));
  await addEvidence(kv, "attested", "fb_c3", { type: "check", check: check("dev_x", false) });
  await addPlace(kv, place("west", -31.9, 115.9));
  await addEvidence(kv, "gone", "fb_c4", { type: "check", check: check("dev_x") });
}

describe("copying the recent list from KV to D1", () => {
  it("copies a new place so the D1 recent list serves it", async () => {
    const kv = listableKv();
    const db = fakeD1();
    await addPlace(kv, {
      id: "np_01",
      location: { lat: -33.5, lon: 151.2 },
      kind: "campground",
      name: "Creek Flat",
      added: "2026-11-03T08:00:00Z",
      contributor: "ctr_a",
      device: "dev_a",
    });

    await copyToD1(kv, db);

    expect(await listPlaces(db, NOW)).toEqual([
      {
        id: "np_01",
        location: { lat: -33.5, lon: 151.2 },
        kind: "campground",
        name: "Creek Flat",
        standing: "shown",
        added: "2026-11-03T08:00:00Z",
        contributor: "ctr_a",
      },
    ]);
  });

  it("answers the same recent list from D1 as KV did, with and without a box", async () => {
    const kv = listableKv();
    const db = fakeD1();
    await storeInKv(kv);
    const box = [151, -34, 152, -33] as const;
    const fromKv = await listPlacesFromKv(kv, NOW);
    const fromKvInBox = await listPlacesFromKv(kv, NOW, [...box]);

    await copyToD1(kv, db);

    const fromD1 = await listPlaces(db, NOW);
    expect(fromD1.map((p) => [p.id, p.standing]).sort()).toEqual([
      ["attested", "shown"],
      ["checked", "confirmed"],
      ["long", "shown"],
      ["plain", "shown"],
      ["west", "shown"],
    ]);
    expect(fromD1.find((p) => p.id === "long")?.name).toBe("N".repeat(1100));
    expect(sorted(fromD1)).toEqual(sorted(fromKv));
    expect(sorted(await listPlaces(db, NOW, [...box]))).toEqual(sorted(fromKvInBox));
  });

  it("leaves each place, piece of evidence and blocked contributor once when run twice", async () => {
    const kv = listableKv();
    const db = fakeD1();
    await storeInKv(kv);

    expect(await copyToD1(kv, db)).toEqual({ places: 8, evidence: 6, blocked: 2 });
    const first = await listPlaces(db, NOW);
    await copyToD1(kv, db);

    const count = (table: string) => (db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([count("new_places"), count("evidence"), count("blocked_contributors")]).toEqual([8, 6, 2]);
    expect(await listPlaces(db, NOW)).toEqual(first);
  });

  it("keeps what the new intake wrote to D1 between the two copies", async () => {
    const kv = listableKv();
    const db = fakeD1();
    await storeInKv(kv);
    await copyToD1(kv, db);

    // After the deploy: a new removal report hides "plain", and the apply run sends a longer block list.
    await insertEvidence(db, "plain", "fb_r9", { kind: "removal_report", report: report("dev_p") });
    await insertEvidence(db, "plain", "fb_r10", { kind: "removal_report", report: report("dev_q") });
    await setBlockList(db, ["ctr_bad", "ctr_other", "ctr_west"]);
    await copyToD1(kv, db);

    expect((await listPlaces(db, NOW)).map((p) => p.id).sort()).toEqual(["attested", "checked", "long"]);
  });

  it("keeps the attestation key the adder's withdraw is checked against", async () => {
    const kv = listableKv();
    const db = fakeD1();
    await storeInKv(kv);

    await copyToD1(kv, db);

    expect((await getPlace(db, "attested"))?.attest_key).toBe("att_1");
    expect((await getPlace(db, "plain"))?.attest_key).toBeUndefined();
  });

  it("lists the KV keys in one pass", async () => {
    const kv = listableKv();
    await storeInKv(kv);
    const keys = [...kv.data.keys()].filter((k) => k.startsWith("np:")).length;

    await copyToD1(kv, fakeD1());

    // The fake KV pages two keys at a time.
    expect(kv.lists).toBe(Math.ceil(keys / 2));
  });
});

const sorted = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => a.id.localeCompare(b.id));
