import type { D1Like } from "./recent.js";

/**
 * Timed workflow starts. GitHub starts scheduled workflows hours late and
 * sometimes not at all, so the intake's scheduled job, once a minute, starts
 * each workflow in a timetable through `workflow_dispatch` when its time
 * comes. Each workflow keeps its own `schedule` as a back-up that skips when
 * the workflow already ran in its slot.
 *
 * A slot is the latest minute at or before now that the entry's cron matches.
 * A slot up to CATCH_UP_MS old is still started, so a missed tick or a failed
 * start is tried again on the next ticks. The slot is claimed before the
 * start, so two ticks at once start one run, and put back when the start fails.
 */

/** One workflow to start: `cron` is a five-field cron in UTC, as in a workflow's `schedule`. */
export interface TimedStart {
  /** `owner/name`. */
  repo: string;
  /** File name (`sync-osm.yml`) or id. */
  workflow: string;
  cron: string;
  /** The branch to run on. Defaults to `main`. */
  ref?: string;
}

/** How long after its time a slot is still started. */
export const CATCH_UP_MS = 30 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const FIELDS: ReadonlyArray<readonly [min: number, max: number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week, 0 and 7 are Sunday
];

type Sets = [minute: Set<number>, hour: Set<number>, dom: Set<number>, month: Set<number>, dow: Set<number>];

interface Cron {
  sets: Sets;
  /** Whether day of month and day of week were both given, so either may match. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Reads a five-field cron with numbers, `*`, ranges, steps and lists. Throws on anything else. */
export function parseCron(text: string): Cron {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${text}" needs five fields`);
  const sets = parts.map((part, i) => {
    const [min, max] = FIELDS[i] ?? [0, 0];
    const set = new Set<number>();
    for (const item of part.split(",")) {
      const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (!m) throw new Error(`cron "${text}": cannot read "${item}"`);
      const step = m[4] === undefined ? 1 : Number(m[4]);
      let from = min;
      let to = max;
      if (m[1] !== "*") {
        from = Number(m[2]);
        to = m[3] === undefined ? (m[4] === undefined ? from : max) : Number(m[3]);
      }
      if (step < 1 || from < min || to > max || from > to) throw new Error(`cron "${text}": "${item}" is out of range`);
      for (let n = from; n <= to; n += step) set.add(i === 4 && n === 7 ? 0 : n);
    }
    return set;
  });
  return { sets: sets as Sets, domRestricted: parts[2] !== "*", dowRestricted: parts[4] !== "*" };
}

/** Whether `cron` matches the UTC minute that starts at `ms`. */
export function cronMatches(cron: Cron, ms: number): boolean {
  const d = new Date(ms);
  const [minute, hour, dom, month, dow] = cron.sets;
  if (!minute.has(d.getUTCMinutes()) || !hour.has(d.getUTCHours()) || !month.has(d.getUTCMonth() + 1)) return false;
  const domOk = dom.has(d.getUTCDate());
  const dowOk = dow.has(d.getUTCDay());
  // As in cron: when both day fields are given, either one matching is enough.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/** The latest minute at or before `nowMs`, and no older than CATCH_UP_MS, that `cron` matches. */
export function dueSlot(cron: Cron, nowMs: number): number | null {
  const thisMinute = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  for (let ms = thisMinute; nowMs - ms <= CATCH_UP_MS; ms -= MINUTE_MS) {
    if (cronMatches(cron, ms)) return ms;
  }
  return null;
}

/**
 * Reads the timetable: a JSON array of TimedStart, as a string (a secret or a
 * plain var) or already parsed (a TOML array in `[vars]`). Throws when an
 * entry cannot be read, so a mistake is logged rather than half applied.
 */
export function parseTimetable(raw: unknown): TimedStart[] {
  const list: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(list)) throw new Error("the timetable is not a list");
  return list.map((entry, i) => {
    const e = entry as Partial<TimedStart> | null;
    if (!e || typeof e.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(e.repo)) throw new Error(`timetable entry ${i}: repo must be owner/name`);
    if (typeof e.workflow !== "string" || e.workflow === "") throw new Error(`timetable entry ${i}: workflow is missing`);
    if (typeof e.cron !== "string") throw new Error(`timetable entry ${i}: cron is missing`);
    parseCron(e.cron);
    if (e.ref !== undefined && (typeof e.ref !== "string" || e.ref === "")) throw new Error(`timetable entry ${i}: ref must be a branch name`);
    return { repo: e.repo, workflow: e.workflow, cron: e.cron, ...(e.ref ? { ref: e.ref } : {}) };
  });
}

export type TimedOutcome =
  /** No slot in the last CATCH_UP_MS. */
  | "not_due"
  /** This slot was already started. */
  | "done"
  | "started"
  /** Starting failed. The slot is put back, so the next tick tries again. */
  | "failed";

/** The row in `runs` for a timed start. Only `last_start` is used, and it holds the slot. */
export function timedRunName(entry: TimedStart): string {
  return `timed:${entry.repo}/${entry.workflow}`;
}

/**
 * Starts each entry whose slot is due and not yet started, with `start`.
 * `start` failing is never thrown: it is passed to `onError`, and the other
 * entries still run.
 */
export async function startTimedIfDue(
  db: D1Like,
  nowMs: number,
  entries: TimedStart[],
  start: (entry: TimedStart) => Promise<void>,
  onError: (entry: TimedStart, error: unknown) => void = () => undefined,
): Promise<TimedOutcome[]> {
  const outcomes: TimedOutcome[] = [];
  for (const entry of entries) {
    const slot = dueSlot(parseCron(entry.cron), nowMs);
    if (slot === null) {
      outcomes.push("not_due");
      continue;
    }
    const name = timedRunName(entry);
    await db.prepare("INSERT OR IGNORE INTO runs (name) VALUES (?)").bind(name).run();
    const row = await db.prepare("SELECT last_start FROM runs WHERE name = ?").bind(name).first<{ last_start: number | null }>();
    const previous = row?.last_start ?? null;
    if (previous !== null && previous >= slot) {
      outcomes.push("done");
      continue;
    }
    const claimed = (await db.prepare("UPDATE runs SET last_start = ? WHERE name = ? AND last_start IS ?").bind(slot, name, previous).run()) as {
      meta?: { changes?: number };
    };
    if (claimed.meta?.changes === 0) {
      outcomes.push("done");
      continue;
    }
    try {
      await start(entry);
      outcomes.push("started");
    } catch (error) {
      await db
        .prepare("UPDATE runs SET last_start = ? WHERE name = ? AND last_start = ?")
        .bind(previous, name, slot)
        .run()
        .catch(() => undefined);
      onError(entry, error);
      outcomes.push("failed");
    }
  }
  return outcomes;
}
