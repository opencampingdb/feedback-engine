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
  ])("refuses %j for %s", (text, reason) => {
    expect(moderateReview(text)).toContain(reason);
  });

  it("refuses text over 2,000 characters", () => {
    expect(moderateReview("a".repeat(2001))).toEqual(["longer than 2,000 characters"]);
  });
});
