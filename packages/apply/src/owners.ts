import type { FactValue, StoredOwnerSubmission } from "@opencampingdb/feedback";
import { moderateReview } from "./moderation.js";
import type { ProofResult } from "./proof.js";
import { resolvePlace, type Change, type Decision, type ReviewEdit } from "./rules.js";
import { roundCoord } from "./serialise.js";
import type { Place } from "./types.js";

/**
 * The owner rules from SPEC "Owners", as pure functions.
 *
 * - A claim or listing waits in `pending/` until its code is on the proof page
 *   (or 7 days pass), then goes to the `feedback/review` PR with an unticked
 *   "Approve owner claim fb_..." box, and moves to `owner-claims/` in the inbox.
 * - A person approves by ticking the box and merging that PR. The next run
 *   reads the merged PR, writes `owners/<place id>.json` in the inbox and puts
 *   `owner_verified` (or the new farm stay) on the `feedback/auto` branch. An
 *   unticked box in a merged PR, or a PR closed without merging, refuses it.
 *   Nothing about an owner reaches `data` before a person approves.
 * - An owner update whose token hash matches `owners/<place id>.json` is
 *   applied at once, except name and location changes, which go to a person.
 * - A temporary closure ends by itself on its `reopens` date.
 */

export const PROOF_WAIT_DAYS = 7;
export const DECISION_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;
export const FARM_STAY_KIND = "farm_stay";

type Claim = Extract<StoredOwnerSubmission, { type: "owner_claim" }>;
type Listing = Extract<StoredOwnerSubmission, { type: "owner_listing" }>;
type Update = Extract<StoredOwnerSubmission, { type: "owner_update" }>;

/** `inbox/owners/<place id>.json`. Private: never written to `data`. */
export interface OwnerRecord {
  place: string;
  /** Id of the approved claim or listing. */
  claim: string;
  token_sha256: string;
  /** Day a person approved it, `YYYY-MM-DD`. */
  approved: string;
  email: string;
  name: string;
}

/** `inbox/owner-claims/<claim id>.json`: a claim or listing waiting for a person. */
export interface AwaitingClaim {
  item: Claim | Listing;
  /** The place claimed, or the id the listing's farm stay will get. */
  place: string;
  /** When it went to the review PR. */
  sent: string;
  proof: ProofResult;
}

export interface ReviewPr {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  body: string;
  comments: { author: { login: string } | null; body: string }[];
}

/** What the review PR shows for a claim or listing. */
export interface ClaimForReview {
  claim: string;
  type: "owner_claim" | "owner_listing";
  place: string;
  proof: ProofResult;
  proofUrl: string;
  code: string;
  /** The approved owner this claim would replace. */
  replaces: { claim: string; approved: string } | undefined;
  listing?: { name: string; description?: string; facts: Record<string, FactValue>; location: { lat: number; lon: number } };
}

export interface OwnerInput {
  now: string;
  /** Owner submissions in `pending/`. */
  pending: readonly StoredOwnerSubmission[];
  /** Proof check results for pending claims and listings, by claim id. */
  proofs: ReadonlyMap<string, ProofResult>;
  awaiting: readonly AwaitingClaim[];
  /** Recent PRs from `feedback/review`. */
  reviewPrs: readonly ReviewPr[];
  /** Logins whose PR comments count (the bot that writes them). */
  botLogins: readonly string[];
  /** Approved owners, by place id. */
  owners: ReadonlyMap<string, OwnerRecord>;
  /** Current records (the automatic checkout), including any temporarily closed ones. */
  places: ReadonlyMap<string, Place>;
  kinds?: ReadonlyMap<string, string>;
}

export interface OwnerOutput {
  decisions: (Omit<Decision, "outcome"> & { outcome: Decision["outcome"] | "awaiting_approval" })[];
  /** Decisions on claims in `owner-claims/`. Claims still waiting are left out. */
  approvals: { claim: string; outcome: "approved" | "refused"; reason: string }[];
  /** Records changed on the automatic branch, with `updated` set. */
  places: Map<string, Place>;
  edits: ReviewEdit[];
  forReview: ClaimForReview[];
  /** Claims and listings to store in `owner-claims/`. */
  awaiting: AwaitingClaim[];
  /** Owner records to write, by place id. */
  owners: Map<string, OwnerRecord>;
  changes: Change[];
}

const APPROVAL_LINE = /^- \[([ xX])\] Approve owner (?:claim|listing) (fb_[0-9A-HJKMNP-TV-Z]{26})\b/gm;

/**
 * The approval boxes in a review PR: in its body, and in comments written by
 * the bot. Only boxes at the start of a line count, so text quoted from an
 * owner (always on one line, after the box) cannot add or tick one.
 */
export function parseApprovals(pr: ReviewPr, botLogins: readonly string[]): { ticked: string[]; listed: string[] } {
  const logins = new Set(botLogins.flatMap((l) => [l, `${l}[bot]`, `app/${l}`]));
  const texts = [pr.body, ...pr.comments.filter((c) => c.author && logins.has(c.author.login)).map((c) => c.body)];
  const ticked: string[] = [];
  const listed: string[] = [];
  for (const text of texts) {
    for (const m of text.replace(/\r\n/g, "\n").matchAll(APPROVAL_LINE)) {
      const id = m[2]!;
      if (!listed.includes(id)) listed.push(id);
      if (m[1] !== " " && !ticked.includes(id)) ticked.push(id);
    }
  }
  return { ticked, listed };
}

/** Text for a box in the review PR. Keep in step with APPROVAL_LINE. */
export function approvalLine(claim: ClaimForReview, summary: string): string {
  const what = claim.type === "owner_listing" ? "listing" : "claim";
  return `- [ ] Approve owner ${what} ${claim.claim}: ${summary}`;
}

export function applyOwnerRules(input: OwnerInput): OwnerOutput {
  const now = Date.parse(input.now);
  const nowIso = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const today = nowIso.slice(0, 10);
  const out: OwnerOutput = {
    decisions: [],
    approvals: [],
    places: new Map(),
    edits: [],
    forReview: [],
    awaiting: [],
    owners: new Map(),
    changes: [],
  };
  const working = new Map<string, Place>();
  const owners = new Map(input.owners);
  const record = (id: string): Place => {
    const existing = working.get(id);
    if (existing) return existing;
    const copy = structuredClone(input.places.get(id)!);
    working.set(id, copy);
    return copy;
  };
  const note = (place: string, summary: string, automatic: boolean, feedback: string[]) =>
    out.changes.push({ place, summary, automatic, feedback });
  const decide = (item: StoredOwnerSubmission, outcome: OwnerOutput["decisions"][number]["outcome"], reason: string, place = item.place) =>
    out.decisions.push({ id: item.id, place, outcome, reason });

  approve();
  for (const item of [...input.pending].sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id))) {
    if (item.type === "owner_update") update(item);
    else intake(item);
  }
  reopenDue();

  for (const [id, place] of working) {
    const original = input.places.get(id);
    if (!original || JSON.stringify(original) !== JSON.stringify(place)) {
      place.updated = nowIso;
      out.places.set(id, place);
    }
  }
  return out;

  /** Decisions on claims waiting in `owner-claims/`, from the review PRs. */
  function approve(): void {
    const seen = input.reviewPrs.map((pr) => ({ pr, ...parseApprovals(pr, input.botLogins) }));
    for (const waiting of input.awaiting) {
      const id = waiting.item.id;
      const mine = seen.filter((s) => s.listed.includes(id));
      const merged = mine.find((s) => s.pr.state === "MERGED" && s.ticked.includes(id));
      const refusedMerge = mine.find((s) => s.pr.state === "MERGED");
      const closed = mine.find((s) => s.pr.state === "CLOSED");
      if (merged) {
        grant(waiting, merged.pr.number);
      } else if (refusedMerge) {
        out.approvals.push({ claim: id, outcome: "refused", reason: `not ticked when review PR #${refusedMerge.pr.number} was merged` });
      } else if (closed) {
        out.approvals.push({ claim: id, outcome: "refused", reason: `review PR #${closed.pr.number} was closed without merging` });
      } else if (now - Date.parse(waiting.sent) > DECISION_DAYS * DAY_MS) {
        out.approvals.push({ claim: id, outcome: "refused", reason: `no decision within ${DECISION_DAYS} days` });
      }
    }
  }

  function grant(waiting: AwaitingClaim, prNumber: number): void {
    const { item } = waiting;
    const target = item.type === "owner_listing" ? waiting.place : resolvePlace(waiting.place, input.places);
    if (target === undefined) {
      out.approvals.push({ claim: item.id, outcome: "refused", reason: `place ${waiting.place} is no longer in the data` });
      return;
    }
    const previous = owners.get(target);
    const owner: OwnerRecord = {
      place: target,
      claim: item.id,
      token_sha256: item.token_sha256,
      approved: today,
      email: item.owner.email,
      name: item.owner.name,
    };
    owners.set(target, owner);
    out.owners.set(target, owner);
    const replaces = previous && previous.claim !== item.id ? `; it replaces claim ${previous.claim} approved ${previous.approved}` : "";

    if (item.type === "owner_listing") {
      if (!input.places.has(target) && !working.has(target)) working.set(target, farmStay(item, target));
      note(target, `owner listing ${item.id} approved on review PR #${prNumber}: new farm stay "${item.listing.name}"${replaces}`, true, [item.id]);
    } else {
      record(target).owner_verified = true;
      note(target, `owner claim ${item.id} approved on review PR #${prNumber}${replaces}`, true, [item.id]);
    }
    out.approvals.push({ claim: item.id, outcome: "approved", reason: `approved on review PR #${prNumber}` });
  }

  function farmStay(item: Listing, id: string): Place {
    const facts: Record<string, FactValue> = { ...item.listing.facts, entry: "private", booking_required: true };
    const sources: Place["fact_sources"] = {};
    for (const k of Object.keys(facts)) (sources as Record<string, string>)[k] = "owner";
    sources.name = "owner";
    sources.location = "owner";
    const place: Place = {
      id,
      name: item.listing.name,
      kind: FARM_STAY_KIND,
      group: input.kinds?.get(FARM_STAY_KIND) ?? "overnight",
      location: { lat: roundCoord(item.location.lat), lon: roundCoord(item.location.lon) },
      osm: null,
      facts,
      fact_sources: sources,
      status: "open",
      rating: null,
      owner_verified: true,
      updated: nowIso,
    };
    if (item.listing.description) {
      place.description = item.listing.description;
      sources.description = "owner";
    }
    return place;
  }

  /** A new claim or listing: wait for the code, then send it to a person. */
  function intake(item: Claim | Listing): void {
    let target: string | undefined;
    if (item.type === "owner_claim") {
      target = resolvePlace(item.place, input.places);
      if (target === undefined) {
        decide(item, "refused", `place ${item.place} is not in the data`);
        return;
      }
    } else {
      const reasons = [...moderateReview(item.listing.name), ...moderateReview(item.listing.description ?? "")];
      if (reasons.length > 0) {
        decide(item, "refused", `listing text contains ${[...new Set(reasons)].join(", ")}`);
        return;
      }
      target = `ocdb_${item.id.replace(/^fb_/, "")}`;
    }
    const proof = input.proofs.get(item.id) ?? { found: false, checked: nowIso, detail: "not checked" };
    const age = now - Date.parse(item.received);
    if (!proof.found && age < PROOF_WAIT_DAYS * DAY_MS) {
      decide(item, "waiting", `waiting for ${item.code} to appear at the proof address`, item.place);
      return;
    }
    const current = owners.get(target);
    out.forReview.push({
      claim: item.id,
      type: item.type,
      place: target,
      proof,
      proofUrl: item.claim.proof_url,
      code: item.code,
      replaces: current ? { claim: current.claim, approved: current.approved } : undefined,
      ...(item.type === "owner_listing"
        ? {
            listing: {
              name: item.listing.name,
              ...(item.listing.description ? { description: item.listing.description } : {}),
              facts: { ...item.listing.facts } as Record<string, FactValue>,
              location: { lat: roundCoord(item.location.lat), lon: roundCoord(item.location.lon) },
            },
          }
        : {}),
    });
    out.awaiting.push({ item, place: target, sent: nowIso, proof });
    decide(item, "awaiting_approval", proof.found ? "sent to a person with the code found" : "sent to a person; the code was not found");
  }

  /** An update from a verified owner. */
  function update(item: Update): void {
    const target = resolvePlace(item.place, input.places);
    if (target === undefined) {
      decide(item, "refused", `place ${item.place} is not in the data`);
      return;
    }
    const owner = owners.get(target) ?? owners.get(item.place);
    if (!owner) {
      decide(item, "refused", "the place has no approved owner");
      return;
    }
    if (owner.token_sha256 !== item.token_sha256) {
      const elsewhere = [...owners.values()].some((o) => o.token_sha256 === item.token_sha256);
      decide(item, "refused", elsewhere ? "the token belongs to another place" : "the token does not match the approved owner");
      return;
    }
    const u = item.update;
    if (u.description) {
      const reasons = moderateReview(u.description);
      if (reasons.length > 0) {
        decide(item, "refused", `description contains ${reasons.join(", ")}`);
        return;
      }
    }
    if (u.status === "temporarily_closed" && (!u.reopens || u.reopens <= today)) {
      decide(item, "refused", `the reopens date ${u.reopens ?? "(none)"} has already passed`);
      return;
    }

    const place = record(target);
    const changed: string[] = [];
    let forPerson = false;
    for (const [fact, value] of Object.entries(u.facts ?? {})) {
      (place.facts as Record<string, FactValue>)[fact] = value as FactValue;
      (place.fact_sources as Record<string, string>)[fact] = "owner";
      changed.push(fact);
    }
    if (u.description !== undefined) {
      if (u.description === "") {
        delete place.description;
        delete place.fact_sources.description;
      } else {
        place.description = u.description;
        place.fact_sources.description = "owner";
      }
      changed.push("description");
    }
    if (u.status === "temporarily_closed") {
      place.status = "temporarily_closed";
      place.reopens = u.reopens!;
      place.fact_sources.status = "owner";
      changed.push(`status temporarily_closed until ${u.reopens}`);
    } else if (u.status === "open") {
      if (place.status === "temporarily_closed" || place.status === "reported_closed") {
        place.status = "open";
        delete place.reopens;
        place.fact_sources.status = "owner";
        changed.push("status open");
      } else if (place.status === "closed") {
        out.edits.push({ kind: "note", place: target, feedback: item.id });
        note(target, "the owner says this closed place is open again (check before reopening)", false, [item.id]);
        forPerson = true;
      }
    }
    if (u.name !== undefined) {
      out.edits.push({ kind: "name", place: target, name: u.name, feedback: item.id, source: "owner" });
      note(target, `the owner renames it "${u.name}" (check before merging)`, false, [item.id]);
      forPerson = true;
    }
    if (u.location !== undefined) {
      const location = { lat: roundCoord(u.location.lat), lon: roundCoord(u.location.lon) };
      out.edits.push({ kind: "location", place: target, location, feedback: item.id, source: "owner" });
      note(target, `the owner moves it to ${location.lat}, ${location.lon} (check before merging)`, false, [item.id]);
      forPerson = true;
    }
    if (changed.length > 0) {
      place.owner_verified = true;
      note(target, `owner update: ${changed.join(", ")}`, true, [item.id]);
    }
    decide(
      item,
      forPerson ? "needs_review" : "applied",
      forPerson ? "owner update applied, with a change for a person to check" : "owner update applied",
      target,
    );
  }

  /** Temporary closures whose reopening day has come. */
  function reopenDue(): void {
    for (const [id, original] of input.places) {
      const place = working.get(id) ?? original;
      if (place.status !== "temporarily_closed" || !place.reopens || place.reopens > today) continue;
      const r = record(id);
      r.status = "open";
      delete r.reopens;
      note(id, `reopened on ${original.reopens ?? today}, the date the owner gave`, true, []);
    }
  }
}
