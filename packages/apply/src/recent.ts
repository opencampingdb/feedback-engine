import type { StoredFeedback } from "@opencampingdb/feedback";
import { sameValue } from "./decide.js";
import { DataRepo, readHistory } from "./io.js";
import { newPlaceIdOf, WINDOW_DAYS, WITHDRAWN } from "./rules.js";
import type { Place } from "./types.js";

/**
 * The intake's store of recent new places, which serves new places to apps
 * until they are in the data. A place must not leave it before it is in the
 * data, or apps would lose it for a while.
 */
export interface RecentStore {
  /** The data holds these places, or their adder withdrew them. The intake keeps them, with their standing, for 7 days from then. */
  remove(ids: readonly string[]): Promise<void>;
  /** Replaces the intake's block list with these hashed contributor ids. */
  block(contributors: readonly string[]): Promise<void>;
}

/**
 * The intake's recent changes: facts and contact takedowns it put live at
 * send time, which apps lay over their release. Both calls name feedback ids,
 * skip ids with no recent change, and are safe to send again.
 */
export interface RecentChangeStore {
  /** The data's main branch holds these items' changes, as of `at`. The intake keeps them for 7 days from then. */
  inData(ids: readonly string[], at: string): Promise<void>;
  /**
   * The apply decided these items other than applying them. Their recent
   * changes leave the list at once. Those among `refused` were refused, and
   * count against their contributor; the rest went to a person or wait.
   */
  overruled(ids: readonly string[], refused: readonly string[]): Promise<void>;
}

/** The ids of the new places on the intake's recent list that the apply run is not done with yet. */
export interface RecentList {
  /** Throws when the list cannot be read. */
  ids(): Promise<ReadonlySet<string>>;
}

/**
 * The intake's public `GET /v1/places/recent`, which lists new places that
 * are `shown` or `confirmed` until they are in the data, and then for 7 days
 * with `in_data_at` and whatever their standing. `ids` leaves out the places
 * with `in_data_at`, which this store has already been told about, so only the
 * places waiting for the data count.
 */
export function intakeRecentList(baseUrl: string, fetcher: typeof fetch = fetch): RecentList {
  const url = new URL("/v1/places/recent", baseUrl).toString();
  return {
    async ids() {
      const response = await fetcher(url, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`the intake did not give the recent list: ${response.status}`);
      const body = (await response.json()) as { places?: unknown };
      if (!Array.isArray(body.places)) throw new Error("the intake's recent list has no places array");
      const ids = new Set<string>();
      for (const place of body.places) {
        const id = (place as { id?: unknown } | null)?.id;
        if (typeof id !== "string") throw new Error("a place on the intake's recent list has no id");
        if (typeof (place as { in_data_at?: unknown }).in_data_at === "string") continue;
        ids.add(id);
      }
      return ids;
    },
  };
}

/** The intake takes at most this many ids in one call. */
const REMOVE_BATCH = 500;

/**
 * The intake's `POST /v1/places/recent/remove` and `POST /v1/places/recent/block`,
 * authorised with the places token the intake keeps as `PLACES_TOKEN`.
 * Removing an id that is not in the store does nothing, and the block list
 * replaces the last one, so sending either again is safe.
 */
export function intakeRecentStore(baseUrl: string, token: string, fetcher: typeof fetch = fetch): RecentStore & RecentChangeStore {
  const url = new URL("/v1/places/recent/remove", baseUrl).toString();
  const blockUrl = new URL("/v1/places/recent/block", baseUrl).toString();
  const post = async (path: string, ids: readonly string[], extra: (part: readonly string[]) => Record<string, unknown>, what: string) => {
    const target = new URL(path, baseUrl).toString();
    for (let start = 0; start < ids.length; start += REMOVE_BATCH) {
      const part = ids.slice(start, start + REMOVE_BATCH);
      const response = await fetcher(target, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ids: part, ...extra(part) }),
      });
      if (!response.ok) throw new Error(`the intake refused ${what}: ${response.status} ${await response.text()}`);
    }
  };
  return {
    inData: (ids, at) => post("/v1/places/recent/in-data", ids, () => ({ at }), "the recent changes in the data"),
    overruled: (ids, refused) => {
      const isRefused = new Set(refused);
      // Each call names the refused ids among its own ids.
      return post("/v1/places/recent/overruled", ids, (part) => ({ refused: part.filter((id) => isRefused.has(id)) }), "the overruled recent changes");
    },
    async block(contributors) {
      const response = await fetcher(blockUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ contributors }),
      });
      if (!response.ok) throw new Error(`the intake refused the block list: ${response.status} ${await response.text()}`);
    },
    async remove(ids) {
      for (let start = 0; start < ids.length; start += REMOVE_BATCH) {
        const response = await fetcher(url, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ ids: ids.slice(start, start + REMOVE_BATCH) }),
        });
        if (!response.ok) throw new Error(`the intake refused to remove recent places: ${response.status} ${await response.text()}`);
      }
    },
  };
}

export interface SettleOptions {
  inbox: string;
  /** A checkout of the data repository's `main`, so only merged places count as in the data. */
  main: string;
  store: RecentStore;
  /** Time of the run. Defaults to now. */
  now?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tells the recent store about every new place from the last 90 days that is
 * now in the data on `main`, and every place its adder withdrew. The store
 * lists each for 7 more days with its standing and then drops it. Places held
 * for a person stay until the review PR that writes them is merged. Returns
 * the ids sent, sorted.
 */
export async function settleRecentPlaces(options: SettleOptions): Promise<string[]> {
  const now = options.now ?? new Date();
  const sinceDay = new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const applied = await readHistory(options.inbox, sinceDay);
  const refused = await readHistory(options.inbox, sinceDay, "refused");
  const reasonOf = (item: object) => (item as { outcome?: { reason?: string } }).outcome?.reason;
  const added = applied.filter((i) => i.type === "report" && i.report.kind === "new_place").map(newPlaceIdOf);
  const withdrawn = [
    ...refused.filter((i) => i.type === "report" && i.report.kind === "new_place" && reasonOf(i) === WITHDRAWN.place).map(newPlaceIdOf),
    ...applied.filter((i) => i.type === "withdraw" && reasonOf(i) === WITHDRAWN.withdrawal).map((i) => i.place as string),
  ];
  const inData = await new DataRepo(options.main).places(added);
  const ids = [...new Set([...inData.keys(), ...withdrawn])].sort();
  if (ids.length > 0) await options.store.remove(ids);
  return ids;
}

/**
 * Sends the intake every contributor blocked in `moderation/blocked_contributors.json`
 * on `main`, so their new places leave the recent list and later ones aren't
 * listed. The whole list goes each time. Returns it, sorted.
 */
export async function sendBlockList(options: { main: string; store: RecentStore }): Promise<string[]> {
  const contributors = [...(await new DataRepo(options.main).blocked())].sort();
  await options.store.block(contributors);
  return contributors;
}

/** A `fact` or `contact` report about a released place, as the intake decides them at send time. */
type ChangeReport = Extract<StoredFeedback, { type: "report" }> & { place: string };

const isChangeReport = (item: StoredFeedback): item is ChangeReport =>
  item.type === "report" &&
  (item.report.kind === "fact" || item.report.kind === "contact") &&
  typeof item.place === "string" &&
  typeof item.report.fact === "string";

/**
 * Whether `place`, as it is on main, holds the change an applied report made:
 * the fact was set in that run or later, or it has the reported value (a
 * contact report: the contact is gone). A place merged into another counts,
 * as the data has moved on from it.
 */
export function inDataOnMain(item: ChangeReport, place: Place | undefined): boolean {
  if (place === undefined) return false;
  if (place.status === "merged") return true;
  const fact = item.report.fact as keyof Place["facts"];
  const run = (item as { outcome?: { run?: unknown } }).outcome?.run;
  const setAt = place.fact_dates?.[fact];
  if (typeof run === "string" && setAt !== undefined && setAt >= run) return true;
  const current = (place.facts as Record<string, unknown>)[fact];
  return item.report.kind === "contact" ? current === undefined : current !== undefined && sameValue(current, item.report.value);
}

/**
 * Tells the intake which fact and contact reports applied in the last 90 days
 * now have their change on `main`, so it keeps each recent change for 7 days
 * from this run and then drops it. `main` is checked out before the run, so a
 * change counts once the PR that wrote it has merged, never before: apps drop
 * a recent change once their release is newer than this time. Returns the ids
 * sent, sorted.
 */
export async function settleRecentChanges(options: Omit<SettleOptions, "store"> & { store: RecentChangeStore }): Promise<string[]> {
  const now = options.now ?? new Date();
  const sinceDay = new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const reports = (await readHistory(options.inbox, sinceDay)).filter(isChangeReport);
  const onMain = await new DataRepo(options.main).places(reports.map((r) => r.place));
  const ids = [...new Set(reports.filter((r) => inDataOnMain(r, onMain.get(r.place))).map((r) => r.id))].sort();
  if (ids.length > 0) await options.store.inData(ids, now.toISOString().replace(/\.\d{3}Z$/, "Z"));
  return ids;
}

/**
 * Tells the intake every item this run decided other than applying it
 * (refused, for a person, or an owner claim sent), so any recent change it
 * put live for one of them leaves the list, and which of them it refused,
 * which count against their contributor. Returns the ids sent, sorted.
 */
export async function sendOverruled(options: { ids: readonly string[]; refused: readonly string[]; store: RecentChangeStore }): Promise<string[]> {
  const ids = [...new Set(options.ids)].sort();
  const sent = new Set(ids);
  const refused = [...new Set(options.refused)].filter((id) => sent.has(id)).sort();
  if (ids.length > 0) await options.store.overruled(ids, refused);
  return ids;
}
