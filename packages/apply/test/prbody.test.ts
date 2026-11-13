import { describe, expect, it } from "vitest";
import { MAX_CLAIMS_PER_RUN, type ClaimForReview } from "../src/owners.js";
import { autoPrBody, MAX_BODY_CHARS, reviewPrBody, reviewPrTexts } from "../src/prbody.js";
import type { ClosedCase, HeldCase } from "../src/rules.js";
import type { Place } from "../src/types.js";

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

describe("traveller values in PR bodies", () => {
  const change = (summary: string) => ({ place: PLACE, summary, automatic: false, feedback: ["fb_01JC0000000000000000000001"] });
  const listed = (body: string) => body.split("\n").filter((l) => l.startsWith("- ")).join("\n");

  it("withholds every quoted value that fails moderation, not only a note", () => {
    const body = reviewPrBody("2026-11-04T00:00:00Z", [
      change('name changed to "Dummyname is a wanker" (check before merging)'),
      change('operator set to "Best crypto tips on whatsapp" (one attested report)'),
      change('description set to "Shady sites by the river." (check before merging)'),
    ], new Map());
    expect(listed(body)).not.toContain("wanker");
    expect(listed(body)).not.toContain("crypto");
    expect(listed(body)).toContain("(withheld, read it in the inbox)");
    expect(listed(body)).toContain('"Shady sites by the river."');
  });

  it("escapes markdown in what it keeps, so a value never makes a link", () => {
    const body = reviewPrBody("2026-11-04T00:00:00Z", [
      change('Commons photo "x.jpg [Look here](https://example.org/x) *bold* #1 | ~ !" reported as not of this place: "see [this](https://example.org/y)"'),
    ], new Map());
    expect(listed(body)).not.toMatch(/(?<!\\)\]\(/);
    expect(listed(body)).toContain("\\[Look here\\]\\(");
    expect(listed(body)).toContain("\\*bold\\*");
  });

  it("writes a held-case line in printable ASCII with link characters escaped, and it still parses", () => {
    const c: HeldCase = {
      case: "commons_mismatch",
      place: PLACE,
      location: { lat: -36.85, lon: 144.55 },
      kind: "free_camp",
      file: "Café [x](y) \u2028 💧.jpg",
      sources: 1,
      feedback: ["fb_01JC0000000000000000000001"],
    };
    const line = reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [], [c]).split("\n").find((l) => l.startsWith("- held-case "))!;
    expect(line).toMatch(/^[\x20-\x7e]*$/);
    expect(line).not.toContain("[x]");
    expect(line).not.toContain("](");
    expect(JSON.parse(line.slice("- held-case ".length))).toEqual(c);
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
    expect(line()).toContain(`code ${listing.code} NOT found at \`${listing.proofUrl}\``);
    expect(line()).toContain(`owner-claims/${listing.claim}.json`);
  });

  it("says the same when the proof code was found", () => {
    const found = { ...listing, proof: { found: true, checked: "2026-11-04T00:00:00Z", detail: "found" } };
    const text = reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [found]);
    expect(text).not.toContain("+61 400 000 000");
    expect(text).not.toContain("-33.123456");
    expect(text).toContain(`code ${listing.code} found at \`${listing.proofUrl}\``);
  });
});

describe("review PR texts within GitHub's limit", () => {
  const GITHUB_LIMIT = 65_536;
  const address = (host: string) => `https://${host}/${"a".repeat(500 - `https://${host}/`.length)}`;
  const claim = (n: number, foundAt?: string): ClaimForReview => ({
    claim: `fb_01JD${String(n).padStart(22, "0")}`,
    type: "owner_claim",
    place: PLACE,
    proof: { found: true, checked: "2026-11-04T00:00:00Z", detail: "found", ...(foundAt ? { url: foundAt } : {}) },
    proofUrl: address("proof.example"),
    code: "OCDB-7KQ2",
    replaces: undefined,
  });
  const mismatch = (n: number): HeldCase => ({
    case: "commons_mismatch",
    place: PLACE,
    location: { lat: -36.85, lon: 144.55 },
    kind: "free_camp",
    file: `${"Café 💧 ".repeat(30)}${n}.jpg`,
    sources: 1,
    feedback: [`fb_01JE${String(n).padStart(22, "0")}`],
  });
  const restored = (n: number): ClosedCase => ({
    case: "fact_doubted",
    place: PLACE,
    fact: "toilets",
    settles: "restored",
    feedback: [`fb_01JF${String(n).padStart(22, "0")}`],
  });
  const named = new Map([[PLACE, { name: "Ünïcode Camp ".repeat(21).trim() } as Place]]);
  const heldLines = (text: string) => text.split("\n").filter((l) => l.startsWith("- held-case ") || l.startsWith("- closed-case "));

  it("keeps the body and every follow-up comment under the limit, and lists every held and closed case exactly once", () => {
    const claims = Array.from({ length: MAX_CLAIMS_PER_RUN }, (_, n) => claim(n, address("elsewhere.example")));
    const held = Array.from({ length: 300 }, (_, n) => mismatch(n));
    const closed = Array.from({ length: 300 }, (_, n) => restored(n));
    const texts = reviewPrTexts("2026-11-04T00:00:00Z", [], named, claims, held, new Map(), closed);
    expect(texts.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(texts.comments.length).toBeGreaterThan(0);
    for (const comment of texts.comments) expect(comment.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(texts.body.split("\n").filter((l) => l.startsWith("- [ ] Approve owner claim "))).toHaveLength(MAX_CLAIMS_PER_RUN);
    const lines = [texts.body, ...texts.comments].flatMap(heldLines);
    expect(lines).toHaveLength(600);
    expect(new Set(lines).size).toBe(600);
    expect(reviewPrBody("2026-11-04T00:00:00Z", [], named, claims, held, new Map(), closed)).toBe(texts.body);
    expect(texts.body.length).toBeLessThan(GITHUB_LIMIT);
  });

  it("writes no follow-up comment when everything fits", () => {
    const texts = reviewPrTexts("2026-11-04T00:00:00Z", [], new Map(), [claim(1)], [mismatch(1)], new Map(), [restored(1)]);
    expect(texts.comments).toEqual([]);
    expect(heldLines(texts.body)).toHaveLength(2);
  });

  it("shows a shortened proof address on a claim line, and the full one stays in the inbox", () => {
    const body = reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [claim(1, address("elsewhere.example"))]);
    const line = body.split("\n").find((l) => l.startsWith("- [ ] Approve owner claim "))!;
    expect(line).not.toContain(address("proof.example"));
    expect(line).toContain("https://proof.example/aaa");
    expect(line).toContain("https://elsewhere.example/aaa");
    expect(line).toContain("ON A DIFFERENT SITE");
    expect(line.length).toBeLessThan(800);
  });

  it("cuts a long proof address between characters, never inside one", () => {
    const emoji = `https://proof.example/${"💧".repeat(100)}`;
    const body = reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [{ ...claim(1), proofUrl: emoji, proof: { found: true, checked: "2026-11-04T00:00:00Z", detail: "found" } }]);
    const line = body.split("\n").find((l) => l.startsWith("- [ ] Approve owner claim "))!;
    expect(line).toContain("💧...");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(line)).toBe(false);
  });

  it("writes the proof address as code, so it never makes a link or a mention", () => {
    const tricky = "https://proof.example/x`[click here](https://elsewhere.example/)`@someone";
    const body = reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [{ ...claim(1), proofUrl: tricky, proof: { found: true, checked: "2026-11-04T00:00:00Z", detail: "found" } }]);
    const line = body.split("\n").find((l) => l.startsWith("- [ ] Approve owner claim "))!;
    expect(line).toContain("found at `https://proof.example/x%60[click%20here](https://elsewhere.example/)%60@someone`");
    expect(line.match(/`/g)).toHaveLength(4);
  });

  it("escapes markdown in a shortened proof detail, even where the cut ends a quoted value", () => {
    const detail = `the page says "${"x".repeat(200)}[click](https://elsewhere.example/) and more"`;
    const body = reviewPrBody("2026-11-04T00:00:00Z", [], new Map(), [{ ...claim(1), proof: { found: false, checked: "2026-11-04T00:00:00Z", detail } }]);
    const line = body.split("\n").find((l) => l.startsWith("- [ ] Approve owner claim "))!;
    expect(line).toContain("\\[click\\]");
    expect(line).not.toMatch(/[^\\]\[click/);
  });
});
