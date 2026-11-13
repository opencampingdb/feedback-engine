import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/run.js";
import { dumpPlace, placePath } from "../src/serialise.js";
import type { Place } from "../src/types.js";

// A run that published its automatic changes and then stopped before it recorded its inbox moves.
const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZB";
const place = {
  id: PLACE,
  name: "Example Camp",
  kind: "free_camp",
  group: "overnight",
  location: { lat: -35.1, lon: 143.2 },
  osm: null,
  facts: { showers: true, website: "https://camp.example/" },
  status: "open",
  rating: null,
  fact_sources: { showers: "feedback", website: "feedback" },
  fact_dates: { showers: "2026-05-01T00:00:00Z", website: "2026-05-01T00:00:00Z" },
  updated: "2026-05-01T00:00:00Z",
} as unknown as Place;
const DAY = "2026-11-01";
const id = (n: number) => `fb_01JD${String(n).padStart(22, "0")}`;
const item = (n: number, device: string, extra: Record<string, unknown>) => ({
  id: id(n), received: `${DAY}T0${n}:00:00Z`, app: "example-app", place: PLACE, device, app_version: "1.0.0", consent: true, ...extra,
});
const items = [
  item(1, "dev-1", { type: "report", report: { kind: "doubt", fact: "showers" } }),
  item(2, "dev-2", { type: "report", report: { kind: "doubt", fact: "showers" }, attested: "app_attest", contributor: "ctr_0000000000000002" }),
  item(3, "dev-3", { type: "report", report: { kind: "contact", fact: "website", reason: "wrong" } }),
  item(4, "dev-4", { type: "report", report: { kind: "contact", fact: "website", reason: "wrong" }, attested: "app_attest", contributor: "ctr_0000000000000004" }),
];

let root: string;
let inbox: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitAll = (cwd: string, message: string) => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.name=example-bot", "-c", "user.email=bot@example.org", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message);
};

async function put(path: string, body: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`);
}
async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) if (e.isFile()) out.push(relative(dir, join(e.parentPath, e.name)).split(sep).join("/"));
  return out.sort();
}
const heldLines = (body: string) => body.split("\n").filter((l) => l.startsWith("- held-case "));
const outcomes = (s: Awaited<ReturnType<typeof run>>) => s.decisions.map((d) => [d.id, d.outcome, d.reason]);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocdb-rerun-"));
  inbox = join(root, "inbox");
  // data main, with history.
  const main = join(root, "main");
  await put(join(main, placePath(PLACE)), dumpPlace(place));
  git(root, "init", "-q", "-b", "main", main);
  commitAll(main, "data");
  for (const i of items) await put(join(inbox, "pending", DAY, `${i.id}.json`), i);
  await cp(inbox, join(root, "inbox-before"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The first run, on a clone of main that becomes feedback/auto, with its automatic changes committed and its inbox moves lost. */
async function firstRun() {
  const auto = join(root, "auto1");
  git(root, "clone", "-q", join(root, "main"), auto);
  const review = join(root, "review1");
  await cp(join(root, "main"), review, { recursive: true });
  const first = await run({ inbox, data: auto, reviewData: review, now: new Date("2026-11-02T00:10:00Z") });
  commitAll(auto, "Apply feedback automatically (run 1)");
  await rm(inbox, { recursive: true, force: true });
  await cp(join(root, "inbox-before"), inbox, { recursive: true });
  return { first, auto };
}

async function secondRun(data: string) {
  const review = join(root, "review2");
  await cp(data, review, { recursive: true });
  return run({ inbox, data, reviewData: review, now: new Date("2026-11-02T01:10:00Z") });
}

describe("a run repeated after its automatic changes were published", () => {
  it("decides the takedowns it already wrote as applied again, with the same cases, while the automatic PR is open", async () => {
    const { first, auto } = await firstRun();
    expect(first.refused).toEqual([]);
    const second = await secondRun(auto);
    expect(outcomes(second)).toEqual(outcomes(first));
    expect(second.refused).toEqual([]);
    expect(second.auto_changed).toBe(false);
    expect(heldLines(second.review_pr_body)).toEqual(heldLines(first.review_pr_body));
    expect(heldLines(second.review_pr_body)).toHaveLength(2);
    const applied = await files(join(inbox, "applied"));
    expect(applied).toHaveLength(4);
    const kept = await Promise.all(applied.map(async (f) => JSON.parse(await readFile(join(inbox, "applied", f), "utf8")).outcome.doubted));
    expect(kept.filter(Boolean)).toEqual([{ fact: "showers", value: true, at: `${DAY}T02:00:00Z` }]);
  });

  it("does the same once the automatic PR was squash-merged into main", async () => {
    const { auto } = await firstRun();
    const main = join(root, "main");
    await cp(join(auto, "places"), join(main, "places"), { recursive: true });
    commitAll(main, "Feedback: automatic changes (#7)");
    const data = join(root, "auto2");
    git(root, "clone", "-q", main, data);
    const second = await secondRun(data);
    expect(second.refused).toEqual([]);
    expect(second.counts.applied).toBe(4);
    expect(heldLines(second.review_pr_body)).toHaveLength(2);
  });

  it("still refuses a doubt about a fact the data never had", async () => {
    const data = join(root, "auto2");
    git(root, "clone", "-q", join(root, "main"), data);
    await rm(join(inbox, "pending"), { recursive: true });
    await put(join(inbox, "pending", DAY, `${id(5)}.json`), item(5, "dev-5", { type: "report", report: { kind: "doubt", fact: "toilets" } }));
    await put(join(inbox, "pending", DAY, `${id(6)}.json`), item(6, "dev-6", { type: "report", report: { kind: "doubt", fact: "toilets" }, attested: "app_attest", contributor: "ctr_0000000000000006" }));
    const out = await secondRun(data);
    expect(out.refused).toEqual([id(5), id(6)]);
  });
});
