import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/run.js";
import { dumpPlace } from "../src/serialise.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const NOW = new Date("2026-10-30T00:00:00Z");
const place: Place = {
  id: PLACE,
  name: "Lake Eppalock Camp",
  kind: "free_camp",
  group: "overnight",
  location: { lat: -36.85, lon: 144.55 },
  osm: { type: "node", id: 123456, version: 7 },
  facts: { power: false },
  status: "open",
  rating: null,
  fact_sources: { power: "osm" },
  updated: "2026-06-01T00:00:00Z",
};

let root: string;
let inbox: string;
let data: string;

async function put(path: string, body: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

/** Every file under `dir`, path to text. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[relative(dir, full).split(sep).join("/")] = await readFile(full, "utf8");
  }
  return out;
}

const id = (n: number) => `fb_01JC${String(n).padStart(22, "0")}`;
const OTHER = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const TRUSTED = "ctr_7a7a7a7a7a7a7a7a";
const NEWCOMER = "ctr_5e5e5e5e5e5e5e5e";

/** Makes TRUSTED a contributor with a published review, of another place. */
async function trustContributor(): Promise<void> {
  await put(
    join(data, "reviews", `${OTHER}.ndjson`),
    `{"app":"example-app","contributor":"${TRUSTED}","created":"2026-09-01T00:00:00Z","id":"rev_01JB0000000000000000000001","place":"${OTHER}","stars":5,"text":"","visited":"2026-08"}\n`,
  );
}

function item(n: number, received: string, device: string, extra: Record<string, unknown>) {
  return { id: id(n), received, app: "example-app", place: PLACE, device, app_version: "1.0.0", consent: true, ...extra };
}

async function pending(n: number, received: string, device: string, extra: Record<string, unknown>) {
  await put(join(inbox, "pending", received.slice(0, 10), `${id(n)}.json`), item(n, received, device, extra));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocdb-apply-"));
  inbox = join(root, "inbox");
  data = join(root, "data");
  await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace(place));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("run", () => {
  it("writes fees to fees/<place id>.ndjson in canonical form", async () => {
    const day = "2026-10-29";
    await put(
      join(data, "fees", `${PLACE}.ndjson`),
      `{"amount":30,"app":"example-app","contributor":"${TRUSTED}","created":"2026-09-01T00:00:00Z","id":"fee_01JB0000000000000000000001","paid":"2026-08","place":"${PLACE}","site":"powered"}\n`,
    );
    await pending(1, `${day}T01:00:00Z`, "aaaa", { type: "fee", contributor: TRUSTED, fee: { amount: 36.5, site: "powered", paid: "2026-10" } });
    await pending(2, `${day}T02:00:00Z`, "bbbb", { type: "fee", contributor: NEWCOMER, fee: { amount: 120, site: "cabin", paid: "2026-09" } });

    const summary = await run({ inbox, data, now: NOW });

    expect(summary.counts).toEqual({ applied: 2, refused: 0, needs_review: 0, waiting: 0, awaiting_approval: 0 });
    expect(summary.auto_files).toEqual([`fees/${PLACE}.ndjson`]);
    expect(await readFile(join(data, "fees", `${PLACE}.ndjson`), "utf8")).toBe(
      `{"amount":36.5,"app":"example-app","contributor":"${TRUSTED}","created":"${day}T01:00:00Z","id":"fee_01JC0000000000000000000001","paid":"2026-10","place":"${PLACE}","site":"powered"}\n` +
        `{"amount":120,"app":"example-app","contributor":"${NEWCOMER}","created":"${day}T02:00:00Z","id":"fee_01JC0000000000000000000002","paid":"2026-09","place":"${PLACE}","site":"cabin"}\n`,
    );
    expect(summary.auto_pr_body).toContain("powered fee of $36.50 a night paid 2026-10, replacing fee_01JB0000000000000000000001");
    expect(summary.review_changed).toBe(false);
  });

  it("applies feedback, writes data files in canonical form and moves inbox files", async () => {
    const day = "2026-10-29";
    const power = { type: "report", report: { kind: "fact", fact: "power", value: true } };
    await pending(1, `${day}T01:00:00Z`, "aaaa", power);
    await pending(2, `${day}T02:00:00Z`, "bbbb", power);
    await trustContributor();
    await pending(3, `${day}T03:00:00Z`, "cccc", {
      type: "review",
      contributor: TRUSTED,
      review: { stars: 4, text: "Flat sites and clean toilets.", visited: "2026-10" },
    });
    await pending(4, `${day}T04:00:00Z`, "dddd", {
      type: "review",
      review: { stars: 1, text: "Write to jo@example.com", visited: "2026-10" },
    });
    await pending(5, `${day}T05:00:00Z`, "eeee", { type: "report", report: { kind: "fact", fact: "fee", value: true } });

    const summary = await run({ inbox, data, now: NOW });

    expect(summary.counts).toEqual({ applied: 3, refused: 1, needs_review: 0, waiting: 1, awaiting_approval: 0 });
    // Refused, but not the item still waiting, which a later run decides.
    expect(summary.not_applied).toEqual([id(4)]);
    expect(summary.refused).toEqual([id(4)]);
    expect(summary.auto_changed).toBe(true);
    expect(summary.review_changed).toBe(false);
    expect([...summary.auto_files].sort()).toEqual([`places/za/${PLACE}.json`, `reviews/${PLACE}.ndjson`]);

    const written = await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8");
    const record = JSON.parse(written) as Place;
    expect(record.facts.power).toBe(true);
    expect(record.fact_sources.power).toBe("feedback");
    expect(record.rating).toEqual({ count: 1, mean: 4 });
    expect(record.updated).toBe("2026-10-30T00:00:00Z");
    expect(written).toContain('"mean": 4.0');
    expect(written).toBe(dumpPlace(record));

    const reviews = await readFile(join(data, "reviews", `${PLACE}.ndjson`), "utf8");
    expect(reviews).toBe(
      `{"app":"example-app","contributor":"${TRUSTED}","created":"${day}T03:00:00Z","id":"rev_01JC0000000000000000000003","place":"${PLACE}",` +
        `"stars":4,"text":"Flat sites and clean toilets.","visited":"2026-10"}\n`,
    );

    expect((await readdir(join(inbox, "applied", day))).sort()).toEqual([`${id(1)}.json`, `${id(2)}.json`, `${id(3)}.json`]);
    const refused = JSON.parse(await readFile(join(inbox, "refused", day, `${id(4)}.json`), "utf8")) as {
      outcome: { result: string; reason: string };
    };
    expect(refused.outcome.result).toBe("refused");
    expect(refused.outcome.reason).toMatch(/email address/);
    expect(await readdir(join(inbox, "pending", day))).toEqual([`${id(5)}.json`]);

    expect(summary.auto_pr_body).toContain("power set to true");
    expect(summary.auto_pr_body).not.toContain("aaaa");
    expect(summary.auto_pr_body).not.toContain("jo@example.com");
    expect(summary.review_pr_body).toBe("");
  });

  it("uses applied items from earlier runs as evidence", async () => {
    await put(join(inbox, "applied", "2026-10-01", `${id(1)}.json`), {
      ...item(1, "2026-10-01T00:00:00Z", "aaaa", { type: "report", report: { kind: "closed" } }),
      outcome: { result: "applied", reason: "place is reported_closed", run: "2026-10-01T01:00:00Z" },
    });
    await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace({ ...place, status: "reported_closed" }));
    await pending(2, "2026-10-29T00:00:00Z", "bbbb", { type: "report", report: { kind: "closed" } });

    const summary = await run({ inbox, data, now: NOW });
    expect(summary.counts.applied).toBe(1);
    const record = JSON.parse(await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8")) as Place;
    expect(record.status).toBe("closed");
  });

  it("writes last_confirmed for a check that found the place there, leaving updated alone", async () => {
    await pending(3, "2026-10-29T00:00:00Z", "aaaa", { type: "check", check: { visited: "2026-10-28", still_there: true } });
    const summary = await run({ inbox, data, now: NOW });
    expect(summary.auto_changed).toBe(true);
    expect(summary.auto_pr_body).toContain("confirmed there by a traveller");
    const text = await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8");
    const record = JSON.parse(text) as Place;
    expect(record.last_confirmed).toBe("2026-10-30T00:00:00Z");
    expect(record.updated).toBe(place.updated);
    expect(text).toBe(dumpPlace({ ...place, last_confirmed: "2026-10-30T00:00:00Z" }));
  });

  it("writes a new place to the automatic checkout with its standing", async () => {
    const review = join(root, "data-review");
    await put(join(review, "places", "za", `${PLACE}.json`), dumpPlace(place));
    await put(join(inbox, "pending", "2026-10-29", `${id(9)}.json`), {
      ...item(9, "2026-10-29T00:00:00Z", "aaaa", {
        type: "report",
        location: { lat: -35.5, lon: 149 },
        report: { kind: "new_place", note: "Free camp by the creek" },
      }),
      contributor: TRUSTED,
      attested: "app_attest",
      place: null,
    });
    await put(join(inbox, "applied", "2026-10-01", `${id(8)}.json`), {
      ...item(8, "2026-10-01T00:00:00Z", "aaaa", { type: "report", location: { lat: -30, lon: 140 }, report: { kind: "new_place" } }),
      contributor: TRUSTED,
      place: null,
      outcome: { result: "applied", reason: "", run: "2026-10-01T01:00:00Z" },
    });
    const summary = await run({ inbox, data, reviewData: review, now: NOW });
    const newId = `ocdb_${id(9).slice(3)}`;
    expect(summary.auto_files).toEqual([`places/${newId.slice(-2).toLowerCase()}/${newId}.json`]);
    const record = await readFile(join(data, summary.auto_files[0]!), "utf8");
    expect(record).toContain('"lon": 149.0');
    expect(record).toContain('"standing": "shown"');
    expect(record).not.toContain("creek");
    expect(summary.review_files).toEqual([]);
    expect(summary.auto_pr_body).toContain("published as shown");
    expect(summary.auto_pr_body).not.toContain("creek");
  });

  /** A new place report in pending/ (or applied/ with an outcome), from TRUSTED. */
  async function newPlace(n: number, received: string, device: string, location: { lat: number; lon: number }, folder = "pending", extra = {}) {
    const body = {
      ...item(n, received, device, { type: "report", location, report: { kind: "new_place", place_kind: "free_camp", ...extra } }),
      contributor: TRUSTED,
      attested: "app_attest",
      place: null,
      ...(folder === "applied" ? { outcome: { result: "applied", reason: "", run: received } } : {}),
    };
    await put(join(inbox, folder, received.slice(0, 10), `${id(n)}.json`), body);
    return `ocdb_${id(n).slice(3)}`;
  }
  /** Every held case in a review PR body, read back the way a triage agent would. */
  const heldCases = (body: string) =>
    body
      .split("\n")
      .filter((l) => l.startsWith("- held-case "))
      .map((l) => JSON.parse(l.slice("- held-case ".length)) as Record<string, unknown>);

  it("holds a possible duplicate in the review checkout and lists it as a held case", async () => {
    const review = join(root, "data-review");
    await put(join(review, "places", "za", `${PLACE}.json`), dumpPlace(place));
    await put(join(data, "schema", "kinds.json"), { kinds: [{ code: "free_camp", label: "Free camp", group: "overnight" }] });
    const newId = await newPlace(9, "2026-10-29T00:00:00Z", "aaaa", { lat: -36.8505, lon: 144.5502 }, "pending", {
      contacts: { email: "jo@example.com" },
    });
    const summary = await run({ inbox, data, reviewData: review, now: NOW });
    expect(summary.auto_changed).toBe(false);
    expect(summary.review_files).toEqual([`places/${newId.slice(-2).toLowerCase()}/${newId}.json`]);
    const draft = JSON.parse(await readFile(join(review, summary.review_files[0]!), "utf8")) as Place;
    expect(draft.standing).toBe("held");
    expect(heldCases(summary.review_pr_body)).toEqual([
      {
        case: "duplicate",
        place: newId,
        standing: "held",
        location: { lat: -36.8505, lon: 144.5502 },
        kind: "free_camp",
        duplicate_of: PLACE,
        distance_m: 58,
        feedback: [id(9)],
      },
      { case: "first_place", place: newId, standing: "held", location: { lat: -36.8505, lon: 144.5502 }, kind: "free_camp", contributor: TRUSTED, feedback: [id(9)] },
    ]);
    expect(summary.review_pr_body).not.toContain("jo@");
  });

  it("takes a doubted fact down with a held case, and a later run restores it and closes the case", async () => {
    const withToilets: Place = { ...place, facts: { power: false, toilets: true }, fact_sources: { power: "osm", toilets: "feedback" }, fact_dates: { toilets: "2026-09-01T00:00:00Z" } };
    await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace(withToilets));
    const doubt = { type: "report", report: { kind: "doubt", fact: "toilets", note: "none I could find" } };
    await pending(1, "2026-10-28T00:00:00Z", "aaaa", { ...doubt, attested: "app_attest", contributor: TRUSTED });
    await pending(2, "2026-10-29T00:00:00Z", "bbbb", doubt);

    const first = await run({ inbox, data, now: NOW });
    const down = JSON.parse(await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8")) as Place;
    expect(down.facts).toEqual({ power: false });
    expect(down.fact_dates?.toilets).toBe("2026-10-29T00:00:00Z");
    expect(heldCases(first.review_pr_body)).toEqual([expect.objectContaining({ case: "fact_doubted", fact: "toilets", value: true, taken_down: true, doubts: [id(1), id(2)] })]);
    expect(first.review_pr_body).not.toContain("none I could find");
    const kept = JSON.parse(await readFile(join(inbox, "applied", "2026-10-29", `${id(2)}.json`), "utf8")) as { outcome: Record<string, unknown> };
    expect(kept.outcome.doubted).toEqual({ fact: "toilets", value: true, at: "2026-10-29T00:00:00Z" });

    const confirm = { type: "report", report: { kind: "fact", fact: "toilets", value: true } };
    await pending(3, "2026-11-01T00:00:00Z", "cccc", confirm);
    await pending(4, "2026-11-02T00:00:00Z", "dddd", { ...confirm, attested: "app_attest" });
    const second = await run({ inbox, data, now: new Date("2026-11-03T00:00:00Z") });
    const back = JSON.parse(await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8")) as Place;
    expect(back.facts).toEqual({ power: false, toilets: true });
    expect(second.auto_pr_body).toContain("toilets restored after two travellers confirmed it (closes the fact_doubted case)");
    expect(second.review_pr_body.split("\n").filter((l) => l.startsWith("- closed-case "))).toEqual([
      `- closed-case ${JSON.stringify({ case: "fact_doubted", place: PLACE, fact: "toilets", settles: "restored", feedback: [id(3), id(4)] })}`,
    ]);
  });

  it("reports the new places it wrote for the first time", async () => {
    const newId = await newPlace(9, "2026-10-29T00:00:00Z", "aaaa", { lat: -30, lon: 140 });
    const summary = await run({ inbox, data, now: NOW });
    expect(summary.new_places).toEqual([newId]);
    expect((await run({ inbox, data, now: NOW })).new_places).toEqual([]);
  });

  it("deletes a withdrawn place from both checkouts", async () => {
    const review = join(root, "data-review");
    await put(join(review, "places", "za", `${PLACE}.json`), dumpPlace(place));
    const newId = await newPlace(9, "2026-10-29T00:00:00Z", "aaaa", { lat: -30, lon: 140 }, "applied");
    const path = `places/${newId.slice(-2).toLowerCase()}/${newId}.json`;
    const record = { ...place, id: newId, name: null, osm: null, facts: {}, fact_sources: { location: "feedback" as const }, location: { lat: -30, lon: 140 }, standing: "shown" as const };
    await put(join(data, path), dumpPlace(record));
    await put(join(review, path), dumpPlace(record));
    await pending(10, "2026-10-29T06:00:00Z", "aaaa", { type: "withdraw", place: newId });
    const summary = await run({ inbox, data, reviewData: review, now: NOW });
    expect(summary.auto_files).toEqual([path]);
    expect(summary.review_files).toEqual([path]);
    await expect(readFile(join(data, path), "utf8")).rejects.toThrow();
    await expect(readFile(join(review, path), "utf8")).rejects.toThrow();
    expect(summary.auto_pr_body).toContain("withdrawn by the person who added it");
    expect(summary.new_places).toEqual([]);
  });

  it("splits automatic and review changes to one place between the checkouts", async () => {
    const review = join(root, "data-review");
    await put(join(review, "places", "za", `${PLACE}.json`), dumpPlace(place));
    const power = { type: "report", report: { kind: "fact", fact: "power", value: true } };
    await pending(1, "2026-10-29T01:00:00Z", "aaaa", power);
    await pending(2, "2026-10-29T02:00:00Z", "bbbb", power);
    await pending(3, "2026-10-29T03:00:00Z", "cccc", {
      type: "report",
      location: { lat: -36.9, lon: 144.6 },
      report: { kind: "wrong_location" },
    });
    const summary = await run({ inbox, data, reviewData: review, now: NOW });
    const auto = JSON.parse(await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8")) as Place;
    const proposed = JSON.parse(await readFile(join(review, "places", "za", `${PLACE}.json`), "utf8")) as Place;
    expect(auto.facts.power).toBe(true);
    expect(auto.location).toEqual(place.location);
    expect(proposed.facts.power).toBe(false);
    expect(proposed.location).toEqual({ lat: -36.9, lon: 144.6 });
    expect(proposed.fact_sources.location).toBe("feedback");
    expect(summary.auto_pr_body).toContain("power set to true");
    expect(summary.auto_pr_body).not.toContain("location moved");
    expect(summary.review_pr_body).toContain("location moved");
    expect(summary.review_pr_body).not.toContain("power set to true");
  });

  it("withholds a note that fails moderation from the PR body", async () => {
    await pending(7, "2026-10-29T00:00:00Z", "aaaa", { type: "report", report: { kind: "other", note: "Ask @ranger_bob" } });
    const summary = await run({ inbox, data, now: NOW });
    expect(summary.review_changed).toBe(true);
    expect(summary.review_pr_body).toContain("note withheld");
    expect(summary.review_pr_body).not.toContain("ranger_bob");
  });

  it("changes nothing when run twice with no new inbox files", async () => {
    const review = join(root, "data-review");
    await put(join(review, "places", "za", `${PLACE}.json`), dumpPlace(place));
    await pending(1, "2026-10-29T01:00:00Z", "aaaa", { type: "report", report: { kind: "fact", fact: "power", value: true } });
    await pending(2, "2026-10-29T02:00:00Z", "bbbb", { type: "report", report: { kind: "closed" } });
    await pending(3, "2026-10-29T03:00:00Z", "cccc", { type: "review", contributor: NEWCOMER, review: { stars: 5, text: "Quiet.", visited: "2026-10" } });
    await pending(4, "2026-10-29T04:00:00Z", "dddd", {
      type: "report",
      location: { lat: -36.9, lon: 144.6 },
      report: { kind: "wrong_location" },
    });
    await run({ inbox, data, reviewData: review, now: NOW });
    const before = await snapshot(root);

    const again = await run({ inbox, data, reviewData: review, now: new Date(NOW.getTime() + 60 * 60 * 1000) });
    expect(again).toMatchObject({ auto_changed: false, review_changed: false, inbox_changed: false });
    expect(again.auto_pr_body).toBe("");
    expect(again.review_pr_body).toBe("");
    expect(await snapshot(root)).toEqual(before);
  });

  it("writes no data twice when the inbox push failed and the same items run again", async () => {
    const review = join(root, "data-review");
    await put(join(review, "places", "za", `${PLACE}.json`), dumpPlace(place));
    const power = { type: "report", report: { kind: "fact", fact: "power", value: true } };
    await pending(1, "2026-10-29T01:00:00Z", "aaaa", power);
    await pending(2, "2026-10-29T02:00:00Z", "bbbb", power);
    await pending(3, "2026-10-29T03:00:00Z", "cccc", { type: "review", contributor: NEWCOMER, review: { stars: 5, text: "Quiet.", visited: "2026-10" } });
    await put(join(inbox, "pending", "2026-10-29", `${id(4)}.json`), {
      ...item(4, "2026-10-29T04:00:00Z", "dddd", { type: "report", location: { lat: -35.5, lon: 149 }, report: { kind: "new_place" } }),
      place: null,
    });
    const inboxBefore = await snapshot(inbox);
    await run({ inbox, data, reviewData: review, now: NOW });
    const dataAfter = { auto: await snapshot(data), review: await snapshot(review) };

    // The inbox commit was never pushed, so the next run sees the same pending files.
    await rm(inbox, { recursive: true });
    for (const [path, text] of Object.entries(inboxBefore)) await put(join(inbox, path), text);
    const again = await run({ inbox, data, reviewData: review, now: new Date(NOW.getTime() + 60 * 60 * 1000) });

    expect(again.auto_changed).toBe(false);
    expect(again.review_changed).toBe(false);
    expect(again.inbox_changed).toBe(true);
    expect({ auto: await snapshot(data), review: await snapshot(review) }).toEqual(dataAfter);
  });

  it("keeps review lines sorted by id", async () => {
    const later = `{"app":"example-app","contributor":"${NEWCOMER}","created":"2026-11-01T00:00:00Z","id":"rev_01JZ0000000000000000000000","place":"${PLACE}","stars":5,"text":"","visited":"2026-10"}`;
    await put(join(data, "reviews", `${PLACE}.ndjson`), `${later}\n`);
    await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace({ ...place, rating: { count: 1, mean: 5 } }));
    await trustContributor();
    await pending(3, "2026-10-29T00:00:00Z", "aaaa", { type: "review", contributor: TRUSTED, review: { stars: 4, text: "Quiet.", visited: "2026-10" } });
    await run({ inbox, data, now: NOW });
    const lines = (await readFile(join(data, "reviews", `${PLACE}.ndjson`), "utf8")).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("rev_01JC0000000000000000000003");
    expect(lines[1]).toBe(later);
    expect(lines[2]).toBe("");
    const record = JSON.parse(await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8")) as Place;
    expect(record.rating).toEqual({ count: 2, mean: 4.5 });
  });

  it("holds a newcomer's review in the review checkout with the rating it would give", async () => {
    const review = join(root, "data-review");
    await put(join(review, "places", "za", `${PLACE}.json`), dumpPlace(place));
    await pending(3, "2026-10-29T00:00:00Z", "aaaa", { type: "review", contributor: NEWCOMER, review: { stars: 4, text: "Quiet.", visited: "2026-10" } });
    const summary = await run({ inbox, data, reviewData: review, now: NOW });
    expect(summary.counts.needs_review).toBe(1);
    expect(summary.auto_changed).toBe(false);
    expect([...summary.review_files].sort()).toEqual([`places/za/${PLACE}.json`, `reviews/${PLACE}.ndjson`]);
    expect(await readFile(join(review, "reviews", `${PLACE}.ndjson`), "utf8")).toContain(NEWCOMER);
    const proposed = JSON.parse(await readFile(join(review, "places", "za", `${PLACE}.json`), "utf8")) as Place;
    expect(proposed.rating).toEqual({ count: 1, mean: 4 });
    expect(summary.review_pr_body).toContain("first review from this contributor");
  });

  it("hides a review reported by three contributors and refuses a blocked contributor", async () => {
    const target = `{"app":"example-app","contributor":"${NEWCOMER}","created":"2026-10-01T00:00:00Z","id":"rev_01JB0000000000000000000009","place":"${PLACE}","stars":1,"text":"","visited":"2026-09"}`;
    await put(join(data, "reviews", `${PLACE}.ndjson`), `${target}\n`);
    await put(join(data, "places", "za", `${PLACE}.json`), dumpPlace({ ...place, rating: { count: 1, mean: 1 } }));
    await put(join(data, "moderation", "blocked_contributors.json"), {
      contributors: [{ contributor: "ctr_bbbbbbbbbbbbbbbb", added: "2026-10-01", reason: "spam_ad" }],
    });
    const report = (n: number, who: string) =>
      pending(n, `2026-10-29T0${n}:00:00Z`, `dev${n}`, {
        type: "review_report",
        contributor: who,
        review_report: { review: "rev_01JB0000000000000000000009", reason: "fake" },
      });
    await report(1, "ctr_1111111111111111");
    await report(2, "ctr_2222222222222222");
    await report(3, "ctr_3333333333333333");
    await report(4, "ctr_bbbbbbbbbbbbbbbb");
    const summary = await run({ inbox, data, now: NOW });
    expect(summary.counts).toMatchObject({ needs_review: 3, refused: 1 });
    const lines = await readFile(join(data, "reviews", `${PLACE}.ndjson`), "utf8");
    expect(JSON.parse(lines)).toMatchObject({ hidden: "reported" });
    const record = JSON.parse(await readFile(join(data, "places", "za", `${PLACE}.json`), "utf8")) as Place;
    expect(record.rating).toBeNull();
    expect(summary.auto_pr_body).toContain("hidden after reports from 3 contributors");
    expect(summary.review_pr_body).toContain("reported as fake");
  });

  it("refuses a review listed in moderation/removed_reviews.json and writes nothing back (audit run-2 OCDB-07)", async () => {
    const review = join(root, "data-review");
    await put(join(review, "places", "za", `${PLACE}.json`), dumpPlace(place));
    await put(join(data, "moderation", "removed_reviews.json"), {
      reviews: [{ review: id(5).replace(/^fb_/, "rev_"), place: PLACE, removed: "2026-10-30", reason: "personal_details" }],
    });
    await pending(5, "2026-10-29T00:00:00Z", "aaaa", { type: "review", contributor: NEWCOMER, review: { stars: 4, text: "Quiet.", visited: "2026-10" } });
    const summary = await run({ inbox, data, reviewData: review, now: NOW });
    expect(summary.counts).toMatchObject({ refused: 1 });
    expect([...summary.review_files, ...summary.auto_files]).toEqual([]);
  });

  it("moves a record found at another path to the SPEC path", async () => {
    await rm(join(data, "places"), { recursive: true });
    await put(join(data, "places", "oc", `${PLACE}.json`), dumpPlace(place));
    await pending(1, "2026-10-29T00:00:00Z", "aaaa", { type: "report", report: { kind: "closed" } });
    const summary = await run({ inbox, data, now: NOW });
    expect([...summary.auto_files].sort()).toEqual([`places/oc/${PLACE}.json`, `places/za/${PLACE}.json`]);
    expect(await readdir(join(data, "places", "oc"))).toEqual([]);
  });

  it("moves a pending file whose id does not match its file name to refused/, writes no data and carries on", async () => {
    const newPlace = { type: "report", place: null, location: { lat: -36.9, lon: 144.6 }, report: { kind: "new_place" } };
    const bad = { ...item(30, "2026-10-29T01:00:00Z", "aaaa", newPlace), id: "fb_/../../../../outside/01JC0000000000000000000030" };
    await put(join(inbox, "pending", "2026-10-29", `${id(30)}.json`), bad);
    await pending(32, "2026-10-29T02:00:00Z", "bbbb", { type: "check", check: { visited: "2026-10-29", still_there: false } });
    const dataBefore = await snapshot(data);
    const summary = await run({ inbox, data, now: NOW });
    expect(await snapshot(data)).toEqual(dataBefore);
    expect(summary.counts).toMatchObject({ applied: 1, refused: 1 });
    expect(summary.inbox_changed).toBe(true);
    const refused = JSON.parse(await readFile(join(inbox, "refused", "2026-10-29", `${id(30)}.json`), "utf8"));
    expect(refused.outcome).toMatchObject({ result: "refused", reason: expect.stringMatching(/id does not match the file name/) });
    expect(await readdir(join(inbox, "applied", "2026-10-29"))).toEqual([`${id(32)}.json`]);
    expect(Object.keys(await snapshot(root)).every((p) => p.startsWith("inbox/") || p.startsWith("data/"))).toBe(true);
  });

  it("moves a pending file whose received time is not ISO 8601, or that is not JSON, to refused/", async () => {
    await put(join(inbox, "pending", "2026-10-29", `${id(31)}.json`), item(31, "../../x", "aaaa", { type: "check", check: { visited: "2026-10-29", still_there: true } }));
    await put(join(inbox, "pending", "2026-10-29", `${id(33)}.json`), "{not json");
    const summary = await run({ inbox, data, now: NOW });
    expect(summary.counts.refused).toBe(2);
    expect((await readdir(join(inbox, "refused", "2026-10-29"))).sort()).toEqual([`${id(31)}.json`, `${id(33)}.json`]);
    const notJson = JSON.parse(await readFile(join(inbox, "refused", "2026-10-29", `${id(33)}.json`), "utf8"));
    expect(notJson).toMatchObject({ raw: "{not json", outcome: { result: "refused" } });
    const badTime = JSON.parse(await readFile(join(inbox, "refused", "2026-10-29", `${id(31)}.json`), "utf8"));
    expect(badTime.outcome.reason).toMatch(/received is not an ISO 8601 UTC time/);
  });

  it("skips and logs a malformed file in applied/ history", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bad = { ...item(34, "2026-10-28T01:00:00Z", "aaaa", { type: "report", report: { kind: "closed" } }), id: "fb_x" };
      await put(join(inbox, "applied", "2026-10-28", `${id(34)}.json`), bad);
      await pending(35, "2026-10-29T01:00:00Z", "bbbb", { type: "report", report: { kind: "closed" } });
      const summary = await run({ inbox, data, now: NOW });
      expect(summary.counts.applied).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(join("applied", "2026-10-28", `${id(34)}.json`)));
    } finally {
      warn.mockRestore();
    }
  });

  it("reads the intake's decision from the inbox file and keeps it when it moves the item", async () => {
    const day = "2026-10-29";
    const attested = { type: "report", contributor: NEWCOMER, attested: "play_integrity", report: { kind: "fact", fact: "power", value: true } };
    await pending(40, `${day}T01:00:00Z`, "aaaa", { ...attested, intake: { state: "held", held_reason: "ai_check" } });
    const summary = await run({ inbox, data, now: NOW });
    expect(summary.counts).toMatchObject({ applied: 0, needs_review: 1 });
    // For a person, not refused: it says nothing against its contributor.
    expect(summary.not_applied).toEqual([id(40)]);
    expect(summary.refused).toEqual([]);
    expect(summary.auto_changed).toBe(false);
    const moved = JSON.parse(await readFile(join(inbox, "applied", day, `${id(40)}.json`), "utf8")) as Record<string, unknown>;
    expect(moved).toMatchObject({ intake: { state: "held", held_reason: "ai_check" }, outcome: { result: "needs_review" } });
  });

  it("keeps first_hand on the report of each applied item, so a reader can count first-hand sources", async () => {
    const day = "2026-10-29";
    await pending(41, `${day}T01:00:00Z`, "aaaa", { type: "report", report: { kind: "fact", fact: "power", value: true, first_hand: "seen_nearby" } });
    await pending(42, `${day}T02:00:00Z`, "bbbb", { type: "report", report: { kind: "fact", fact: "power", value: true, first_hand: "says_so" } });
    const summary = await run({ inbox, data, now: NOW });
    expect(summary.counts.applied).toBe(2);
    const applied = async (n: number) => JSON.parse(await readFile(join(inbox, "applied", day, `${id(n)}.json`), "utf8")) as Record<string, unknown>;
    expect(await applied(41)).toMatchObject({ report: { kind: "fact", fact: "power", value: true, first_hand: "seen_nearby" }, outcome: { result: "applied" } });
    expect(await applied(42)).toMatchObject({ report: { first_hand: "says_so" }, outcome: { result: "applied" } });
  });

  it("refuses an inbox item whose first_hand is not one of its values", async () => {
    const day = "2026-10-29";
    await pending(43, `${day}T01:00:00Z`, "aaaa", { type: "report", report: { kind: "fact", fact: "power", value: true, first_hand: "-36.85,144.55" } });
    const summary = await run({ inbox, data, now: NOW });
    expect(summary.counts).toMatchObject({ applied: 0, refused: 1 });
    const refused = JSON.parse(await readFile(join(inbox, "refused", day, `${id(43)}.json`), "utf8"));
    expect(refused.outcome.reason).toMatch(/report\.first_hand must be seen_nearby or says_so/);
  });

  it("skips and logs a pending item whose id is already in applied/ or refused/, so it is never decided twice", async () => {
    const day = "2026-10-29";
    const power = { type: "report", report: { kind: "fact", fact: "power", value: true } };
    await pending(50, `${day}T01:00:00Z`, "aaaa", power);
    await pending(51, `${day}T01:00:00Z`, "bbbb", power);
    await pending(52, `${day}T01:00:00Z`, "cccc", { type: "report", report: { kind: "closed" } });
    // Copies written again after an earlier run moved them.
    await put(join(inbox, "applied", "2026-10-28", `${id(50)}.json`), { ...item(50, `${day}T01:00:00Z`, "aaaa", power), outcome: { result: "applied" } });
    await put(join(inbox, "refused", day, `${id(51)}.json`), { ...item(51, `${day}T01:00:00Z`, "bbbb", power), outcome: { result: "refused" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const summary = await run({ inbox, data, now: NOW });
      expect(summary.counts.waiting + summary.counts.applied + summary.counts.refused + summary.counts.needs_review).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${id(50)} was decided already`));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${id(51)} was decided already`));
    } finally {
      warn.mockRestore();
    }
    // The earlier decisions are left as they were.
    const applied = JSON.parse(await readFile(join(inbox, "applied", "2026-10-28", `${id(50)}.json`), "utf8")) as { outcome: { result: string } };
    expect(applied.outcome.result).toBe("applied");
  });

  it("does nothing when the inbox is empty", async () => {
    const summary = await run({ inbox, data, now: NOW });
    expect(summary).toMatchObject({
      auto_changed: false,
      review_changed: false,
      inbox_changed: false,
      auto_pr_body: "",
      review_pr_body: "",
    });
  });
});
