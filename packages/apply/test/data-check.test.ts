import { describe, expect, it } from "vitest";
import { byCodePoint, doNotMatchProblems, placeProblems, reviewProblems, textProblems } from "../src/data-check.js";
import { withDoNotMatch } from "../src/review.js";
import type { Place, Review } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const NOW = "2026-10-30T00:00:00Z";

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: PLACE,
    name: "Dummy Flat",
    kind: "free_camp",
    group: "overnight",
    location: { lat: -36.85, lon: 144.55 },
    osm: { type: "node", id: 123456, version: 7 },
    facts: { toilets: true },
    status: "open",
    rating: null,
    fact_sources: { toilets: "feedback" },
    fact_dates: { toilets: "2026-10-01T00:00:00Z" },
    updated: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function line(overrides: Partial<Review> = {}): Review {
  return {
    id: "rev_01JA0000000000000000000001",
    place: PLACE,
    stars: 4,
    text: "Quiet and flat with good shade.",
    visited: "2026-10",
    created: "2026-10-29T00:00:00Z",
    app: "example-app",
    contributor: "ctr_0123456789abcdef",
    ...overrides,
  };
}

describe("text the data validator refuses", () => {
  // Each case is a text pipeline/validate.py's text_problems refuses, with the reason it gives.
  const refused: [string, string, string][] = [
    ["eight Arabic-Indic digits", "Site \u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668 by the water was the best one.", "a phone number"],
    ["digit groups joined by U+0085", "Gate code on the sign 1234\u00855678 near the entry.", "a phone number"],
    ["digit groups joined by U+001C", "Gate 1234\u001c5678 near the entry.", "a phone number"],
    ["a sign-off with the long s", "Quiet and flat with good shade. Thank\u017f, Sam", "a personal name"],
    ["a request for contact with the dotless i", "Lovely spot, ema\u0131l me for the track notes.", "a request for contact"],
    ["a request for contact with the dotted capital I", "Lovely spot, EMA\u0130L ME for the track notes.", "a request for contact"],
    ["a sign-off at the end", "Flat grassy spot by the creek, room for three vans. Cheers, Dave", "a personal name"],
    ["a sign-off with thanks", "Shady sites near the river, drop toilet only. Thanks, Sarah", "a personal name"],
    ["my name is", "Hi, my name is Jo and the camp is great", "a personal name"],
    ["a handle", "Follow @campjo for more", "a social media handle"],
    ["an email address", "Write to jo@example.com", "an email address"],
    ["digits after a date", "Room 2026-10-1212345678", "a phone number"],
  ];
  for (const [what, text, reason] of refused) {
    it(`refuses ${what}`, () => {
      expect(textProblems(text)).toContain(reason);
    });
  }

  // Each case is a text text_problems accepts.
  const accepted: [string, string][] = [
    ["plain text", "Quiet and flat with good shade."],
    ["dates, which are blanked before the digit check", "Stayed 2026-10-12 to 2026-10-14, then 2026-11"],
    ["a sign-off with a lower case word", "Great spot. Thanks, everyone"],
    ["seven digits", "Gate code 1234 567"],
    ["a handle glued to a word", "jo@campjo is not a handle here"],
    ["a date written in Arabic-Indic digits", "Stayed \u0662\u0660\u0662\u0666-10-12 2026-10-14"],
  ];
  for (const [what, text] of accepted) {
    it(`accepts ${what}`, () => {
      expect(textProblems(text)).toEqual([]);
    });
  }
});

describe("place records the data validator refuses", () => {
  it("accepts a valid record", () => {
    expect(placeProblems(place(), { now: NOW })).toEqual([]);
  });

  it("refuses a source and date kept for a fact the record no longer has", () => {
    const p = place({ facts: {}, fact_sources: { toilets: "feedback" }, fact_dates: { toilets: "2026-10-01T00:00:00Z" } });
    expect(placeProblems(p, { now: NOW })).toEqual(["fact_sources must have an entry for every fact and no other fact, differ on [toilets]"]);
  });

  it("refuses a date for a value from OSM, and a missing date for one that is not", () => {
    const p = place({ facts: { toilets: true, power: true }, fact_sources: { toilets: "osm", power: "feedback" }, fact_dates: { toilets: "2026-10-01T00:00:00Z" } });
    expect(placeProblems(p, { now: NOW })).toEqual(["fact_dates must have an entry for every fact_sources entry that is not osm and no other, differ on [power, toilets]"]);
  });

  it("refuses a date later than updated", () => {
    const p = place({ fact_dates: { toilets: "2026-10-02T00:00:00Z" } });
    expect(placeProblems(p, { now: NOW })).toEqual(["fact_dates later than updated for [toilets]"]);
  });

  it("refuses pets_months without pets seasonal, and a single month", () => {
    const { fact_dates: _, ...rest } = place({ facts: { pets: "yes", pets_months: "May-May" }, fact_sources: { pets: "osm", pets_months: "osm" } });
    const p: Place = rest;
    expect(placeProblems(p, { now: NOW })).toEqual([
      "pets_months is only for a place whose pets fact is seasonal",
      "pets_months must be two different months, such as May-Sep",
    ]);
  });

  it("refuses an owner value without owner_verified", () => {
    const p = place({ fact_sources: { toilets: "owner" } });
    expect(placeProblems(p, { now: NOW })).toEqual(["[toilets] have the source owner, so owner_verified must be true"]);
  });

  it("refuses an owner-listed farm stay that is not private, booked ahead and bookable", () => {
    const p = place({ kind: "farm_stay", osm: null, facts: { entry: "public", booking_required: false }, fact_sources: { entry: "owner", booking_required: "owner" }, fact_dates: { entry: NOW.replace("10-30", "10-01"), booking_required: "2026-10-01T00:00:00Z" }, owner_verified: true });
    expect(placeProblems(p, { now: NOW })).toEqual([
      "a farm_stay must have the fact entry private",
      "a farm_stay must have the fact booking_required true",
      "a farm_stay needs a booking_url or a phone fact",
    ]);
  });

  it("refuses a description the review text rules refuse", () => {
    const p = place({ description: "Flat grassy spot by the creek. Cheers, Dave" });
    expect(placeProblems(p, { now: NOW })).toEqual(["description contains a personal name"]);
  });

  it("refuses reopens without a temporary closure, and a day that does not exist", () => {
    expect(placeProblems(place({ reopens: "2026-12-01" }), { now: NOW })).toEqual(["reopens is set but status is not temporarily_closed"]);
    expect(placeProblems(place({ status: "temporarily_closed", reopens: "2026-02-30" }), { now: NOW })).toEqual(["reopens 2026-02-30 is not a real date"]);
  });

  it("refuses an email address holding a character Python reads as space", () => {
    const p = place({ facts: { email: "camp\u0085site@example.org" }, fact_sources: { email: "feedback" }, fact_dates: { email: "2026-10-01T00:00:00Z" } });
    expect(placeProblems(p, { now: NOW })).toEqual(["facts/email does not match the schema's pattern"]);
  });

  it("refuses text that is not well formed, which has no canonical form", () => {
    expect(placeProblems(place({ name: "Dummy \ud83d Flat" }), { now: NOW })).toEqual(["name is not well formed text, so the file cannot be in canonical form"]);
  });

  it("refuses standing on a place from OSM, last_confirmed in the future, and a group that is not the kind's", () => {
    const p = place({ standing: "shown", last_confirmed: "2026-11-01T00:00:00Z", group: "utility" });
    expect(placeProblems(p, { now: NOW, kinds: new Map([["free_camp", "overnight"]]) })).toEqual([
      "group utility does not match kind free_camp, which is in group overnight",
      "last_confirmed 2026-11-01T00:00:00Z is in the future",
      "standing is only for a place a traveller added, which has osm null",
    ]);
  });

  it("refuses a value longer than the schema allows, counted in characters", () => {
    const p = place({ description: "a".repeat(501) });
    expect(placeProblems(p, { now: NOW })).toEqual(["description is longer than 500 characters"]);
    // A character above U+FFFF counts once, as Python counts it.
    expect(placeProblems(place({ description: "\ud83d\ude00".repeat(500) }), { now: NOW })).toEqual([]);
  });
});

describe("review lines the data validator refuses", () => {
  it("accepts a valid line", () => {
    expect(reviewProblems(line())).toEqual([]);
  });

  it("refuses text that is not well formed", () => {
    expect(reviewProblems(line({ text: "Great camp \ud83d by the lake." }))).toEqual(["text is not well formed text, so the line cannot be in canonical form"]);
  });

  it("refuses text the text rules refuse", () => {
    expect(reviewProblems(line({ text: "Quiet and flat. Thank\u017f, Sam" }))).toEqual(["text contains a personal name"]);
  });
});

describe("the do-not-match list", () => {
  it("orders file names by code point, as Python sorts them", () => {
    // U+1F600 is above U+FF21, though its first UTF-16 unit is below it.
    expect(["\ud83d\ude00.jpg", "\uff21.jpg"].sort(byCodePoint)).toEqual(["\uff21.jpg", "\ud83d\ude00.jpg"]);
    expect(["b.jpg", "a.jpg"].sort(byCodePoint)).toEqual(["a.jpg", "b.jpg"]);
  });

  it("writes pairs in the order the validator checks", () => {
    const entry = (file: string) => ({ place: PLACE, file, added: "2026-10-30", source: "reports" as const });
    const text = withDoNotMatch(undefined, [entry("\ud83d\ude00.jpg"), entry("\uff21.jpg")]);
    expect((JSON.parse(text) as { pairs: { file: string }[] }).pairs.map((p) => p.file)).toEqual(["\uff21.jpg", "\ud83d\ude00.jpg"]);
  });

  it("refuses a file name the schema refuses", () => {
    expect(doNotMatchProblems({ place: PLACE, file: "File:Camp.jpg" })).toEqual(["file is not a Commons file name"]);
    expect(doNotMatchProblems({ place: PLACE, file: "Camp.jpg" })).toEqual([]);
  });

  it("refuses a file name the intake would refuse, by the same rule", () => {
    for (const file of ["image : Camp.jpg", "FILE:Camp.jpg", "Camp", "Camp[1].jpg", "https://example.org/a.jpg"]) {
      expect(doNotMatchProblems({ place: PLACE, file })).toEqual(["file is not a Commons file name"]);
    }
    expect(doNotMatchProblems({ place: PLACE, file: "Camp 2019.jpeg" })).toEqual([]);
    // Counted in code points, as the data validator counts them.
    expect(doNotMatchProblems({ place: PLACE, file: `${"💧".repeat(251)}.jpg` })).toEqual([]);
    expect(doNotMatchProblems({ place: PLACE, file: `${"💧".repeat(252)}.jpg` })).toEqual(["file is not a Commons file name"]);
  });
});
