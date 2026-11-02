import { describe, expect, it } from "vitest";
import { FEE_SITES, createFeedbackClient, validateSubmission, type FetchLike, type StorageAdapter } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const NOW = new Date("2026-11-02T03:00:00Z");
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true, contributor: CONTRIBUTOR };
const fee = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  validateSubmission({ ...base, type: "fee", place: PLACE, fee: { amount: 35, site: "powered", paid: "2026-10", ...body }, ...extra }, NOW);

describe("fee validation", () => {
  it("accepts a fee and keeps only the known fields", () => {
    const r = fee({ amount: 42.5, site: "unpowered", paid: "2026-11", extra: "x" });
    expect(r).toEqual({
      ok: true,
      value: { ...base, type: "fee", place: PLACE, fee: { amount: 42.5, site: "unpowered", paid: "2026-11" } },
    });
  });

  it("lists the site types", () => {
    expect(FEE_SITES).toEqual(["unpowered", "powered", "cabin"]);
    for (const site of FEE_SITES) expect(fee({ site }).ok).toBe(true);
  });

  it.each([0, -5, 1000.01, 1001, 12.345, Number.NaN, Infinity, "35", null])("refuses amount %j", (amount) => {
    expect(fee({ amount })).toEqual({
      ok: false,
      errors: ["fee.amount must be more than 0 and at most 1000 dollars, with at most 2 decimal places"],
    });
  });

  it.each([0.01, 12.34, 19.99, 1000])("accepts amount %j", (amount) => {
    expect(fee({ amount }).ok).toBe(true);
  });

  it("refuses an unknown site type", () => {
    expect(fee({ site: "tent" })).toEqual({ ok: false, errors: ["fee.site must be one of unpowered, powered, cabin"] });
  });

  it.each(["2026-1", "2026-13", "26-10", "2026-10-01", 202610])("refuses paid %j", (paid) => {
    expect(fee({ paid })).toEqual({ ok: false, errors: ["fee.paid must be YYYY-MM"] });
  });

  it("refuses a month in the future", () => {
    expect(fee({ paid: "2026-12" })).toEqual({ ok: false, errors: ["fee.paid must not be in the future"] });
  });

  it("accepts the next month once it has started in the furthest time zone ahead of UTC", () => {
    const lastDayUtc = new Date("2026-10-31T11:00:00Z"); // already 1 November in UTC+14
    const r = validateSubmission({ ...base, type: "fee", place: PLACE, fee: { amount: 35, site: "powered", paid: "2026-11" } }, lastDayUtc);
    expect(r.ok).toBe(true);
  });

  it("accepts 24 months ago and refuses 25", () => {
    expect(fee({ paid: "2024-11" }).ok).toBe(true);
    expect(fee({ paid: "2024-10" })).toEqual({ ok: false, errors: ["fee.paid must be within the last 24 months"] });
  });

  it("needs a place id and refuses a location", () => {
    expect(fee({}, { place: null })).toMatchObject({ ok: false, errors: ["place is required for a fee"] });
    expect(fee({}, { place: "camp_1" }).ok).toBe(false);
    expect(fee({}, { location: { lat: -36.8, lon: 144.5 } })).toMatchObject({ ok: false, errors: ["location is not allowed on a fee"] });
  });

  it("refuses a missing fee body, and a fee body on another type", () => {
    expect(validateSubmission({ ...base, type: "fee", place: PLACE }, NOW)).toEqual({ ok: false, errors: ["fee must be an object"] });
    const r = validateSubmission(
      { ...base, type: "check", place: PLACE, check: { visited: "2026-10-01", still_there: true }, fee: { amount: 1, site: "cabin", paid: "2026-10" } },
      NOW,
    );
    expect(r).toEqual({ ok: false, errors: ["fee is not allowed when type is check"] });
  });
});

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

describe("client fee()", () => {
  function setup() {
    const calls: { body: string }[] = [];
    const fetch: FetchLike = async (_url, init) => {
      calls.push({ body: init.body });
      return { status: 202, json: async () => ({ id: "fb_1" }), headers: { get: () => null } };
    };
    const client = createFeedbackClient({
      endpoint: "https://intake.example",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: memoryStorage(),
      fetch,
      now: () => NOW.getTime(),
    });
    return { client, calls };
  }

  it("sends a fee with the contributor", async () => {
    const { client, calls } = setup();
    const result = await client.fee({ place: PLACE, fee: { amount: 28, site: "unpowered", paid: "2026-10" }, contributor: CONTRIBUTOR, consent: true });
    expect(result).toEqual({ status: "sent", id: "fb_1" });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      type: "fee",
      place: PLACE,
      contributor: CONTRIBUTOR,
      fee: { amount: 28, site: "unpowered", paid: "2026-10" },
      consent: true,
    });
  });

  it("checks the month against the client's clock and needs consent", async () => {
    const { client, calls } = setup();
    await expect(client.fee({ place: PLACE, fee: { amount: 28, site: "cabin", paid: "2026-12" }, consent: true })).rejects.toThrow(
      /must not be in the future/,
    );
    await expect(client.fee({ place: PLACE, fee: { amount: 28, site: "cabin", paid: "2026-10" }, consent: false })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
