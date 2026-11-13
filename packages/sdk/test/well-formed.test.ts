import { describe, expect, it } from "vitest";
import { isCommonsFileName, isValidFactValue, validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };
const owner = { device: base.device, app_version: "1.0.0", terms_accepted: true, owner: { name: "Sam", email: "sam@example.com" } };

// A surrogate with no partner: JSON can carry it as an escape, but it is not text.
const LONE = ["\ud83d", "\ude00"];

describe("well formed text", () => {
  for (const ch of LONE) {
    const code = `U+${ch.charCodeAt(0).toString(16).toUpperCase()}`;

    it(`refuses review text holding a lone ${code}`, () => {
      const r = validateSubmission({ ...base, type: "review", place: PLACE, review: { stars: 4, text: `Great camp ${ch} by the lake.`, visited: "2026-10" } }, new Date("2026-11-01T00:00:00Z"));
      expect(r).toEqual({ ok: false, errors: ["review.text must be well formed text"] });
    });

    it(`refuses a note holding a lone ${code}`, () => {
      const r = validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "power", value: true, note: `a${ch}b` } });
      expect(r.ok).toBe(false);
    });

    it(`refuses a new place description holding a lone ${code}`, () => {
      const r = validateSubmission({
        ...base,
        type: "report",
        place: null,
        location: { lat: -36.85, lon: 144.55 },
        report: { kind: "new_place", place_kind: "free_camp", name: "Dummy Flat", description: `Flat ${ch} spot` },
      });
      expect(r.ok).toBe(false);
    });

    it(`refuses an owner description holding a lone ${code}`, () => {
      const r = validateSubmission({
        ...owner,
        type: "owner_update",
        place: PLACE,
        token: "q2Vb7Rk1cW9yZ3hVdm5Pb2pQTlR4Y0FyZ0lCd2pUcEs",
        update: { description: `Shady ${ch} sites` },
      });
      expect(r.ok).toBe(false);
    });

    it(`refuses a Commons file name holding a lone ${code}`, () => {
      expect(isCommonsFileName(`Camp${ch}.jpg`)).toBe(false);
    });
  }

  it("keeps a character above U+FFFF written as a pair", () => {
    const r = validateSubmission({ ...base, type: "review", place: PLACE, review: { stars: 4, text: "Great camp \ud83d\ude00 by the lake.", visited: "2026-10" } }, new Date("2026-11-01T00:00:00Z"));
    expect(r.ok).toBe(true);
    expect(isCommonsFileName("Camp \ud83d\ude00.jpg")).toBe(true);
  });
});

describe("email fact", () => {
  // Characters the data repository's schema reads as space, which JavaScript's \s leaves out.
  for (const ch of ["\u0085", "\u001c", "\u001f"]) {
    it(`refuses an address holding U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`, () => {
      expect(isValidFactValue("email", `camp${ch}site@example.org`)).toBe(false);
    });
  }

  it("accepts an ordinary address", () => {
    expect(isValidFactValue("email", "campsite@example.org")).toBe(true);
  });
});
