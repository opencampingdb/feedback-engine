import { describe, expect, it } from "vitest";
import {
  createFeedbackClient,
  FeedbackValidationError,
  OWNER_TERMS_SUMMARY,
  OWNER_TERMS_URL,
  OwnerRequestError,
  OwnerTermsRequiredError,
  validateSubmission,
  type FetchLike,
  type StorageAdapter,
} from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DEVICE = "3b241101-e2bb-4255-8caf-4136c566a962";
const TOKEN = "q2Vb7Rk1cW9yZ3hVdm5Pb2pQTlR4Y0FyZ0lCd2pUcEs";
const base = { device: DEVICE, app_version: "1.0.0", terms_accepted: true };
const owner = { name: "Jo Bloggs", email: "jo@example.com" };

const claim = { ...base, type: "owner_claim", place: PLACE, owner, claim: { proof_url: "https://riverbend.example/about" } };
const listing = {
  ...base,
  type: "owner_listing",
  place: null,
  location: { lat: -36.85, lon: 144.55 },
  owner,
  claim: { proof_url: "https://riverbend.example/stay" },
  listing: {
    name: "Riverbend Farm Stay",
    description: "Six grassy sites beside the river on a working sheep farm.",
    facts: { booking_url: "https://riverbend.example/book", toilets: true, pets: "leashed" },
  },
};
const update = {
  ...base,
  type: "owner_update",
  place: PLACE,
  token: TOKEN,
  update: { facts: { power: true }, description: "Now with powered sites." },
};

function errorsOf(body: unknown): string {
  const r = validateSubmission(body);
  return r.ok ? "" : r.errors.join(" | ");
}

describe("new place kind", () => {
  const newPlace = {
    type: "report",
    place: null,
    location: { lat: -36.85, lon: 144.55 },
    device: DEVICE,
    app_version: "1.0.0",
    consent: true,
  };

  it("accepts a kind code the user picked", () => {
    const r = validateSubmission({ ...newPlace, report: { kind: "new_place", place_kind: "free_camp" } });
    expect(r).toMatchObject({ ok: true, value: { report: { place_kind: "free_camp" } } });
  });

  it("refuses a kind that is not a code, or on another report kind", () => {
    expect(errorsOf({ ...newPlace, report: { kind: "new_place", place_kind: "Free Camp!" } })).toContain("place_kind");
    expect(errorsOf({ ...newPlace, place: PLACE, location: undefined, report: { kind: "closed", place_kind: "free_camp" } })).toContain(
      "place_kind is only allowed",
    );
  });
});

describe("owner validation", () => {
  it("accepts a claim, a listing and an update", () => {
    expect(validateSubmission(claim).ok).toBe(true);
    expect(validateSubmission(listing).ok).toBe(true);
    expect(validateSubmission(update).ok).toBe(true);
  });

  it("needs terms_accepted: true and no consent field", () => {
    expect(errorsOf({ ...claim, terms_accepted: false })).toContain("terms_accepted must be true");
    expect(errorsOf({ ...claim, terms_accepted: undefined })).toContain("terms_accepted must be true");
  });

  it.each([
    [{ ...claim, place: null }, "place is required"],
    [{ ...claim, owner: { name: "", email: "jo@example.com" } }, "owner.name"],
    [{ ...claim, owner: { name: "Jo", email: "not an email" } }, "owner.email"],
    [{ ...claim, claim: { proof_url: "http://riverbend.example" } }, "claim.proof_url"],
    [{ ...claim, claim: { proof_url: "https://localhost/x" } }, "claim.proof_url"],
    [{ ...claim, token: TOKEN }, "token is not allowed"],
    [{ ...listing, place: PLACE }, "place must be null"],
    [{ ...listing, location: undefined }, "location is required"],
    [{ ...listing, listing: { ...listing.listing, facts: { toilets: true } } }, "booking_url or phone"],
    [{ ...listing, listing: { ...listing.listing, name: "" } }, "listing.name"],
    [{ ...listing, listing: { ...listing.listing, description: "x".repeat(501) } }, "listing.description"],
    [{ ...listing, listing: { ...listing.listing, facts: { booking_url: "http://x.example" } } }, "booking_url"],
    [{ ...listing, listing: { ...listing.listing, facts: { phone: "0412 345 678", access: "4wd" } } }, "access"],
    [{ ...update, token: "short" }, "token"],
    [{ ...update, owner }, "owner is not allowed"],
    [{ ...update, update: {} }, "update must change something"],
    [{ ...update, update: { status: "temporarily_closed" } }, "reopens"],
    [{ ...update, update: { status: "closed" } }, "update.status"],
    [{ ...update, update: { reopens: "2026-12-01" } }, "reopens is only allowed"],
    [{ ...update, update: { status: "temporarily_closed", reopens: "2026-02-30" } }, "update.reopens"],
    [{ ...update, update: { facts: { rating: 5 } } }, "update.facts.rating"],
    [{ ...update, update: { description: "x".repeat(501) } }, "update.description"],
  ])("refuses %#: %s", (body, message) => {
    expect(errorsOf(body)).toContain(message);
  });

  it("accepts a temporary closure with a reopening date and a name change for a person", () => {
    const body = { ...update, update: { status: "temporarily_closed", reopens: "2026-12-01", name: "Riverbend Camp" } };
    expect(validateSubmission(body).ok).toBe(true);
  });
});

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function client(reply: { status: number; body?: unknown } | "network") {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    if (reply === "network") throw new TypeError("Network request failed");
    return {
      status: reply.status,
      json: async () => reply.body ?? {},
      headers: { get: () => null },
    };
  };
  const c = createFeedbackClient({
    endpoint: "https://intake.example",
    appKey: "owner-page-key",
    appVersion: "1.0.0",
    storage: memoryStorage(),
    fetch,
    randomUUID: () => DEVICE,
  });
  return { c, calls };
}

describe("owner client calls", () => {
  it("ownerClaim sends at once and returns the code and token", async () => {
    const { c, calls } = client({ status: 202, body: { id: "fb_1", code: "OCDB-7KQ2", token: TOKEN } });
    const result = await c.ownerClaim({
      place: PLACE,
      owner,
      proofUrl: "https://riverbend.example/about",
      termsAccepted: true,
    });
    expect(result).toEqual({ id: "fb_1", code: "OCDB-7KQ2", token: TOKEN });
    expect(calls[0]!.body).toEqual({ ...claim, device: DEVICE });
    expect(await c.pending()).toBe(0); // owner calls are never queued
  });

  it("ownerListing sends the listing", async () => {
    const { c, calls } = client({ status: 202, body: { id: "fb_2", code: "OCDB-AB12", token: TOKEN } });
    await c.ownerListing({
      location: listing.location,
      owner,
      proofUrl: listing.claim.proof_url,
      listing: listing.listing as never,
      termsAccepted: true,
    });
    expect(calls[0]!.body).toEqual({ ...listing, device: DEVICE });
  });

  it("ownerUpdate carries the token", async () => {
    const { c, calls } = client({ status: 202, body: { id: "fb_3" } });
    expect(await c.ownerUpdate(TOKEN, { place: PLACE, update: update.update, termsAccepted: true })).toEqual({ id: "fb_3" });
    expect(calls[0]!.body).toEqual({ ...update, device: DEVICE });
  });

  it("refuses to send without the owner terms", async () => {
    const { c, calls } = client({ status: 202 });
    await expect(
      c.ownerClaim({ place: PLACE, owner, proofUrl: "https://riverbend.example", termsAccepted: false }),
    ).rejects.toBeInstanceOf(OwnerTermsRequiredError);
    expect(calls).toHaveLength(0);
  });

  it("throws on an invalid payload before sending", async () => {
    const { c, calls } = client({ status: 202 });
    await expect(c.ownerUpdate("short", { place: PLACE, update: { facts: { power: true } }, termsAccepted: true })).rejects.toBeInstanceOf(
      FeedbackValidationError,
    );
    expect(calls).toHaveLength(0);
  });

  it("reports the intake's answer when it refuses or cannot be reached", async () => {
    const refused = client({ status: 429 });
    await expect(refused.c.ownerUpdate(TOKEN, { place: PLACE, update: update.update, termsAccepted: true })).rejects.toMatchObject({
      name: "OwnerRequestError",
      httpStatus: 429,
    });
    const offline = client("network");
    const error = await offline.c
      .ownerUpdate(TOKEN, { place: PLACE, update: update.update, termsAccepted: true })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OwnerRequestError);
    expect((error as OwnerRequestError).httpStatus).toBe(0);
  });

  it("exports the owner terms summary", () => {
    expect(OWNER_TERMS_SUMMARY).toMatch(/ODbL/);
    expect(OWNER_TERMS_SUMMARY).toMatch(/council/);
    expect(OWNER_TERMS_URL).toMatch(/^https:\/\//);
    expect(OWNER_TERMS_SUMMARY).not.toMatch(/[–—]/);
  });
});
