import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { applyRules, type RulesInput } from "../src/rules.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T00:00:00Z");

const at = (hours: number) => new Date(T0 + hours * HOUR).toISOString().replace(/\.\d{3}Z$/, "Z");

function place(overrides: Partial<Place> = {}): Place {
  return {
    id: PLACE,
    name: "Lake Camp",
    kind: "free_camp",
    group: "overnight",
    location: { lat: -36.85, lon: 144.55 },
    osm: { type: "node", id: 123456, version: 7 },
    facts: { power: false, fee: true },
    status: "open",
    rating: null,
    fact_sources: { power: "osm", fee: "osm" },
    updated: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

let seq = 0;
const fbId = () => `fb_01JD${String(++seq).padStart(22, "0")}`;
const ctr = (name: string) => `ctr_${Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16)}`;

/** An attested fact report from `device`, `hours` after T0. */
const fact = (hours: number, device: string, name: string, value: unknown): StoredFeedback =>
  ({
    id: fbId(),
    received: at(hours),
    app: "example-app",
    place: PLACE,
    device,
    app_version: "1.0.0",
    consent: true,
    attested: "app_attest",
    contributor: ctr(device),
    type: "report",
    report: { kind: "fact", fact: name, value },
  }) as StoredFeedback;

/** An item as `applied/` holds it, with the outcome an earlier run gave it. */
const stored = (item: StoredFeedback, result: string, extra: Record<string, unknown> = {}) =>
  ({ ...item, outcome: { result, reason: "", run: item.received, ...extra } }) as unknown as StoredFeedback;

function run(pending: StoredFeedback[], opts: { now?: number; history?: StoredFeedback[]; places?: Place[] } = {}) {
  const places = new Map((opts.places ?? [place()]).map((p) => [p.id, p]));
  const input: RulesInput = {
    everyPlace: [...places.values()],
    now: at(opts.now ?? 30),
    pending,
    history: opts.history ?? [],
    places,
    reviews: () => [],
    kinds: new Map([["free_camp", "overnight"]]),
  };
  const out = applyRules(input);
  const outcome = (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.outcome;
  return { ...out, outcome, after: () => out.places.get(PLACE) };
}

describe("a disputed place", () => {
  it("freezes when three sources send three values for one fact within 24 hours, and sends the case to the reviewer", () => {
    const a = fact(0, "dev-a", "pets", "yes");
    const b = fact(5, "dev-b", "pets", "no");
    const c = fact(20, "dev-c", "pets", "leashed");
    const out = run([a, b, c]);
    expect(out.after()?.facts.pets).toBeUndefined();
    for (const item of [a, b, c]) expect(out.outcome(item)).toBe("needs_review");
    expect(out.held).toEqual([
      expect.objectContaining({ case: "disputed", place: PLACE, fact: "pets", values: ["leashed", "no", "yes"], sources: 3, feedback: [a.id, b.id, c.id] }),
    ]);
    // A note for the review PR, so the run lists the case there although no file changes.
    expect(out.edits).toEqual([{ kind: "note", place: PLACE, feedback: c.id }]);
  });
});

describe("not a dispute", () => {
  it("leaves two sources with two values to the disagreement rule", () => {
    const a = fact(0, "dev-a", "pets", "yes");
    const b = fact(5, "dev-b", "pets", "no");
    const out = run([a, b]);
    expect(out.outcome(a)).toBe("applied");
    expect(out.outcome(b)).toBe("needs_review");
    expect(out.held.filter((h) => h.case === "disputed")).toEqual([]);
  });

  it("counts one source changing its mind once, with its latest value", () => {
    const a1 = fact(0, "dev-a", "pets", "yes");
    const a2 = fact(1, "dev-a", "pets", "leashed");
    const b = fact(2, "dev-b", "pets", "no");
    const out = run([a1, a2, b]);
    expect(out.held.filter((h) => h.case === "disputed")).toEqual([]);
    expect(out.decisions.some((d) => d.frozen !== undefined)).toBe(false);
  });

  it("does not freeze for three values spread over more than 24 hours", () => {
    const a = fact(0, "dev-a", "pets", "yes");
    const b = fact(10, "dev-b", "pets", "no");
    const c = fact(25, "dev-c", "pets", "leashed");
    const out = run([a, b, c], { now: 40 });
    expect(out.held.filter((h) => h.case === "disputed")).toEqual([]);
  });
});

describe("while frozen", () => {
  const freeze = (hours: number) => {
    const a = stored(fact(hours, "dev-a", "pets", "yes"), "applied");
    const b = stored(fact(hours + 1, "dev-b", "pets", "no"), "needs_review");
    const c = stored(fact(hours + 2, "dev-c", "pets", "leashed"), "needs_review", { frozen: { fact: "pets", at: at(hours + 2) } });
    return [a, b, c];
  };

  it("changes no other fact on the place in the run that freezes it", () => {
    const power = fact(0, "dev-d", "power", true);
    const a = fact(1, "dev-a", "pets", "yes");
    const b = fact(2, "dev-b", "pets", "no");
    const c = fact(3, "dev-c", "pets", "leashed");
    const out = run([power, a, b, c]);
    expect(out.outcome(power)).toBe("waiting");
    expect(out.after()?.facts.power ?? false).toBe(false);
  });

  it("keeps the place frozen in later runs until the reviewer decides, and changes no fact on it", () => {
    const power = fact(40, "dev-d", "power", true);
    const pets = fact(41, "dev-e", "pets", "yes");
    const out = run([power, pets], { now: 50, history: freeze(0), places: [place({ facts: { power: false, fee: true, pets: "yes" }, fact_dates: { pets: at(0) }, fact_sources: { power: "osm", fee: "osm", pets: "feedback" } })] });
    expect(out.outcome(power)).toBe("waiting");
    expect(out.outcome(pets)).toBe("waiting");
    expect(out.after()?.facts.power ?? false).toBe(false);
  });

  it("lifts once the data has the reviewer's value for the fact, and refuses reports of it sent before the decision", () => {
    const power = fact(40, "dev-d", "power", true);
    const pets = fact(41, "dev-e", "pets", "no");
    const decided = place({ facts: { power: false, fee: true, pets: "leashed" }, fact_dates: { pets: at(45) }, fact_sources: { power: "osm", fee: "osm", pets: "feedback" } });
    const out = run([power, pets], { now: 50, history: freeze(0), places: [decided] });
    expect(out.outcome(power)).toBe("applied");
    expect(out.after()?.facts.power).toBe(true);
    expect(out.outcome(pets)).toBe("refused");
    expect(out.after()?.facts.pets).toBe("leashed");
  });
});
