import { describe, expect, it } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { checkContacts, RDAP_BOOTSTRAP_URL, type Fetch } from "../src/contact-checks.js";
import { applyRules, type RulesInput } from "../src/rules.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-07-01T00:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

/** A place in Victoria, with its own website on record. */
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
const fbId = () => `fb_01JD${String(++seq).padStart(22, "0")}`;
const ctr = (name: string) => `ctr_${Buffer.from(name).toString("hex").padEnd(16, "0").slice(0, 16)}`;

/** A fact report, attested unless `attested` is false. */
const fact = (day: number, device: string, name: string, value: unknown, attested = true): StoredFeedback =>
  ({
    id: fbId(),
    received: at(day),
    app: "example-app",
    place: PLACE,
    device,
    app_version: "1.0.0",
    consent: true,
    contributor: ctr(device),
    ...(attested ? { attested: "app_attest" } : {}),
    type: "report",
    report: { kind: "fact", fact: name, value },
  }) as StoredFeedback;

/** Excerpts of IANA's bootstrap file. */
const BOOTSTRAP = {
  version: "1.0",
  services: [
    [["au"], ["https://rdap.cctld.au/rdap/"]],
    [["org"], ["https://rdap.publicinterestregistry.org/rdap/"]],
    [["com"], ["https://rdap.verisign.com/com/v1/"]],
  ],
};

/** An RDAP domain answer, shaped as the .com registry sends one. */
const rdapDomain = (name: string, registered: string) => ({
  objectClassName: "domain",
  ldhName: name.toUpperCase(),
  events: [
    { eventAction: "registration", eventDate: registered },
    { eventAction: "expiration", eventDate: "2030-01-01T00:00:00Z" },
    { eventAction: "last changed", eventDate: "2026-06-01T00:00:00Z" },
  ],
});

type Answer = Response | (() => Response | Promise<Response>);

/**
 * The web as the checks see it: a page or answer per URL, 404 for the rest.
 * `asked` lists every URL fetched. A URL mapped to "hang" never answers until
 * the check gives up.
 */
function web(pages: Record<string, Answer | "hang" | string | object>) {
  const asked: string[] = [];
  const fetch: Fetch = async (url, init) => {
    asked.push(url);
    const page = pages[url];
    if (page === undefined) return new Response("not found", { status: 404 });
    if (page === "hang") {
      return new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (typeof page === "function") return page();
    if (page instanceof Response) return page;
    if (typeof page === "string") return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/rdap+json" } });
  };
  return { fetch, asked };
}

/** The rules run with the contact checks run first, as the apply runs them. */
async function run(pending: StoredFeedback[], opts: { places?: Place[]; now?: number; fetch?: Fetch; history?: StoredFeedback[] } = {}) {
  const places = new Map((opts.places ?? [place()]).map((p) => [p.id, p]));
  const now = at(opts.now ?? 1);
  const contactChecks = await checkContacts(pending, places, { fetch: opts.fetch ?? web({}).fetch, now: () => Date.parse(now), timeoutMs: 50 });
  const input: RulesInput = { now, pending, history: opts.history ?? [], places, reviews: () => [], contactChecks };
  const out = applyRules(input);
  const outcome = (item: StoredFeedback) => out.decisions.find((d) => d.id === item.id)?.outcome;
  return { ...out, outcome, after: () => out.places.get(PLACE) };
}

describe("the website check", () => {
  it("puts an attested phone live when the place's website shows it", async () => {
    const r = fact(0, "dev-a", "phone", "03 5555 0100");
    const out = await run([r], { fetch: web({ "https://lake.example.org/": "<p>Call us on (03) 5555-0100</p>" }).fetch });
    expect(out.outcome(r)).toBe("applied");
    expect(out.after()?.facts.phone).toBe("03 5555 0100");
  });

  it("holds an attested phone the place's website does not show for the AI reviewer, naming the check", async () => {
    const r = fact(0, "dev-a", "phone", "03 5555 0100");
    const out = await run([r], { fetch: web({ "https://lake.example.org/": "<p>Call us on 03 5555 0999</p>" }).fetch });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.after()).toBeUndefined();
    expect(out.held).toEqual([
      expect.objectContaining({ case: "contact_check", place: PLACE, fact: "phone", checks: ["website"], feedback: [r.id] }),
    ]);
    expect(out.edits).toEqual([expect.objectContaining({ kind: "fact", fact: "phone", value: "03 5555 0100" })]);
  });

  it("reads the contact pages the home page links to, and finds an email written with entities or a social link", async () => {
    const pages = web({
      "https://lake.example.org/": '<a href="/about">About</a> <a href="/contact-us">Get in touch</a>',
      "https://lake.example.org/contact-us": '<a href="mailto:stay&#64;lake.example.org">Email</a> <a href="https://www.facebook.com/LakeCamp/">Facebook</a>',
      "https://rdap.publicinterestregistry.org/rdap/domain/example.org": rdapDomain("example.org", "1995-08-31T04:00:00Z"),
      [RDAP_BOOTSTRAP_URL]: BOOTSTRAP,
    });
    const email = fact(0, "dev-a", "email", "stay@lake.example.org");
    const facebook = fact(0, "dev-b", "facebook", "https://facebook.com/lakecamp");
    const out = await run([email, facebook], { fetch: pages.fetch });
    expect(out.outcome(email)).toBe("applied");
    expect(out.outcome(facebook)).toBe("applied");
    expect(pages.asked).not.toContain("https://lake.example.org/about");
  });

  it("holds a contact for a place with no website on record, and when the website does not answer in time", async () => {
    const r = fact(0, "dev-a", "phone", "03 5555 0100");
    const none = await run([r], { places: [place({ facts: {}, fact_sources: {} })] });
    expect(none.outcome(r)).toBe("needs_review");
    expect(none.held[0]).toMatchObject({ case: "contact_check", checks: ["website"], problem: "the place's website: there is none on record" });

    const slow = await run([r], { fetch: web({ "https://lake.example.org/": "hang" }).fetch });
    expect(slow.outcome(r)).toBe("needs_review");
    expect(slow.held[0]).toMatchObject({ case: "contact_check", checks: ["website"], problem: "the place's website: timed out" });
  });
});

describe("the domain age check", () => {
  const COM = "https://rdap.verisign.com/com/v1/domain/";
  const AU = "https://rdap.cctld.au/rdap/domain/";

  /** An RDAP answer as the .au registry sends one: no registration date, only when it last changed. */
  const auDomain = (name: string, changed: string) => ({
    objectClassName: "domain",
    ldhName: name,
    status: ["server renew prohibited"],
    events: [
      { eventAction: "last changed", eventDate: changed },
      { eventAction: "last update of RDAP database", eventDate: "2026-07-01T06:52:25.205Z" },
    ],
  });

  it("puts a website live whose domain is older than 90 days, and holds one registered since", async () => {
    const old = fact(0, "dev-a", "website", "https://www.oldcamp.com/stay");
    const fresh = fact(0, "dev-b", "website", "https://newcamp.com", true);
    const pages = web({
      [RDAP_BOOTSTRAP_URL]: BOOTSTRAP,
      [`${COM}oldcamp.com`]: rdapDomain("oldcamp.com", "2019-03-02T00:00:00Z"),
      [`${COM}newcamp.com`]: rdapDomain("newcamp.com", "2026-06-20T00:00:00Z"),
    });
    const out = await run([old], { fetch: pages.fetch });
    expect(out.outcome(old)).toBe("applied");
    expect(out.after()?.facts.website).toBe("https://www.oldcamp.com/stay");
    // The bootstrap file is fetched once for the run.
    const both = await run([fact(0, "dev-c", "website", "https://www.oldcamp.com/stay"), fresh], { fetch: pages.fetch });
    expect(both.outcome(fresh)).toBe("needs_review");
    expect(both.held).toEqual([
      expect.objectContaining({ case: "contact_check", fact: "website", checks: ["domain_age"], problem: "the domain: registered on 2026-06-20, less than 90 days ago", value: "https://lake.example.org" }),
    ]);
    expect(pages.asked.filter((u) => u === RDAP_BOOTSTRAP_URL)).toHaveLength(2);
  });

  it("holds an email whose domain is new, though the website shows it", async () => {
    const r = fact(0, "dev-a", "email", "bookings@newcamp.com");
    const out = await run([r], {
      fetch: web({
        "https://lake.example.org/": "<p>bookings@newcamp.com</p>",
        [RDAP_BOOTSTRAP_URL]: BOOTSTRAP,
        [`${COM}newcamp.com`]: rdapDomain("newcamp.com", "2026-06-01T00:00:00Z"),
      }).fetch,
    });
    expect(out.outcome(r)).toBe("needs_review");
    expect(out.held[0]).toMatchObject({ checks: ["domain_age"] });
  });

  it("passes an .au domain with no registration date only when it has not changed in 90 days", async () => {
    const steady = fact(0, "dev-a", "website", "https://www.steadycamp.com.au");
    const renewed = fact(0, "dev-b", "website", "https://renewedcamp.com.au");
    const pages = web({
      [RDAP_BOOTSTRAP_URL]: BOOTSTRAP,
      [`${AU}steadycamp.com.au`]: auDomain("steadycamp.com.au", "2025-09-25T06:26:58.666Z"),
      [`${AU}renewedcamp.com.au`]: auDomain("renewedcamp.com.au", "2026-06-25T06:26:58.666Z"),
    });
    expect((await run([steady], { fetch: pages.fetch })).outcome(steady)).toBe("applied");
    const out = await run([renewed], { fetch: pages.fetch });
    expect(out.outcome(renewed)).toBe("needs_review");
    expect(out.held[0]).toMatchObject({ checks: ["domain_age"], problem: "the domain: the registry gives no registration date, and it changed in the last 90 days" });
  });

  it("passes a government domain without a lookup", async () => {
    const r = fact(0, "dev-a", "website", "https://www.parks.vic.gov.au/places/lake");
    const pages = web({});
    const out = await run([r], { fetch: pages.fetch });
    expect(out.outcome(r)).toBe("applied");
    expect(pages.asked).toEqual([]);
  });

  it("holds the contact when the registry or the bootstrap file fails, times out or has no such domain", async () => {
    const r = fact(0, "dev-a", "website", "https://camp.com");
    const cases: [Record<string, Answer | "hang" | string | object>, string][] = [
      [{}, "the domain: the RDAP bootstrap file answered 404"],
      [{ [RDAP_BOOTSTRAP_URL]: "hang" }, "the domain: timed out"],
      [{ [RDAP_BOOTSTRAP_URL]: BOOTSTRAP }, "the domain: the registry has no such domain"],
      [{ [RDAP_BOOTSTRAP_URL]: BOOTSTRAP, [`${COM}camp.com`]: () => new Response("busy", { status: 503 }) }, "the domain: the registry answered 503"],
      [{ [RDAP_BOOTSTRAP_URL]: BOOTSTRAP, [`${COM}camp.com`]: "hang" }, "the domain: timed out"],
      [{ [RDAP_BOOTSTRAP_URL]: BOOTSTRAP, [`${COM}camp.com`]: "<html>not json</html>" }, "the domain: could not be read"],
      [{ [RDAP_BOOTSTRAP_URL]: { services: [] } }, "the domain: no RDAP service lists its top-level domain"],
    ];
    for (const [pages, problem] of cases) {
      const out = await run([r], { fetch: web(pages).fetch });
      expect(out.outcome(r)).toBe("needs_review");
      expect(out.held[0]).toMatchObject({ case: "contact_check", checks: ["domain_age"], problem });
    }
  });
});

describe("the address check", () => {
  const address = (fields: Record<string, string>) => ({ street: "Lake Road", suburb: "Lake Eppalock", ...fields });

  it("puts an address live whose state and postcode belong where the place is", async () => {
    const r = fact(0, "dev-a", "address", address({ state: "VIC", postcode: "3551" }));
    const out = await run([r]);
    expect(out.outcome(r)).toBe("applied");
    expect(out.after()?.facts.address).toEqual(address({ state: "VIC", postcode: "3551" }));
  });

  it("holds an address in another state, with a postcode from another state, or with neither", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ state: "WA", postcode: "6000" }, "the address is in WA, which the place is not"],
      [{ state: "VIC", postcode: "4000" }, "the postcode is in QLD, which the place is not"],
      [{ postcode: "9999" }, "the postcode is in QLD, which the place is not"],
      [{}, "the address has no state or postcode to check"],
    ];
    for (const [fields, problem] of cases) {
      const r = fact(0, "dev-a", "address", address(fields));
      const out = await run([r]);
      expect(out.outcome(r)).toBe("needs_review");
      expect(out.held[0]).toMatchObject({ case: "contact_check", fact: "address", checks: ["address"], problem });
    }
  });

  it("allows for a place near a border, where towns take the other state's postcodes", async () => {
    // A place on the New South Wales side of the Murray, with a Victorian postcode, and one near the ACT.
    const murray = place({ location: { lat: -35.98, lon: 146.0 } });
    const r = fact(0, "dev-a", "address", address({ state: "NSW", postcode: "3644" }));
    expect((await run([r], { places: [murray] })).outcome(r)).toBe("applied");
    const canberra = place({ location: { lat: -35.3, lon: 149.13 } });
    const act = fact(0, "dev-b", "address", address({ state: "ACT", postcode: "2601" }));
    expect((await run([act], { places: [canberra] })).outcome(act)).toBe("applied");
    // Far from the border, the other state is held.
    const perth = fact(0, "dev-c", "address", address({ state: "NSW" }));
    expect((await run([perth], { places: [place({ location: { lat: -31.95, lon: 115.86 } })] })).outcome(perth)).toBe("needs_review");
  });
});

describe("contacts the checks pass", () => {
  const shows = web({ "https://lake.example.org/": "<p>Phone 03 5555 0100</p>" });

  it("sets a contact without attestation once a second device agrees, and holds a failing one for the AI reviewer", async () => {
    const a = fact(0, "dev-a", "phone", "03 5555 0100", false);
    const first = await run([a], { fetch: shows.fetch });
    expect(first.outcome(a)).toBe("waiting");
    expect(first.edits).toEqual([]);
    const b = fact(2, "dev-b", "phone", "03 5555 0100", false);
    const second = await run([a, b], { fetch: shows.fetch, now: 3 });
    expect(second.outcome(a)).toBe("applied");
    expect(second.outcome(b)).toBe("applied");
    expect(second.after()?.facts.phone).toBe("03 5555 0100");
    expect(second.changes).toEqual([expect.objectContaining({ automatic: true, feedback: [a.id, b.id] })]);

    const wrong = fact(0, "dev-c", "phone", "03 5555 0999", false);
    const held = await run([wrong], { fetch: shows.fetch });
    expect(held.outcome(wrong)).toBe("needs_review");
    expect(held.held[0]).toMatchObject({ case: "contact_check", checks: ["website"] });
  });

  it("still sends a contact the owner set to a person, whatever the checks say", async () => {
    const owned = place({ facts: { website: "https://lake.example.org", phone: "03 5555 0111" }, fact_sources: { website: "owner", phone: "owner" } });
    for (const attested of [true, false]) {
      const r = fact(0, "dev-a", "phone", "03 5555 0100", attested);
      const out = await run([r], { places: [owned], fetch: shows.fetch });
      expect(out.outcome(r)).toBe("needs_review");
      expect(out.held).toEqual([]);
      expect(out.decisions[0]!.reason).toBe("phone was set by the owner, so a person decides");
    }
  });

  it("leaves a contact the checks have not run on waiting for a later run", async () => {
    const r = fact(0, "dev-a", "phone", "03 5555 0100");
    const places = new Map([[PLACE, place()]]);
    const out = applyRules({ now: at(1), pending: [r], history: [], places, reviews: () => [], contactChecks: new Map() });
    expect(out.decisions[0]).toMatchObject({ outcome: "waiting", reason: "the contact checks have not run on phone yet" });
  });
});

describe("a contact about a merged place", () => {
  it("is checked against the place it was merged into", async () => {
    const TOMB = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
    const tombstone = place({ id: TOMB, status: "merged", merged_into: PLACE, facts: {}, fact_sources: {} });
    const r = { ...fact(0, "dev-a", "phone", "03 5555 0100"), place: TOMB } as StoredFeedback;
    const out = await run([r], { places: [place(), tombstone], fetch: web({ "https://lake.example.org/": "<p>03 5555 0100</p>" }).fetch });
    expect(out.outcome(r)).toBe("applied");
    expect(out.after()?.facts.phone).toBe("03 5555 0100");
  });
});
