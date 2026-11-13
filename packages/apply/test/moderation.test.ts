import { describe, expect, it } from "vitest";
import { moderateReview } from "../src/moderation.js";

describe("moderateReview", () => {
  it.each([
    "Stayed 2026-10-30, lovely and quiet",
    "Visited 2026-10, back again 2026-11-02",
    "From 2026-10-30 2026-11-02 the creek was up",
    "Here 2026-10-30 to 2026-11-02",
    "",
  ])("does not treat dates as phone numbers: %j", (text) => {
    expect(moderateReview(text)).toEqual([]);
  });

  it.each([
    ["Ring 0412 345 678", "a phone number"],
    ["Stayed 2026-10-30, ring 0412345678", "a phone number"],
    ["Call (02) 6123 4567 on arrival", "a phone number"],
    ["Write to jo@example.com", "an email address"],
    ["See www.example.com", "a link"],
    ["Follow @campingjo", "a social media handle"],
    ["My name is Jo", "a personal name"],
    ["Lovely spot. Cheers, Sam", "a personal name"],
    ["Text me for the gate code", "a request for contact"],
    ["Total shit hole", "offensive language"],
    ["The ranger is a tosser", "offensive language"],
    ["Best crypto tips on whatsapp", "spam"],
  ])("refuses %j for %s", (text, reason) => {
    expect(moderateReview(text)).toContain(reason);
  });

  it("refuses text over 2,000 characters", () => {
    expect(moderateReview("a".repeat(2001))).toEqual(["longer than 2,000 characters"]);
  });
});

describe("disguised offensive language and advertising", () => {
  it.each([
    "this place is f u c k i n g awful",
    "s.h.i.t toilets",
    "what a sh1t hole",
    "$h!t service",
    "f*ck this",
    "sh#t",
    "fuuuuck the flies",
    "c u n t of a road",
  ])("refuses %j", (text) => {
    expect(moderateReview(text)).toContain("offensive language");
  });

  it.each([
    "Powered sites $45 per night",
    "Book now before it fills up",
    "20% off this week only",
    "Use promo code CAMP10",
    "Check out our other parks",
  ])("refuses the advertisement %j", (text) => {
    expect(moderateReview(text)).toContain("advertising");
  });

  it.each([
    "Great for a 4wd, about 5km of corrugations",
    "Paid $20 for two nights, worth it",
    "Classic bush camp, lots of Scunthorpe-style grass",
    "About 1.5 hours from town. Cocoon of gum trees, raccoon-free!",
    "Aboriginal heritage walk nearby, a must",
    "A b c of camping: arrive early",
    "Booked in at the office, staff were lovely",
    "Grassy sites, about 50% shaded",
  ])("passes %j", (text) => {
    expect(moderateReview(text)).toEqual([]);
  });

  // Texts the data validator refuses because Python's \d, \s and case-insensitive matching are wider than JavaScript's.
  it.each([
    ["Site \u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668 by the water was the best one.", "a phone number"],
    ["Quiet and flat with good shade. Thank\u017f, Sam", "a personal name"],
    ["Lovely spot, ema\u0131l me for the track notes.", "a request for contact"],
    ["Gate code on the sign 1234\u00855678 near the entry.", "a phone number"],
  ])("refuses %j for %s, as the data validator does", (text, reason) => {
    expect(moderateReview(text)).toContain(reason);
  });
});
