import { describe, expect, it } from "vitest";
import { autoPrBody, reviewPrBody } from "../src/prbody.js";
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

describe("review PR photo previews", () => {
  const held = {
    place: "ocdb_01M6J07SRSHVX9P46W6ZVQGTNM",
    summary: "photo pho_01M6JPNZNFN1MQN9GMCXFC7WCB (480 x 639), first photo from this contributor (look at it before merging)",
    automatic: false,
    feedback: ["fb_01M6JPNZNFN1MQN9GMCXFC7WCB"],
    photo: "pho_01M6JPNZNFN1MQN9GMCXFC7WCB",
  };

  it("links each held photo when previews are on", () => {
    const previews = new Map([[held.photo, "https://intake.example/v1/photos/review/pho_01M6JPNZNFN1MQN9GMCXFC7WCB/full.jpg?expires=1&sig=x"]]);
    const body = reviewPrBody("2026-11-04T00:00:00Z", [held], new Map(), [], [], previews);
    expect(body).toContain("[View the photo](https://intake.example/v1/photos/review/pho_01M6JPNZNFN1MQN9GMCXFC7WCB/full.jpg?expires=1&sig=x)");
    expect(body).toContain("stop working after 30 days");
  });

  it("writes the line as before when previews are off", () => {
    const body = reviewPrBody("2026-11-04T00:00:00Z", [held], new Map());
    expect(body).not.toContain("View the photo");
    expect(body).not.toContain("30 days");
  });
});

describe("PR body size", () => {
  const note = (i: number) => ({
    place: PLACE,
    summary: `report ${i}: "${"The gate by the river is locked after dark and the track floods in rain. ".repeat(26)}"`,
    automatic: false,
    feedback: [`fb_01JC${String(i).padStart(22, "0")}`],
  });

  it("stays under GitHub's body limit however many changes a run has, and says how many it left out", () => {
    const changes = Array.from({ length: 60 }, (_, i) => note(i));
    const review = reviewPrBody("2026-11-04T00:00:00Z", changes, new Map());
    expect(review.length).toBeLessThan(65_536);
    expect(review).toMatch(/and \d+ more, listed in the run's job summary/);
    const auto = autoPrBody("2026-11-04T00:00:00Z", changes.map((c) => ({ ...c, automatic: true })), [], new Map());
    expect(auto.length).toBeLessThan(65_536);
  });

  it("lists every change when they fit", () => {
    const review = reviewPrBody("2026-11-04T00:00:00Z", [note(1), note(2)], new Map());
    expect(review).not.toContain("more, listed");
    expect(review.match(/^- /gm)).toHaveLength(2);
  });
});

describe("owner listings in the review PR (audit run-2 OCDB-NV-03)", () => {
  const listing = {
    claim: "fb_01JC0000000000000000000009",
    type: "owner_listing" as const,
    place: "ocdb_01JC0000000000000000000009",
    proof: { found: false, checked: "2026-11-04T00:00:00Z", detail: "the page did not load" },
    proofUrl: "https://riverbend.example.org/stay",
    code: "OCDB-7K3Q",
    replaces: undefined,
    listing: {
      name: "Riverbend Farm Stay",
      description: "Quiet paddock by the river.",
      facts: { phone: "+61 400 000 000", booking_url: "https://book.example.net/riverbend", fee: true },
      location: { lat: -33.123456, lon: 151.654321 },
    },
  };

  const body = () => reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [listing]);
  const line = () => body().split("\n").find((l) => l.startsWith("- [ ] Approve owner listing "))!;

  it("keeps the listing's name, description, fact values and exact location out of the public PR", () => {
    for (const secret of ["+61 400 000 000", "book.example.net", "Riverbend Farm Stay", "Quiet paddock", "-33.123456", "151.654321", "-33.12", "151.65"]) {
      expect(body()).not.toContain(secret);
    }
  });

  it("gives the reviewer the claim, a coarse location, the fact names, the proof result and where the full listing is", () => {
    expect(line()).toContain(listing.claim);
    expect(line()).toContain("-33.1, 151.7");
    expect(line()).toContain("booking_url, fee, phone");
    expect(line()).toContain("description sent");
    expect(line()).toContain(`code ${listing.code} NOT found at ${listing.proofUrl}`);
    expect(line()).toContain(`owner-claims/${listing.claim}.json`);
  });

  it("says the same when the proof code was found", () => {
    const found = { ...listing, proof: { found: true, checked: "2026-11-04T00:00:00Z", detail: "found" } };
    const text = reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [found]);
    expect(text).not.toContain("+61 400 000 000");
    expect(text).not.toContain("-33.123456");
    expect(text).toContain(`code ${listing.code} found at ${listing.proofUrl}`);
  });
});
