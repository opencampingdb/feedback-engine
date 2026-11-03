import { DataRepo, readHistory } from "./io.js";
import { newPlaceIdOf, WINDOW_DAYS, WITHDRAWN } from "./rules.js";

/**
 * The intake's store of recent new places, which serves new places to apps
 * until they are in the data. A place must not leave it before it is in the
 * data, or apps would lose it for a while.
 */
export interface RecentStore {
  remove(ids: readonly string[]): Promise<void>;
}

/** The intake takes at most this many ids in one call. */
const REMOVE_BATCH = 500;

/**
 * The intake's `POST /v1/places/recent/remove`, authorised with the places
 * token the intake keeps as `PLACES_TOKEN`. Removing an id that is not in the
 * store does nothing, so sending the same ids again is safe.
 */
export function intakeRecentStore(baseUrl: string, token: string, fetcher: typeof fetch = fetch): RecentStore {
  const url = new URL("/v1/places/recent/remove", baseUrl).toString();
  return {
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
 * Takes out of the recent store every new place from the last 90 days that
 * is now in the data on `main`, and every place its adder withdrew. Places
 * held for a person stay until the review PR that writes them is merged.
 * Returns the ids sent, sorted.
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
