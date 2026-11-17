import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Transport, TransportResponse } from "../src/proof.js";
import { run } from "../src/run.js";
import { dumpPlace } from "../src/serialise.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const NOW = new Date("2026-10-30T00:00:00Z");
const DAY = "2026-10-29";
const GOV = "https://www.parks.vic.gov.au/places/example-camp";
const OWN = "https://example.org/facilities";

const basePlace: Place = {
  id: PLACE,
  name: "Lake Eppalock Camp",
  kind: "free_camp",
  group: "overnight",
  location: { lat: -36.85, lon: 144.55 },
  osm: { type: "node", id: 123456, version: 7 },
  facts: { power: false, website: "https://www.example.org/" },
  status: "open",
  rating: null,
  fact_sources: { power: "osm", website: "osm" },
  updated: "2026-06-01T00:00:00Z",
};

let root: string;
let inbox: string;
let data: string;

async function put(path: string, body: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

const id = (n: number) => `fb_01JC${String(n).padStart(22, "0")}`;

/** A fact report without attestation, as a website or an app without App Attest sends it. */
async function report(n: number, device: string, fact: string, value: unknown, source?: string) {
  await put(join(inbox, "pending", DAY, `${id(n)}.json`), {
    id: id(n),
    received: `${DAY}T0${n}:00:00Z`,
    app: "example-app",
    place: PLACE,
    device,
    app_version: "1.0.0",
    consent: true,
    type: "report",
    report: { kind: "fact", fact, value, ...(source ? { source } : {}) },
  });
}

function html(status: number, body: string, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }): TransportResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers,
    body: (async function* () {
      yield bytes;
    })(),
  };
}

/** The pages the fake network answers with, and the addresses asked for. */
function network(pages: Record<string, TransportResponse | Error>) {
  const asked: string[] = [];
  const transport: Transport = async (url) => {
    asked.push(url.href);
    const reply = pages[url.href];
    if (!reply) throw new Error(`no page for ${url.href}`);
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { transport, asked };
}

const page = (text: string) => html(200, `<html><head><title>Example Camp</title></head><body><main>${text}</main></body></html>`);

async function placeNow(): Promise<Place> {
  return JSON.parse(await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8")) as Place;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocdb-source-"));
  inbox = join(root, "inbox");
  data = join(root, "data");
  await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace(basePlace));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const outcomeOf = (summary: Awaited<ReturnType<typeof run>>, n: number) => summary.decisions.find((d) => d.id === id(n));

describe("source links in the apply run", () => {
  it("counts a value the linked page shows as a second source, so one report sets it", async () => {
    await report(1, "aaaa", "toilets", true, GOV);
    const { transport, asked } = network({ [GOV]: page("<h2>Facilities</h2><ul><li>Flush toilets</li><li>Picnic tables</li></ul>") });

    const summary = await run({ inbox, data, now: NOW, sourceTransport: transport });

    expect(asked).toEqual([GOV]);
    expect(outcomeOf(summary, 1)).toMatchObject({ outcome: "applied", reason: expect.stringContaining("source_link") });
    expect((await placeNow()).facts.toilets).toBe(true);
    expect(summary.auto_pr_body).toContain("source link");
  });

  it("takes a page on the host of the place's website on record", async () => {
    await report(1, "aaaa", "showers", true, OWN);
    const { transport } = network({ [OWN]: page("Hot showers in the amenities block.") });
    const summary = await run({ inbox, data, now: NOW, sourceTransport: transport });
    expect(outcomeOf(summary, 1)?.outcome).toBe("applied");
    expect((await placeNow()).facts.showers).toBe(true);
  });

  it("leaves a report waiting when the page does not show the value", async () => {
    await report(1, "aaaa", "toilets", true, GOV);
    const { transport } = network({ [GOV]: page("There are no toilets at this camp. Bring a portable toilet.") });
    const summary = await run({ inbox, data, now: NOW, sourceTransport: transport });
    expect(outcomeOf(summary, 1)).toMatchObject({ outcome: "waiting" });
    expect((await placeNow()).facts.toilets).toBeUndefined();
  });

  it("never confirms when the page cannot be fetched", async () => {
    const failures: (TransportResponse | Error)[] = [
      new Error("connect ECONNREFUSED"),
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      html(500, "Flush toilets"),
      html(404, "Flush toilets"),
      html(200, "Flush toilets", { "content-type": "application/pdf" }),
    ];
    for (const failure of failures) {
      await rm(inbox, { recursive: true, force: true });
      await report(1, "aaaa", "toilets", true, GOV);
      const { transport } = network({ [GOV]: failure });
      const summary = await run({ inbox, data, now: NOW, sourceTransport: transport });
      expect(outcomeOf(summary, 1)?.outcome).toBe("waiting");
    }
    expect((await placeNow()).facts.toilets).toBeUndefined();
  });

  it("never confirms from a page on another host, nor one a redirect takes elsewhere", async () => {
    await report(1, "aaaa", "toilets", true, "https://camp-reviews.example.net/camp");
    await report(2, "bbbb", "showers", true, GOV);
    const { transport, asked } = network({
      [GOV]: html(302, "", { location: "https://camp-reviews.example.net/camp" }),
      "https://camp-reviews.example.net/camp": page("Flush toilets and hot showers"),
    });
    const summary = await run({ inbox, data, now: NOW, sourceTransport: transport });
    expect(asked).toEqual([GOV]);
    expect(outcomeOf(summary, 1)?.outcome).toBe("waiting");
    expect(outcomeOf(summary, 2)?.outcome).toBe("waiting");
  });

  it("follows a redirect that stays on an allowed host", async () => {
    await report(1, "aaaa", "toilets", true, GOV);
    const moved = "https://www.parks.vic.gov.au/places/example-camp/";
    const { transport } = network({ [GOV]: html(301, "", { location: moved }), [moved]: page("Flush toilets") });
    const summary = await run({ inbox, data, now: NOW, sourceTransport: transport });
    expect(outcomeOf(summary, 1)?.outcome).toBe("applied");
  });

  it("counts the link as a second source for a contact that passed the contact checks", async () => {
    const onWebsite = new Response("<html><body>Call us on (03) 5555 0100</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const contactFetch = async (url: string) => (url.startsWith("https://www.example.org") ? onWebsite.clone() : new Response("not found", { status: 404 }));
    await report(1, "aaaa", "phone", "03 5555 0100", GOV);
    const { transport } = network({ [GOV]: page("Bookings: phone 03 5555 0100") });
    const summary = await run({ inbox, data, now: NOW, sourceTransport: transport, contactChecks: { fetch: contactFetch } });
    expect(outcomeOf(summary, 1)).toMatchObject({ outcome: "applied", reason: expect.stringContaining("source_link") });
    expect((await placeNow()).facts.phone).toBe("03 5555 0100");
  });

  it("is off without a transport for an inbox item that has no link", async () => {
    await report(1, "aaaa", "toilets", true);
    const summary = await run({ inbox, data, now: NOW });
    expect(outcomeOf(summary, 1)?.outcome).toBe("waiting");
  });
});

describe("what a page must say for a value to appear on it", () => {
  /** Whether one report of `fact` = `value`, linked to a page holding `text`, goes in. */
  async function confirms(fact: string, value: unknown, text: string): Promise<boolean> {
    await rm(inbox, { recursive: true, force: true });
    await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace(basePlace));
    await report(1, "aaaa", fact, value, GOV);
    const { transport } = network({ [GOV]: page(text) });
    const summary = await run({ inbox, data, now: NOW, sourceTransport: transport });
    return outcomeOf(summary, 1)?.outcome === "applied";
  }

  it("reads a yes or no fact only from wording that says it, and never from a page that says both", async () => {
    expect(await confirms("toilets", true, "Facilities include toilets and tables.")).toBe(true);
    expect(await confirms("toilets", false, "There are no toilets.")).toBe(true);
    // Closed toilets are not missing ones: the page says neither.
    expect(await confirms("toilets", false, "Toilets are closed for repairs.")).toBe(false);
    expect(await confirms("toilets", true, "Toilets are closed for repairs.")).toBe(false);
    expect(await confirms("toilets", true, "No toilets here; the nearest toilets are in town.")).toBe(false);
    expect(await confirms("toilets", false, "Toilets and showers.")).toBe(false);
    // A page that never names the fact says nothing about it either way.
    expect(await confirms("toilets", false, "A quiet bush camp by the river.")).toBe(false);
    expect(await confirms("drinking_water", true, "Drinking water is available from the tank.")).toBe(true);
    expect(await confirms("drinking_water", true, "Tank water is not suitable for drinking.")).toBe(false);
    expect(await confirms("campfires", false, "Campfires are not permitted.")).toBe(true);
    expect(await confirms("campfires", true, "Campfires are not permitted.")).toBe(false);
    expect(await confirms("power", true, "Powered sites are available.")).toBe(true);
    expect(await confirms("power", true, "Powered and unpowered sites.")).toBe(false);
  });

  it("reads a value from a list of choices only when no other choice is named", async () => {
    expect(await confirms("pets", "no", "Dogs are not allowed in the park.")).toBe(true);
    expect(await confirms("pets", "no", "No dogs allowed.")).toBe(true);
    expect(await confirms("pets", "yes", "No dogs allowed.")).toBe(false);
    expect(await confirms("pets", "yes", "Dogs are welcome.")).toBe(true);
    expect(await confirms("pets", "yes", "Dogs are allowed on a leash.")).toBe(false);
    expect(await confirms("pets", "leashed", "Dogs must be kept on a lead.")).toBe(true);
    expect(await confirms("pets", "seasonal", "Dogs are allowed from May to September.")).toBe(false);
    expect(await confirms("fee", false, "This is a free camp.")).toBe(true);
    expect(await confirms("fee", false, "Free camping for 48 hours. Camping fees apply after that.")).toBe(false);
    expect(await confirms("toilet_type", "pit", "There is a drop toilet near the gate.")).toBe(true);
    expect(await confirms("access", "4wd", "4WD access only.")).toBe(false);
  });

  it("finds a charge, a stay and a name as the page writes them", async () => {
    expect(await confirms("charge", "25 AUD/night", "Camping costs $25.00 per site per night.")).toBe(true);
    expect(await confirms("charge", "25 AUD/night", "Camping costs $250 per week.")).toBe(false);
    expect(await confirms("charge", "12.5 AUD/night", "Fees: $12.50 a night.")).toBe(true);
    expect(await confirms("max_stay", "7d", "Maximum stay of 7 nights.")).toBe(true);
    expect(await confirms("max_stay", "7d", "Maximum stay of 17 nights.")).toBe(false);
    expect(await confirms("max_stay", "2w", "You may stay up to 2 weeks.")).toBe(true);
    expect(await confirms("operator", "Example Shire Council", "Managed by Example  Shire &nbsp;Council.")).toBe(true);
    expect(await confirms("operator", "Example Shire Council", "Managed by Example Shire.")).toBe(false);
    // Words in scripts and styles are not on the page a visitor reads.
    expect(await confirms("toilets", true, "<script>var toilets = true;</script>A quiet camp.")).toBe(false);
  });
});
