import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isOwnerSubmission, type StoredFeedback, type StoredSubmission } from "@opencampingdb/feedback";
import type { AwaitingClaim, OwnerRecord } from "./owners.js";
import type { Decision } from "./rules.js";
import { dumpPlace, dumpReviewLine, placePath, reviewPath } from "./serialise.js";
import type { Place, Review } from "./types.js";

export interface PendingFile {
  path: string;
  /** The `<yyyy-mm-dd>` folder it sits in. */
  day: string;
  item: StoredSubmission;
}

const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const FEEDBACK_FILE = /^fb_[0-9A-HJKMNP-TV-Z]{26}\.json$/;
const FEEDBACK_ID = /^fb_[0-9A-HJKMNP-TV-Z]{26}$/;
const RECEIVED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Why `item` cannot be used, or undefined when it has a feedback id (equal to
 * `expectedId` when given) and an ISO 8601 UTC `received`.
 */
function storedProblem(item: StoredSubmission, expectedId?: string): string | undefined {
  if (typeof item !== "object" || item === null) return "the file is not a JSON object";
  if (typeof item.id !== "string" || !FEEDBACK_ID.test(item.id) || (expectedId !== undefined && item.id !== expectedId)) {
    return "id does not match the file name";
  }
  if (typeof item.received !== "string" || !RECEIVED.test(item.received) || Number.isNaN(Date.parse(item.received))) {
    return "received is not an ISO 8601 UTC time";
  }
  return undefined;
}

/** A file in a day folder whose content cannot be used. `day` and `name` come from the checked folder and file names. */
export interface MalformedFile {
  path: string;
  day: string;
  name: string;
  raw: string;
  reason: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function dayFolders(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && DAY_FOLDER.test(e.name)).map((e) => e.name).sort();
}

async function readFeedbackFolder(root: string, day: string): Promise<{ files: PendingFile[]; malformed: MalformedFile[] }> {
  const folder = join(root, day);
  const files: PendingFile[] = [];
  const malformed: MalformedFile[] = [];
  for (const name of (await readdir(folder)).sort()) {
    if (!FEEDBACK_FILE.test(name)) continue;
    const path = join(folder, name);
    const raw = await readFile(path, "utf8");
    let item: StoredSubmission;
    try {
      item = JSON.parse(raw) as StoredSubmission;
    } catch {
      malformed.push({ path, day, name, raw, reason: "the file is not valid JSON" });
      continue;
    }
    const problem = storedProblem(item, name.slice(0, -5));
    if (problem) malformed.push({ path, day, name, raw, reason: problem });
    else files.push({ path, day, item });
  }
  return { files, malformed };
}

/** Every file in `pending/`. Files whose content cannot be used are returned apart, for `refuseMalformed`. */
export async function readPending(inbox: string): Promise<{ files: PendingFile[]; malformed: MalformedFile[] }> {
  const root = join(inbox, "pending");
  const files: PendingFile[] = [];
  const malformed: MalformedFile[] = [];
  for (const day of await dayFolders(root)) {
    const read = await readFeedbackFolder(root, day);
    files.push(...read.files);
    malformed.push(...read.malformed);
  }
  return { files, malformed };
}

/** Moves pending files whose content cannot be used to `refused/<day>/<file name>`, with the reason. */
export async function refuseMalformed(inbox: string, malformed: readonly MalformedFile[], runAt: string): Promise<number> {
  for (const file of malformed) {
    const target = join(inbox, "refused", file.day, file.name);
    await mkdir(dirname(target), { recursive: true });
    const outcome = { result: "refused", reason: `the inbox file could not be used: ${file.reason}`, run: runAt };
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.raw);
    } catch {
      parsed = undefined;
    }
    const isObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    const body = isObject ? { ...(parsed as Record<string, unknown>), outcome } : { raw: file.raw, outcome };
    await writeFile(target, `${JSON.stringify(body, null, 2)}\n`, "utf8");
    await rm(file.path);
  }
  return malformed.length;
}

/** Items in `applied/` from day folders on or after `sinceDay`, as evidence for the rules. */
export async function readHistory(inbox: string, sinceDay: string): Promise<StoredFeedback[]> {
  const root = join(inbox, "applied");
  const out: StoredFeedback[] = [];
  for (const day of await dayFolders(root)) {
    if (day < sinceDay) continue;
    const read = await readFeedbackFolder(root, day);
    for (const bad of read.malformed) console.warn(`skipping ${bad.path}: ${bad.reason}`);
    for (const file of read.files) {
      if (!isOwnerSubmission(file.item)) out.push(file.item as StoredFeedback);
    }
  }
  return out;
}

const PLACE_FILE = /^ocdb_[0-9A-HJKMNP-TV-Z]{26}\.json$/;

async function readJsonFolder<T>(folder: string, name: RegExp): Promise<T[]> {
  if (!(await exists(folder))) return [];
  const out: T[] = [];
  for (const file of (await readdir(folder)).sort()) {
    if (name.test(file)) out.push(JSON.parse(await readFile(join(folder, file), "utf8")) as T);
  }
  return out;
}

/** Approved owners: `owners/<place id>.json`. */
export async function readOwners(inbox: string): Promise<Map<string, OwnerRecord>> {
  const records = await readJsonFolder<OwnerRecord>(join(inbox, "owners"), PLACE_FILE);
  return new Map(records.map((r) => [r.place, r]));
}

/** Writes owner records, replacing any earlier owner of the same place. */
export async function writeOwners(inbox: string, owners: Iterable<OwnerRecord>): Promise<number> {
  let written = 0;
  for (const owner of owners) {
    await mkdir(join(inbox, "owners"), { recursive: true });
    await writeFile(join(inbox, "owners", `${owner.place}.json`), `${JSON.stringify(owner, null, 2)}\n`, "utf8");
    written += 1;
  }
  return written;
}

/** Claims and listings waiting for a person: `owner-claims/<claim id>.json`. */
export async function readAwaiting(inbox: string): Promise<AwaitingClaim[]> {
  const folder = join(inbox, "owner-claims");
  const out: AwaitingClaim[] = [];
  if (!(await exists(folder))) return out;
  for (const name of (await readdir(folder)).sort()) {
    if (!FEEDBACK_FILE.test(name)) continue;
    const path = join(folder, name);
    let problem: string | undefined;
    let waiting: AwaitingClaim | undefined;
    try {
      waiting = JSON.parse(await readFile(path, "utf8")) as AwaitingClaim;
      problem = storedProblem(waiting?.item as StoredSubmission, name.slice(0, -5));
    } catch {
      problem = "the file is not valid JSON";
    }
    if (problem || !waiting) console.warn(`skipping ${path}: ${problem}`);
    else out.push(waiting);
  }
  return out;
}

/**
 * Moves decided claims out of `owner-claims/` to `applied/` (approved) or
 * `refused/`, in the day folder the claim arrived in, with the outcome.
 */
export async function settleAwaiting(
  inbox: string,
  approvals: readonly { claim: string; outcome: "approved" | "refused"; reason: string }[],
  runAt: string,
): Promise<number> {
  let moved = 0;
  for (const a of approvals) {
    const source = join(inbox, "owner-claims", `${a.claim}.json`);
    if (!(await exists(source))) continue;
    const waiting = JSON.parse(await readFile(source, "utf8")) as AwaitingClaim;
    const folder = a.outcome === "approved" ? "applied" : "refused";
    const target = join(inbox, folder, waiting.item.received.slice(0, 10), `${a.claim}.json`);
    await mkdir(dirname(target), { recursive: true });
    const withOutcome = { ...waiting.item, proof: waiting.proof, outcome: { result: a.outcome, reason: a.reason, run: runAt } };
    await writeFile(target, `${JSON.stringify(withOutcome, null, 2)}\n`, "utf8");
    await rm(source);
    moved += 1;
  }
  return moved;
}

/** Moves each decided pending file to `applied/` or `refused/`, adding the outcome. Waiting files stay. */
export async function moveDecided(
  inbox: string,
  files: readonly PendingFile[],
  decisions: readonly Decision[],
  runAt: string,
  awaiting: readonly AwaitingClaim[] = [],
): Promise<number> {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const waitingFor = new Map(awaiting.map((a) => [a.item.id, a]));
  let moved = 0;
  for (const file of files) {
    const decision = byId.get(file.item.id);
    if (!decision || decision.outcome === "waiting") continue;
    const claim = waitingFor.get(file.item.id);
    if (decision.outcome === "awaiting_approval" && claim) {
      // Waits for a person in owner-claims/, out of the day folders.
      const target = join(inbox, "owner-claims", basename(file.path));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(claim, null, 2)}\n`, "utf8");
      await rm(file.path);
      moved += 1;
      continue;
    }
    const folder = decision.outcome === "refused" ? "refused" : "applied";
    const target = join(inbox, folder, file.day, basename(file.path));
    await mkdir(dirname(target), { recursive: true });
    const withOutcome = { ...file.item, outcome: { result: decision.outcome, reason: decision.reason, run: runAt } };
    await writeFile(target, `${JSON.stringify(withOutcome, null, 2)}\n`, "utf8");
    await rm(file.path);
    moved += 1;
  }
  // Remove day folders left empty in pending/.
  const pendingRoot = join(inbox, "pending");
  for (const day of await dayFolders(pendingRoot)) {
    const folder = join(pendingRoot, day);
    if ((await readdir(folder)).length === 0) await rm(folder, { recursive: true });
  }
  return moved;
}

/** Read access to a checkout of the data repository. */
export class DataRepo {
  #index: Map<string, string> | undefined;

  constructor(readonly root: string) {}

  /** `relativePath` under the checkout, which must stay inside `folder`. */
  #inside(folder: "places" | "reviews", relativePath: string): string {
    const path = join(this.root, relativePath);
    if (!resolve(path).startsWith(resolve(this.root, folder) + sep)) throw new Error(`refusing to write outside ${folder}/: ${relativePath}`);
    return path;
  }

  async #placeIndex(): Promise<Map<string, string>> {
    if (this.#index) return this.#index;
    const index = new Map<string, string>();
    const walk = async (dir: string): Promise<void> => {
      if (!(await exists(dir))) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".json")) index.set(entry.name.slice(0, -5), path);
      }
    };
    await walk(join(this.root, "places"));
    this.#index = index;
    return index;
  }

  /** Kind code to group, from `schema/kinds.json`. Undefined when the file is missing. */
  async kinds(): Promise<Map<string, string> | undefined> {
    const path = join(this.root, "schema", "kinds.json");
    if (!(await exists(path))) return undefined;
    const file = JSON.parse(await readFile(path, "utf8")) as { kinds?: { code: string; group: string }[] };
    return new Map((file.kinds ?? []).map((k) => [k.code, k.group]));
  }

  /** Loads the given place records. Ids with no record are left out. */
  async places(ids: Iterable<string>): Promise<Map<string, Place>> {
    const index = await this.#placeIndex();
    const out = new Map<string, Place>();
    for (const id of new Set(ids)) {
      const path = index.get(id);
      if (path) out.set(id, JSON.parse(await readFile(path, "utf8")) as Place);
    }
    return out;
  }

  async reviews(placeId: string): Promise<Review[]> {
    const path = this.#inside("reviews", reviewPath(placeId));
    if (!(await exists(path))) return [];
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Review);
  }

  /**
   * Writes changed records at the SPEC path. A record found anywhere else is
   * moved there, so the data validator's path check passes.
   */
  async writePlaces(places: Iterable<Place>): Promise<string[]> {
    const index = await this.#placeIndex();
    const written: string[] = [];
    for (const place of places) {
      const path = this.#inside("places", placePath(place.id));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, dumpPlace(place), "utf8");
      const old = index.get(place.id);
      if (old && resolve(old) !== resolve(path)) {
        await rm(old);
        written.push(relative(this.root, old).split(sep).join("/"));
      }
      index.set(place.id, path);
      written.push(placePath(place.id));
    }
    return written;
  }

  /**
   * Adds review lines and rewrites the file with every line sorted by id, LF
   * endings and a trailing newline. Existing lines keep their text.
   */
  async addReviews(placeId: string, reviews: readonly Review[]): Promise<string> {
    const path = this.#inside("reviews", reviewPath(placeId));
    await mkdir(dirname(path), { recursive: true });
    const existing = (await exists(path)) ? (await readFile(path, "utf8")).split(/\r?\n/) : [];
    const entries = existing
      .filter((line) => line.trim())
      .map((line) => ({ id: (JSON.parse(line) as Review).id, line }));
    for (const r of reviews) entries.push({ id: r.id, line: dumpReviewLine(r) });
    entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    await writeFile(path, entries.map((e) => `${e.line}\n`).join(""), "utf8");
    return reviewPath(placeId);
  }
}
