import { describe, expect, it } from "vitest";
import { validateSubmission } from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };
const owner = { device: base.device, app_version: "1.0.0", terms_accepted: true, owner: { name: "Sam", email: "sam@example.com" } };

// The characters some readers take as the end of a line.
const BREAKS = [" ", " ", "\u0085"];

describe("one-line values", () => {
  for (const ch of BREAKS) {
    const code = `U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

    it(`refuses a Commons file name holding ${code}`, () => {
      const r = validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "commons_mismatch", file: `Camp${ch}x.jpg` } });
      expect(r.ok).toBe(false);
    });

    it(`refuses a name report holding ${code}`, () => {
      const r = validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "name", value: `Creek${ch}Camp` } });
      expect(r.ok).toBe(false);
    });

    it(`refuses an operator holding ${code}`, () => {
      const r = validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "operator", value: `Parks${ch}Board` } });
      expect(r.ok).toBe(false);
    });

    it(`refuses an owner's listing name holding ${code}`, () => {
      const r = validateSubmission({
        ...owner,
        type: "owner_listing",
        place: null,
        location: { lat: -36.85, lon: 144.55 },
        claim: { proof_url: "https://farm.example.com/" },
        listing: { name: `Farm${ch}Stay`, facts: { phone: "+61 3 5555 0101" } },
      });
      expect(r.ok).toBe(false);
    });

    it(`keeps ${code} in a note, which may run over several lines`, () => {
      const r = validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "fact", fact: "power", value: true, note: `a${ch}b` } });
      expect(r.ok).toBe(true);
    });
  }

  it("still accepts the same values without the break", () => {
    expect(validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "name", value: "Creek Camp" } }).ok).toBe(true);
    expect(validateSubmission({ ...base, type: "report", place: PLACE, report: { kind: "commons_mismatch", file: "Camp x.jpg" } }).ok).toBe(true);
  });
});
