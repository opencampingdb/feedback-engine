import { describe, expect, it } from "vitest";
import { reviewPrBody } from "../src/prbody.js";
import type { HeldCase } from "../src/rules.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";

describe("review PR body held cases", () => {
  const withdrawn: HeldCase = {
    case: "contact_withdrawn",
    place: PLACE,
    location: { lat: -36.85, lon: 144.55 },
    kind: "free_camp",
    fact: "email",
    value: "stay@park.example.org",
    reasons: ["spam"],
    feedback: ["fb_01JC0000000000000000000001", "fb_01JC0000000000000000000002"],
  };

  it("lists a withdrawn contact with its value, as a line a reviewer can parse", () => {
    const body = reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [], [withdrawn]);
    const line = body.split("\n").find((l) => l.startsWith("- held-case "))!;
    expect(JSON.parse(line.slice("- held-case ".length))).toEqual(withdrawn);
    expect(line).not.toContain("@");
  });

  it("explains each case and how to restore a withdrawn contact", () => {
    const body = reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [], [withdrawn]);
    expect(body).toContain("## Held cases");
    for (const name of ["duplicate", "hidden", "contacts", "description", "first_place", "contact_withdrawn"]) expect(body).toContain(`\`${name}\``);
    expect(body).toContain("its `value` is the place's own published contact");
    expect(body).toContain("To restore it, set `facts.<fact>` back to `value` on the place in this PR.");
  });
});
