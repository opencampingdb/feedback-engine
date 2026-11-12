import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { FIRST_HAND, FIRST_HAND_KINDS, isFeedbackId, isOwnerSubmission, type StoredFeedback, type StoredSubmission } from "@opencampingdb/feedback";
import type { AwaitingClaim, OwnerRecord } from "./owners.js";
import { pairKey, withDoNotMatch, type DoNotMatchEntry } from "./review.js";
import { majorRoads, type MajorRoads } from "./roads.js";
import type { Decision } from "./rules.js";
import { dumpFeeLine, dumpPhotoLine, dumpPlace, dumpReviewLine, feePath, photoPath, placePath, reviewPath } from "./serialise.js";
import type { BlockedList, Fee, Photo, Place, RemovedPhotos, Review } from "./types.js";

export interface PendingFile {
  path: string;
  /** The `<yyyy-mm-dd>` folder it sits in. */
  day: string;
  item: StoredSubmission;
}

/** How many place files `allPlaces` reads at once. */
const PLACE_READS = 64;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
const FEEDBACK_FILE = /^fb_[0-9A-HJKMNP-TV-Z]{26}\.json$/;
const RECEIVED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Why `item` cannot be used, or undefined when it has a feedback id (equal to
 * `expectedId` when given), an ISO 8601 UTC `received` and, on a report that
 * has one, a `first_hand` the SDK allows on a kind in `FIRST_HAND_KINDS`, so
 * applied items carry only those.
 */
function storedProblem(item: StoredSubmission, expectedId?: string): string | undefined {
  if (typeof item !== "object" || item === null) return "the file is not a JSON object";
  if (typeof item.id !== "string" || !isFeedbackId(item.id) || (expectedId !== undefined && item.id !== expectedId)) {
    return "id does not match the file name";
  }
  if (typeof item.received !== "string" || !RECEIVED.test(item.received) || Number.isNaN(Date.parse(item.received))) {
    return "received is not an ISO 8601 UTC time";
  }
  const report = (item as { report?: unknown }).report;
  if (typeof report === "object" && report !== null && "first_hand" in report) {
    const { kind, first_hand } = report as { kind?: unknown; first_hand?: unknown };
    if (!(FIRST_HAND_KINDS as readonly unknown[]).includes(kind) || !(FIRST_HAND as readonly unknown[]).includes(first_hand)) {
      return `report.first_hand must be seen_nearby or says_so, on a ${FIRST_HAND_KINDS.slice(0, -1).join(", ")} or ${FIRST_HAND_KINDS.at(-1)} report`;
    }
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

/** The feedback ids already decided: every `fb_` file name in `applied/` and `refused/`. */
async function decidedIds(inbox: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const folder of ["applied", "refused"]) {
    const root = join(inbox, folder);
    for (const day of await dayFolders(root)) {
      for (const name of await readdir(join(root, day))) if (FEEDBACK_FILE.test(name)) ids.add(name.slice(0, -5));
    }
  }
  return ids;
}

/**
 * Every file in `pending/`. Files whose content cannot be used are returned
 * apart, for `refuseMalformed`. A file whose id is already in `applied/` or
 * `refused/` is skipped and logged: an item is decided once, so a copy the
 * intake wrote again after the apply moved it is never decided twice.
 */
export async function readPending(inbox: string): Promise<{ files: PendingFile[]; malformed: MalformedFile[] }> {
  const root = join(inbox, "pending");
  const files: PendingFile[] = [];
  const malformed: MalformedFile[] = [];
  const days = await dayFolders(root);
  const decided = days.length > 0 ? await decidedIds(inbox) : new Set<string>();
  for (const day of days) {
    const read = await readFeedbackFolder(root, day);
    for (const file of read.files) {
      if (decided.has(file.item.id)) console.warn(`skipping ${file.path}: ${file.item.id} was decided already`);
      else files.push(file);
    }
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

/** Items in `applied/` (or `refused/`) from day folders on or after `sinceDay`, as evidence for the rules. */
export async function readHistory(inbox: string, sinceDay: string, folder: "applied" | "refused" = "applied"): Promise<StoredFeedback[]> {
  const root = join(inbox, folder);
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

/**
 * The fields of one CSV line, as Python's csv module writes them: fields
 * separated by commas, quoted with double quotes when they hold a comma, a
 * quote (doubled) or a line break.
 */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

/** The major roads in a geometry sidecar written by the data repository's `pipeline.extract --geometry`, read line by line. */
export async function readRoads(path: string): Promise<MajorRoads> {
  const lines: string[] = [];
  for await (const line of createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity })) {
    if (line.includes('"road"')) lines.push(line);
  }
  return majorRoads(lines);
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

/** Moves each decided pending file to `applied/` or `refused/`, adding the outcome (with `doubted` on a doubt that took a fact down). Waiting files stay. */
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
    // A doubt that took a fact down keeps the value, so later runs find the open case.
    const outcome = {
      result: decision.outcome,
      reason: decision.reason,
      run: runAt,
      ...(decision.held_reason ? { held_reason: decision.held_reason } : {}),
      ...(decision.doubted ? { doubted: decision.doubted } : {}),
    };
    const withOutcome = { ...file.item, outcome };
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
  #inside(folder: "places" | "reviews" | "fees" | "photos", relativePath: string): string {
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

  /** Every place record in the checkout, for the duplicates check on new places. */
  async allPlaces(): Promise<Place[]> {
    const paths = [...(await this.#placeIndex()).values()];
    const out: Place[] = new Array(paths.length);
    // A few reads at a time: one open file per place exhausts the process's file handles on a full checkout.
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(PLACE_READS, paths.length) }, async () => {
        while (next < paths.length) {
          const i = next++;
          out[i] = JSON.parse(await readFile(paths[i]!, "utf8")) as Place;
        }
      }),
    );
    return out;
  }

  /** Deletes a place record wherever it is. Returns its path, or undefined when there is none. */
  async removePlace(id: string): Promise<string | undefined> {
    const index = await this.#placeIndex();
    const path = index.get(id);
    if (!path) return undefined;
    this.#inside("places", relative(this.root, path));
    await rm(path);
    index.delete(id);
    return relative(this.root, path).split(sep).join("/");
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
   * Writes every review line of a place, sorted by id, with LF endings and a
   * trailing newline. Returns the path, or undefined when the file already
   * holds exactly that.
   */
  async writeReviews(placeId: string, reviews: readonly Review[]): Promise<string | undefined> {
    const path = this.#inside("reviews", reviewPath(placeId));
    const text = [...reviews]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => `${dumpReviewLine(r)}\n`)
      .join("");
    if ((await exists(path)) && (await readFile(path, "utf8")) === text) return undefined;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
    return reviewPath(placeId);
  }

  async fees(placeId: string): Promise<Fee[]> {
    const path = this.#inside("fees", feePath(placeId));
    if (!(await exists(path))) return [];
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Fee);
  }

  /**
   * Writes every fee line of a place, sorted by id, with LF endings and a
   * trailing newline. Returns the path, or undefined when the file already
   * holds exactly that.
   */
  async writeFees(placeId: string, fees: readonly Fee[]): Promise<string | undefined> {
    const path = this.#inside("fees", feePath(placeId));
    const text = [...fees]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((f) => `${dumpFeeLine(f)}\n`)
      .join("");
    if ((await exists(path)) && (await readFile(path, "utf8")) === text) return undefined;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
    return feePath(placeId);
  }

  async photos(placeId: string): Promise<Photo[]> {
    const path = this.#inside("photos", photoPath(placeId));
    if (!(await exists(path))) return [];
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Photo);
  }

  /** Every photo line in the data. Reads every photo file. */
  async allPhotos(): Promise<Photo[]> {
    const folder = join(this.root, "photos");
    if (!(await exists(folder))) return [];
    const out: Photo[] = [];
    for (const name of (await readdir(folder)).sort()) {
      if (!name.endsWith(".ndjson")) continue;
      for (const line of (await readFile(join(folder, name), "utf8")).split("\n")) {
        if (line.trim()) out.push(JSON.parse(line) as Photo);
      }
    }
    return out;
  }

  /**
   * Writes every photo line of a place, sorted by id. Removes the file when
   * no lines are left. Returns the path, or undefined when nothing changed.
   */
  async writePhotos(placeId: string, photos: readonly Photo[]): Promise<string | undefined> {
    const path = this.#inside("photos", photoPath(placeId));
    const there = await exists(path);
    if (photos.length === 0) {
      if (!there) return undefined;
      await rm(path);
      return photoPath(placeId);
    }
    const text = [...photos]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => `${dumpPhotoLine(p)}\n`)
      .join("");
    if (there && (await readFile(path, "utf8")) === text) return undefined;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
    return photoPath(placeId);
  }

  /** `moderation/removed_photos.json`. Empty when the file is missing. */
  async removedPhotos(): Promise<RemovedPhotos["photos"]> {
    const path = join(this.root, "moderation", "removed_photos.json");
    if (!(await exists(path))) return [];
    return (JSON.parse(await readFile(path, "utf8")) as Partial<RemovedPhotos>).photos ?? [];
  }

  /**
   * Adds photos to `moderation/removed_photos.json`, keeping the first entry
   * for an id and sorting by id. Returns the path, or undefined when nothing
   * was added.
   */
  async addRemovedPhotos(entries: readonly RemovedPhotos["photos"][number][]): Promise<string | undefined> {
    const current = await this.removedPhotos();
    const known = new Set(current.map((e) => e.photo));
    const added = entries.filter((e) => !known.has(e.photo) && (known.add(e.photo), true));
    if (added.length === 0) return undefined;
    // Keys in sorted order, as Python's json.dumps(sort_keys=True) writes them.
    const photos = [...current, ...added].map((e) => ({ photo: e.photo, reason: e.reason, removed: e.removed })).sort((a, b) => (a.photo < b.photo ? -1 : a.photo > b.photo ? 1 : 0));
    const path = join(this.root, "moderation", "removed_photos.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ photos }, null, 2)}\n`, "utf8");
    return "moderation/removed_photos.json";
  }

  /** Pairs in `moderation/commons-do-not-match.json`. Empty when the file is missing. */
  async doNotMatch(): Promise<DoNotMatchEntry[]> {
    const path = join(this.root, "moderation", "commons-do-not-match.json");
    if (!(await exists(path))) return [];
    return (JSON.parse(await readFile(path, "utf8")) as { pairs?: DoNotMatchEntry[] }).pairs ?? [];
  }

  /** Adds pairs to `moderation/commons-do-not-match.json` with `withDoNotMatch`. Returns the path, or undefined when nothing changed. */
  async addDoNotMatch(entries: readonly DoNotMatchEntry[]): Promise<string | undefined> {
    if (entries.length === 0) return undefined;
    const path = join(this.root, "moderation", "commons-do-not-match.json");
    const before = (await exists(path)) ? await readFile(path, "utf8") : undefined;
    const text = withDoNotMatch(before, entries);
    if (text === before) return undefined;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, "utf8");
    return "moderation/commons-do-not-match.json";
  }

  /** Pairs in `moderation/distinct_places.json`, as `pairKey` makes them. Empty when the file is missing. */
  async distinct(): Promise<Set<string>> {
    const path = join(this.root, "moderation", "distinct_places.json");
    if (!(await exists(path))) return new Set();
    const list = JSON.parse(await readFile(path, "utf8")) as { pairs?: { a: string; b: string }[] };
    return new Set((list.pairs ?? []).map((pair) => pairKey(pair.a, pair.b)));
  }

  /** Contributors in `moderation/blocked_contributors.json`. Empty when the file is missing. */
  async blocked(): Promise<Set<string>> {
    const path = join(this.root, "moderation", "blocked_contributors.json");
    if (!(await exists(path))) return new Set();
    const list = JSON.parse(await readFile(path, "utf8")) as Partial<BlockedList>;
    return new Set((list.contributors ?? []).map((entry) => entry.contributor));
  }

  /** Review ids in `moderation/removed_reviews.json` (data's `pipeline.moderate remove`). Empty when the file is missing. */
  async removedReviews(): Promise<Set<string>> {
    const path = join(this.root, "moderation", "removed_reviews.json");
    if (!(await exists(path))) return new Set();
    const list = JSON.parse(await readFile(path, "utf8")) as { reviews?: { review: string }[] };
    return new Set((list.reviews ?? []).map((entry) => entry.review));
  }

  /**
   * Contributors with at least one visible review anywhere in the data, so
   * their next reviews are trusted. Reads every review file.
   */
  async reviewers(blocked: ReadonlySet<string>): Promise<Set<string>> {
    const out = new Set<string>();
    for (const review of await this.allReviews()) {
      if (review.hidden === undefined && review.contributor && !blocked.has(review.contributor)) out.add(review.contributor);
    }
    return out;
  }

  /** Every review line in the data. Reads every review file. */
  async allReviews(): Promise<Review[]> {
    const folder = join(this.root, "reviews");
    if (!(await exists(folder))) return [];
    const out: Review[] = [];
    for (const name of (await readdir(folder)).sort()) {
      if (!name.endsWith(".ndjson")) continue;
      for (const line of (await readFile(join(folder, name), "utf8")).split("\n")) {
        if (line.trim()) out.push(JSON.parse(line) as Review);
      }
    }
    return out;
  }
}
