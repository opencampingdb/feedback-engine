import { describe, expect, it } from "vitest";
import {
  ConsentRequiredError,
  CONSENT_TEXT,
  createFeedbackClient,
  FeedbackValidationError,
  type FeedbackClientOptions,
  type FetchLike,
  sdkCoordinate,
  tidyName,
  tidyText,
  type Answer,
  type FactsInput,
  HELD_REASONS,
  itemDecision,
  keyIsUnusable,
  type RefusalReason,
  type StorageAdapter,
} from "../src/index.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";

function memoryStorage(): StorageAdapter & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    removeItem: async (k) => {
      data.delete(k);
    },
  };
}

type Reply = number | "network" | { status: number; retryAfter?: string; body?: unknown };

function fakeFetch(replies: Reply[]) {
  const calls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  let n = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const reply = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    if (reply === "network") throw new TypeError("Network request failed");
    const status = typeof reply === "number" ? reply : reply.status;
    const retryAfter = typeof reply === "object" ? reply.retryAfter ?? null : null;
    const body = typeof reply === "object" && "body" in reply ? reply.body : status === 202 ? { id: `fb_${n}` } : { error: "x" };
    return {
      status,
      json: async () => body,
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter : null) },
    };
  };
  return { fetch, calls };
}

function setup(replies: Reply[], start = 1_000_000, extra: Partial<FeedbackClientOptions> = {}) {
  const storage = memoryStorage();
  const { fetch, calls } = fakeFetch(replies);
  let clock = start;
  let uuid = 0;
  const client = createFeedbackClient({
    endpoint: "https://intake.example/",
    appKey: "key-1",
    appVersion: "1.2.3",
    storage,
    fetch,
    now: () => clock,
    random: () => 0,
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    ...extra,
  });
  return {
    client,
    storage,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const check = { place: PLACE, check: { visited: "2026-10-20", still_there: true }, consent: true };

describe("createFeedbackClient", () => {
  it("refuses to send without consent", async () => {
    const { client, calls } = setup([202]);
    await expect(client.check({ ...check, consent: false })).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(calls).toHaveLength(0);
  });

  it("sends a check with the app key, device and version", async () => {
    const { client, calls } = setup([202]);
    const result = await client.check(check);
    expect(result).toEqual({ status: "sent", id: "fb_1" });
    expect(calls[0]!.url).toBe("https://intake.example/v1/feedback");
    expect(calls[0]!.headers["x-app-key"]).toBe("key-1");
    expect(calls[0]!.body).toEqual({
      type: "check",
      place: PLACE,
      device: "00000000-0000-4000-8000-000000000001",
      app_version: "1.2.3",
      consent: true,
      check: { visited: "2026-10-20", still_there: true },
    });
  });

  it("withdraws a new place it sent", async () => {
    const { client, calls } = setup([202]);
    expect(await client.withdraw({ place: PLACE, consent: true })).toEqual({ status: "sent", id: "fb_1" });
    expect(calls[0]!.url).toBe("https://intake.example/v1/feedback");
    expect(calls[0]!.body).toEqual({
      type: "withdraw",
      place: PLACE,
      device: "00000000-0000-4000-8000-000000000001",
      app_version: "1.2.3",
      consent: true,
    });
  });

  it("generates one device id per install and keeps it", async () => {
    const { client, calls, storage } = setup([202]);
    await client.check(check);
    await client.review({ place: PLACE, review: { stars: 4, text: "Shady and quiet", visited: "2026-10" }, consent: true });
    const devices = calls.map((c) => (c.body as { device: string }).device);
    expect(new Set(devices).size).toBe(1);
    expect(storage.data.get("ocdb.feedback.device")).toBe(devices[0]);
  });

  it("throws on an invalid payload before queuing it", async () => {
    const { client, calls } = setup([202]);
    await expect(
      client.review({ place: PLACE, review: { stars: 6 as 5, text: "", visited: "2026-10" }, consent: true }),
    ).rejects.toBeInstanceOf(FeedbackValidationError);
    expect(calls).toHaveLength(0);
    expect(await client.pending()).toBe(0);
  });

  it("keeps an item on a network error and sends it on a later flush", async () => {
    const { client, calls, advance } = setup(["network", 202]);
    expect(await client.check(check)).toEqual({ status: "queued" });
    expect(await client.pending()).toBe(1);

    // Not due yet: backoff is 15 to 30 seconds after the first failure.
    expect(await client.flush()).toEqual({ sent: 0, dropped: 0, remaining: 1 });
    expect(calls).toHaveLength(1);

    advance(30_000);
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(await client.pending()).toBe(0);
  });

  it("keeps items on 429 and 5xx", async () => {
    for (const status of [429, 500, 503]) {
      const { client } = setup([status]);
      expect(await client.check(check)).toEqual({ status: "queued" });
      expect(await client.pending()).toBe(1);
    }
  });

  it("honours Retry-After on 429", async () => {
    const { client, calls, advance } = setup([{ status: 429, retryAfter: "120" }, 202]);
    await client.check(check);
    advance(60_000);
    await client.flush();
    expect(calls).toHaveLength(1);
    advance(60_000);
    expect((await client.flush()).sent).toBe(1);
  });

  it("drops items on 400 and 401", async () => {
    for (const status of [400, 401]) {
      const { client } = setup([status]);
      expect(await client.check(check)).toEqual({ status: "rejected", httpStatus: status });
      expect(await client.pending()).toBe(0);
    }
  });

  it("backs off further after each failure", async () => {
    const { client, calls, advance } = setup(["network"]);
    await client.check(check);
    advance(15_000);
    await client.flush(); // second try
    expect(calls).toHaveLength(2);
    advance(15_000);
    await client.flush(); // not due: second backoff is at least 30 seconds
    expect(calls).toHaveLength(2);
    advance(15_000);
    await client.flush();
    expect(calls).toHaveLength(3);
  });

  it("stops a flush at the first network error so the rest wait", async () => {
    const { client, calls, advance } = setup(["network"]);
    await client.check(check);
    await client.check(check); // first item is not due, second fails and is kept
    advance(60_000);
    const result = await client.flush();
    expect(result).toEqual({ sent: 0, dropped: 0, remaining: 2 });
    expect(calls).toHaveLength(3);
  });

  it("survives a restart because the queue is in storage", async () => {
    const first = setup(["network"]);
    await first.client.check(check);
    const { fetch, calls } = fakeFetch([202]);
    const again = createFeedbackClient({
      endpoint: "https://intake.example",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: first.storage,
      fetch,
      now: () => 10_000_000,
    });
    expect(await again.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(calls).toHaveLength(1);
  });

  it("drops queued items older than the maximum age", async () => {
    const { client, advance } = setup(["network"]);
    await client.check(check);
    advance(31 * 24 * 60 * 60 * 1000);
    expect(await client.flush()).toEqual({ sent: 0, dropped: 1, remaining: 0 });
  });

  it("exports consent wording that names both licences", () => {
    expect(CONSENT_TEXT).toContain("ODbL");
    expect(CONSENT_TEXT).toContain("DbCL");
    expect(CONSENT_TEXT).toContain("OpenStreetMap as notes");
    expect(CONSENT_TEXT).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("refusal reasons", () => {
  const attest = async () => ({ "x-attest-platform": "ios" });
  const refused = (reason: string, details = ["counter 4 is not above 7"]) => ({
    status: 401,
    body: { error: "attestation_invalid", reason, details },
  });

  it("passes the reason and details of a refused assertion to the app's hook", async () => {
    const seen: unknown[][] = [];
    const { client } = setup([refused("counter_not_increased")], 1_000_000, {
      attest,
      onAttestationRejected: (...args) => void seen.push(args),
    });
    expect(await client.check(check)).toEqual({ status: "queued" });
    expect(seen).toEqual([
      ["attestation_invalid", { reason: "counter_not_increased", details: ["counter 4 is not above 7"] }],
    ]);
  });

  it("calls the hook with the error alone when the intake gave no reason", async () => {
    const seen: unknown[][] = [];
    const { client } = setup([{ status: 401, body: { error: "attestation_required" } }], 1_000_000, {
      attest,
      onAttestationRejected: (...args) => void seen.push(args),
    });
    await client.check(check);
    expect(seen).toEqual([["attestation_required"]]);
  });

  it("still works with a hook written for one argument", async () => {
    const seen: string[] = [];
    const { client } = setup([refused("bad_signature")], 1_000_000, {
      attest,
      onAttestationRejected: (error: string) => void seen.push(error),
    });
    expect(await client.check(check)).toEqual({ status: "queued" });
    expect(seen).toEqual(["attestation_invalid"]);
  });

  it("keeps the details but leaves out a reason code it does not know", async () => {
    const seen: unknown[][] = [];
    const { client } = setup([refused("some_later_code", ["a newer check failed"])], 1_000_000, {
      attest,
      onAttestationRejected: (...args) => void seen.push(args),
    });
    await client.check(check);
    expect(seen).toEqual([["attestation_invalid", { details: ["a newer check failed"] }]]);
  });

  it("keeps a refused item queued and sends it on a later flush", async () => {
    const { client, advance } = setup([refused("unknown_key"), 202], 1_000_000, { attest });
    expect(await client.check(check)).toEqual({ status: "queued" });
    expect(await client.pending()).toBe(1);
    advance(60 * 60 * 1000);
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });

  it("keeps the item queued and leaves the hook alone on 503 unavailable", async () => {
    const seen: unknown[] = [];
    const { client, advance } = setup([{ status: 503, body: { error: "unavailable" } }, 202], 1_000_000, {
      attest,
      onAttestationRejected: (error) => void seen.push(error),
    });
    expect(await client.check(check)).toEqual({ status: "queued" });
    expect(await client.pending()).toBe(1);
    expect(seen).toEqual([]);
    advance(60 * 60 * 1000);
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
  });
});

describe("keyIsUnusable", () => {
  const table = {
    unknown_key: true,
    wrong_app: true,
    bad_signature: true,
    counter_not_increased: false,
    category_not_accepted: false,
    malformed: false,
    integrity_not_met: false,
  } satisfies Record<RefusalReason, boolean>;

  it.each(Object.entries(table))("says %s drops the key: %s", (reason, drops) => {
    expect(keyIsUnusable(reason as RefusalReason)).toBe(drops);
  });

  it("keeps the key when there is no reason", () => {
    expect(keyIsUnusable(undefined)).toBe(false);
  });
});

describe("a caller's own ref and onAnswered", () => {
  it("keeps the ref with the queued item and never sends it", async () => {
    const { client, calls, storage } = setup(["network", 202]);
    expect(await client.check({ ...check, ref: "my-record-1" })).toEqual({ status: "queued" });
    expect(calls[0]!.body).not.toHaveProperty("ref");
    const queued = JSON.parse(storage.data.get("ocdb.feedback.queue")!);
    expect(queued[0].ref).toBe("my-record-1");
    expect(queued[0].body).not.toHaveProperty("ref");
  });

  it("tells onAnswered the ref and id of an item sent at once", async () => {
    const answers: Answer[] = [];
    const { client } = setup([202], 1_000_000, { onAnswered: (a) => void answers.push(a) });
    expect(await client.check({ ...check, ref: "my-record-1" })).toEqual({ status: "sent", id: "fb_1" });
    expect(answers).toEqual([{ ref: "my-record-1", type: "check", outcome: { kind: "sent", id: "fb_1" } }]);
  });

  it("tells onAnswered the ref and id of a new place sent by a later flush", async () => {
    const answers: Answer[] = [];
    const { client, advance } = setup(["network", { status: 202, body: { id: "fb_new" } }], 1_000_000, {
      onAnswered: (a) => void answers.push(a),
    });
    const newPlace = { place: null, location: { lat: -36.8, lon: 144.5 }, report: { kind: "new_place", name: "River Bend", place_kind: "campground" }, consent: true } as const;
    expect(await client.report({ ...newPlace, ref: "draft-7" })).toEqual({ status: "queued" });
    expect(answers).toEqual([]);
    advance(60_000);
    await client.flush();
    expect(answers).toEqual([{ ref: "draft-7", type: "report", outcome: { kind: "sent", id: "fb_new" } }]);
  });

  it("tells onAnswered the status of a dropped item", async () => {
    const answers: Answer[] = [];
    const { client } = setup([400], 1_000_000, { onAnswered: (a) => void answers.push(a) });
    expect(await client.check({ ...check, ref: "r-1" })).toEqual({ status: "rejected", httpStatus: 400 });
    expect(answers).toEqual([{ ref: "r-1", type: "check", outcome: { kind: "dropped", httpStatus: 400 } }]);
  });

  it("tells onAnswered with status 0 when an item grows too old to send", async () => {
    const answers: Answer[] = [];
    const { client, advance } = setup(["network"], 1_000_000, { onAnswered: (a) => void answers.push(a) });
    await client.check({ ...check, ref: "old" });
    advance(31 * 24 * 60 * 60 * 1000);
    await client.flush();
    expect(answers).toEqual([{ ref: "old", type: "check", outcome: { kind: "dropped", httpStatus: 0 } }]);
  });

  it("passes on an older intake's bare id with no state", async () => {
    const answers: Answer[] = [];
    const { client } = setup([{ status: 202, body: { id: "fb_old" } }], 1_000_000, { onAnswered: (a) => void answers.push(a) });
    expect(await client.check({ ...check, ref: "r-old" })).toEqual({ status: "sent", id: "fb_old" });
    expect(answers).toEqual([{ ref: "r-old", type: "check", outcome: { kind: "sent", id: "fb_old" } }]);
    expect(answers[0]!.outcome).not.toHaveProperty("state");
    expect(answers[0]!.outcome).not.toHaveProperty("heldReason");
  });

  const toilets = { place: PLACE, report: { kind: "fact", fact: "toilets", value: true }, consent: true } as const;

  it("tells onAnswered and the caller that a change is live", async () => {
    const answers: Answer[] = [];
    const { client } = setup([{ status: 202, body: { id: "fb_live", state: "live" } }], 1_000_000, { onAnswered: (a) => void answers.push(a) });
    expect(await client.report({ ...toilets, ref: "r-live" })).toEqual({ status: "sent", id: "fb_live", state: "live" });
    expect(answers).toEqual([{ ref: "r-live", type: "report", outcome: { kind: "sent", id: "fb_live", state: "live" } }]);
  });

  it("tells onAnswered that a change is held, with the reason, on a later flush", async () => {
    const answers: Answer[] = [];
    const { client, advance } = setup(["network", { status: 202, body: { id: "fb_held", state: "held", held_reason: "owner_value" } }], 1_000_000, {
      onAnswered: (a) => void answers.push(a),
    });
    expect(await client.report({ ...toilets, ref: "r-held" })).toEqual({ status: "queued" });
    advance(60_000);
    await client.flush();
    expect(answers).toEqual([{ ref: "r-held", type: "report", outcome: { kind: "sent", id: "fb_held", state: "held", heldReason: "owner_value" } }]);
  });

  it("keeps held but leaves out a held reason this SDK does not know", async () => {
    const answers: Answer[] = [];
    const { client } = setup([{ status: 202, body: { id: "fb_x", state: "held", held_reason: "a_newer_code" } }], 1_000_000, {
      onAnswered: (a) => void answers.push(a),
    });
    expect(await client.report(toilets)).toEqual({ status: "sent", id: "fb_x", state: "held" });
    expect(answers[0]!.outcome).toEqual({ kind: "sent", id: "fb_x", state: "held" });
  });

  it("keeps sending when onAnswered throws", async () => {
    const answers: Answer[] = [];
    // One at a time, so each try is a call of its own (batches are in batch.test.ts).
    const { client, calls, advance } = setup(["network", "network", 202], 1_000_000, {
      maxBatchSize: 1,
      onAnswered: (a) => {
        answers.push(a);
        throw new Error("app record store failed");
      },
    });
    await client.check({ ...check, ref: "a" });
    await client.check({ ...check, ref: "b" });
    advance(60 * 60 * 1000);
    expect(await client.flush()).toEqual({ sent: 2, dropped: 0, remaining: 0 });
    expect(answers.map((a) => a.ref)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(4);
    expect(await client.pending()).toBe(0);
  });

  it("sends an item queued before refs existed and answers it without a ref", async () => {
    const answers: Answer[] = [];
    const { client, storage, calls } = setup([202], 1_000_000, { onAnswered: (a) => void answers.push(a) });
    const body = { type: "check", place: PLACE, device: "d-1", app_version: "1.2.2", consent: true, check: check.check };
    storage.data.set("ocdb.feedback.queue", JSON.stringify([{ localId: "old-1", body, queuedAt: 1_000_000, attempts: 1, nextAttemptAt: 0 }]));
    expect(await client.flush()).toEqual({ sent: 1, dropped: 0, remaining: 0 });
    expect(calls[0]!.body).toEqual(body);
    expect(answers).toEqual([{ type: "check", outcome: { kind: "sent", id: "fb_1" } }]);
  });

  it("refuses a ref that is empty or longer than 100 characters", async () => {
    const { client, calls } = setup([202]);
    await expect(client.check({ ...check, ref: "" })).rejects.toBeInstanceOf(FeedbackValidationError);
    await expect(client.check({ ...check, ref: "x".repeat(101) })).rejects.toBeInstanceOf(FeedbackValidationError);
    expect(await client.check({ ...check, ref: "x".repeat(100) })).toEqual({ status: "sent", id: "fb_1" });
    expect(calls).toHaveLength(1);
  });

  it("carries a ref on review reports and withdraws without sending it", async () => {
    const answers: Answer[] = [];
    const { client, calls } = setup([202], 1_000_000, { onAnswered: (a) => void answers.push(a) });
    await client.reportReview({ place: PLACE, review: "rev_01JBXK3M8Q4R5S6T7V8W9X0YZA", reason: "spam_ad", consent: true, ref: "rr" });
    await client.withdraw({ place: PLACE, consent: true, ref: "wd" });
    expect(calls.every((c) => !("ref" in (c.body as object)))).toBe(true);
    expect(answers.map((a) => [a.ref, a.type])).toEqual([["rr", "review_report"], ["wd", "withdraw"]]);
  });

  it("queues the location as sdkCoordinate rounds it and a tidied name and text as given", async () => {
    const { client, storage } = setup(["network"]);
    const location = { lat: -36.81234567, lon: 144.50000049 };
    const name = tidyName("  RIVER   BEND ");
    const note = tidyText("FLAT SITES  BY THE RIVER!!!!  ");
    await client.report({ place: null, location, report: { kind: "new_place", name, place_kind: "campground", note }, consent: true, ref: "n" });
    const [item] = JSON.parse(storage.data.get("ocdb.feedback.queue")!);
    expect(item.body.location).toEqual({ lat: sdkCoordinate(location.lat), lon: sdkCoordinate(location.lon) });
    expect(item.body.location).toEqual({ lat: -36.812346, lon: 144.5 });
    expect(item.body.report.name).toBe("River Bend");
    expect(item.body.report.name).toBe(name);
    expect(item.body.report.note).toBe(note);
  });

  it("trims a name it was given untidied", async () => {
    const { client, storage } = setup(["network"]);
    await client.report({ place: null, location: { lat: -36.8, lon: 144.5 }, report: { kind: "new_place", name: "  River   Bend ", place_kind: "campground" }, consent: true });
    const [item] = JSON.parse(storage.data.get("ocdb.feedback.queue")!);
    expect(item.body.report.name).toBe("River   Bend");
  });
});


describe("itemDecision", () => {
  it("reads live, held with each known reason, and nothing else", () => {
    expect(itemDecision({ id: "fb_1" })).toEqual({});
    expect(itemDecision({ id: "fb_1", state: "live" })).toEqual({ state: "live" });
    expect(itemDecision({ id: "fb_1", state: "live", held_reason: "text_check" })).toEqual({ state: "live" });
    for (const reason of HELD_REASONS) expect(itemDecision({ id: "fb_1", state: "held", held_reason: reason })).toEqual({ state: "held", heldReason: reason });
    expect(itemDecision({ id: "fb_1", state: "held" })).toEqual({ state: "held" });
    expect(itemDecision({ id: "fb_1", state: "held", held_reason: 7 })).toEqual({ state: "held" });
    expect(itemDecision({ id: "fb_1", state: "pending" })).toEqual({});
    expect(itemDecision(null)).toEqual({});
    expect(itemDecision("fb_1")).toEqual({});
  });

  it("lists the twenty codes the intake sends", () => {
    expect(HELD_REASONS).toEqual([
      "not_attested",
      "owner_value",
      "disagreement",
      "link_check",
      "text_check",
      "unconfirmed",
      "no_contributor",
      "daily_cap",
      "ai_check",
      "check_unavailable",
      "unknown_place",
      "blocked",
      "no_value",
      "invalid_value",
      "single_doubt",
      "protected_source",
      "taken_down",
      "not_seasonal",
      "unlikely_charge",
      "commons_report",
    ]);
  });
});

describe("reportFacts", () => {
  const edit: FactsInput = { place: PLACE, facts: { toilets: true, pets: "leashed", fee: false }, consent: true };

  it("sends one fact report per fact, in order, and returns each fact's result", async () => {
    const { client, calls } = setup([202]);
    const results = await client.reportFacts(edit);
    expect(calls.map((c) => (c.body as { report: unknown }).report)).toEqual([
      { kind: "fact", fact: "toilets", value: true },
      { kind: "fact", fact: "pets", value: "leashed" },
      { kind: "fact", fact: "fee", value: false },
    ]);
    expect(calls.every((c) => (c.body as { place: string }).place === PLACE)).toBe(true);
    expect(results.map((r) => [r.fact, r.result.status])).toEqual([
      ["toilets", "sent"],
      ["pets", "sent"],
      ["fee", "sent"],
    ]);
  });

  it("gives each fact's report the ref <ref>:<fact> for onAnswered", async () => {
    const answers: Answer[] = [];
    const { client } = setup([202], 1_000_000, { onAnswered: (a) => void answers.push(a) });
    await client.reportFacts({ ...edit, ref: "edit-1" });
    expect(answers.map((a) => a.ref)).toEqual(["edit-1:toilets", "edit-1:pets", "edit-1:fee"]);
  });

  it("skips facts left undefined, refuses without consent and refuses a ref over 90 characters", async () => {
    const { client, calls } = setup([202]);
    expect(await client.reportFacts({ place: PLACE, facts: { toilets: undefined }, consent: true })).toEqual([]);
    await expect(client.reportFacts({ ...edit, consent: false })).rejects.toBeInstanceOf(ConsentRequiredError);
    await expect(client.reportFacts({ ...edit, ref: "x".repeat(91) })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toHaveLength(0);
  });

  it("queues the facts it cannot send yet, to retry like any report", async () => {
    const { client } = setup(["network"]);
    const results = await client.reportFacts(edit);
    expect(results.map((r) => r.result.status)).toEqual(["queued", "queued", "queued"]);
  });
});

describe("items waiting for a new place's id (NewPlaceRef)", () => {
  const NEW_ID = "fb_01M6R45Y75GTXQBS5ETC16CYSZ";
  const NEW_PLACE = "ocdb_01M6R45Y75GTXQBS5ETC16CYSZ";
  const newPlace = {
    place: null,
    location: { lat: -32.040723, lon: 152.540633 },
    report: { kind: "new_place" as const, name: "Diamond Beach Holiday Park" },
    consent: true,
    ref: "np-1",
  };
  const sentNew = { status: 202, body: { id: NEW_ID } };
  const bodies = (calls: { body: unknown }[]) => calls.map((c) => c.body as { place: string | null; report?: { kind: string; fact?: string } });

  it("holds items about a new place until its id comes, then sends them with that id, in order", async () => {
    // One at a time, so each item is a call of its own (batches are in batch.test.ts).
    const { client, calls, advance } = setup(["network", sentNew, 202], 1_000_000, { maxBatchSize: 1 });
    expect((await client.report(newPlace)).status).toBe("queued");
    const facts = await client.reportFacts({ place: { newPlace: "np-1" }, facts: { toilets: true, pets: "leashed" }, consent: true });
    expect(facts.map((f) => f.result.status)).toEqual(["queued", "queued"]);
    // Only the new place was tried: the waiting items were never sent with the placeholder.
    expect(calls).toHaveLength(1);
    advance(60 * 60 * 1000);
    await client.flush();
    expect(bodies(calls).slice(1).map((b) => [b.place, b.report?.kind, b.report?.fact])).toEqual([
      [null, "new_place", undefined],
      [NEW_PLACE, "fact", "toilets"],
      [NEW_PLACE, "fact", "pets"],
    ]);
  });

  it("sends at once with the id when the new place was already sent", async () => {
    const { client, calls } = setup([sentNew, 202]);
    expect((await client.report(newPlace)).status).toBe("sent");
    const result = await client.check({ place: { newPlace: "np-1" }, check: { visited: "2026-10-20", still_there: true }, consent: true });
    expect(result.status).toBe("sent");
    expect((calls[1]!.body as { place: string }).place).toBe(NEW_PLACE);
  });

  it("drops the waiting items, telling onAnswered why, when the new place is refused", async () => {
    const answers: Answer[] = [];
    const { client, calls, advance } = setup(["network", 400], 1_000_000, { onAnswered: (a) => void answers.push(a) });
    await client.report(newPlace);
    await client.report({ place: { newPlace: "np-1" }, report: { kind: "fact", fact: "toilets", value: true }, consent: true, ref: "t" });
    advance(60 * 60 * 1000);
    expect(await client.flush()).toEqual({ sent: 0, dropped: 2, remaining: 0 });
    expect(answers.map((a) => [a.ref, a.outcome])).toEqual([
      ["np-1", { kind: "dropped", httpStatus: 400 }],
      ["t", { kind: "dropped", httpStatus: 0, reason: "new_place_dropped" }],
    ]);
    expect(calls).toHaveLength(2);
    await expect(client.report({ place: { newPlace: "np-1" }, report: { kind: "fact", fact: "toilets", value: true }, consent: true })).rejects.toBeInstanceOf(
      FeedbackValidationError,
    );
  });

  it("keeps waiting across a restart, and sends once a new client sends the new place", async () => {
    const first = setup(["network"]);
    await first.client.report(newPlace);
    await first.client.report({ place: { newPlace: "np-1" }, report: { kind: "fact", fact: "showers", value: true }, consent: true });
    // A new client over the same storage, as after the app restarts.
    const { fetch, calls } = fakeFetch([sentNew, 202]);
    const second = createFeedbackClient({
      endpoint: "https://intake.example/",
      appKey: "key-1",
      appVersion: "1.2.3",
      storage: first.storage,
      fetch,
      now: () => 1_000_000 + 60 * 60 * 1000,
      random: () => 0,
    });
    expect(await second.flush()).toEqual({ sent: 2, dropped: 0, remaining: 0 });
    expect(bodies(calls).map((b) => b.place)).toEqual([null, NEW_PLACE]);
  });

  it("never lets a waiting item block the items behind it", async () => {
    const { client, calls } = setup(["network", 202]);
    await client.report(newPlace); // fails: the new place waits for a retry
    await client.report({ place: { newPlace: "np-1" }, report: { kind: "fact", fact: "toilets", value: true }, consent: true });
    // A check queued behind the waiting item goes at once.
    expect((await client.check(check)).status).toBe("sent");
    expect(bodies(calls).map((b) => b.place)).toEqual([null, PLACE]);
  });

  it("refuses a ref that names no queued or sent new place", async () => {
    const { client, calls } = setup([202]);
    await expect(client.report({ place: { newPlace: "unknown" }, report: { kind: "fact", fact: "toilets", value: true }, consent: true })).rejects.toBeInstanceOf(
      FeedbackValidationError,
    );
    expect(calls).toHaveLength(0);
  });
});
