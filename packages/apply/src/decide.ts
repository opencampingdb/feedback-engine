import {
  contactProblem,
  firstProblem,
  isContactFact,
  isFactName,
  isValidFactValue,
  tidyText,
  type ContactFactName,
  type ContactReportReason,
  type FactName,
  type FactValue,
  type FeeValue,
  type StoredFeedback,
  type TextProblem,
} from "@opencampingdb/feedback";
import type { Place } from "./types.js";

/**
 * The rules for one item against one place, shared by the apply and the
 * intake so both decide alike. Pure functions with no Node APIs: the intake
 * runs them in a Worker at send time, and `applyRules` runs them for each
 * item in a run.
 *
 * Each decision is `live` (the change goes into the data at once), `held`
 * (accepted, but kept from apps until a reviewer decides) or `refused`, with
 * a reason code and the reason in words. The caller works out which earlier
 * items count as evidence and passes them in; the rules pick out the ones
 * about the same place and fact within 90 days before the item.
 */

export const WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;

/**
 * Facts a report without attestation cannot change on its own: a single
 * report proposes the change on the PR for a person. An attested report of a
 * contact fact or the address applies at once when it passes `contactProblem`,
 * as other facts do; any other fact here always goes to a person.
 */
export const REVIEWED_FACTS: ReadonlySet<FactName> = new Set<FactName>([
  "website",
  "phone",
  "phone_2",
  "email",
  "facebook",
  "instagram",
  "tiktok",
  "x",
  "address",
]);

export type ReportItem = Extract<StoredFeedback, { type: "report" }>;

/** What the rules read of a place: its facts, and who set each one and when. */
export type PlaceState = Pick<Place, "facts" | "fact_sources" | "fact_dates">;

/**
 * Why an item is held. `not_attested`: a report without attestation, which a
 * person reads (a contact fact) or a second device has to agree with (any
 * other fact). `owner_value`: the verified owner set the value. `disagreement`:
 * another source sent a different value within 90 days. `link_check`: a contact
 * fails `contactProblem`. `text_check`: free text fails the text checks.
 * `unconfirmed`: a contact report from one source, or with none attested.
 * `no_contributor`: a new place sent without a contributor.
 */
export type HeldReason = "not_attested" | "owner_value" | "disagreement" | "link_check" | "text_check" | "unconfirmed" | "no_contributor";

/** The reasons the intake holds an item for one of its checks rather than for these rules. */
export const CHECK_HOLDS: readonly string[] = ["text_check", "link_check", "ai_check", "daily_cap", "check_unavailable"];

/**
 * The check the intake held `item` for at send time (its `intake` field), or
 * null when it did not hold it for one. The apply has none of those checks,
 * so such an item goes to a person, never into the data on its own. Items the
 * intake held for a reason of these rules, and items without the field, are
 * decided here as before.
 */
export function heldForCheck(item: StoredFeedback): string | null {
  const intake: unknown = (item as { intake?: unknown }).intake;
  if (typeof intake !== "object" || intake === null) return null;
  const { state, held_reason: reason } = intake as { state?: unknown; held_reason?: unknown };
  return state === "held" && typeof reason === "string" && CHECK_HOLDS.includes(reason) ? reason : null;
}

/** Why an item is refused. `invalid_value`: not a valid fact value. `no_value`: a contact report about a contact the place does not have. */
export type RefusedReason = "invalid_value" | "no_value";

/** A change the rules accept: `value` null takes the fact off the place. */
export interface FactChange {
  place: string;
  fact: FactName;
  value: FactValue | null;
}

/** A contact taken down after reports from two sources, for a reviewer to look at. */
export interface Takedown {
  /** The value the place published. */
  value: FactValue;
  /** Independent sources among the reports. */
  sources: number;
  reasons: ContactReportReason[];
  /** The reports counted, in the order they were passed in. */
  feedback: string[];
}

export type ItemDecision =
  /** `changes` is empty when the place already has the value. */
  | { verdict: "live"; changes: FactChange[]; why: string; takedown?: Takedown }
  /** `problem`: on `link_check`, the check the value failed. */
  | { verdict: "held"; reason: HeldReason; why: string; problem?: string }
  | { verdict: "refused"; reason: RefusedReason; why: string };

export interface ItemInput {
  item: ReportItem;
  /** The place as it is now, with any change accepted before this item. */
  place: PlaceState;
  /**
   * Earlier items the caller counts as evidence: the rules use those that are
   * reports about the same place and fact, sent at or before the item and no
   * more than 90 days before it. The item itself may be among them.
   */
  earlier: readonly StoredFeedback[];
}

const time = (item: StoredFeedback) => Date.parse(item.received);

/** Whether `item` arrived at or before `at`, and no more than 90 days before it. */
export function inWindow(item: StoredFeedback, at: number): boolean {
  const t = time(item);
  return t <= at && at - t <= WINDOW_MS;
}

/** One source: items from one client network count once, whatever device ids they carry. Items stored without a network count by device. */
export const sourceOf = (item: StoredFeedback) => item.origin ?? item.device;

/** Independent sources among `items`. */
export function distinctSources(items: readonly StoredFeedback[]): number {
  return new Set(items.map(sourceOf)).size;
}

/** Two fact values are the same: an address is compared field by field. */
export const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

const show = (value: unknown) => JSON.stringify(value);

/** The refusal for a `fact` report whose fact or value is not valid, or null when both are. It needs no place. */
export function factRefusal(item: ReportItem): Extract<ItemDecision, { verdict: "refused" }> | null {
  const { fact, value } = item.report;
  if (isFactName(fact) && isValidFactValue(fact, value)) return null;
  return { verdict: "refused", reason: "invalid_value", why: `${String(fact)} = ${show(value)} is not a valid fact` };
}

/**
 * A `fact` report. An attested report changes the fact at once, unless the
 * owner set it, another source disagrees within 90 days, or (for a contact
 * fact or the address) it fails `contactProblem`; then it is held. A report
 * without attestation is held: a person reads a contact fact, and any other
 * fact waits for a second device to agree (which `applyRules` settles across
 * runs).
 */
export function decideFact({ item, place, earlier }: ItemInput): ItemDecision {
  const refusal = factRefusal(item);
  if (refusal !== null) return refusal;
  const fact = item.report.fact as FactName;
  const value = item.report.value as FactValue;
  const reviewed = REVIEWED_FACTS.has(fact);
  if (reviewed && (!isContactFact(fact) || item.attested === undefined)) {
    return { verdict: "held", reason: "not_attested", why: `${fact} changes are checked by a person` };
  }
  const current = (place.facts as Record<string, unknown>)[fact];
  if (sameValue(current, value)) return { verdict: "live", changes: [], why: `${fact} is already ${show(value)}` };
  if (item.attested === undefined) {
    return { verdict: "held", reason: "not_attested", why: `waiting for a second device to agree on ${fact}` };
  }
  if (place.fact_sources[fact] === "owner") {
    return { verdict: "held", reason: "owner_value", why: `${fact} was set by the owner, so a person decides` };
  }
  if (reviewed) {
    const problem = contactProblem(fact as ContactFactName, value);
    if (problem !== null) {
      return { verdict: "held", reason: "link_check", problem, why: `${fact} fails the link checks (${problem}), so a person checks it` };
    }
  }
  const at = time(item);
  const source = sourceOf(item);
  const disagrees = earlier.some(
    (r) =>
      r.id !== item.id &&
      r.type === "report" &&
      r.report.kind === "fact" &&
      r.place === item.place &&
      r.report.fact === fact &&
      sourceOf(r) !== source &&
      !sameValue(r.report.value, value) &&
      inWindow(r, at),
  );
  if (disagrees) {
    return { verdict: "held", reason: "disagreement", why: `another device reported a different ${fact}, so a person decides` };
  }
  return { verdict: "live", changes: [{ place: item.place as string, fact, value }], why: `${fact} set to ${show(value)}` };
}

/**
 * A `contact` report that a contact on a place is wrong or spam. Reports from
 * two sources within 90 days, at least one attested, take the contact off the
 * place at once (`live`, with a `takedown` for a reviewer). One source is held
 * for a person, a contact the owner set is left to a person, and a report
 * about a contact the place does not have is refused. Reports sent before the
 * contact was last set are about an older value and do not count, the item
 * itself included.
 */
export function decideContactReport({ item, place, earlier }: ItemInput): ItemDecision {
  const fact = item.report.fact as ContactFactName;
  const reason = item.report.reason as ContactReportReason;
  const value = (place.facts as Record<string, FactValue | undefined>)[fact];
  if (value === undefined) return { verdict: "refused", reason: "no_value", why: `place has no ${fact}` };
  if (place.fact_sources[fact] === "owner") {
    return { verdict: "held", reason: "owner_value", why: `${fact} was set by the owner, so a person decides` };
  }
  const at = time(item);
  const setAt = place.fact_dates?.[fact];
  const since = setAt === undefined ? -Infinity : Date.parse(setAt);
  const all = earlier.some((r) => r.id === item.id) ? earlier : [...earlier, item];
  const reports = all.filter(
    (r): r is ReportItem =>
      r.type === "report" && r.report.kind === "contact" && r.place === item.place && r.report.fact === fact && inWindow(r, at) && time(r) >= since,
  );
  if (distinctSources(reports) >= 2 && reports.some((r) => r.attested !== undefined)) {
    const reasons = [...new Set(reports.map((r) => r.report.reason as ContactReportReason))].sort();
    return {
      verdict: "live",
      changes: [{ place: item.place as string, fact, value: null }],
      why: `${fact} taken down after reports from two sources`,
      takedown: { value, sources: distinctSources(reports), reasons, feedback: reports.map((r) => r.id) },
    };
  }
  return { verdict: "held", reason: "unconfirmed", why: `a report that the ${fact} is ${reason} is read by a person` };
}

/** Why a new place is not listed for apps until a reviewer decides, or null when it is. */
export function newPlaceListing(item: ReportItem): { reason: "not_attested" | "no_contributor" | "text_check"; why: string } | null {
  if (item.attested === undefined) return { reason: "not_attested", why: "not proven by attestation" };
  if (item.contributor === undefined) return { reason: "no_contributor", why: "no contributor" };
  const problem = item.report.note === undefined ? null : firstProblem(tidyText(item.report.note));
  return problem === null ? null : { reason: "text_check", why: `note fails the text checks (${problem})` };
}

/** The fields a `new_place` report carries, and which of them a published place holds back. */
export interface NewPlaceFields {
  /** Every contact fact and the address the report carries. */
  contacts: Partial<Record<ContactFactName, FactValue>>;
  /** The contacts that fail `contactProblem` (`link_check`): a published place leaves them for a person. */
  failing: ContactFactName[];
  /** The description as published: tidied, and left out when it is empty or fails the text checks. */
  description?: string;
  /** The text check the description failed (`text_check`), or null. */
  descriptionProblem: TextProblem | null;
  fee?: FeeValue;
}

export function newPlaceFields(item: ReportItem): NewPlaceFields {
  const { contacts: sent, address, description: text, fee } = item.report;
  const contacts: Partial<Record<ContactFactName, FactValue>> = { ...sent, ...(address ? { address } : {}) };
  const failing = (Object.keys(contacts) as ContactFactName[]).filter((fact) => contactProblem(fact, contacts[fact]) !== null);
  const tidied = text === undefined ? undefined : tidyText(text);
  const descriptionProblem = tidied === undefined ? null : firstProblem(tidied);
  return {
    contacts,
    failing,
    ...(tidied !== undefined && tidied.length > 0 && descriptionProblem === null ? { description: tidied } : {}),
    descriptionProblem,
    ...(fee !== undefined ? { fee } : {}),
  };
}
