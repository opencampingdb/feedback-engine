import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StoredOwnerSubmission } from "@opencampingdb/feedback";
import {
  applyOwnerRules,
  botPrs,
  parseApprovals,
  type AwaitingClaim,
  type OwnerInput,
  type OwnerRecord,
  type ReviewPr,
} from "../src/owners.js";
import type { ProofResult } from "../src/proof.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const TOKEN = "q2Vb7Rk1cW9yZ3hVdm5Pb2pQTlR4Y0FyZ0lCd2pUcEs";
const OTHER_TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const NOW = "2026-10-31T09:00:00Z";
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: PLACE,
    name: "Riverbend Camp",
    kind: "paid_campground",
    group: "overnight",
    location: { lat: -36.85, lon: 144.55 },
    osm: { type: "node", id: 1, version: 1 },
    facts: { power: false, fee: true },
    status: "open",
    rating: null,
    fact_sources: { power: "osm", fee: "osm" },
    updated: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

const ownerOf = (placeId: string, token: string, claim = "fb_01JA0000000000000000000001"): OwnerRecord => ({
  place: placeId,
  claim,
  token_sha256: sha(token),
  approved: "2026-10-01",
  email: "jo@example.com",
  name: "Jo Bloggs",
});

let seq = 0;
const fbId = () => `fb_01JC${String(++seq).padStart(22, "0")}`;
const fields = (received = ago(0)) => ({ id: fbId(), received, app: "owner-page", device: "aaaa", app_version: "1.0.0", terms_accepted: true as const });

function updateItem(update: Record<string, unknown>, token = TOKEN, placeId = PLACE): StoredOwnerSubmission {
  return { ...fields(), type: "owner_update", place: placeId, token_sha256: sha(token), update } as StoredOwnerSubmission;
}

function claimItem(received = ago(0), placeId = PLACE): StoredOwnerSubmission {
  return {
    ...fields(received),
    type: "owner_claim",
    place: placeId,
    owner: { name: "Sam Owner", email: "sam@example.com" },
    claim: { proof_url: "https://riverbend.example/about" },
    code: "OCDB-7KQ2",
    token_sha256: sha(OTHER_TOKEN),
  } as StoredOwnerSubmission;
}

function listingItem(description = "Six grassy sites on a working sheep farm."): StoredOwnerSubmission {
  return {
    ...fields(),
    type: "owner_listing",
    place: null,
    location: { lat: -36.123456, lon: 145.654321 },
    owner: { name: "Sam Owner", email: "sam@example.com" },
    claim: { proof_url: "https://farm.example/stay" },
    listing: { name: "Riverbend Farm Stay", description, facts: { booking_url: "https://farm.example/book", toilets: true } },
    code: "OCDB-AB12",
    token_sha256: sha(OTHER_TOKEN),
  } as StoredOwnerSubmission;
}

const found: ProofResult = { found: true, checked: NOW, detail: "code found" };
const missing: ProofResult = { found: false, checked: NOW, detail: "code not found on the page" };

function run(opts: Partial<Omit<OwnerInput, "places" | "owners">> & { places?: Place[]; ownerList?: OwnerRecord[] } = {}) {
  const places = new Map((opts.places ?? [place(), place({ id: OTHER })]).map((p) => [p.id, p]));
  const owners = new Map((opts.ownerList ?? [ownerOf(PLACE, TOKEN)]).map((o) => [o.place, o]));
  const out = applyOwnerRules({
    now: NOW,
    pending: opts.pending ?? [],
    proofs: opts.proofs ?? new Map(),
    awaiting: opts.awaiting ?? [],
    reviewPrs: opts.reviewPrs ?? [],
    botLogins: ["opencampingdb-bot"],
    owners,
    places,
  });
  const decision = (item: { id: string }) => out.decisions.find((d) => d.id === item.id);
  return { ...out, decision, after: (id = PLACE) => out.places.get(id) };
}

describe("owner updates", () => {
  it("applies a matching update at once and marks the values as from the owner", () => {
    const item = updateItem({ facts: { power: true, booking_url: "https://riverbend.example/book" }, description: "Shady sites by the river." });
    const out = run({ pending: [item] });
    expect(out.decision(item)?.outcome).toBe("applied");
    expect(out.after()).toMatchObject({
      facts: { power: true, fee: true, booking_url: "https://riverbend.example/book" },
      fact_sources: { power: "owner", fee: "osm", booking_url: "owner", description: "owner" },
      fact_dates: { power: NOW, booking_url: NOW, description: NOW },
      description: "Shady sites by the river.",
      owner_verified: true,
      updated: NOW,
    });
  });

  it("takes pets_months off when the owner sets pets to anything but seasonal", () => {
    const seasonal = place({ facts: { pets: "seasonal", pets_months: "May-Sep" }, fact_sources: { pets: "osm", pets_months: "osm" } });
    const item = updateItem({ facts: { pets: "no" } });
    const out = run({ pending: [item], places: [seasonal] });
    expect(out.decision(item)?.outcome).toBe("applied");
    expect(out.after()?.facts).toEqual({ pets: "no" });
    expect(out.after()?.fact_sources).toEqual({ pets: "owner" });
  });

  // Updates that would leave a record the data validator refuses: a person decides, and nothing is written.
  const farmStay = place({
    kind: "farm_stay",
    osm: null,
    facts: { entry: "private", booking_required: true, booking_url: "https://farm.example/book" },
    fact_sources: { entry: "owner", booking_required: "owner", booking_url: "owner", name: "owner", location: "owner" },
    fact_dates: { entry: ago(30), booking_required: ago(30), booking_url: ago(30), name: ago(30), location: ago(30) },
    owner_verified: true,
    updated: ago(30),
  });
  it.each([
    ["pets_months on a place whose pets is not seasonal", place({ facts: { pets: "yes" }, fact_sources: { pets: "osm" } }), { pets_months: "May-Sep" }, "pets_months is only for a place whose pets fact is seasonal"],
    ["entry public on an owner-listed farm stay", farmStay, { entry: "public" }, "a farm_stay must have the fact entry private"],
    ["booking_required false on an owner-listed farm stay", farmStay, { booking_required: false }, "a farm_stay must have the fact booking_required true"],
  ])("sends %s to a person with the reason", (_, current, facts, reason) => {
    const item = updateItem({ facts });
    const out = run({ pending: [item], places: [current as Place] });
    expect(out.decision(item)).toMatchObject({ outcome: "needs_review", reason: expect.stringContaining(reason) });
    expect(out.after()).toBeUndefined();
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: item.id }]);
    expect(out.changes).toEqual([expect.objectContaining({ automatic: false, summary: expect.stringContaining(reason) })]);
  });

  it("still applies seasonal pets with its months", () => {
    const item = updateItem({ facts: { pets: "seasonal", pets_months: "May-Sep" } });
    const out = run({ pending: [item] });
    expect(out.decision(item)?.outcome).toBe("applied");
    expect(out.after()?.facts).toMatchObject({ pets: "seasonal", pets_months: "May-Sep" });
  });

  it("refuses a wrong token", () => {
    const item = updateItem({ facts: { power: true } }, "WRONGwrongWRONGwrongWRONGwrongWRONGwrong123");
    const out = run({ pending: [item] });
    expect(out.decision(item)).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/does not match/) });
    expect(out.after()).toBeUndefined();
  });

  it("refuses a token that belongs to another place", () => {
    const item = updateItem({ facts: { power: true } }, OTHER_TOKEN);
    const out = run({ pending: [item], ownerList: [ownerOf(PLACE, TOKEN), ownerOf(OTHER, OTHER_TOKEN)] });
    expect(out.decision(item)).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/another place/) });
    expect(out.after()).toBeUndefined();
    expect(out.after(OTHER)).toBeUndefined();
  });

  it("refuses an update for a place with no approved owner", () => {
    const item = updateItem({ facts: { power: true } }, TOKEN, OTHER);
    const out = run({ pending: [item] });
    expect(out.decision(item)).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/no approved owner/) });
  });

  it("refuses a description that fails moderation, and changes nothing", () => {
    const item = updateItem({ facts: { power: true }, description: "Best shit camp around" });
    const out = run({ pending: [item] });
    expect(out.decision(item)).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/offensive language/) });
    expect(out.after()).toBeUndefined();
  });

  it("removes the description when an empty one is sent", () => {
    const out = run({
      pending: [updateItem({ description: "" })],
      places: [
        place({
          description: "Old text",
          owner_verified: true,
          fact_sources: { power: "osm", fee: "osm", description: "owner" },
          fact_dates: { description: "2026-09-01T00:00:00Z" },
        }),
      ],
    });
    expect(out.after()?.description).toBeUndefined();
    expect(out.after()?.fact_sources.description).toBeUndefined();
    expect(out.after()?.fact_dates).toBeUndefined();
  });

  it("closes a place temporarily until its reopening date", () => {
    const item = updateItem({ status: "temporarily_closed", reopens: "2026-12-01" });
    const out = run({ pending: [item] });
    expect(out.after()).toMatchObject({
      status: "temporarily_closed",
      reopens: "2026-12-01",
      fact_sources: { status: "owner" },
      fact_dates: { status: NOW },
    });
  });

  it("refuses a reopening date that has already passed", () => {
    const item = updateItem({ status: "temporarily_closed", reopens: "2026-10-31" });
    const out = run({ pending: [item] });
    expect(out.decision(item)).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/reopens/) });
    expect(out.after()).toBeUndefined();
  });

  it("refuses a temporary closure of a closed place, so it never reopens by itself", () => {
    const item = updateItem({ status: "temporarily_closed", reopens: "2026-11-01" });
    const out = run({ pending: [item], places: [place({ status: "closed" }), place({ id: OTHER })] });
    expect(out.decision(item)).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/closed/) });
    expect(out.after()).toBeUndefined();
  });

  it("reopens a temporarily closed place once its date arrives", () => {
    const closed = place({ status: "temporarily_closed", reopens: "2026-10-31", fact_sources: { power: "osm", fee: "osm", status: "owner" } });
    const out = run({ places: [closed] });
    expect(out.after()).toMatchObject({ status: "open", fact_sources: { status: "owner" } });
    expect(out.after()?.reopens).toBeUndefined();
    expect(out.changes.some((c) => c.automatic && /reopened/.test(c.summary))).toBe(true);
  });

  it("leaves a place closed until the day before it reopens", () => {
    const closed = place({ status: "temporarily_closed", reopens: "2026-11-01", fact_sources: { status: "owner" } });
    expect(run({ places: [closed] }).after()).toBeUndefined();
  });

  it("lets the owner end a temporary closure early", () => {
    const closed = place({ status: "temporarily_closed", reopens: "2026-12-01", fact_sources: { status: "owner" } });
    const out = run({ places: [closed], pending: [updateItem({ status: "open" })] });
    expect(out.after()?.status).toBe("open");
    expect(out.after()?.reopens).toBeUndefined();
  });

  it("sends a name or location change, or reopening a closed place, to a person", () => {
    const item = updateItem({ name: "Riverbend Bush Camp", location: { lat: -36.86, lon: 144.56 }, facts: { power: true } });
    const reopen = updateItem({ status: "open" });
    const out = run({ pending: [item, reopen], places: [place({ status: "closed" }), place({ id: OTHER })] });
    expect(out.decision(item)?.outcome).toBe("needs_review");
    expect(out.after()?.facts.power).toBe(true); // the rest applies at once
    expect(out.after()?.name).toBe("Riverbend Camp");
    expect(out.edits).toEqual(
      expect.arrayContaining([
        { kind: "name", place: PLACE, name: "Riverbend Bush Camp", feedback: item.id, source: "owner" },
        { kind: "location", place: PLACE, location: { lat: -36.86, lon: 144.56 }, feedback: item.id, source: "owner" },
        { kind: "note", place: PLACE, feedback: reopen.id },
      ]),
    );
    expect(out.decision(reopen)?.outcome).toBe("needs_review");
  });
});

describe("claims and listings before review", () => {
  it("sends a claim with its code found to the review PR, with no data change", () => {
    const item = claimItem();
    const out = run({ pending: [item], proofs: new Map([[item.id, found]]), ownerList: [] });
    expect(out.decision(item)?.outcome).toBe("awaiting_approval");
    expect(out.places.size).toBe(0);
    expect(out.forReview).toEqual([expect.objectContaining({ claim: item.id, place: PLACE, proof: found, replaces: undefined })]);
  });

  it("keeps a claim pending while its code is not on the page yet", () => {
    const item = claimItem(ago(2));
    const out = run({ pending: [item], proofs: new Map([[item.id, missing]]) });
    expect(out.decision(item)?.outcome).toBe("waiting");
    expect(out.forReview).toHaveLength(0);
  });

  it("sends a claim to a person after 7 days even when the code was never found", () => {
    const item = claimItem(ago(8));
    const out = run({ pending: [item], proofs: new Map([[item.id, missing]]) });
    expect(out.decision(item)?.outcome).toBe("awaiting_approval");
    expect(out.forReview[0]?.proof.found).toBe(false);
  });

  it("says when a claim would replace the current owner", () => {
    const item = claimItem();
    const out = run({ pending: [item], proofs: new Map([[item.id, found]]) });
    expect(out.forReview[0]?.replaces).toEqual({ claim: "fb_01JA0000000000000000000001", approved: "2026-10-01" });
  });

  it("refuses a listing whose farm stay the data validator would refuse", () => {
    const base = listingItem() as Extract<StoredOwnerSubmission, { type: "owner_listing" }>;
    const item = { ...base, listing: { ...base.listing, facts: { ...base.listing.facts, pets: "yes", pets_months: "May-Sep" } } } as StoredOwnerSubmission;
    const out = run({ pending: [item], proofs: new Map([[item.id, found]]) });
    expect(out.decision(item)).toMatchObject({ outcome: "refused", reason: expect.stringContaining("pets_months is only for a place whose pets fact is seasonal") });
    expect(out.forReview).toHaveLength(0);
  });

  it("refuses a claim on a place that is not in the data", () => {
    const item = claimItem(ago(0), "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZZ");
    expect(run({ pending: [item], proofs: new Map([[item.id, found]]) }).decision(item)?.outcome).toBe("refused");
  });

  it("refuses a listing whose description fails moderation", () => {
    const item = listingItem("Message me at sam@example.com");
    const out = run({ pending: [item], proofs: new Map([[item.id, found]]) });
    expect(out.decision(item)).toMatchObject({ outcome: "refused", reason: expect.stringMatching(/email/) });
  });

  it("sends a listing to review with the farm stay it would create", () => {
    const item = listingItem();
    const out = run({ pending: [item], proofs: new Map([[item.id, found]]) });
    expect(out.decision(item)?.outcome).toBe("awaiting_approval");
    expect(out.forReview[0]).toMatchObject({ claim: item.id, place: `ocdb_${item.id.slice(3)}`, listing: { name: "Riverbend Farm Stay" } });
  });
});

// The bot as GitHub's GraphQL API names a comment's author: its slug, with the account type.
const BOT = { login: "opencampingdb-bot", type: "Bot" };

function awaitingOf(item: StoredOwnerSubmission, sent = ago(1)): AwaitingClaim {
  const placeId = item.type === "owner_listing" ? `ocdb_${item.id.slice(3)}` : (item.place as string);
  return { item: item as AwaitingClaim["item"], place: placeId, sent, proof: found };
}

const PR_AUTHOR = { login: "app/opencampingdb-bot" };
const merged = (body: string, comments: ReviewPr["comments"] = []): ReviewPr => ({
  number: 7,
  state: "MERGED",
  body,
  comments,
  author: PR_AUTHOR,
  isCrossRepository: false,
});

describe("approval by merging the review PR", () => {
  it("reads only ticked boxes at the start of a line, from the body and the bot's comments", () => {
    const pr = merged("intro\n- [x] Approve owner claim fb_01JC0000000000000000000001: x\n- [ ] Approve owner claim fb_01JC0000000000000000000002: y", [
      { author: BOT, body: "- [X] Approve owner claim fb_01JC0000000000000000000003: z" },
      { author: { login: "someone" }, body: "- [x] Approve owner claim fb_01JC0000000000000000000004: me too" },
      { author: BOT, body: "text - [x] Approve owner claim fb_01JC0000000000000000000005 in the middle" },
    ]);
    expect(parseApprovals(pr, ["opencampingdb-bot"])).toEqual({
      ticked: ["fb_01JC0000000000000000000001", "fb_01JC0000000000000000000003"],
      refused: [],
      listed: ["fb_01JC0000000000000000000001", "fb_01JC0000000000000000000002", "fb_01JC0000000000000000000003"],
    });
  });

  it("reads comments only from an account of type Bot with the bot's login", () => {
    const tick = (n: number) => `- [x] Approve owner claim fb_01JC000000000000000000000${n}: x`;
    const pr = merged("intro", [
      { author: { login: "opencampingdb-bot" }, body: tick(1) },
      { author: { login: "opencampingdb-bot", type: "User" }, body: tick(2) },
      { author: { login: "opencampingdb-bot", type: "Organization" }, body: tick(3) },
      { author: { login: "other-bot", type: "Bot" }, body: tick(4) },
      { author: { login: "opencampingdb-bot", type: "Bot" }, body: tick(5) },
      { author: { login: "opencampingdb-bot[bot]" }, body: tick(6) },
      { author: { login: "app/opencampingdb-bot" }, body: tick(7) },
    ]);
    expect(parseApprovals(pr, ["opencampingdb-bot"]).ticked).toEqual([
      "fb_01JC0000000000000000000005",
      "fb_01JC0000000000000000000006",
      "fb_01JC0000000000000000000007",
    ]);
  });

  it("does not count a PR opened by an account whose login is the bare bot slug", () => {
    const body = "- [x] Approve owner claim fb_01JC0000000000000000000001: x";
    expect(parseApprovals({ ...merged(body), author: { login: "opencampingdb-bot" } }, ["opencampingdb-bot"]).ticked).toEqual([]);
    expect(parseApprovals({ ...merged(body), author: { login: "opencampingdb-bot", type: "User" } }, ["opencampingdb-bot"]).ticked).toEqual([]);
    expect(parseApprovals({ ...merged(body), author: { login: "opencampingdb-bot", type: "Bot" } }, ["opencampingdb-bot"]).ticked).toEqual([
      "fb_01JC0000000000000000000001",
    ]);
  });

  for (const ch of ["\u2028", "\u2029", "\u0085", "\r"]) {
    it(`reads a box only at the start of a newline, not after ${JSON.stringify(ch)}`, () => {
      const claim = "fb_01JC0000000000000000000001";
      const pr = merged(`- [ ] Approve owner claim ${claim}: x`, [
        { author: BOT, body: `- held-case {"file":"a${ch}- [x] Approve owner claim ${claim}"}` },
      ]);
      expect(parseApprovals(pr, ["opencampingdb-bot"])).toEqual({ ticked: [], refused: [], listed: [claim] });
    });
  }

  it("ignores PRs from a fork and PRs the bot did not open", () => {
    const body = "- [x] Approve owner claim fb_01JC0000000000000000000001: x";
    const none = { ticked: [], refused: [], listed: [] };
    expect(parseApprovals({ ...merged(body), isCrossRepository: true }, ["opencampingdb-bot"])).toEqual(none);
    expect(parseApprovals({ ...merged(body), author: { login: "someone" } }, ["opencampingdb-bot"])).toEqual(none);
    expect(parseApprovals({ ...merged(body), author: null }, ["opencampingdb-bot"])).toEqual(none);
    expect(parseApprovals(merged(body), ["opencampingdb-bot"]).ticked).toEqual(["fb_01JC0000000000000000000001"]);
  });

  it("does not refuse a claim named in a closed PR from a fork", () => {
    const item = claimItem();
    const fork: ReviewPr = { ...merged(`- [ ] Approve owner claim ${item.id}: x`), number: 99, state: "CLOSED", isCrossRepository: true, author: { login: "someone" } };
    const out = run({ ownerList: [], awaiting: [awaitingOf(item)], reviewPrs: [fork] });
    expect(out.approvals).toEqual([]);
  });

  it("approves a ticked claim: writes the owner record and sets owner_verified", () => {
    const item = claimItem();
    const out = run({
      ownerList: [],
      awaiting: [awaitingOf(item)],
      reviewPrs: [merged(`- [x] Approve owner claim ${item.id}: Riverbend`)],
    });
    expect(out.approvals).toEqual([{ claim: item.id, outcome: "approved", reason: "approved on review PR #7" }]);
    expect(out.owners.get(PLACE)).toEqual({
      place: PLACE,
      claim: item.id,
      token_sha256: sha(OTHER_TOKEN),
      approved: "2026-10-31",
      email: "sam@example.com",
      name: "Sam Owner",
    });
    expect(out.after()?.owner_verified).toBe(true);
  });

  it("a replacement claim replaces the old token hash", () => {
    const item = claimItem();
    const out = run({ awaiting: [awaitingOf(item)], reviewPrs: [merged(`- [x] Approve owner claim ${item.id}: Riverbend`)] });
    expect(out.owners.get(PLACE)?.token_sha256).toBe(sha(OTHER_TOKEN));
    expect(out.changes.some((c) => /replaces/.test(c.summary))).toBe(true);
    // The old token no longer works once the new record is written.
    const later = updateItem({ facts: { power: true } }, TOKEN);
    const next = run({ pending: [later], ownerList: [out.owners.get(PLACE)!] });
    expect(next.decision(later)?.outcome).toBe("refused");
  });

  it("approves a listing by creating a private farm stay", () => {
    const item = listingItem();
    const out = run({ awaiting: [awaitingOf(item)], reviewPrs: [merged(`- [x] Approve owner listing ${item.id}: Riverbend Farm Stay`)] });
    const id = `ocdb_${item.id.slice(3)}`;
    expect(out.after(id)).toEqual({
      id,
      name: "Riverbend Farm Stay",
      kind: "farm_stay",
      group: "overnight",
      location: { lat: -36.123456, lon: 145.654321 },
      osm: null,
      facts: { booking_url: "https://farm.example/book", toilets: true, entry: "private", booking_required: true },
      fact_sources: {
        booking_url: "owner",
        toilets: "owner",
        entry: "owner",
        booking_required: "owner",
        name: "owner",
        location: "owner",
        description: "owner",
      },
      fact_dates: {
        booking_url: NOW,
        toilets: NOW,
        entry: NOW,
        booking_required: NOW,
        name: NOW,
        location: NOW,
        description: NOW,
      },
      status: "open",
      rating: null,
      description: "Six grassy sites on a working sheep farm.",
      owner_verified: true,
      updated: NOW,
    });
    expect(out.owners.get(id)?.claim).toBe(item.id);
  });

  it("refuses a claim whose Refuse box is ticked in a merged PR", () => {
    const a = claimItem();
    const out = run({
      ownerList: [],
      awaiting: [awaitingOf(a)],
      reviewPrs: [merged(`- [ ] Approve owner claim ${a.id}: x\n- [x] Refuse owner claim ${a.id}`)],
    });
    expect(out.approvals).toEqual([{ claim: a.id, outcome: "refused", reason: "refused on review PR #7" }]);
    expect(out.owners.size).toBe(0);
    expect(out.forReview).toEqual([]);
  });

  it("lists a claim again when its PR was merged with neither box ticked, or both, or was closed", () => {
    const a = claimItem();
    const b = claimItem(ago(0), OTHER);
    const c = claimItem();
    const out = run({
      ownerList: [ownerOf(PLACE, TOKEN)],
      awaiting: [awaitingOf(a), awaitingOf(b), awaitingOf(c)],
      reviewPrs: [
        merged(`- [ ] Approve owner claim ${a.id}: x\n- [ ] Refuse owner claim ${a.id}\n- [x] Approve owner claim ${c.id}: z\n- [x] Refuse owner claim ${c.id}`),
        { ...merged(`- [x] Approve owner claim ${b.id}: y`), number: 8, state: "CLOSED" },
      ],
    });
    expect(out.approvals).toEqual([]);
    expect(out.owners.size).toBe(0);
    expect(out.places.size).toBe(0);
    expect(out.forReview.map((f) => [f.claim, f.again, f.place])).toEqual([
      [a.id, 7, PLACE],
      [b.id, 8, OTHER],
      [c.id, 7, PLACE],
    ]);
    // The claim on PLACE would still replace its approved owner.
    expect(out.forReview[0]!.replaces).toEqual({ claim: "fb_01JA0000000000000000000001", approved: "2026-10-01" });
    expect(out.forReview[1]!.replaces).toBeUndefined();
  });

  it("does not list a claim again while an open PR lists it, or when no PR ever did", () => {
    const a = claimItem();
    const b = claimItem();
    const out = run({
      ownerList: [],
      awaiting: [awaitingOf(a), awaitingOf(b)],
      reviewPrs: [{ ...merged(`- [ ] Approve owner claim ${a.id}: x`), number: 9, state: "OPEN" }, merged(`- [ ] Approve owner claim ${a.id}: x`)],
    });
    expect(out.approvals).toEqual([]);
    expect(out.forReview).toEqual([]);
  });

  it("does not count a box ticked after the PR was merged, in the body or in a comment", () => {
    const a = claimItem();
    const b = claimItem(ago(0), OTHER);
    const late = {
      ...merged(`- [x] Approve owner claim ${a.id}: x`, [{ author: BOT, body: `- [x] Approve owner claim ${b.id}: y`, editedAt: "2026-10-30T10:00:01Z" }]),
      mergedAt: "2026-10-30T10:00:00Z",
      bodyEditedAt: "2026-10-30T10:05:00Z",
    };
    const out = run({ ownerList: [], awaiting: [awaitingOf(a), awaitingOf(b)], reviewPrs: [late] });
    expect(out.approvals).toEqual([]);
    expect(out.owners.size).toBe(0);
    expect(out.forReview.map((f) => f.claim)).toEqual([a.id, b.id]);
    // Ticked before the merge, the same boxes approve.
    const inTime = { ...late, bodyEditedAt: "2026-10-30T09:59:00Z", comments: [{ author: BOT, body: `- [x] Approve owner claim ${b.id}: y`, editedAt: "2026-10-30T10:00:00Z" }] };
    expect(run({ ownerList: [], awaiting: [awaitingOf(a), awaitingOf(b)], reviewPrs: [inTime] }).approvals.map((x) => x.outcome)).toEqual(["approved", "approved"]);
  });

  it("keeps waiting while the review PR is open, and gives up after 60 days", () => {
    const a = claimItem();
    const b = claimItem();
    const out = run({
      ownerList: [],
      awaiting: [awaitingOf(a, ago(3)), awaitingOf(b, ago(61))],
      reviewPrs: [{ ...merged(`- [x] Approve owner claim ${a.id}: x\n- [ ] Approve owner claim ${b.id}: y`), number: 9, state: "OPEN" }],
    });
    expect(out.approvals).toEqual([{ claim: b.id, outcome: "refused", reason: "no decision within 60 days" }]);
  });
});

describe("a place whose owner was removed", () => {
  it("loses owner_verified when it has no owner record, and keeps the values the owner set", () => {
    const verified = place({ owner_verified: true, facts: { power: true, fee: true }, fact_sources: { power: "owner", fee: "osm" } });
    const out = run({ places: [verified, place({ id: OTHER, owner_verified: true })], ownerList: [ownerOf(OTHER, TOKEN)] });
    expect(out.places.size).toBe(1);
    expect(out.after()).not.toHaveProperty("owner_verified");
    expect(out.after()!.facts).toEqual({ power: true, fee: true });
    expect(out.after()!.fact_sources).toEqual({ power: "owner", fee: "osm" });
    expect(out.changes).toEqual([{ place: PLACE, summary: "the place has no owner record any more, so it is no longer owner verified", automatic: true, feedback: [] }]);
  });

  it("refuses an update with the removed owner's token in the same run", () => {
    const item = updateItem({ facts: { power: true } });
    const out = run({ places: [place({ owner_verified: true })], ownerList: [], pending: [item] });
    expect(out.decision(item)).toMatchObject({ outcome: "refused", reason: "the place has no approved owner" });
    expect(out.after()).not.toHaveProperty("owner_verified");
    expect(out.after()!.facts.power).toBe(false);
  });

  it("keeps owner_verified on a place approved in this run", () => {
    const c = claimItem();
    const out = run({ ownerList: [], awaiting: [awaitingOf(c)], reviewPrs: [merged(`- [x] Approve owner claim ${c.id}: x`)] });
    expect(out.after()!.owner_verified).toBe(true);
  });
});

describe("merged places", () => {
  const tombstone = place({ id: OTHER, status: "merged", merged_into: PLACE });

  it("applies an owner update for a merged id to the place it was merged into", () => {
    const item = updateItem({ facts: { power: true } }, TOKEN, OTHER);
    const out = run({ pending: [item], places: [tombstone, place()], ownerList: [ownerOf(PLACE, TOKEN)] });
    expect(out.decision(item)?.outcome).toBe("applied");
    expect(out.after()?.facts.power).toBe(true);
    expect(out.after(OTHER)).toBeUndefined();
  });

  it("sends a claim for a merged id to review against the place it was merged into", () => {
    const item = claimItem(ago(0), OTHER);
    const out = run({ pending: [item], proofs: new Map([[item.id, found]]), places: [tombstone, place()], ownerList: [] });
    expect(out.forReview[0]?.place).toBe(PLACE);
  });
});

describe("the bot's own PRs", () => {
  const pr = (number: number, login: string, type: string | undefined, isCrossRepository = false): ReviewPr => ({
    number,
    state: "MERGED",
    body: "",
    isCrossRepository,
    author: { login, ...(type ? { type } : {}) } as ReviewPr["author"],
    comments: [],
  });

  it("keeps only PRs from the data repository that the bot opened, in order, by the one author rule", () => {
    const prs = [
      pr(9, "opencampingdb-bot", "Bot"),
      pr(8, "opencampingdb-bot", "User"),
      pr(7, "opencampingdb-bot[bot]", undefined),
      pr(6, "app/opencampingdb-bot", undefined),
      pr(5, "opencampingdb-bot", undefined),
      pr(4, "opencampingdb-bot", "Bot", true),
      pr(3, "someone", "User"),
    ];
    expect(botPrs(prs, ["opencampingdb-bot"]).map((p) => p.number)).toEqual([9, 7, 6]);
  });
});
