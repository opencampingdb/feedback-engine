import { describe, expect, it } from "vitest";
import { copyToD1 } from "../src/copy-to-d1.js";
import { getPlace, insertEvidence, listPlaces, removePlaces, setBlockList, type StoredPlace } from "../src/recent.js";
import { fakeD1 } from "./fake-d1.js";
import { listableKv, type FakeKv } from "./fake-kv.js";
import { addKvEvidence, addKvPlace, listPlacesFromKv, setKvBlocked } from "./kv-recent-list.js";

const NOW = "2026-11-03T09:00:00Z";
/** When the first copy started. Everything `storeInKv` writes is from before it. */
const FIRST_COPY = "2026-11-03T08:00:00Z";

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
async function storeInKv(kv: FakeKv) {
  await addKvPlace(kv, place("plain", -33.5, 151.2));
  await addKvPlace(kv, place("checked", -33.6, 151.3));
  await addKvEvidence(kv, "checked", "fb_c1", { type: "check", check: check("dev_x") });
  await addKvEvidence(kv, "checked", "fb_c2", { type: "check", check: check("dev_y") });
  await addKvPlace(kv, place("reported", -33.7, 151.4));
  await addKvEvidence(kv, "reported", "fb_r1", { type: "report", report: report("dev_x") });
  await addKvEvidence(kv, "reported", "fb_r2", { type: "report", report: report("dev_y") });
  await addKvPlace(kv, place("withdrawn", -33.8, 151.5));
  await addKvEvidence(kv, "withdrawn", "fb_w1", { type: "withdraw", at: "2026-11-02T09:00:00Z" });
  await addKvPlace(kv, place("blocked", -33.9, 151.6, { contributor: "ctr_bad" }));
  await setKvBlocked(kv, ["ctr_bad", "ctr_other"]);
  await addKvPlace(kv, place("long", -34.0, 151.7, { name: "N".repeat(1100) }));
  await addKvPlace(kv, place("attested", -34.1, 151.8, { attest_key: "att_1" }));
  await addKvEvidence(kv, "attested", "fb_c3", { type: "check", check: check("dev_x", false) });
  await addKvPlace(kv, place("west", -31.9, 115.9));
  await addKvEvidence(kv, "gone", "fb_c4", { type: "check", check: check("dev_x") });
}

describe("copying the recent list from KV to D1", () => {
  it("copies a new place so the D1 recent list serves it", async () => {
    const kv = listableKv();
    const db = fakeD1();
    await addKvPlace(kv, {
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
    await copyToD1(kv, db, { since: FIRST_COPY });

    expect((await listPlaces(db, NOW)).map((p) => p.id).sort()).toEqual(["attested", "checked", "long"]);
  });

  describe("the copy after the deploy, from when the first copy started", () => {
    it("leaves a place the apply run removed from D1 removed", async () => {
      const kv = listableKv();
      const db = fakeD1();
      await storeInKv(kv);
      await copyToD1(kv, db);

      await removePlaces(db, ["plain"]);
      await copyToD1(kv, db, { since: FIRST_COPY });

      expect((await listPlaces(db, NOW)).map((p) => p.id)).not.toContain("plain");
      expect(await getPlace(db, "plain")).toBeUndefined();
    });

    it("keeps a place withdrawn after the first copy off the list", async () => {
      const kv = listableKv();
      const db = fakeD1();
      await storeInKv(kv);
      await copyToD1(kv, db);

      // The adder withdraws it through the new intake, and the apply run then takes it out.
      await insertEvidence(db, "plain", "fb_w9", { kind: "withdraw", at: "2026-11-03T08:30:00Z" });
      await removePlaces(db, ["plain"]);
      await copyToD1(kv, db, { since: FIRST_COPY });

      expect((await listPlaces(db, NOW)).map((p) => p.id)).not.toContain("plain");
    });

    it("leaves a contributor taken off the block list in D1 off it", async () => {
      const kv = listableKv();
      const db = fakeD1();
      await storeInKv(kv);
      await copyToD1(kv, db);
      expect((await listPlaces(db, NOW)).map((p) => p.id)).not.toContain("blocked");

      await setBlockList(db, []);
      const count = await copyToD1(kv, db, { since: FIRST_COPY });

      expect(count.blocked).toBe(0);
      expect((await listPlaces(db, NOW)).map((p) => p.id)).toContain("blocked");
    });

    it("copies a place, and evidence, written to KV after the first copy started", async () => {
      const kv = listableKv();
      const db = fakeD1();
      await storeInKv(kv);
      await copyToD1(kv, db);

      // The old intake, still live until the deploy, takes a new place and a check on an older one.
      await addKvPlace(kv, place("late", -33.4, 151.1, { added: "2026-11-03T08:10:00Z" }));
      await addKvEvidence(kv, "plain", "fb_c9", { type: "check", check: { ...check("dev_p"), day: "2026-11-03T08:20:00Z" } });
      await addKvEvidence(kv, "plain", "fb_c10", { type: "check", check: { ...check("dev_q"), day: "2026-11-03T08:20:00Z" } });
      expect(await copyToD1(kv, db, { since: FIRST_COPY })).toEqual({ places: 1, evidence: 2, blocked: 0 });

      const listed = await listPlaces(db, NOW);
      expect(listed.find((p) => p.id === "late")?.standing).toBe("shown");
      expect(listed.find((p) => p.id === "plain")?.standing).toBe("confirmed");
    });

    it("refuses a since that is not a time", async () => {
      await expect(copyToD1(listableKv(), fakeD1(), { since: "yesterday" })).rejects.toThrow(/not a time/);
    });
  });

  it("keeps the registered key the adder's withdraw is checked against", async () => {
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
