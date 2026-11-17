import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyRules, type RulesInput } from "../src/rules.js";
import { TRUST_CONFIRMED_EDITS, trustedContributors, type TrustRecord } from "../src/trust.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

/** The facts a trusted contributor's edits set, one each. */
const FACTS = ["tents", "toilets", "showers", "drinking_water", "dump_station"] as const;

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: PLACE,
    name: "Lake Eppalock Camp",
    kind: "campground",
    group: "overnight",
    location: { lat: -36.85, lon: 144.55 },
    osm: { type: "node", id: 123456, version: 7 },
    facts: { website: "https://lake.example.org" },
    status: "open",
    rating: null,
    fact_sources: { website: "osm" },
    updated: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

let seq = 0;
const fbId = () => `fb_01JT${String(++seq).padStart(22, "0")}`;
const ctr = (name: string) => `ctr_${Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16)}`;

type Who = { device: string; signedIn?: boolean; humanChecked?: boolean; attested?: boolean };

/** A report from `who`: attested and signed in unless it says otherwise. */
function report(day: number, who: Who, body: object, placeId: string | null = PLACE): StoredFeedback {
  return {
    id: fbId(),
    received: at(day),
    app: "example-app",
    place: placeId,
    device: who.device,
    origin: `org_${who.device}`,
    app_version: "1.0.0",
    consent: true,
    contributor: ctr(who.device),
    ...(who.signedIn !== false ? { signed_in: true } : {}),
    ...(who.attested !== false ? { attested: "app_attest" } : {}),
    ...(who.humanChecked ? { human_checked: true } : {}),
    type: "report",
    report: body,
  } as StoredFeedback;
}

const fact = (day: number, who: Who, name: string, value: unknown, placeId = PLACE) => report(day, who, { kind: "fact", fact: name, value }, placeId);
const applied = (item: StoredFeedback) => ({ ...item, outcome: { result: "applied", reason: "", run: item.received } }) as unknown as StoredFeedback;

const X: Who = { device: "dev-x" };

/** Runs the rules, with the place already holding `facts` as values X set, and the contact checks passing for every contact. */
function run(pending: StoredFeedback[], opts: { history?: StoredFeedback[]; trust?: TrustRecord; place?: Place; now?: number; extra?: Partial<RulesInput> } = {}) {
  const p = opts.place ?? place();
  const passed = new Map(
    pending
      .filter((i) => i.type === "report" && i.report.kind === "fact" && ["phone", "email", "website"].includes(i.report.fact as string))
      .map((i) => [i.id, [{ check: "website" as const, passed: true, detail: "the website shows it" }]]),
  );
  const input: RulesInput = {
    now: at(opts.now ?? 10),
    pending,
    history: opts.history ?? [],
    places: new Map([[p.id, p]]),
    reviews: () => [],
    contactChecks: passed,
    ...(opts.trust ? { trust: opts.trust } : {}),
    ...opts.extra,
  };
  const out = applyRules(input);
  return { ...out, outcome: (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.outcome };
}

/** X's edits, one per fact in FACTS (the first `n`), applied in earlier runs, and the place holding them. */
function edits(n: number, who: Who = X) {
  const history = FACTS.slice(0, n).map((name, i) => applied(fact(i, who, name, true)));
  const facts = Object.fromEntries([["website", "https://lake.example.org"], ...FACTS.slice(0, n).map((name) => [name, true])]);
  const sources = Object.fromEntries([["website", "osm"], ...FACTS.slice(0, n).map((name) => [name, "feedback"])]);
  const dates = Object.fromEntries(FACTS.slice(0, n).map((name) => [name, at(1)]));
  return { history, place: place({ facts, fact_sources: sources, fact_dates: dates }) };
}

/** Confirmations, from other travellers, of the first `n` of X's edits. */
const confirmations = (n: number) => FACTS.slice(0, n).map((name, i) => fact(6, { device: `dev-other-${i}` }, name, true));

/** Earns X trust: five edits confirmed by five other travellers. Returns the trust the run leaves. */
function earned(): TrustRecord {
  const { history, place } = edits(5);
  return run(confirmations(5), { history, place }).trust;
}

describe("trust from a track record", () => {
  it("is earned once other sources confirm five of a signed-in contributor's edits", () => {
    expect(TRUST_CONFIRMED_EDITS).toBe(5);
    expect(trustedContributors(earned())).toEqual(new Set([ctr("dev-x")]));
  });

  it("is not earned with four", () => {
    const { history, place } = edits(5);
    const out = run(confirmations(4), { history, place });
    expect(trustedContributors(out.trust)).toEqual(new Set());
  });

  it("is kept across runs: a fifth confirmation in a later run earns it", () => {
    const { history, place } = edits(5);
    const first = run(confirmations(4), { history, place });
    const later = run([fact(7, { device: "dev-other-9" }, "dump_station", true)], { history, place, trust: first.trust, now: 11 });
    expect(trustedContributors(later.trust)).toEqual(new Set([ctr("dev-x")]));
  });

  it("counts an edit once, however many sources confirm it", () => {
    const { history, place } = edits(5);
    const again = FACTS.slice(0, 4).map((name, i) => fact(7, { device: `dev-more-${i}` }, name, true));
    const out = run([...confirmations(4), ...again, fact(8, { device: "dev-more-9" }, "tents", true)], { history, place });
    expect(trustedContributors(out.trust)).toEqual(new Set());
  });

  it("counts no confirmation from the contributor's own device or network", () => {
    const { history, place } = edits(5);
    const own = FACTS.map((name) => fact(6, { device: "dev-x", signedIn: false }, name, true));
    expect(trustedContributors(run(own, { history, place }).trust)).toEqual(new Set());
  });

  it("is never earned by human-checked or signed-out sources", () => {
    for (const who of [{ device: "dev-web", humanChecked: true, attested: false }, { device: "dev-out", signedIn: false }]) {
      const { history, place } = edits(5, who);
      expect(trustedContributors(run(confirmations(5), { history, place }).trust)).toEqual(new Set());
    }
  });

  it("is withdrawn by an upheld doubt about one of their edits, and the count starts again", () => {
    const { history, place: p } = edits(5);
    const trust = earned();
    const doubts = [report(11, { device: "dev-d1" }, { kind: "doubt", fact: "tents" }), report(11, { device: "dev-d2" }, { kind: "doubt", fact: "tents" })];
    const out = run(doubts, { history, place: p, trust, now: 12 });
    expect(out.outcome(doubts[1]!)).toBe("applied");
    expect(trustedContributors(out.trust)).toEqual(new Set());
    // Confirmations of the edits sent before the doubt never count again.
    const later = run([fact(13, { device: "dev-late" }, "toilets", true)], { history, place: p, trust: out.trust, now: 14 });
    expect(later.trust.contributors[ctr("dev-x")]?.confirmed ?? []).toEqual([]);
  });

  it("is not withdrawn by a doubt that leaves the value", () => {
    const { history, place: p } = edits(5);
    const doubt = report(11, { device: "dev-d1" }, { kind: "doubt", fact: "tents" });
    const out = run([doubt], { history, place: p, trust: earned(), now: 12 });
    expect(out.outcome(doubt)).toBe("needs_review");
    expect(trustedContributors(out.trust)).toEqual(new Set([ctr("dev-x")]));
  });

  it("counts a new place that another traveller checked nearby and found there", () => {
    const { history, place: p } = edits(4);
    const newPlace = report(2, X, { kind: "new_place", place_kind: "campground", name: "Bush Camp" }, null);
    (newPlace as { location?: unknown }).location = { lat: -30.1, lon: 140.2 };
    const id = `ocdb_${newPlace.id.replace(/^fb_/, "")}`;
    const record = place({ id, name: "Bush Camp", location: { lat: -30.1, lon: 140.2 }, osm: null, facts: {}, fact_sources: {}, standing: "shown" });
    const seen = { ...report(6, { device: "dev-check" }, {}, id), type: "check", check: { visited: at(6).slice(0, 10), still_there: true, nearby: true } } as unknown as StoredFeedback;
    delete (seen as { report?: unknown }).report;
    const out = applyRules({
      now: at(10),
      pending: [...confirmations(4), seen],
      history: [...history, applied(newPlace)],
      places: new Map([[p.id, p], [id, record]]),
      reviews: () => [],
    });
    expect(trustedContributors(out.trust)).toEqual(new Set([ctr("dev-x")]));
  });

  it("is never held by a blocked contributor", () => {
    expect(trustedContributors(earned(), new Set([ctr("dev-x")]))).toEqual(new Set());
  });
});

describe("what trust does in the apply", () => {
  const unattested: Who = { device: "dev-x", attested: false };

  it("puts a trusted contributor's contact live once it passes the contact checks, without a second source", () => {
    const phone = fact(11, unattested, "phone", "+61 3 5555 0100");
    const trusted = run([phone], { trust: earned(), now: 12 });
    expect(trusted.outcome(phone)).toBe("applied");
    expect(trusted.places.get(PLACE)?.facts.phone).toBe("+61 3 5555 0100");
    const untrusted = run([phone], { now: 12 });
    expect(untrusted.outcome(phone)).toBe("waiting");
  });

  it("still waits for the contact checks", () => {
    const phone = fact(11, unattested, "phone", "+61 3 5555 0100");
    const out = run([phone], { trust: earned(), now: 12, extra: { contactChecks: new Map() } });
    expect(out.outcome(phone)).toBe("waiting");
  });

  it("does not trust a report the contributor sent signed out or through a human check", () => {
    const phone = fact(11, { device: "dev-x", attested: false, signedIn: false }, "phone", "+61 3 5555 0100");
    expect(run([phone], { trust: earned(), now: 12 }).outcome(phone)).toBe("waiting");
  });

  it("lists a trusted contributor's new place straight away", () => {
    const newPlace = report(11, unattested, { kind: "new_place", place_kind: "campground", name: "Bush Camp" }, null);
    (newPlace as { location?: unknown }).location = { lat: -30.1, lon: 140.2 };
    const trusted = run([newPlace], { trust: earned(), now: 12 });
    expect(trusted.outcome(newPlace)).toBe("applied");
    const untrusted = run([newPlace], { now: 12 });
    expect(untrusted.outcome(newPlace)).toBe("needs_review");
  });
});
