import type { NewPlaceReportReason } from "./types.js";

/**
 * Where a new place stands. `shown` and `confirmed` places are served to
 * everyone, `confirmed` without the "not checked yet" label. A `held` place
 * shows only to its adder until a person or the apply run settles it. `hidden`
 * and `withdrawn` places are served to nobody.
 */
export type NewPlaceStanding = "shown" | "confirmed" | "held" | "hidden" | "withdrawn";


/** A "Were you here?" answer on a new place. */
export interface NewPlaceCheck {
  device: string;
  /** The independent source it came from (a client network), when known. Evidence from one source counts once. */
  source?: string;
  /** False for "No, it's not there", which counts as a report. */
  stillThere: boolean;
  /** Whether the device was near the place when it answered. */
  nearby: boolean;
  /** When it was sent, an ISO 8601 date or time. */
  day: string;
}

export interface NewPlaceReport {
  device: string;
  /** The independent source it came from (a client network), when known. Evidence from one source counts once. */
  source?: string;
  reason: NewPlaceReportReason;
  /** When it was sent, an ISO 8601 date or time. */
  day: string;
}

export interface NewPlaceStandingInput {
  /** When the intake accepted the `new_place` report, an ISO 8601 time. */
  added: string;
  /** The device that added the place, whether a moderator blocked its contributor, and whether this is their first place. */
  contributor: { device: string; source?: string; blocked: boolean; firstPlace: boolean };
  checks: NewPlaceCheck[];
  reports: NewPlaceReport[];
  /** When the adder deleted the place, if they did. */
  withdrawnAt: string | null;
  /** The id of an existing place within 150 m in the same group, if any. */
  duplicateOf: string | null;
  /** A person's latest restore or hide, which wins over everything but the adder's own early delete. */
  moderator: { action: "restore" | "hide"; at: string } | null;
  /** The time to work the standing out at. Anything dated later hasn't happened yet. */
  now: string;
}

/** How long the adder can delete a place outright. After that their delete is one more report. */
const WITHDRAW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Still-there checks from other sources near the place that confirm it. */
export const NEW_PLACE_CHECKS_TO_CONFIRM = 2;
/** Reports from different sources that hide an unconfirmed place. */
export const NEW_PLACE_REPORTS_TO_HIDE = 2;
/** Reports from different sources that hide a confirmed place. */
export const NEW_PLACE_REPORTS_TO_HIDE_CONFIRMED = 3;

/**
 * The one rule for whether a new place shows, shared by the intake, the apply
 * run and apps. Each source (a client network when known, else a device)
 * counts once, whether it reported, answered "not there" or both. A restore ignores the reports up to it, and a report dated by
 * day alone counts as before a restore made that day.
 */
export function newPlaceStanding(input: NewPlaceStandingInput): NewPlaceStanding {
  const { added, contributor, duplicateOf, moderator } = input;
  const now = Date.parse(input.now);
  const happened = (at: string) => Date.parse(at) <= now;
  const withdrawnAt = input.withdrawnAt !== null && happened(input.withdrawnAt) ? input.withdrawnAt : null;
  if (withdrawnAt !== null && Date.parse(withdrawnAt) - Date.parse(added) <= WITHDRAW_WINDOW_MS) return "withdrawn";

  const mod = moderator !== null && happened(moderator.at) ? moderator : null;
  if (mod?.action === "hide") return "hidden";
  // A restore wipes the slate: only what came after it counts against the place.
  const counts = (at: string) => happened(at) && (mod === null || Date.parse(at) > Date.parse(mod.at));

  const sourceOf = (e: { device: string; source?: string }) => e.source ?? e.device;
  const checks = input.checks.filter((c) => happened(c.day));
  const against = new Set(input.reports.filter((r) => counts(r.day)).map(sourceOf));
  for (const c of checks) if (!c.stillThere && counts(c.day)) against.add(sourceOf(c));
  if (withdrawnAt !== null && counts(withdrawnAt)) against.add(sourceOf(contributor));

  const confirming = new Set(
    checks.filter((c) => c.stillThere && c.nearby && c.device !== contributor.device && !against.has(sourceOf(c))).map(sourceOf),
  );
  const confirmed = confirming.size >= NEW_PLACE_CHECKS_TO_CONFIRM;

  if (mod === null && contributor.blocked) return "hidden";
  if (against.size >= (confirmed ? NEW_PLACE_REPORTS_TO_HIDE_CONFIRMED : NEW_PLACE_REPORTS_TO_HIDE)) return "hidden";
  if (mod === null && duplicateOf !== null) return "held";
  return confirmed ? "confirmed" : "shown";
}
