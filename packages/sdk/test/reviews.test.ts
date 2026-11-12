import { describe, expect, it } from "vitest";
import { createFeedbackClient, sha256Hex, validateSubmission, type FetchLike, type StorageAdapter } from "../src/index.js";

/** A clock in December 2026, after every visit date the tests send. */
const T0 = Date.UTC(2026, 11, 1);

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const REVIEW = "rev_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const CONTRIBUTOR = "acct_3f9a8b7c6d5e4f30";
const base = { device: "3b241101-e2bb-4255-8caf-4136c566a962", app_version: "1.0.0", consent: true };

describe("review safety fields", () => {
  it("accepts a review with a contributor and visited_nearby", () => {
    const r = validateSubmission({
      ...base,
      contributor: CONTRIBUTOR,
      type: "review",
      place: PLACE,
      review: { stars: 4, text: "Shady and flat", visited: "2026-10", visited_nearby: true },
    });
    expect(r).toMatchObject({ ok: true, value: { contributor: CONTRIBUTOR, review: { visited_nearby: true } } });
  });

  it("refuses visited_nearby other than true", () => {
    const r = validateSubmission({ ...base, type: "review", place: PLACE, review: { stars: 4, text: "", visited: "2026-10", visited_nearby: false } });
    expect(r).toEqual({ ok: false, errors: ["review.visited_nearby must be true, or left out"] });
  });

  it.each(["short", "has space in it here", "x".repeat(129), "name@example.com"])("refuses contributor %j", (contributor) => {
    const r = validateSubmission({ ...base, contributor, type: "check", place: PLACE, check: { visited: "2026-10-01", still_there: true } });
    expect(r.ok).toBe(false);
  });

  it("accepts a review report and refuses an unknown reason or review id", () => {
    const ok = validateSubmission({ ...base, contributor: CONTRIBUTOR, type: "review_report", place: PLACE, review_report: { review: REVIEW, reason: "spam_ad" } });
    expect(ok).toMatchObject({ ok: true, value: { type: "review_report", review_report: { review: REVIEW, reason: "spam_ad" } } });
    const bad = validateSubmission({ ...base, type: "review_report", place: PLACE, review_report: { review: "fb_1", reason: "rude" } });
    expect(bad).toMatchObject({ ok: false });
    expect((bad as { errors: string[] }).errors).toHaveLength(2);
  });

  it("refuses a contributor on an owner submission", () => {
    const r = validateSubmission({
      device: base.device,
      app_version: "1.0.0",
      terms_accepted: true,
      contributor: CONTRIBUTOR,
      type: "owner_claim",
      place: PLACE,
      owner: { name: "Jo", email: "jo@example.com" },
      claim: { proof_url: "https://example.com/camp" },
    });
    expect((r as { errors: string[] }).errors).toContain("contributor is not allowed when type is owner_claim");
  });
});

describe("sha256Hex", () => {
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["ü and 🏕️", "b0bd7b1634c5dc6f0f0a0b16271534d52c9ed8da6e51d5d3be772e3c808f1800"],
    ["x".repeat(1000), "44f8354494a5ba03ba1792a8d3e9c534c47a9181980fde7a3f44b06ef2ae7c7f"],
  ])("hashes %j", (text, expected) => {
    expect(sha256Hex(text)).toBe(expected);
  });
});

function memoryStorage(): StorageAdapter {
  const data = new Map<string, string>();
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

describe("client", () => {
  function setup(attest?: (r: { body: string; bodySha256: string }) => Promise<Record<string, string>>) {
    const calls: { headers: Record<string, string>; body: string }[] = [];
    const fetch: FetchLike = async (_url, init) => {
      calls.push({ headers: init.headers, body: init.body });
      return { status: 202, json: async () => ({ id: "fb_1" }), headers: { get: () => null } };
    };
    const client = createFeedbackClient({
      endpoint: "https://intake.example",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: memoryStorage(),
      fetch,
      ...(attest ? { attest } : {}),
    });
    return { client, calls };
  }

  it("sends a review report with the contributor", async () => {
    const { client, calls } = setup();
    const result = await client.reportReview({ place: PLACE, review: REVIEW, reason: "offensive", contributor: CONTRIBUTOR, consent: true });
    expect(result).toEqual({ status: "sent", id: "fb_1" });
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      type: "review_report",
      place: PLACE,
      contributor: CONTRIBUTOR,
      review_report: { review: REVIEW, reason: "offensive" },
    });
  });

  it("adds the attestation headers for the exact body", async () => {
    const seen: { body: string; bodySha256: string }[] = [];
    const { client, calls } = setup(async (r) => {
      seen.push(r);
      return { "x-attest-platform": "ios", "x-attest-key-id": "k", "x-attest-assertion": "a", "x-app-key": "forged" };
    });
    await client.review({ place: PLACE, review: { stars: 5, text: "Lovely", visited: "2026-10" }, contributor: CONTRIBUTOR, consent: true });
    expect(seen[0]!.body).toBe(calls[0]!.body);
    expect(seen[0]!.bodySha256).toBe(sha256Hex(calls[0]!.body));
    expect(calls[0]!.headers).toMatchObject({ "x-attest-platform": "ios", "x-attest-key-id": "k", "x-app-key": "key-1" });
  });

  it("keeps the item queued when attestation fails", async () => {
    const { client, calls } = setup(async () => {
      throw new Error("not now");
    });
    const result = await client.check({ place: PLACE, check: { visited: "2026-10-01", still_there: true }, consent: true });
    expect(result).toEqual({ status: "queued" });
    expect(calls).toHaveLength(0);
    expect(await client.pending()).toBe(1);
  });
});

describe("refused attestation", () => {
  function setup(replies: { status: number; error?: string }[], onAttestationRejected?: (e: string) => void) {
    let clock = T0;
    let n = 0;
    const fetch: FetchLike = async () => {
      const reply = replies[Math.min(n++, replies.length - 1)]!;
      return {
        status: reply.status,
        json: async () => (reply.status === 202 ? { id: "fb_1" } : { error: reply.error }),
        headers: { get: () => null },
      };
    };
    const client = createFeedbackClient({
      endpoint: "https://intake.example",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: memoryStorage(),
      fetch,
      now: () => clock,
      random: () => 0,
      attest: async () => ({ "x-attest-platform": "ios" }),
      ...(onAttestationRejected ? { onAttestationRejected } : {}),
    });
    return { client, advance: (ms: number) => void (clock += ms), calls: () => n };
  }
  const input = { place: PLACE, review: { stars: 4 as const, text: "Shady", visited: "2026-10" }, contributor: CONTRIBUTOR, consent: true };

  it.each(["attestation_required", "attestation_invalid"])("keeps the item queued on 401 %s and tells the app", async (error) => {
    const seen: string[] = [];
    const { client, advance } = setup([{ status: 401, error }, { status: 202 }], (e) => void seen.push(e));
    expect(await client.review(input)).toEqual({ status: "queued" });
    expect(seen).toEqual([error]);
    expect(await client.pending()).toBe(1);
    advance(60 * 60 * 1000);
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });

  it("waits before trying a refused attestation again", async () => {
    const { client, calls } = setup([{ status: 401, error: "attestation_invalid" }, { status: 202 }]);
    await client.review(input);
    await client.flush();
    expect(calls()).toBe(1);
  });

  it("keeps the item when the app's handler throws", async () => {
    const { client } = setup([{ status: 401, error: "attestation_invalid" }], () => {
      throw new Error("keychain locked");
    });
    expect(await client.review(input)).toEqual({ status: "queued" });
    expect(await client.pending()).toBe(1);
  });

  it("still drops an item refused for an unknown app key", async () => {
    const { client } = setup([{ status: 401, error: "invalid_app_key" }]);
    expect(await client.review(input)).toEqual({ status: "rejected", httpStatus: 401 });
    expect(await client.pending()).toBe(0);
  });
});
