import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { decideClear, sameSender, type PlaceState, type ReportItem, type Setter } from "../src/decide.js";
import { applyRules } from "../src/rules.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

let seq = 0;
function clear(day: number, device: string, fact = "facebook", extra: Record<string, unknown> = {}): ReportItem {
  seq += 1;
  return {
    id: `fb_01JE${String(seq).padStart(22, "0")}`,
    received: at(day),
    app: "example-app",
    place: PLACE,
    device,
    app_version: "1.0.0",
    consent: true,
    attested: "app_attest",
    contributor: "ctr_00000000000000aa",
    type: "report",
    report: { kind: "clear", fact },
    ...extra,
  } as unknown as ReportItem;
}
const setter = (day: number, device: string, extra: Partial<Setter> = {}): Setter => ({ device, received: at(day), ...extra });

function state(overrides: Partial<PlaceState> = {}): PlaceState {
  return {
    facts: { facebook: "https://www.facebook.com/wrongpark", brand: "ingenia", power: true, pets: "seasonal", pets_months: "May-Sep", website: "https://example.com" },
    fact_sources: { facebook: "feedback", brand: "feedback", power: "osm", pets: "feedback", pets_months: "feedback", website: "owner" },
    fact_dates: { facebook: at(-5), brand: at(-5), pets: at(-5), pets_months: at(-5), website: at(-5) },
    ...overrides,
  };
}

describe("decideClear", () => {
  it("clears a value its own sender set, as their correction would", () => {
    expect(decideClear({ item: clear(0, "dev-a"), place: state(), setter: setter(-5, "dev-a") })).toEqual({
      verdict: "live",
      changes: [{ place: PLACE, fact: "facebook", value: null }],
      why: "facebook cleared by the traveller who set it",
    });
  });

  it("clears every kind of fact, the brand among them", () => {
    expect(decideClear({ item: clear(0, "dev-a", "brand"), place: state(), setter: setter(-5, "dev-a") })).toMatchObject({
      verdict: "live",
      changes: [{ place: PLACE, fact: "brand", value: null }],
    });
  });

  it("takes pets_months off with pets", () => {
    expect(decideClear({ item: clear(0, "dev-a", "pets"), place: state(), setter: setter(-5, "dev-a") })).toMatchObject({
      verdict: "live",
      changes: [
        { place: PLACE, fact: "pets", value: null },
        { place: PLACE, fact: "pets_months", value: null },
      ],
    });
  });

  it("holds a clear of a value another sender set, for a person", () => {
    expect(decideClear({ item: clear(0, "dev-b"), place: state(), setter: setter(-5, "dev-a") })).toEqual({
      verdict: "held",
      reason: "not_own_value",
      why: "facebook was not set by this traveller, so a person decides",
    });
  });

  it("holds a clear when the setter is not known", () => {
    expect(decideClear({ item: clear(0, "dev-a"), place: state(), setter: undefined })).toMatchObject({ verdict: "held", reason: "not_own_value" });
  });

  it("never clears a value from OSM or the owner", () => {
    expect(decideClear({ item: clear(0, "dev-a", "power"), place: state(), setter: setter(-5, "dev-a") })).toEqual({
      verdict: "held",
      reason: "protected_source",
      why: "power came from OSM, so a person decides",
    });
    expect(decideClear({ item: clear(0, "dev-a", "website"), place: state(), setter: setter(-5, "dev-a") })).toEqual({
      verdict: "held",
      reason: "owner_value",
      why: "website was set by the owner, so a person decides",
    });
  });

  it("holds a value a data rule set", () => {
    const place = state({ facts: { pets: "no" }, fact_sources: { pets: "rule" }, fact_dates: {} });
    expect(decideClear({ item: clear(0, "dev-a", "pets"), place, setter: setter(-5, "dev-a") })).toMatchObject({ verdict: "held", reason: "not_own_value" });
  });

  it("clears a contact the sender gave with a new place", () => {
    const place = state({ fact_sources: { ...state().fact_sources, facebook: "contributed" } });
    expect(decideClear({ item: clear(0, "dev-a"), place, setter: setter(-5, "dev-a") })).toMatchObject({ verdict: "live" });
  });

  it("holds an own clear without attestation for a person", () => {
    const item = { ...clear(0, "dev-a"), attested: undefined } as unknown as ReportItem;
    expect(decideClear({ item, place: state(), setter: setter(-5, "dev-a") })).toEqual({
      verdict: "held",
      reason: "not_attested",
      why: "clearing facebook without attestation is read by a person",
    });
  });

  it("refuses a clear sent before the value was set", () => {
    expect(decideClear({ item: clear(-6, "dev-a"), place: state(), setter: setter(-5, "dev-a") })).toEqual({
      verdict: "refused",
      reason: "no_value",
      why: "facebook was set again after the clear was sent",
    });
  });

  it("is live with nothing to change when the place does not have the fact", () => {
    expect(decideClear({ item: clear(0, "dev-a", "instagram"), place: state(), setter: undefined })).toEqual({
      verdict: "live",
      changes: [],
      why: "place has no instagram",
    });
  });

  it("refuses a fact name that is not a fact", () => {
    expect(decideClear({ item: clear(0, "dev-a", "colour"), place: state(), setter: undefined })).toMatchObject({ verdict: "refused", reason: "invalid_value" });
  });
});

describe("sameSender", () => {
  it("matches the device, the attested key, or a contributor proved on both", () => {
    expect(sameSender({ device: "a" }, { device: "a" })).toBe(true);
    expect(sameSender({ device: "a", attest_key: "ak_1" }, { device: "b", attest_key: "ak_1" })).toBe(true);
    expect(sameSender({ device: "a", contributor: "ctr_1", proved: true }, { device: "b", contributor: "ctr_1", proved: true })).toBe(true);
  });

  it("does not match a contributor without proof, or a missing attested key", () => {
    expect(sameSender({ device: "a", contributor: "ctr_1" }, { device: "b", contributor: "ctr_1" })).toBe(false);
    expect(sameSender({ device: "a", contributor: "ctr_1", proved: true }, { device: "b", contributor: "ctr_1" })).toBe(false);
    expect(sameSender({ device: "a" }, { device: "b" })).toBe(false);
  });
});

describe("clears in the apply", () => {
  const place = (): Place =>
    ({
      id: PLACE,
      name: "Example Holiday Park",
      kind: "caravan_park",
      group: "overnight",
      location: { lat: -33, lon: 151 },
      osm: null,
      facts: { facebook: "https://www.facebook.com/wrongpark", power: true },
      status: "open",
      rating: null,
      fact_sources: { facebook: "feedback", power: "osm" },
      fact_dates: { facebook: at(-5) },
      updated: at(-5),
    }) as Place;
  const setBy = (device: string, value = "https://www.facebook.com/wrongpark", extra: Record<string, unknown> = {}): StoredFeedback =>
    ({
      ...clear(-5, device),
      attest_key: `ak_${device}`,
      report: { kind: "fact", fact: "facebook", value },
      outcome: { result: "applied", run: at(-5) },
      ...extra,
    }) as unknown as StoredFeedback;
  const run = (pending: StoredFeedback[], history: StoredFeedback[]) =>
    applyRules({ now: at(1), pending, history, places: new Map([[PLACE, place()]]), reviews: () => [] });

  it("takes the value off at once when its sender clears it", () => {
    const item = clear(0, "dev-a");
    const out = run([item], [setBy("dev-a")]);
    expect(out.decisions).toEqual([expect.objectContaining({ id: item.id, outcome: "applied", reason: "facebook cleared by the traveller who set it" })]);
    const after = out.places.get(PLACE)!;
    expect(after.facts).toEqual({ power: true });
    expect(after.fact_sources.facebook).toBeUndefined();
    expect(after.fact_dates?.facebook).toBeUndefined();
  });

  it("matches the sender by attested key when the device differs", () => {
    const item = { ...clear(0, "dev-new"), attest_key: "ak_dev-a" } as ReportItem;
    expect(run([item], [setBy("dev-a")]).decisions[0]).toMatchObject({ outcome: "applied" });
  });

  it("sends a clear of someone else's value to a person and keeps it", () => {
    const item = clear(0, "dev-b");
    const out = run([item], [setBy("dev-a")]);
    expect(out.decisions[0]).toMatchObject({ outcome: "needs_review", reason: "facebook was not set by this traveller, so a person decides" });
    expect(out.places.get(PLACE)?.facts.facebook ?? place().facts.facebook).toBe("https://www.facebook.com/wrongpark");
  });

  it("treats a later confirmation from another sender as theirs", () => {
    const confirmed = { ...setBy("dev-b"), received: at(-2) } as StoredFeedback;
    expect(run([clear(0, "dev-a")], [setBy("dev-a"), confirmed]).decisions[0]).toMatchObject({ outcome: "needs_review" });
  });

  it("does not count a report that set an older value", () => {
    const older = setBy("dev-a", "https://www.facebook.com/olderpark");
    expect(run([clear(0, "dev-a")], [older]).decisions[0]).toMatchObject({ outcome: "needs_review" });
  });

  it("clears a value its sender set earlier in the same run", () => {
    const set = { ...clear(-1, "dev-a"), report: { kind: "fact", fact: "facebook", value: "https://www.facebook.com/otherpark" } } as unknown as ReportItem;
    const out = run([set, clear(0, "dev-a")], []);
    expect(out.decisions.map((d) => d.outcome)).toEqual(["applied", "applied"]);
    expect(out.places.get(PLACE)!.facts).toEqual({ power: true });
  });

  it("never clears an OSM value", () => {
    expect(run([clear(0, "dev-a", "power")], []).decisions[0]).toMatchObject({ outcome: "needs_review", reason: "power came from OSM, so a person decides" });
  });
});
