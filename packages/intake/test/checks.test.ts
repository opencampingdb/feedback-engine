import type { FeedbackSubmission, ReportBody } from "@opencampingdb/feedback";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_TIMEOUT_MS,
  createChecks,
  GUARD_MODEL,
  LIVE_DAILY_LIMIT,
  pruneLiveCounts,
  URLHAUS_HOST_ENDPOINT,
  URLHAUS_URL_ENDPOINT,
  type AiLike,
  type CheckContributor,
  type CheckDeps,
} from "../src/checks.js";
import type { D1Like } from "../src/recent.js";
import { fakeD1 } from "./fake-d1.js";

const NOW = Date.parse("2026-11-04T09:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const KEY = "urlhaus-test-key";
const PLACE = "ocdb_01JB0000000000000000000000";

const NEWCOMER: CheckContributor = { id: "ctr_0123456789abcdef", accepted: 0, taken_down: 0 };
const TRUSTED: CheckContributor = { id: "ctr_fedcba9876543210", accepted: 5, taken_down: 0 };

function report(report: ReportBody, place: string | null = PLACE): FeedbackSubmission {
  return {
    type: "report",
    place,
    ...(place === null ? { location: { lat: -36.9, lon: 144.6 } } : {}),
    device: "3b241101-e2bb-4255-8caf-4136c566a962",
    app_version: "1.0.0",
    consent: true,
    report,
  } as FeedbackSubmission;
}

const fact = (name: string, value: unknown) => report({ kind: "fact", fact: name, value } as ReportBody);
const newPlace = (extra: Partial<ReportBody> = {}) => report({ kind: "new_place", name: "Lake Eppalock Rest Area", place_kind: "campground", ...extra }, null);

type Behaviour = "clean" | "listed" | "down" | "hang" | "garbage" | "odd_status";
type HostAnswer = Behaviour | { blacklists?: Record<string, string>; urls?: { url_status: string }[] };

/** URLhaus: `urls` and `hosts` say how it answers for each address and host (clean when not named). */
function fakeUrlhaus(urls: Record<string, Behaviour> = {}, hosts: Record<string, HostAnswer> = {}) {
  const calls: { endpoint: string; key: string | null; type: string | null; body: URLSearchParams }[] = [];
  const answer = (behaviour: Behaviour, listed: Record<string, unknown>, signal?: AbortSignal | null): Promise<Response> => {
    if (behaviour === "hang") {
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (behaviour === "down") return Promise.resolve(new Response("busy", { status: 503 }));
    if (behaviour === "garbage") return Promise.resolve(new Response("null", { status: 200 }));
    const body = behaviour === "odd_status" ? { query_status: "http_post_expected" } : behaviour === "listed" ? { query_status: "ok", ...listed } : { query_status: "no_results" };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  const fetch = async (endpoint: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const body = new URLSearchParams(String(init?.body));
    calls.push({ endpoint, key: headers.get("auth-key"), type: headers.get("content-type"), body });
    if (endpoint === URLHAUS_URL_ENDPOINT) {
      return answer(urls[body.get("url")!] ?? "clean", { url_status: "online", threat: "malware_download" }, init?.signal);
    }
    if (endpoint === URLHAUS_HOST_ENDPOINT) {
      const host = hosts[body.get("host")!] ?? "clean";
      if (typeof host === "string") return answer(host, { blacklists: { spamhaus_dbl: "spammer_domain", surbl: "listed" } }, init?.signal);
      return new Response(JSON.stringify({ query_status: "ok", url_count: host.urls?.length ?? 0, blacklists: host.blacklists ?? { spamhaus_dbl: "not listed", surbl: "not listed" }, urls: host.urls ?? [] }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${endpoint}`);
  };
  return { fetch, calls };
}

/** Workers AI: answers each run with `out` (a function may throw or never settle). */
function fakeAi(out: unknown | (() => Promise<unknown>) = { response: { safe: true, categories: [] } }): AiLike & { runs: { model: string; inputs: Record<string, unknown> }[] } {
  const runs: { model: string; inputs: Record<string, unknown> }[] = [];
  return {
    runs,
    run: async (model, inputs) => {
      runs.push({ model, inputs });
      return typeof out === "function" ? (out as () => Promise<unknown>)() : out;
    },
  };
}

function setup(overrides: Partial<CheckDeps> & { urlhaus?: ReturnType<typeof fakeUrlhaus> } = {}) {
  const db = fakeD1();
  const urlhaus = overrides.urlhaus ?? fakeUrlhaus();
  const ai = "ai" in overrides ? overrides.ai : fakeAi();
  let now = NOW;
  const deps: CheckDeps = { db, fetch: urlhaus.fetch, urlhausKey: KEY, now: () => now, ...overrides, ai };
  return { ...createChecks(deps), db, urlhaus, ai: ai as ReturnType<typeof fakeAi> | undefined, setNow: (ms: number) => void (now = ms) };
}

const counted = (db: ReturnType<typeof fakeD1>, contributor = NEWCOMER.id) =>
  db.db.prepare("SELECT day, count FROM live_counts WHERE contributor = ? ORDER BY day").all(contributor);

afterEach(() => {
  vi.useRealTimers();
});

describe("checks: the intake's own rules", () => {
  it("passes a fact with no text or links without calling URLhaus or the AI, and counts it", async () => {
    const t = setup();
    expect(await t.check(fact("toilets", true), NEWCOMER)).toMatchObject({ pass: true });
    expect(t.urlhaus.calls).toEqual([]);
    expect(t.ai!.runs).toEqual([]);
    expect(counted(t.db)).toEqual([{ day: "2026-11-04", count: 1 }]);
  });

  it("holds a name, description or note that fails the text checks, before any paid check", async () => {
    const t = setup();
    expect(await t.check(newPlace({ name: "Shithole Creek" }), NEWCOMER)).toEqual({ held: "text_check" });
    expect(await t.check(newPlace({ description: "Buy now, crypto deals every day" }), NEWCOMER)).toEqual({ held: "text_check" });
    expect(await t.check(newPlace({ note: "the owner is a wanker" }), NEWCOMER)).toEqual({ held: "text_check" });
    expect(await t.check(report({ kind: "description", value: "click here for a promo code" }), NEWCOMER)).toEqual({ held: "text_check" });
    expect(await t.check(report({ kind: "name", value: "fuuuck this place" }), NEWCOMER)).toEqual({ held: "text_check" });
    expect(t.urlhaus.calls).toEqual([]);
    expect(t.ai!.runs).toEqual([]);
    expect(counted(t.db)).toEqual([]);
  });

  it("holds opening hours whose quoted comment fails the text checks, without calling the AI on a fact", async () => {
    const t = setup();
    expect(await t.check(fact("opening_hours", 'Mo-Su 08:00-17:00 "click here for a promo code"'), NEWCOMER)).toEqual({ held: "text_check" });
    expect(await t.check(fact("opening_hours", 'Mo-Su 08:00-17:00 "office closes at noon"'), NEWCOMER)).toMatchObject({ pass: true });
    expect(t.ai!.runs).toEqual([]);
  });

  it("holds a description with a phone number in it, but not a note, which is stored without it", async () => {
    const t = setup();
    expect(await t.check(newPlace({ description: "Ring 0412 345 678 to book" }), NEWCOMER)).toEqual({ held: "text_check" });
    expect(await t.check(newPlace({ note: "Ring 0412 345 678 to book" }), NEWCOMER)).toMatchObject({ pass: true });
    expect(t.ai!.runs[0]!.inputs.messages).toEqual([{ role: "user", content: "Lake Eppalock Rest Area\n\nRing [removed] to book" }]);
  });

  it("holds a contact or address that fails contactProblem, phone and email formats included", async () => {
    const t = setup();
    expect(await t.check(fact("website", "https://bit.ly/abc"), NEWCOMER)).toEqual({ held: "link_check" });
    expect(await t.check(fact("website", "http://example.org"), NEWCOMER)).toEqual({ held: "link_check" });
    expect(await t.check(fact("facebook", "https://example.org/camp"), NEWCOMER)).toEqual({ held: "link_check" });
    expect(await t.check(fact("phone", "call me"), NEWCOMER)).toEqual({ held: "link_check" });
    expect(await t.check(fact("email", "not-an-email"), NEWCOMER)).toEqual({ held: "link_check" });
    expect(await t.check(fact("address", { state: "VIC" }), NEWCOMER)).toEqual({ held: "link_check" });
    expect(await t.check(newPlace({ contacts: { website: "https://tinyurl.com/x" } }), NEWCOMER)).toEqual({ held: "link_check" });
    expect(t.urlhaus.calls).toEqual([]);
    expect(counted(t.db)).toEqual([]);
  });

  it("passes a good phone and email without calling URLhaus", async () => {
    const t = setup();
    expect(await t.check(fact("phone", "+61 3 5432 1234"), NEWCOMER)).toMatchObject({ pass: true });
    expect(await t.check(fact("email", "stay@example.org"), NEWCOMER)).toMatchObject({ pass: true });
    expect(t.urlhaus.calls).toEqual([]);
  });

  it("holds a contributor's live changes past the daily cap, counted per UTC day", async () => {
    const t = setup();
    for (let i = 0; i < LIVE_DAILY_LIMIT; i++) expect(await t.check(fact("toilets", true), NEWCOMER)).toMatchObject({ pass: true });
    expect(await t.check(fact("website", "https://example.org"), NEWCOMER)).toEqual({ held: "daily_cap" });
    expect(t.urlhaus.calls).toEqual([]);
    // Someone else has their own count.
    expect(await t.check(fact("toilets", true), TRUSTED)).toMatchObject({ pass: true });
    // The next UTC day starts again.
    t.setNow(Date.parse("2026-11-05T00:00:00Z"));
    expect(await t.check(fact("toilets", true), NEWCOMER)).toMatchObject({ pass: true });
    expect(counted(t.db)).toEqual([
      { day: "2026-11-04", count: LIVE_DAILY_LIMIT },
      { day: "2026-11-05", count: 1 },
    ]);
  });

  it("caps live changes per client network and per attest key too, whatever contributor id the app sends", async () => {
    const t = setup();
    const from = (n: number, extra: Partial<CheckContributor>): CheckContributor => ({
      id: `ctr_${String(n).padStart(16, "0")}`,
      accepted: 0,
      taken_down: 0,
      ...extra,
    });
    // A new contributor id each time, from one network.
    for (let i = 0; i < LIVE_DAILY_LIMIT; i++) expect(await t.check(fact("toilets", true), from(i, { origin: "a1b2c3d4e5f60718" }))).toMatchObject({ pass: true });
    expect(await t.check(fact("toilets", true), from(99, { origin: "a1b2c3d4e5f60718" }))).toEqual({ held: "daily_cap" });
    // The cap that was full takes nothing from the others: the held item's contributor has no count.
    expect(counted(t.db, from(99, {}).id)).toEqual([]);
    expect(await t.check(fact("toilets", true), from(99, { origin: "0f0f0f0f0f0f0f0f" }))).toMatchObject({ pass: true });

    // A new contributor id and network each time, from one App Attest key.
    for (let i = 0; i < LIVE_DAILY_LIMIT; i++) {
      expect(await t.check(fact("toilets", true), from(200 + i, { origin: i.toString(16).padStart(16, "e"), attest_key: "ak_00112233445566ff" }))).toMatchObject({ pass: true });
    }
    expect(await t.check(fact("toilets", true), from(300, { attest_key: "ak_00112233445566ff" }))).toEqual({ held: "daily_cap" });
    const count = (key: string) => t.db.db.prepare("SELECT count FROM live_counts WHERE contributor = ?").get(key);
    expect(count("ak_00112233445566ff")).toEqual({ count: LIVE_DAILY_LIMIT });
    expect(count("org_a1b2c3d4e5f60718")).toEqual({ count: LIVE_DAILY_LIMIT });
    expect(count("org_0f0f0f0f0f0f0f0f")).toEqual({ count: 1 });
    expect(count(`org_${(7).toString(16).padStart(16, "e")}`)).toEqual({ count: 1 });
  });

  it("counts only items that pass", async () => {
    const t = setup({ urlhaus: fakeUrlhaus({ "https://bad.example.org/": "listed" }) });
    await t.check(newPlace({ name: "Shithole Creek" }), NEWCOMER);
    await t.check(fact("website", "https://bad.example.org/"), NEWCOMER);
    expect(counted(t.db)).toEqual([]);
  });

  it("holds as daily_cap when another item takes the last place while this one is checked", async () => {
    const t = setup({
      ai: fakeAi(async () => {
        t.db.db.prepare("UPDATE live_counts SET count = ? WHERE contributor = ?").run(LIVE_DAILY_LIMIT, NEWCOMER.id);
        return { response: { safe: true } };
      }),
    });
    expect(await t.check(fact("toilets", true), NEWCOMER)).toMatchObject({ pass: true });
    expect(await t.check(newPlace(), NEWCOMER)).toEqual({ held: "daily_cap" });
  });

  it("holds as check_unavailable when D1 is down", async () => {
    const down: D1Like = {
      prepare: () => {
        throw new Error("D1_ERROR: unavailable");
      },
      batch: async () => {
        throw new Error("D1_ERROR: unavailable");
      },
    };
    const t = setup({ db: down });
    expect(await t.check(fact("toilets", true), NEWCOMER)).toEqual({ held: "check_unavailable" });
  });

  it("prunes counts from before yesterday", async () => {
    const t = setup();
    for (const day of ["2026-11-01", "2026-11-03", "2026-11-04"]) {
      t.db.db.prepare("INSERT INTO live_counts (contributor, day, count) VALUES (?, ?, 1)").run(NEWCOMER.id, day);
    }
    await pruneLiveCounts(t.db, NOW);
    expect(counted(t.db).map((r) => r.day)).toEqual(["2026-11-03", "2026-11-04"]);
  });
});

describe("checks: URLhaus", () => {
  it("looks up a website's address and host with the auth key, as form posts", async () => {
    const t = setup();
    expect(await t.check(fact("website", "https://Camp.Example.org/stay"), TRUSTED)).toMatchObject({ pass: true });
    expect(t.urlhaus.calls.map((c) => [c.endpoint, c.key, c.type, Object.fromEntries(c.body)])).toEqual([
      [URLHAUS_URL_ENDPOINT, KEY, "application/x-www-form-urlencoded", { url: "https://Camp.Example.org/stay" }],
      [URLHAUS_HOST_ENDPOINT, KEY, "application/x-www-form-urlencoded", { host: "camp.example.org" }],
    ]);
  });

  it("looks up a social page's address only, not its network's host", async () => {
    const t = setup();
    expect(await t.check(fact("facebook", "https://www.facebook.com/examplecamp"), TRUSTED)).toMatchObject({ pass: true });
    expect(t.urlhaus.calls.map((c) => c.endpoint)).toEqual([URLHAUS_URL_ENDPOINT]);
  });

  it("checks every link on a new place", async () => {
    const t = setup({ urlhaus: fakeUrlhaus({ "https://bad.example.org/": "listed" }) });
    expect(await t.check(newPlace({ contacts: { website: "https://bad.example.org/", phone: "03 5432 1234" } }), TRUSTED)).toEqual({ held: "link_check" });
    expect(t.urlhaus.calls.map((c) => c.body.get("url") ?? c.body.get("host"))).toEqual(["https://bad.example.org/", "bad.example.org"]);
  });

  it("holds an address URLhaus knows", async () => {
    const t = setup({ urlhaus: fakeUrlhaus({ "https://www.instagram.com/bad": "listed" }) });
    expect(await t.check(fact("instagram", "https://www.instagram.com/bad"), TRUSTED)).toEqual({ held: "link_check" });
  });

  it("holds a website whose host is on SURBL or the Spamhaus DBL, or serves malware that is online", async () => {
    const t = setup({
      urlhaus: fakeUrlhaus(
        {},
        {
          "spam.example.org": { blacklists: { spamhaus_dbl: "spammer_domain", surbl: "not listed" } },
          "surbl.example.org": { blacklists: { spamhaus_dbl: "not listed", surbl: "listed" } },
          "hacked.example.org": { blacklists: { spamhaus_dbl: "abused_legit_malware", surbl: "not listed" } },
          "online.example.org": { urls: [{ url_status: "offline" }, { url_status: "online" }] },
          "offline.example.org": { urls: [{ url_status: "offline" }, { url_status: "unknown" }] },
        },
      ),
    });
    expect(await t.check(fact("website", "https://spam.example.org"), TRUSTED)).toEqual({ held: "link_check" });
    expect(await t.check(fact("website", "https://surbl.example.org"), TRUSTED)).toEqual({ held: "link_check" });
    expect(await t.check(fact("website", "https://hacked.example.org"), TRUSTED)).toEqual({ held: "link_check" });
    expect(await t.check(fact("website", "https://online.example.org"), TRUSTED)).toEqual({ held: "link_check" });
    expect(await t.check(fact("website", "https://offline.example.org"), TRUSTED)).toMatchObject({ pass: true });
  });

  it("reads the query_staus spelling in URLhaus's example", async () => {
    const fetch = async () => new Response(JSON.stringify({ query_staus: "ok", url_status: "online" }), { status: 200 });
    const t = setup({ fetch });
    expect(await t.check(fact("x", "https://x.com/bad"), TRUSTED)).toEqual({ held: "link_check" });
  });

  it("holds as check_unavailable without an auth key", async () => {
    const t = setup({ urlhausKey: undefined });
    expect(await t.check(fact("website", "https://example.org"), TRUSTED)).toEqual({ held: "check_unavailable" });
    expect(t.urlhaus.calls).toEqual([]);
    expect(counted(t.db, TRUSTED.id)).toEqual([]);
  });

  it("holds as check_unavailable when URLhaus is down, answers nonsense or an unexpected status", async () => {
    for (const behaviour of ["down", "garbage", "odd_status"] as const) {
      const t = setup({ urlhaus: fakeUrlhaus({ "https://example.org": behaviour }) });
      expect(await t.check(fact("website", "https://example.org"), TRUSTED)).toEqual({ held: "check_unavailable" });
    }
    const t = setup({ urlhaus: fakeUrlhaus({}, { "example.org": "down" }) });
    expect(await t.check(fact("website", "https://example.org"), TRUSTED)).toEqual({ held: "check_unavailable" });
    const thrown = setup({ fetch: async () => Promise.reject(new TypeError("network connection lost")) });
    expect(await thrown.check(fact("website", "https://example.org"), TRUSTED)).toEqual({ held: "check_unavailable" });
  });

  it("holds as link_check when one lookup finds the link even though another is down", async () => {
    const t = setup({ urlhaus: fakeUrlhaus({ "https://example.org": "listed" }, { "example.org": "down" }) });
    expect(await t.check(fact("website", "https://example.org"), TRUSTED)).toEqual({ held: "link_check" });
  });

  it(`holds as check_unavailable when URLhaus takes longer than ${CHECK_TIMEOUT_MS} ms, and aborts the request`, async () => {
    vi.useFakeTimers();
    const t = setup({ urlhaus: fakeUrlhaus({ "https://example.org": "hang" }) });
    const result = t.check(fact("website", "https://example.org"), TRUSTED);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS - 1);
    let settled = false;
    void result.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ held: "check_unavailable" });
  });

  it("isn't asked when the own rules held the item, and the AI isn't asked when URLhaus held it", async () => {
    const t = setup({ urlhaus: fakeUrlhaus({ "https://bad.example.org": "listed" }) });
    expect(await t.check(newPlace({ name: "Shithole Creek", contacts: { website: "https://bad.example.org" } }), NEWCOMER)).toEqual({ held: "text_check" });
    expect(t.urlhaus.calls).toEqual([]);
    expect(await t.check(newPlace({ contacts: { website: "https://bad.example.org" } }), NEWCOMER)).toEqual({ held: "link_check" });
    expect(t.ai!.runs).toEqual([]);
  });
});

describe("checks: Llama Guard", () => {
  it("asks about the free text from a contributor without a track record, and nothing else", async () => {
    const t = setup();
    const item = newPlace({ description: "Grassy sites by the water", note: "Lovely spot", fee: true, contacts: { website: "https://camp.example.org", phone: "03 5432 1234" } });
    expect(await t.check(item, NEWCOMER)).toMatchObject({ pass: true });
    expect(t.ai!.runs).toEqual([
      {
        model: GUARD_MODEL,
        inputs: {
          messages: [{ role: "user", content: "Lake Eppalock Rest Area\n\nGrassy sites by the water\n\nLovely spot" }],
          temperature: 0,
          max_tokens: 64,
          response_format: { type: "json_object" },
        },
      },
    ]);
  });

  it("asks about a name or description report's value", async () => {
    const t = setup();
    await t.check(report({ kind: "name", value: "lake eppalock rest area" }), NEWCOMER);
    await t.check(report({ kind: "description", value: "Shady sites" }), NEWCOMER);
    expect(t.ai!.runs.map((r) => r.inputs.messages)).toEqual([[{ role: "user", content: "Lake Eppalock Rest Area" }], [{ role: "user", content: "Shady sites" }]]);
  });

  it("never gets facts, fees, choices or links", async () => {
    const t = setup();
    await t.check(fact("pets", "leashed"), NEWCOMER);
    await t.check(fact("website", "https://camp.example.org"), NEWCOMER);
    await t.check(report({ kind: "kind", place_kind: "campground" }), NEWCOMER);
    await t.check(report({ kind: "closed" }), NEWCOMER);
    expect(t.ai!.runs).toEqual([]);
  });

  it("skips a contributor with a track record: at least 5 accepted and none taken down", async () => {
    const t = setup();
    await t.check(newPlace(), TRUSTED);
    await t.check(newPlace(), { ...TRUSTED, accepted: 40 });
    expect(t.ai!.runs).toEqual([]);
    await t.check(newPlace(), { ...TRUSTED, accepted: 4 });
    await t.check(newPlace(), { ...TRUSTED, accepted: 40, taken_down: 1 });
    expect(t.ai!.runs).toHaveLength(2);
  });

  it("holds what it calls unsafe, in its JSON or its plain text answer", async () => {
    for (const out of [{ response: { safe: false, categories: ["S10"] } }, { response: "unsafe\nS1,S10" }, { response: " Unsafe\nS12" }]) {
      const t = setup({ ai: fakeAi(out) });
      expect(await t.check(newPlace(), NEWCOMER)).toEqual({ held: "ai_check" });
      expect(counted(t.db)).toEqual([]);
    }
  });

  it("passes what it calls safe, in its JSON or its plain text answer", async () => {
    for (const out of [{ response: { safe: true, categories: [] } }, { response: "safe" }, { response: "safe\n" }]) {
      const t = setup({ ai: fakeAi(out) });
      expect(await t.check(newPlace(), NEWCOMER)).toMatchObject({ pass: true });
    }
  });

  it("holds as check_unavailable without the AI binding, when it fails or answers without a verdict", async () => {
    const none = setup({ ai: undefined });
    expect(await none.check(newPlace(), NEWCOMER)).toEqual({ held: "check_unavailable" });
    // A contributor with a track record doesn't need it.
    expect(await none.check(newPlace(), TRUSTED)).toMatchObject({ pass: true });
    const outs = [
      async () => Promise.reject(new Error("3040: Capacity temporarily exceeded")),
      async () => ({ response: "I can't help with that" }),
      async () => ({ response: { categories: [] } }),
      async () => null,
    ];
    for (const out of outs) {
      const t = setup({ ai: fakeAi(out) });
      expect(await t.check(newPlace(), NEWCOMER)).toEqual({ held: "check_unavailable" });
      expect(counted(t.db)).toEqual([]);
    }
  });

  it(`holds as check_unavailable when it takes longer than ${CHECK_TIMEOUT_MS} ms`, async () => {
    vi.useFakeTimers();
    const t = setup({ ai: fakeAi(() => new Promise(() => {})) });
    const result = t.check(newPlace(), NEWCOMER);
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    expect(await result).toEqual({ held: "check_unavailable" });
    expect(counted(t.db)).toEqual([]);
  });
});
