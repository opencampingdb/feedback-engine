#!/usr/bin/env node
/**
 * Integration check against the data repository. Not part of CI.
 *
 * 1. Copies the data repository's pipeline and schema to a temporary folder,
 *    builds place records from its OSM test fixtures with pipeline.extract and
 *    pipeline.sync, and checks them with pipeline.validate.
 * 2. Writes a set of inbox submissions covering every rule.
 * 3. Runs apply with separate automatic and review checkouts, then runs
 *    pipeline.validate on both. Every file apply writes must pass.
 * 4. Owner flow: a claim and a listing go to review, a ticked and merged
 *    review PR approves them, and an owner update follows. Validates both
 *    checkouts again. Proof pages are never fetched: a fake check finds the code.
 * 5. Runs apply a second time and checks that nothing changes.
 *
 * Usage (from the feedback-engine root, after `npm run build`):
 *   node packages/apply/scripts/integration-check.mjs [--data-repo ../data] [--data-ref owners] [--python python]
 *
 * --data-ref reads pipeline/ and schema/ from that commit or branch with
 * `git archive`, which leaves the data repository's working tree alone.
 *
 * The Python must have the data repository's requirements.txt installed
 * (osmium and jsonschema). Exits 0 when every check passes.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(here, "../../..");
const { values } = parseArgs({
  options: {
    "data-repo": { type: "string", default: resolve(engineRoot, "../data") },
    "data-ref": { type: "string" },
    python: { type: "string", default: process.env.PYTHON ?? "python" },
    keep: { type: "boolean", default: false },
  },
});
let dataRepo = resolve(values["data-repo"]);
const python = values.python;
const { run } = await import(new URL("../dist/run.js", import.meta.url).href);

let failures = 0;
const say = (text) => console.log(text);
function check(ok, label) {
  say(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures += 1;
}

function py(args, cwd) {
  const result = spawnSync(python, args, { cwd, encoding: "utf8" });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

async function snapshot(dir) {
  const out = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[relative(dir, full).split(sep).join("/")] = await readFile(full, "utf8");
  }
  return out;
}

async function copyData(to) {
  await mkdir(to, { recursive: true });
  for (const name of ["pipeline", "schema"]) {
    await cp(join(dataRepo, name), join(to, name), {
      recursive: true,
      filter: (src) => !src.includes("__pycache__") && !src.includes(".pytest_cache"),
    });
  }
  await mkdir(join(to, "places"), { recursive: true });
  await mkdir(join(to, "reviews"), { recursive: true });
}

const root = await mkdtemp(join(tmpdir(), "ocdb-integration-"));
say(`Data repository: ${dataRepo}${values["data-ref"] ? ` at ${values["data-ref"]}` : ""}`);
say(`Working folder:  ${root}`);

// Never fetch a real proof page from a test run.
const checkProof = async (url, code) => ({ found: true, checked: new Date().toISOString(), detail: `code ${code} found at ${url}` });

try {
  if (values["data-ref"]) {
    const exported = join(root, "data-export");
    await mkdir(exported, { recursive: true });
    const tarFile = join(root, "data.tar");
    const archive = spawnSync("git", ["-C", dataRepo, "archive", "--format=tar", "-o", tarFile, values["data-ref"], "pipeline", "schema"], { encoding: "utf8" });
    if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
    // Relative paths: GNU tar reads "C:" in a Windows path as a remote host.
    const untar = spawnSync("tar", ["-xf", "data.tar", "-C", "data-export"], { cwd: root, encoding: "utf8" });
    if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
    const commit = spawnSync("git", ["-C", dataRepo, "rev-parse", "--short", values["data-ref"]], { encoding: "utf8" });
    say(`Exported pipeline and schema from ${values["data-ref"]} (${commit.stdout.trim()})`);
    dataRepo = exported;
  }
  // 1. Place records from the fixtures.
  const base = join(root, "data-base");
  await copyData(base);
  const fixtures = join(dataRepo, "pipeline", "tests", "fixtures");
  const fixture = (await readdir(fixtures)).includes("grampians-overpass.osm") ? "grampians-overpass.osm" : "v1.osm";
  const extract = py(["-m", "pipeline.extract", join(fixtures, fixture), "--out", join(root, "extract.ndjson")], base);
  check(extract.code === 0, `pipeline.extract on ${fixture}`);
  if (extract.code !== 0) throw new Error(extract.out);
  const sync = py(["-m", "pipeline.sync", join(root, "extract.ndjson"), "--root", ".", "--report", join(root, "sync.md")], base);
  check(sync.code === 0, "pipeline.sync builds place records");
  if (sync.code !== 0) throw new Error(sync.out);
  const baseline = py(["-m", "pipeline.validate", "--root", "."], base);
  check(baseline.code === 0, "pipeline.validate on the fixture records");
  if (baseline.code !== 0) throw new Error(baseline.out);

  const records = [];
  for (const [path, text] of Object.entries(await snapshot(join(base, "places")))) {
    if (path.endsWith(".json")) records.push(JSON.parse(text));
  }
  records.sort((a, b) => (a.id < b.id ? -1 : 1));
  check(records.length >= 3, `${records.length} place records to work with`);
  const [first, second, third] = records;

  // 2. Inbox submissions.
  const inbox = join(root, "inbox");
  const day = "2026-10-29";
  let n = 0;
  async function submit(device, place, body, minute) {
    n += 1;
    const id = `fb_01JC${String(n).padStart(22, "0")}`;
    const received = `${day}T00:${String(minute).padStart(2, "0")}:00Z`;
    const item = { id, received, app: "camporacle", place, device, app_version: "1.0.0", consent: true, ...body };
    await mkdir(join(inbox, "pending", day), { recursive: true });
    await writeFile(join(inbox, "pending", day, `${id}.json`), `${JSON.stringify(item, null, 2)}\n`);
    return id;
  }
  const flip = first.facts.power === true ? false : true;
  await submit("dev0000000000001", first.id, { type: "report", report: { kind: "fact", fact: "power", value: flip } }, 1);
  await submit("dev0000000000002", first.id, { type: "report", report: { kind: "fact", fact: "power", value: flip } }, 2);
  await submit("dev0000000000003", first.id, { type: "report", report: { kind: "fact", fact: "entry", value: "customers" } }, 3);
  await submit("dev0000000000004", first.id, { type: "report", report: { kind: "fact", fact: "entry", value: "customers" } }, 4);
  await submit("dev0000000000005", second.id, { type: "report", report: { kind: "closed" } }, 5);
  await submit("dev0000000000006", second.id, { type: "check", check: { visited: "2026-10-28", still_there: false } }, 6);
  await submit("dev0000000000007", third.id, { type: "report", report: { kind: "closed" } }, 7);
  await submit("dev0000000000008", first.id, { type: "review", review: { stars: 4, text: "Flat sites, clean toilets.", visited: "2026-10" } }, 8);
  await submit("dev0000000000009", first.id, { type: "review", review: { stars: 5, text: "Stayed 2026-10-12, quiet and shady.", visited: "2026-10" } }, 9);
  await submit("dev0000000000010", first.id, { type: "review", review: { stars: 1, text: "Email me on jo@example.com", visited: "2026-10" } }, 10);
  await submit("dev0000000000011", null, { type: "report", location: { lat: -37.2, lon: 142.4 }, report: { kind: "new_place", note: "Free camp by the creek" } }, 11);
  await submit("dev0000000000012", third.id, { type: "report", location: { lat: -37.123456, lon: 142.654321 }, report: { kind: "wrong_location" } }, 12);
  await submit("dev0000000000013", second.id, { type: "report", report: { kind: "fact", fact: "website", value: "https://example.org/camp" } }, 13);
  await submit("dev0000000000014", third.id, { type: "report", report: { kind: "other", note: "Gate is locked after dark" } }, 14);
  await submit("dev0000000000015", third.id, { type: "report", report: { kind: "fact", fact: "fee", value: true } }, 15);

  // 3. Apply, then validate both checkouts.
  const auto = join(root, "data-auto");
  const review = join(root, "data-review");
  await cp(base, auto, { recursive: true });
  await cp(base, review, { recursive: true });
  const summary = await run({ inbox, data: auto, reviewData: review, now: new Date("2026-10-30T00:00:00Z"), checkProof });
  say(`\napply: ${JSON.stringify(summary.counts)}`);
  say(`automatic files: ${summary.auto_files.join(", ") || "(none)"}`);
  say(`review files:    ${summary.review_files.join(", ") || "(none)"}\n`);
  check(summary.auto_changed && summary.review_changed, "apply changed both checkouts");

  for (const [name, dir] of [["automatic", auto], ["review", review]]) {
    const result = py(["-m", "pipeline.validate", "--root", "."], dir);
    check(result.code === 0, `pipeline.validate on the ${name} checkout`);
    say(result.out.split("\n").map((l) => `      ${l}`).join("\n"));
  }

  // 4. Owners: a claim and a listing, approved by merging the review PR, then an update.
  const token = "q2Vb7Rk1cW9yZ3hVdm5Pb2pQTlR4Y0FyZ0lCd2pUcEs";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const owner = { name: "Sam Owner", email: "sam@example.com" };
  async function submitOwner(body, minute) {
    n += 1;
    const id = `fb_01JC${String(n).padStart(22, "0")}`;
    const item = { id, received: `${day}T01:${String(minute).padStart(2, "0")}:00Z`, app: "owner-page", device: "owner0000000001", app_version: "1.0.0", terms_accepted: true, ...body };
    await mkdir(join(inbox, "pending", day), { recursive: true });
    await writeFile(join(inbox, "pending", day, `${id}.json`), `${JSON.stringify(item, null, 2)}\n`);
    return id;
  }
  await submitOwner({ type: "owner_claim", place: first.id, owner, claim: { proof_url: "https://riverbend.example/about" }, code: "OCDB-7KQ2", token_sha256: tokenHash }, 1);
  const listingId = await submitOwner({
    type: "owner_listing",
    place: null,
    location: { lat: -37.3, lon: 142.3 },
    owner,
    claim: { proof_url: "https://farm.example/stay" },
    listing: { name: "Riverbend Farm Stay", description: "Six grassy sites on a working sheep farm.", facts: { booking_url: "https://farm.example/book", toilets: true } },
    code: "OCDB-AB12",
    token_sha256: tokenHash,
  }, 2);
  const sent = await run({ inbox, data: auto, reviewData: review, now: new Date("2026-10-30T02:00:00Z"), checkProof });
  check(sent.owner_claims && sent.counts.awaiting_approval === 2, "owner claim and listing sent to the review PR");
  check(!sent.review_pr_body.includes("sam@example.com") && !sent.review_pr_body.includes("Sam Owner"), "the review PR holds no owner name or email");
  const merged = { number: 1, state: "MERGED", body: sent.review_pr_body.replace(/^- \[ \] Approve owner/gm, "- [x] Approve owner"), comments: [] };
  const approved = await run({ inbox, data: auto, reviewData: review, now: new Date("2026-10-30T03:00:00Z"), checkProof, reviewPrs: [merged] });
  check(approved.auto_changed, "approval writes owner_verified and the farm stay");
  await submitOwner({ type: "owner_update", place: first.id, token_sha256: tokenHash, update: {
    facts: { power: true, booking_url: "https://riverbend.example/book" },
    description: "Shady sites by the river, visited 2026-10.",
    status: "temporarily_closed",
    reopens: "2026-12-01",
  } }, 3);
  const updated = await run({ inbox, data: auto, reviewData: review, now: new Date("2026-10-30T04:00:00Z"), checkProof });
  check(updated.counts.applied === 1, "owner update applied");
  const farmId = `ocdb_${listingId.slice(3)}`;
  say(`owner files: ${[...approved.auto_files, ...updated.auto_files].join(", ")} (farm stay ${farmId})`);
  for (const [name, dir] of [["automatic", auto], ["review", review]]) {
    const result = py(["-m", "pipeline.validate", "--root", "."], dir);
    check(result.code === 0, `pipeline.validate on the ${name} checkout after the owner flow`);
    say(result.out.split("\n").map((l) => `      ${l}`).join("\n"));
  }

  // 5. A second run with no new inbox files changes nothing.
  const before = { auto: await snapshot(auto), review: await snapshot(review), inbox: await snapshot(inbox) };
  const again = await run({ inbox, data: auto, reviewData: review, now: new Date("2026-10-30T05:00:00Z"), checkProof, reviewPrs: [merged] });
  const after = { auto: await snapshot(auto), review: await snapshot(review), inbox: await snapshot(inbox) };
  check(
    !again.auto_changed && !again.review_changed && !again.inbox_changed && JSON.stringify(before) === JSON.stringify(after),
    "a second run changes nothing",
  );
} catch (error) {
  failures += 1;
  say(`\nStopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (!values.keep) await rm(root, { recursive: true, force: true });
}

say(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
