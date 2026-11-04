import { describe, expect, it } from "vitest";
import { reviewPrBody } from "../src/prbody.js";
import { allowedDecisions, applyDecision, heldCaseKey, parseHeldCases, settleByRules, type HeldCase } from "../src/review.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const AT = "2026-11-04T09:00:00Z";

function place(overrides: { [K in keyof Place]?: Place[K] | undefined } = {}): Place {
  return {
    id: PLACE,
    name: "Creek Bend",
    kind: "free_camp",
    group: "overnight",
    location: { lat: -36.85, lon: 144.55 },
    osm: null,
    facts: { toilets: true },
    status: "open",
    rating: null,
    fact_sources: { name: "contributed", toilets: "contributed" },
    fact_dates: { name: "2026-11-01T00:00:00Z", toilets: "2026-11-01T00:00:00Z" },
    standing: "held",
    updated: "2026-11-01T00:00:00Z",
    ...overrides,
  } as Place;
}

const base = { place: PLACE, location: { lat: -36.85, lon: 144.55 }, kind: "free_camp", feedback: ["fb_01JC0000000000000000000001"] };
const duplicate: HeldCase = { ...base, case: "duplicate", standing: "held", duplicate_of: OTHER, distance_m: 80 };
const hidden: HeldCase = { ...base, case: "hidden", standing: "hidden", reports: 2, reasons: ["not_there"] };
const firstPlace: HeldCase = { ...base, case: "first_place", standing: "shown", contributor: "ctr_0123456789abcdef" };
const withdrawn: HeldCase = {
  ...base,
  case: "contact_withdrawn",
  fact: "email",
  value: "stay@park.example.org",
  reasons: ["spam"],
  feedback: ["fb_01JC0000000000000000000002", "fb_01JC0000000000000000000001"],
};

describe("reading held cases", () => {
  it("reads every case the apply writes in the review PR body, and nothing else", () => {
    const cases = [duplicate, hidden, firstPlace, withdrawn, { ...base, case: "contacts" as const, standing: "shown" as const, contacts: ["website"] }];
    const body = reviewPrBody(AT, [], new Map(), [], cases);
    expect(parseHeldCases(body)).toEqual(cases);
  });

  it("skips lines that don't parse or don't have a held case's shape", () => {
    const text = [
      "- held-case {not json",
      `- held-case ${JSON.stringify({ ...duplicate, place: "not-a-place" })}`,
      `- held-case ${JSON.stringify({ ...duplicate, case: "anything" })}`,
      `- held-case ${JSON.stringify({ ...withdrawn, value: undefined })}`,
      `  - held-case ${JSON.stringify(duplicate)}`,
      `- held-case ${JSON.stringify(duplicate)}`,
    ].join("\n");
    expect(parseHeldCases(text)).toEqual([duplicate]);
  });

  it("keys a case the same however its feedback ids are ordered", () => {
    expect(heldCaseKey(withdrawn)).toBe(heldCaseKey({ ...withdrawn, feedback: [...withdrawn.feedback].reverse() }));
    expect(heldCaseKey(withdrawn)).not.toBe(heldCaseKey(hidden));
  });
});

describe("what the rules settle", () => {
  it("leaves the cases whose values wait in the inbox to a person", () => {
    for (const kind of ["contacts", "description"] as const) {
      const c: HeldCase = { ...base, case: kind, standing: "shown" };
      expect(allowedDecisions(c)).toEqual(["leave"]);
      expect(settleByRules(c, place({ standing: "shown" }))?.decision).toBe("leave");
    }
  });

  it("leaves a blocked contributor's place, an owner's place and a place a person decided on", () => {
    expect(settleByRules({ ...base, case: "hidden", standing: "hidden", blocked: true }, place({ standing: "hidden" }))?.reason).toContain("blocked");
    expect(settleByRules(duplicate, place({ owner_verified: true }))?.reason).toContain("owner");
    expect(settleByRules(duplicate, place({ moderator: { action: "restore", at: "2026-11-02" } }))?.reason).toContain("a person");
  });

  it("leaves a contact the owner set, one back on the place, and one that fails the link rules", () => {
    const owner = place({ standing: undefined, fact_sources: { email: "owner" } });
    expect(settleByRules(withdrawn, owner)?.reason).toContain("owner");
    expect(settleByRules(withdrawn, place({ standing: undefined, facts: { email: "new@park.example.org" } }))?.reason).toContain("again");
    expect(settleByRules({ ...withdrawn, fact: "website", value: "http://bit.ly/x" }, place({ standing: undefined }))?.reason).toContain("link rules");
  });

  it("leaves a case that is out of date, or whose place is missing", () => {
    expect(settleByRules(duplicate, undefined)?.reason).toContain("not on the review branch");
    expect(settleByRules(duplicate, place({ standing: "shown" }))?.reason).toContain("no longer held");
    expect(settleByRules(hidden, place({ standing: "shown" }))?.reason).toContain("no longer hidden");
    expect(settleByRules(firstPlace, place({ standing: "hidden" }))?.reason).toContain("already hidden");
    expect(settleByRules(duplicate, place({ status: "merged" }))?.reason).toContain("merged");
  });

  it("asks a reviewer about the rest", () => {
    expect(settleByRules(duplicate, place())).toBeNull();
    expect(settleByRules(hidden, place({ standing: "hidden" }))).toBeNull();
    expect(settleByRules(firstPlace, place({ standing: "shown" }))).toBeNull();
    expect(settleByRules(withdrawn, place({ standing: undefined }))).toBeNull();
  });
});

describe("what a decision does to the place", () => {
  it("approves a held place as shown, and restores a hidden one with a person's restore", () => {
    expect(applyDecision(place(), duplicate, "approve", AT)).toMatchObject({ standing: "shown", updated: AT });
    expect(applyDecision(place(), duplicate, "approve", AT)?.moderator).toBeUndefined();
    expect(applyDecision(place({ standing: "hidden" }), hidden, "approve", AT)).toMatchObject({ standing: "shown", moderator: { action: "restore", at: AT } });
  });

  it("takes down spam with a hide decision, so reports can't bring it back", () => {
    expect(applyDecision(place({ standing: "shown" }), firstPlace, "take_down", AT)).toMatchObject({ standing: "hidden", moderator: { action: "hide", at: AT } });
  });

  it("restores a withdrawn contact with its source and date", () => {
    const out = applyDecision(place({ standing: undefined }), withdrawn, "restore", AT)!;
    expect(out.facts).toMatchObject({ email: "stay@park.example.org", toilets: true });
    expect(out.fact_sources.email).toBe("feedback");
    expect(out.fact_dates?.email).toBe(AT);
  });

  it("changes nothing for leave, for approving a published first place, or for a decision the case doesn't allow", () => {
    const before = place({ standing: "shown" });
    expect(applyDecision(before, firstPlace, "leave", AT)).toBeNull();
    expect(applyDecision(before, firstPlace, "approve", AT)).toBeNull();
    expect(applyDecision(before, withdrawn, "take_down", AT)).toBeNull();
    expect(applyDecision(before, { ...base, case: "contacts", standing: "shown" }, "approve", AT)).toBeNull();
    expect(before.standing).toBe("shown");
  });
});
