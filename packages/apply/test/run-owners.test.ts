import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewPr } from "../src/owners.js";
import type { ProofResult } from "../src/proof.js";
import { run } from "../src/run.js";
import { dumpPlace, placePath } from "../src/serialise.js";
import type { Place } from "../src/types.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const TOKEN = "q2Vb7Rk1cW9yZ3hVdm5Pb2pQTlR4Y0FyZ0lCd2pUcEs";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const NOW = new Date("2026-10-31T09:00:00Z");
const LATER = new Date("2026-10-31T10:00:00Z");

const place: Place = {
  id: PLACE,
  name: "Riverbend Camp",
  kind: "paid_campground",
  group: "overnight",
  location: { lat: -36.85, lon: 144.55 },
  osm: { type: "node", id: 1, version: 1 },
  facts: { power: false },
  status: "open",
  rating: null,
  fact_sources: { power: "osm" },
  updated: "2026-06-01T00:00:00Z",
};

let root: string;
let inbox: string;
let data: string;
let review: string;

async function put(path: string, body: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}

const id = (n: number) => `fb_01JC${String(n).padStart(22, "0")}`;
const owner = { name: "Sam Owner", email: "sam@example.com" };

async function pending(n: number, body: Record<string, unknown>) {
  const item = { id: id(n), received: "2026-10-31T08:00:00Z", app: "owner-page", device: "aaaa", app_version: "1.0.0", terms_accepted: true, ...body };
  await put(join(inbox, "pending", "2026-10-31", `${id(n)}.json`), item);
}

const claim = (n: number) =>
  pending(n, {
    type: "owner_claim",
    place: PLACE,
    owner,
    claim: { proof_url: "https://riverbend.example/about" },
    code: "OCDB-7KQ2",
    token_sha256: sha(TOKEN),
  });

const proofCalls: string[] = [];
const checkProof = async (url: string, code: string): Promise<ProofResult> => {
  proofCalls.push(`${url} ${code}`);
  return { found: true, checked: NOW.toISOString(), detail: `code found at ${url}` };
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocdb-owners-"));
  inbox = join(root, "inbox");
  data = join(root, "data");
  review = join(root, "data-review");
  for (const dir of [data, review]) {
    await put(join(dir, placePath(PLACE)), dumpPlace(place));
    await put(join(dir, "schema", "kinds.json"), {
      kinds: [
        { code: "campground", label: "Campground", group: "overnight" },
        { code: "paid_campground", label: "Paid campground", group: "overnight" },
        { code: "farm_stay", label: "Farm stay", group: "overnight" },
      ],
    });
  }
  proofCalls.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ticked = (body: string, number = 12): ReviewPr => ({
  number,
  state: "MERGED",
  body: body.replace(/^- \[ \] Approve owner/gm, "- [x] Approve owner"),
  comments: [],
  author: { login: "app/opencampingdb-bot" },
  isCrossRepository: false,
});

describe("owner claims end to end", () => {
  it("sends a claim to the review PR, then approves it once the ticked PR is merged", async () => {
    await claim(1);
    const first = await run({ inbox, data, reviewData: review, now: NOW, checkProof });
    expect(proofCalls).toEqual(["https://riverbend.example/about OCDB-7KQ2"]);
    expect(first.owner_claims).toBe(true);
    expect(first.review_changed).toBe(true);
    expect(first.auto_changed).toBe(false);
    expect(first.review_pr_body).toContain(`- [ ] Approve owner claim ${id(1)}:`);
    expect(first.review_pr_body).toContain("OCDB-7KQ2");
    expect(first.review_pr_body).not.toContain("sam@example.com");
    expect(first.review_pr_body).not.toContain("Sam Owner");
    expect(await readdir(join(inbox, "owner-claims"))).toEqual([`${id(1)}.json`]);
    expect(JSON.parse(await readFile(join(data, placePath(PLACE)), "utf8")).owner_verified).toBeUndefined();

    // A person ticks the box and merges.
    const second = await run({
      inbox,
      data,
      reviewData: review,
      now: LATER,
      checkProof,
      reviewPrs: [ticked(first.review_pr_body)],
      botLogins: ["opencampingdb-bot"],
    });
    expect(second.auto_changed).toBe(true);
    expect(second.inbox_changed).toBe(true);
    expect(second.auto_pr_body).toContain(`owner claim ${id(1)} approved on review PR #12`);
    const record = JSON.parse(await readFile(join(data, placePath(PLACE)), "utf8")) as Place;
    expect(record.owner_verified).toBe(true);
    expect(JSON.parse(await readFile(join(inbox, "owners", `${PLACE}.json`), "utf8"))).toEqual({
      place: PLACE,
      claim: id(1),
      token_sha256: sha(TOKEN),
      approved: "2026-10-31",
      email: "sam@example.com",
      name: "Sam Owner",
    });
    expect(await readdir(join(inbox, "owner-claims"))).toEqual([]);
    expect(await readdir(join(inbox, "applied", "2026-10-31"))).toEqual([`${id(1)}.json`]);

    // The owner's update with the token is applied at once.
    await pending(2, { type: "owner_update", place: PLACE, token_sha256: sha(TOKEN), update: { facts: { power: true } } });
    const third = await run({ inbox, data, reviewData: review, now: LATER, checkProof });
    expect(third.counts.applied).toBe(1);
    const updated = JSON.parse(await readFile(join(data, placePath(PLACE)), "utf8")) as Place;
    expect(updated.facts.power).toBe(true);
    expect(updated.fact_sources.power).toBe("owner");
    expect(proofCalls).toHaveLength(1); // updates are never fetched
  });

  it("writes an approved listing as a canonical farm stay record", async () => {
    await pending(3, {
      type: "owner_listing",
      place: null,
      location: { lat: -36.1, lon: 145.2 },
      owner,
      claim: { proof_url: "https://farm.example/stay" },
      listing: { name: "Riverbend Farm Stay", facts: { phone: "0412 345 678" } },
      code: "OCDB-AB12",
      token_sha256: sha(TOKEN),
    });
    const first = await run({ inbox, data, reviewData: review, now: NOW, checkProof });
    expect(first.review_pr_body).toContain(`- [ ] Approve owner listing ${id(3)}:`);
    const second = await run({ inbox, data, reviewData: review, now: LATER, checkProof, reviewPrs: [ticked(first.review_pr_body)], botLogins: ["opencampingdb-bot"] });
    const newId = `ocdb_${id(3).slice(3)}`;
    expect(second.auto_files).toContain(placePath(newId));
    const text = await readFile(join(data, placePath(newId)), "utf8");
    const record = JSON.parse(text) as Place;
    expect(text).toBe(dumpPlace(record));
    expect(record).toMatchObject({ kind: "farm_stay", group: "overnight", osm: null, facts: { entry: "private", booking_required: true } });
    expect(text).toContain('"lat": -36.1,');
  });

  it("carries on with the run when one proof check fails", async () => {
    await claim(5);
    await pending(6, { type: "owner_update", place: PLACE, token_sha256: sha(TOKEN), update: { facts: { power: true } } });
    const failing = async (): Promise<ProofResult> => {
      throw new Error("aborted");
    };
    const summary = await run({ inbox, data, reviewData: review, now: NOW, checkProof: failing });
    expect(summary.counts).toMatchObject({ waiting: 1, refused: 1 });
    expect(await readdir(join(inbox, "pending", "2026-10-31"))).toEqual([`${id(5)}.json`]);
  });

  it("checks the oldest claims first and leaves the rest waiting when the proof budget runs out", async () => {
    const body = { type: "owner_claim", place: PLACE, owner, code: "OCDB-7KQ2", token_sha256: sha(TOKEN) };
    await pending(7, { ...body, received: "2026-10-31T08:30:00Z", claim: { proof_url: "https://b.example/" } });
    await pending(8, { ...body, received: "2026-10-30T08:00:00Z", claim: { proof_url: "https://a.example/" } });
    await pending(9, { ...body, received: "2026-10-31T08:45:00Z", claim: { proof_url: "https://c.example/" } });
    const slow = async (url: string, code: string): Promise<ProofResult> => {
      await new Promise((r) => setTimeout(r, 50));
      return checkProof(url, code);
    };
    const summary = await run({ inbox, data, reviewData: review, now: NOW, checkProof: slow, proofBudget: { ms: 20, concurrency: 1 } });
    expect(proofCalls).toEqual(["https://a.example/ OCDB-7KQ2"]);
    expect(summary.counts).toMatchObject({ awaiting_approval: 1, waiting: 2 });
    expect(await readdir(join(inbox, "owner-claims"))).toEqual([`${id(8)}.json`]);
  });

  it("does not fetch the proof page for a claim on a missing place or one past the wait", async () => {
    await pending(10, {
      type: "owner_claim",
      place: "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB",
      owner,
      claim: { proof_url: "https://gone.example/" },
      code: "OCDB-7KQ2",
      token_sha256: sha(TOKEN),
    });
    await pending(11, {
      type: "owner_claim",
      place: PLACE,
      received: "2026-10-23T08:00:00Z",
      owner,
      claim: { proof_url: "https://old.example/" },
      code: "OCDB-7KQ2",
      token_sha256: sha(TOKEN),
    });
    const summary = await run({ inbox, data, reviewData: review, now: NOW, checkProof });
    expect(proofCalls).toEqual([]);
    expect(summary.counts).toMatchObject({ refused: 1, awaiting_approval: 1 });
    expect(summary.review_pr_body).toContain("NOT found");
  });

  it("shows in the review PR where the code was found, and flags a different site", async () => {
    await claim(12);
    const redirected = async (url: string, code: string): Promise<ProofResult> => {
      proofCalls.push(`${url} ${code}`);
      return { found: true, checked: NOW.toISOString(), detail: "code found at https://elsewhere.example/page", url: "https://elsewhere.example/page" };
    };
    const summary = await run({ inbox, data, reviewData: review, now: NOW, checkProof: redirected });
    expect(summary.review_pr_body).toContain("found at https://elsewhere.example/page, ON A DIFFERENT SITE from the submitted https://riverbend.example/about");
  });

  it("does not flag a redirect between the www and bare names of one site", async () => {
    await claim(13);
    const www = async (): Promise<ProofResult> => ({
      found: true,
      checked: NOW.toISOString(),
      detail: "code found at https://www.riverbend.example/about",
      url: "https://www.riverbend.example/about",
    });
    const summary = await run({ inbox, data, reviewData: review, now: NOW, checkProof: www });
    expect(summary.review_pr_body).toContain("code OCDB-7KQ2 found at https://www.riverbend.example/about.");
    expect(summary.review_pr_body).not.toContain("DIFFERENT SITE");
  });

  it("skips and logs a malformed file in owner-claims/", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await put(join(inbox, "owner-claims", `${id(14)}.json`), { item: { id: "fb_/../x", received: "2026-10-31T08:00:00Z" }, place: PLACE, sent: NOW.toISOString(), proof: {} });
      await claim(15);
      const summary = await run({ inbox, data, reviewData: review, now: NOW, checkProof });
      expect(summary.counts.awaiting_approval).toBe(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${id(14)}.json`));
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the claim in owner-claims while the PR is open, and changes nothing", async () => {
    await claim(4);
    const first = await run({ inbox, data, reviewData: review, now: NOW, checkProof });
    const open: ReviewPr = { ...ticked(first.review_pr_body), state: "OPEN" };
    const again = await run({ inbox, data, reviewData: review, now: LATER, checkProof, reviewPrs: [open] });
    expect(again).toMatchObject({ auto_changed: false, review_changed: false, inbox_changed: false, owner_claims: false });
    expect(await readdir(join(inbox, "owner-claims"))).toEqual([`${id(4)}.json`]);
  });
});
