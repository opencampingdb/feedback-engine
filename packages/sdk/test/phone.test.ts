import { describe, expect, it } from "vitest";
import { formatPhone, formatSubmissionPhones, validateSubmission } from "../src/index.js";
import type { Submission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };

describe("formatPhone", () => {
  it.each([
    // Landlines, domestic and +61.
    ["0261234567", "02 6123 4567"],
    ["(07) 4564-2000", "07 4564 2000"],
    ["08.9123.4567", "08 9123 4567"],
    ["03 9123 4567", "03 9123 4567"],
    ["+61261234567", "+61 2 6123 4567"],
    ["+6174564 2000", "+61 7 4564 2000"],
    ["+61 (0)7 4564 2000", "+61 7 4564 2000"],
    ["+61 07 4564 2000", "+61 7 4564 2000"],
    // Mobiles.
    ["0412345678", "0412 345 678"],
    ["0412 345678", "0412 345 678"],
    ["+61412345678", "+61 412 345 678"],
    ["+61 0412 345 678", "+61 412 345 678"],
    // Local rate, free call and 13 numbers.
    ["1300123456", "1300 123 456"],
    ["1800-123-456", "1800 123 456"],
    ["131234", "13 12 34"],
  ])("%s reads %s", (input, expected) => {
    expect(formatPhone(input)).toBe(expected);
  });

  it.each([
    // Overseas numbers keep their own grouping, with the spacing tidied.
    ["+64  9 123  4567", "+64 9 123 4567"],
    ["+1 212 555 0100", "+1 212 555 0100"],
    // Too short, too long or not a known shape.
    ["12345", "12345"],
    ["02 6123 45678", "02 6123 45678"],
    ["0612345678", "0612345678"],
    ["+61 9 1234", "+61 9 1234"],
    // No country code is guessed for a number written without +.
    ["61 7 4564 2000", "61 7 4564 2000"],
    // Text that is not only a phone number is left as typed, bar spacing.
    ["  call 0412 345 678 ", "call 0412 345 678"],
    ["", ""],
  ])("%s is left as %s", (input, expected) => {
    expect(formatPhone(input)).toBe(expected);
  });

  it("is stable when run twice", () => {
    for (const input of ["+6174564 2000", "0412345678", "1300123456", "131234", "+64 9 123 4567"]) {
      expect(formatPhone(formatPhone(input))).toBe(formatPhone(input));
    }
  });
});

describe("formatSubmissionPhones", () => {
  const valid = (body: Record<string, unknown>): Submission => {
    const checked = validateSubmission(body);
    if (!checked.ok) throw new Error(checked.errors.join("; "));
    return checked.value;
  };

  it("formats a phone or phone_2 fact report", () => {
    const phone = valid({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "phone", value: "+6174564 2000" } });
    expect(formatSubmissionPhones(phone)).toMatchObject({ report: { value: "+61 7 4564 2000" } });
    const second = valid({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "phone_2", value: "0412345678" } });
    expect(formatSubmissionPhones(second)).toMatchObject({ report: { value: "0412 345 678" } });
  });

  it("formats a new place's phone and leaves its other contacts", () => {
    const report = valid({
      ...base, type: "report", place: null, location: { lat: -36.8, lon: 144.5 },
      report: { kind: "new_place", name: "Creek Camp", place_kind: "free_camp", contacts: { phone: "0354123456", website: "https://example.com" } },
    });
    expect(formatSubmissionPhones(report)).toMatchObject({ report: { contacts: { phone: "03 5412 3456", website: "https://example.com" } } });
  });

  it("leaves other facts and other submissions as they are, and never changes its input", () => {
    const fee = valid({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "fee", value: true } });
    expect(formatSubmissionPhones(fee)).toBe(fee);
    const phone = valid({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "phone", value: "0261234567" } });
    const before = JSON.stringify(phone);
    formatSubmissionPhones(phone);
    expect(JSON.stringify(phone)).toBe(before);
    const tidy = valid({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "phone", value: "02 6123 4567" } });
    expect(formatSubmissionPhones(tidy)).toBe(tidy);
  });

  it("formats an owner's update and listing facts", () => {
    const update = {
      type: "owner_update", place: PLACE, token: "t", device: base.device, app_version: "1.0.0", terms_accepted: true,
      update: { facts: { phone: "0745642000", phone_2: "+61412345678", website: "https://example.com" } },
    } as unknown as Submission;
    expect(formatSubmissionPhones(update)).toMatchObject({
      update: { facts: { phone: "07 4564 2000", phone_2: "+61 412 345 678", website: "https://example.com" } },
    });
    const listing = {
      type: "owner_listing", place: null, location: { lat: -36.8, lon: 144.5 }, device: base.device, app_version: "1.0.0",
      terms_accepted: true, owner: { name: "A", email: "a@example.com" }, claim: { proof_url: "https://example.com/p" },
      listing: { name: "Example Station", facts: { phone: "1800123456" } },
    } as unknown as Submission;
    expect(formatSubmissionPhones(listing)).toMatchObject({ listing: { facts: { phone: "1800 123 456" } } });
  });
});
