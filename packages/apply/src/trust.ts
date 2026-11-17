/**
 * Trust from a track record. The apply keeps, for each signed-in
 * contributor, the edits of theirs that other sources later confirmed. Once
 * there are TRUST_CONFIRMED_EDITS of them the contributor is trusted: their
 * new places are listed straight away, and their contacts go live once they
 * pass the contact checks, without a second source. A doubt about any of
 * their edits that takes the value down withdraws trust at once and starts
 * the count again: edits sent before it never count again.
 *
 * Only items from a contributor the app sent (`signed_in`) earn or use trust.
 * Items from a human check (websites), signed-out installs and installs whose
 * id stands in for a contributor never do.
 */

import type { FactValue, StoredFeedback } from "@opencampingdb/feedback";
import { sameValue, sourceOf } from "./decide.js";

/** Confirmed edits that make a contributor trusted. */
export const TRUST_CONFIRMED_EDITS = 5;

/** One edit other sources confirmed: a fact report, or a new place (no `fact`). */
export interface ConfirmedEdit {
  feedback: string;
  /** When the intake received the edit. */
  received: string;
  place: string;
  fact?: string;
  value?: FactValue;
}

export interface ContributorTrust {
  /** Their edits other sources confirmed, oldest first. */
  confirmed: ConfirmedEdit[];
  /** When the latest upheld doubt about one of their edits was received. Edits sent at or before it never count. */
  withdrawn?: string;
}

/** `trust/contributors.json` in the inbox. Private: it ties feedback ids to contributors. */
export interface TrustRecord {
  contributors: Record<string, ContributorTrust>;
}

export const emptyTrust = (): TrustRecord => ({ contributors: {} });

/** Whether `item` may earn or use trust: a contributor the app sent, and no human check. */
export function earnsTrust(item: StoredFeedback): boolean {
  return item.contributor !== undefined && item.signed_in === true && item.human_checked === undefined;
}

/** The trusted contributors in `record`, leaving out blocked ones. */
export function trustedContributors(record: TrustRecord, blocked: ReadonlySet<string> = new Set()): Set<string> {
  return new Set(
    Object.entries(record.contributors)
      .filter(([contributor, entry]) => entry.confirmed.length >= TRUST_CONFIRMED_EDITS && !blocked.has(contributor))
      .map(([contributor]) => contributor),
  );
}

/** Whether `item` is sent by a trusted contributor in a way that uses the trust. */
export function isTrusted(item: StoredFeedback, trusted: ReadonlySet<string>): boolean {
  return earnsTrust(item) && trusted.has(item.contributor!);
}

/** A confirmation: `by` agreed with `edit`. */
export interface Confirmation {
  edit: StoredFeedback;
  place: string;
  fact?: string;
  value?: FactValue;
  by: StoredFeedback;
}

/** A doubt upheld in a run: the value it took down (or, without `fact`, a new place hidden), and when it was received. */
export interface UpheldDoubt {
  place: string;
  fact?: string;
  value?: FactValue;
  at: string;
}

/** Whether `by` is an independent source for `edit`: another device, network and contributor. */
export function independentOf(edit: StoredFeedback, by: StoredFeedback): boolean {
  return by.device !== edit.device && sourceOf(by) !== sourceOf(edit) && (by.contributor === undefined || by.contributor !== edit.contributor);
}

/**
 * The trust a run leaves: `record` with this run's confirmations added and
 * its upheld doubts applied. `edits` are the items a doubt may be about (fact
 * reports and new places, with the value each set), so trust is withdrawn
 * from every signed-in contributor who sent the value taken down.
 */
export function nextTrust(
  record: TrustRecord,
  confirmations: readonly Confirmation[],
  upheld: readonly UpheldDoubt[],
  edits: readonly { item: StoredFeedback; place: string; fact?: string; value?: FactValue }[],
): TrustRecord {
  const next: TrustRecord = {
    contributors: Object.fromEntries(
      Object.entries(record.contributors).map(([c, e]) => [c, { confirmed: e.confirmed.map((x) => ({ ...x })), ...(e.withdrawn ? { withdrawn: e.withdrawn } : {}) }]),
    ),
  };
  const entry = (contributor: string) => (next.contributors[contributor] ??= { confirmed: [] });

  for (const { edit, place, fact, value, by } of confirmations) {
    if (!earnsTrust(edit) || !independentOf(edit, by) || Date.parse(by.received) <= Date.parse(edit.received)) continue;
    const mine = entry(edit.contributor!);
    if (mine.confirmed.some((c) => c.feedback === edit.id)) continue;
    mine.confirmed.push({ feedback: edit.id, received: edit.received, place, ...(fact !== undefined ? { fact } : {}), ...(value !== undefined ? { value } : {}) });
  }

  for (const doubt of upheld) {
    const matches = (place: string, fact: string | undefined, value: FactValue | undefined) =>
      place === doubt.place && (doubt.fact === undefined ? fact === undefined : fact === doubt.fact && sameValue(value, doubt.value));
    const who = new Set<string>();
    for (const e of edits) {
      if (earnsTrust(e.item) && Date.parse(e.item.received) < Date.parse(doubt.at) && matches(e.place, e.fact, e.value)) who.add(e.item.contributor!);
    }
    for (const [contributor, e] of Object.entries(next.contributors)) {
      if (e.confirmed.some((c) => Date.parse(c.received) < Date.parse(doubt.at) && matches(c.place, c.fact, c.value))) who.add(contributor);
    }
    for (const contributor of who) {
      const mine = entry(contributor);
      if (mine.withdrawn === undefined || Date.parse(mine.withdrawn) < Date.parse(doubt.at)) mine.withdrawn = doubt.at;
    }
  }

  // Edits sent at or before a withdrawal never count.
  for (const [contributor, e] of Object.entries(next.contributors)) {
    if (e.withdrawn !== undefined) e.confirmed = e.confirmed.filter((c) => Date.parse(c.received) > Date.parse(e.withdrawn!));
    e.confirmed.sort((a, b) => a.received.localeCompare(b.received) || a.feedback.localeCompare(b.feedback));
    if (e.confirmed.length === 0 && e.withdrawn === undefined) delete next.contributors[contributor];
  }
  return next;
}
