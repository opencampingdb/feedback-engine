import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import {
  decideContactReport,
  decideFact,
  distinctSources,
  inWindow,
  newPlaceFields,
  newPlaceListing,
  type PlaceState,
  type ReportItem,
} from "../src/decide.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

let seq = 0;
function base(day: number, device: string, placeId: string | null = PLACE) {
  seq += 1;
  return { id: `fb_01JD${String(seq).padStart(22, "0")}`, received: at(day), app: "example-app", place: placeId, device, app_version: "1.0.0", consent: true as const };
}

const fact = (day: number, device: string, name: string, value: unknown, extra: Record<string, unknown> = {}): ReportItem =>
  ({ ...base(day, device), type: "report", report: { kind: "fact", fact: name, value }, ...extra }) as ReportItem;
const attested = <T extends StoredFeedback>(item: T): T => ({ ...item, attested: "app_attest", contributor: "ctr_00000000000000aa" });
const contactReport = (day: number, device: string, name: string, reason = "spam", extra: Record<string, unknown> = {}): ReportItem =>
  ({ ...base(day, device), type: "report", report: { kind: "contact", fact: name, reason }, ...extra }) as ReportItem;

function state(overrides: Partial<PlaceState> = {}): PlaceState {
  return { facts: { power: false, website: "https://park.example.org" }, fact_sources: { power: "osm", website: "osm" }, ...overrides };
}

describe("decideFact", () => {
  it("refuses a fact or value that is not valid", () => {
    expect(decideFact({ item: attested(fact(0, "dev-a", "colour", "red")), place: state(), earlier: [] })).toEqual({
      verdict: "refused",
      reason: "invalid_value",
      why: 'colour = "red" is not a valid fact',
    });
    expect(decideFact({ item: attested(fact(0, "dev-a", "power", "yes")), place: state(), earlier: [] })).toMatchObject({ verdict: "refused", reason: "invalid_value" });
  });

  it("makes an attested report live with its change", () => {
    const item = attested(fact(0, "dev-a", "power", true));
    expect(decideFact({ item, place: state(), earlier: [] })).toEqual({
      verdict: "live",
      changes: [{ place: PLACE, fact: "power", value: true }],
      why: "power set to true",
    });
  });

  it("holds opening hours whose quoted comment fails the text checks", () => {
    const spam = attested(fact(0, "dev-a", "opening_hours", 'Mo-Su 08:00-17:00 "click here for a promo code"'));
    expect(decideFact({ item: spam, place: state(), earlier: [] })).toMatchObject({ verdict: "held", reason: "text_check" });
    const fine = attested(fact(0, "dev-a", "opening_hours", 'Mo-Su 08:00-17:00 "office closes at noon"'));
    expect(decideFact({ item: fine, place: state(), earlier: [] })).toMatchObject({ verdict: "live" });
  });

  it("holds an operator, a conditional charge's condition or a charge's unit that fails the text checks", () => {
    const held = { verdict: "held", reason: "text_check" };
    for (const [name, value] of [
      ["operator", "the owner is a wanker"],
      ["operator", "Best crypto tips on whatsapp"],
      ["charge_conditional", "10 AUD @ (the owner is a wanker)"],
      ["charge_conditional", "10 AUD/wanker @ (Dec-Jan)"],
      ["charge", "10 AUD/wanker"],
      ["charge_powered", "10 AUD/wanker/night"],
    ] as const) {
      expect(decideFact({ item: attested(fact(0, "dev-a", name, value)), place: state(), earlier: [] })).toMatchObject(held);
    }
    for (const [name, value] of [
      ["operator", "Example Shire Council"],
      ["charge_conditional", "10 AUD/person @ (Dec-Jan)"],
      ["charge", "15 AUD/vehicle/night"],
    ] as const) {
      expect(decideFact({ item: attested(fact(0, "dev-a", name, value)), place: state(), earlier: [] })).toMatchObject({ verdict: "live" });
    }
  });

  it("makes an attested contact that passes the link checks live", () => {
    const item = attested(fact(0, "dev-a", "phone", "03 5555 0100"));
    expect(decideFact({ item, place: state(), earlier: [] })).toMatchObject({ verdict: "live", changes: [{ place: PLACE, fact: "phone", value: "03 5555 0100" }] });
  });

  it("is live with no change when the place already has the value", () => {
    const item = attested(fact(0, "dev-a", "power", false));
    expect(decideFact({ item, place: state(), earlier: [] })).toEqual({ verdict: "live", changes: [], why: "power is already false" });
    const address = { street: "Lake Road", postcode: "3999" };
    const same = attested(fact(0, "dev-a", "address", { ...address }));
    expect(decideFact({ item: same, place: state({ facts: { address } }), earlier: [] })).toMatchObject({ verdict: "live", changes: [] });
  });

  it("holds a contact report without attestation for a person, even with the value the place has", () => {
    for (const value of ["https://other.example.org", "https://park.example.org"]) {
      const item = fact(0, "dev-a", "website", value);
      expect(decideFact({ item, place: state(), earlier: [] })).toEqual({ verdict: "held", reason: "not_attested", why: "website changes are checked by a person" });
    }
  });

  it("holds any other report without attestation for a second device, unless the place has the value", () => {
    expect(decideFact({ item: fact(0, "dev-a", "power", true), place: state(), earlier: [] })).toEqual({
      verdict: "held",
      reason: "not_attested",
      why: "waiting for a second device to agree on power",
    });
    expect(decideFact({ item: fact(0, "dev-a", "power", false), place: state(), earlier: [] })).toMatchObject({ verdict: "live", changes: [] });
  });

  it("holds a value the owner set", () => {
    const place = state({ fact_sources: { power: "owner", website: "owner" } });
    for (const item of [attested(fact(0, "dev-a", "power", true)), attested(fact(0, "dev-a", "website", "https://other.example.org"))]) {
      expect(decideFact({ item, place, earlier: [] })).toMatchObject({ verdict: "held", reason: "owner_value", why: expect.stringContaining("set by the owner") });
    }
  });

  it("holds a contact that fails the link checks, with the problem", () => {
    const item = attested(fact(0, "dev-a", "website", "https://bit.ly/lakecamp"));
    expect(decideFact({ item, place: state(), earlier: [] })).toEqual({
      verdict: "held",
      reason: "link_check",
      problem: "must not be a link shortener",
      why: "website fails the link checks (must not be a link shortener), so a person checks it",
    });
    const social = attested(fact(0, "dev-a", "facebook", "https://example.org/lakecamp"));
    expect(decideFact({ item: social, place: state(), earlier: [] })).toMatchObject({ verdict: "held", reason: "link_check" });
  });

  it("holds a report another source disagreed with in the 90 days before it", () => {
    const item = attested(fact(10, "dev-a", "power", true));
    const other = fact(5, "dev-b", "power", false);
    expect(decideFact({ item, place: state({ facts: {} }), earlier: [other] })).toEqual({
      verdict: "held",
      reason: "disagreement",
      why: "another device reported a different power, so a person decides",
    });
  });

  it("does not count the same source, the same value, a later report, an old report or another place or fact as disagreeing", () => {
    const item = attested(fact(100, "dev-a", "power", true, { origin: "net-1" }));
    const earlier: StoredFeedback[] = [
      item,
      fact(90, "dev-b", "power", false, { origin: "net-1" }),
      fact(90, "dev-c", "power", true),
      fact(101, "dev-d", "power", false),
      fact(9, "dev-e", "power", false),
      { ...fact(90, "dev-f", "power", false), place: OTHER } as StoredFeedback,
      fact(90, "dev-g", "toilets", false),
      contactReport(90, "dev-h", "website"),
    ];
    expect(decideFact({ item, place: state({ facts: {} }), earlier })).toMatchObject({ verdict: "live", changes: [{ fact: "power", value: true }] });
  });

  it("compares an address field by field when looking for disagreement", () => {
    const value = { street: "Lake Road", postcode: "3999" };
    const item = attested(fact(10, "dev-a", "address", value));
    const same = fact(5, "dev-b", "address", { ...value });
    expect(decideFact({ item, place: state(), earlier: [same] })).toMatchObject({ verdict: "live" });
    const different = fact(5, "dev-b", "address", { street: "Creek Road", postcode: "3999" });
    expect(decideFact({ item, place: state(), earlier: [different] })).toMatchObject({ verdict: "held", reason: "disagreement" });
  });
});

describe("decideContactReport", () => {
  it("refuses a report about a contact the place does not have", () => {
    const item = attested(contactReport(0, "dev-a", "phone"));
    expect(decideContactReport({ item, place: state(), earlier: [] })).toEqual({ verdict: "refused", reason: "no_value", why: "place has no phone" });
  });

  it("holds a report about a contact the owner set", () => {
    const item = attested(contactReport(0, "dev-a", "website"));
    const second = contactReport(0, "dev-b", "website");
    const place = state({ fact_sources: { website: "owner" } });
    expect(decideContactReport({ item, place, earlier: [second] })).toEqual({ verdict: "held", reason: "owner_value", why: "website was set by the owner, so a person decides" });
  });

  it("holds a report from one source for a person", () => {
    const item = attested(contactReport(1, "dev-a", "website", "wrong"));
    const sameNetwork = contactReport(0, "dev-b", "website", "spam");
    expect(decideContactReport({ item: { ...item, origin: "net-1" }, place: state(), earlier: [{ ...sameNetwork, origin: "net-1" } as StoredFeedback] })).toEqual({
      verdict: "held",
      reason: "unconfirmed",
      why: "a report that the website is wrong is read by a person",
    });
  });

  it("holds reports from two sources when none is attested", () => {
    const item = contactReport(1, "dev-a", "website");
    expect(decideContactReport({ item, place: state(), earlier: [contactReport(0, "dev-b", "website")] })).toMatchObject({ verdict: "held", reason: "unconfirmed" });
  });

  it("takes the contact down on reports from two sources, one attested", () => {
    const first = attested(contactReport(0, "dev-b", "website", "spam"));
    const item = contactReport(1, "dev-a", "website", "wrong");
    expect(decideContactReport({ item, place: state(), earlier: [first, item] })).toEqual({
      verdict: "live",
      changes: [{ place: PLACE, fact: "website", value: null }],
      why: "website taken down after reports from two sources",
      takedown: { value: "https://park.example.org", sources: 2, reasons: ["spam", "wrong"], feedback: [first.id, item.id] },
    });
  });

  it("counts the item itself when the caller leaves it out", () => {
    const first = attested(contactReport(0, "dev-b", "website"));
    const item = contactReport(1, "dev-a", "website");
    expect(decideContactReport({ item, place: state(), earlier: [first] })).toMatchObject({ verdict: "live", takedown: { feedback: [first.id, item.id] } });
  });

  it("does not count reports sent before the contact was last set, or more than 90 days before the item", () => {
    const place = state({ fact_sources: { website: "feedback" }, fact_dates: { website: at(50) } });
    const item = contactReport(100, "dev-a", "website");
    const earlier = [attested(contactReport(40, "dev-b", "website")), attested({ ...contactReport(60, "dev-c", "phone") })];
    expect(decideContactReport({ item, place, earlier })).toMatchObject({ verdict: "held", reason: "unconfirmed" });
    const old = attested(contactReport(5, "dev-b", "website"));
    expect(decideContactReport({ item, place: state(), earlier: [old] })).toMatchObject({ verdict: "held", reason: "unconfirmed" });
  });

  it("does not count the item when it was sent before the contact was last set", () => {
    const place = state({ fact_sources: { website: "feedback" }, fact_dates: { website: at(50) } });
    const item = attested(contactReport(40, "dev-a", "website"));
    const later = attested(contactReport(40, "dev-b", "website"));
    expect(decideContactReport({ item, place, earlier: [later] })).toMatchObject({ verdict: "held", reason: "unconfirmed" });
  });
});

describe("new places", () => {
  const newPlace = (report: Record<string, unknown>, extra: Record<string, unknown> = {}): ReportItem =>
    ({ ...base(0, "dev-a", null), type: "report", location: { lat: -36.85, lon: 144.55 }, report: { kind: "new_place", ...report }, ...extra }) as ReportItem;
  const listed = (item: ReportItem) => attested(item);

  it("lists a new place from an attested install with a contributor whose note passes the text checks", () => {
    expect(newPlaceListing(listed(newPlace({ note: "Gravel pit off the highway" })))).toBeNull();
    expect(newPlaceListing(listed(newPlace({})))).toBeNull();
  });

  it("says why a new place is not listed", () => {
    expect(newPlaceListing(newPlace({}))).toEqual({ reason: "not_attested", why: "not proven by attestation" });
    expect(newPlaceListing(newPlace({}, { attested: "app_attest" }))).toEqual({ reason: "no_contributor", why: "no contributor" });
    expect(newPlaceListing(listed(newPlace({ note: "buy now at the casino" })))).toEqual({ reason: "text_check", why: "note fails the text checks (spam)" });
  });

  it("splits the contacts into those that pass the link checks and those that fail", () => {
    const address = { street: "Lake Road", postcode: "3999" };
    const fields = newPlaceFields(newPlace({ contacts: { phone: "03 5555 0100", website: "http://park.example.org" }, address }));
    expect(fields.contacts).toEqual({ phone: "03 5555 0100", website: "http://park.example.org", address });
    expect(fields.failing).toEqual(["website"]);
  });

  it("publishes the description tidied, and holds one that fails the text checks", () => {
    expect(newPlaceFields(newPlace({ description: "  Shady   sites by the river  " }))).toMatchObject({ description: "Shady sites by the river", descriptionProblem: null });
    const spam = newPlaceFields(newPlace({ description: "buy now at the casino" }));
    expect(spam.description).toBeUndefined();
    expect(spam.descriptionProblem).toBe("spam");
    const blank = newPlaceFields(newPlace({ description: "   " }));
    expect(blank.description).toBeUndefined();
    expect(blank.descriptionProblem).toBeNull();
  });

  it("carries the fee, and leaves out what the report does not send", () => {
    expect(newPlaceFields(newPlace({ fee: "donation" }))).toEqual({ contacts: {}, failing: [], descriptionProblem: null, fee: "donation" });
    expect(newPlaceFields(newPlace({}))).toEqual({ contacts: {}, failing: [], descriptionProblem: null });
  });
});

describe("sources and the window", () => {
  it("counts one client network once, and devices without a network one by one", () => {
    const items = [fact(0, "dev-a", "power", true, { origin: "net-1" }), fact(0, "dev-b", "power", true, { origin: "net-1" }), fact(0, "dev-c", "power", true)];
    expect(distinctSources(items)).toBe(2);
  });

  it("takes items at or before the time and no more than 90 days before it", () => {
    const now = Date.parse(at(100));
    expect(inWindow(fact(100, "d", "power", true), now)).toBe(true);
    expect(inWindow(fact(10, "d", "power", true), now)).toBe(true);
    expect(inWindow(fact(9, "d", "power", true), now)).toBe(false);
    expect(inWindow(fact(101, "d", "power", true), now)).toBe(false);
  });
});
