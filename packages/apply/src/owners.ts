import type { FactName, FactValue, StoredOwnerSubmission } from "@opencampingdb/feedback";
import { newProblems, placeProblems } from "./data-check.js";
import { factsClearedBy } from "./decide.js";
import { moderateReview } from "./moderation.js";
import type { ProofResult } from "./proof.js";
import { resolvePlace, type Change, type Decision, type ReviewEdit } from "./rules.js";
import { roundCoord } from "./serialise.js";
import { dropSource, setSource } from "./sources.js";
import type { Place, SourceKey } from "./types.js";

/**
 * The owner rules from SPEC "Owners", as pure functions.
 *
 * - A claim or listing waits in `pending/` until its code is on the proof page
 *   (or 7 days pass), then goes to the `feedback/review` PR with an unticked
 *   "Approve owner claim fb_..." box, and moves to `owner-claims/` in the inbox.
 * - A person decides by ticking the claim's "Approve" or "Refuse" box and
 *   merging that PR. The next run reads the merged PR. For an approval it
 *   writes `owners/<place id>.json` in the inbox and puts `owner_verified` (or
 *   the new farm stay) on the `feedback/auto` branch. A claim with neither box
 *   ticked, or both, when its PR is merged or closed is listed again on the
 *   next review PR. A box ticked after the PR was merged does not count.
 *   Nothing about an owner reaches `data` before a person approves.
 * - An owner update whose token hash matches `owners/<place id>.json` is
 *   applied at once, except name and location changes, which go to a person.
 * - A place whose owner record was deleted loses `owner_verified` at the next run.
 * - A temporary closure ends by itself on its `reopens` date.
 */

export const PROOF_WAIT_DAYS = 7;
export const DECISION_DAYS = 60;
/**
 * Most claims and listings one run sends to a person, so their approval boxes
 * always fit in the review PR body. The rest wait in `pending/`, oldest
 * first, for the next run.
 */
export const MAX_CLAIMS_PER_RUN = 20;
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

/**
 * Who wrote a PR or a comment. `type` is the account type (`Bot`, `User`,
 * `Organization`), as GitHub's GraphQL API gives it in `__typename`.
 */
export interface PrAuthor {
  login: string;
  type?: string;
}

export interface ReviewPr {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  body: string;
  /** When the PR was merged, ISO 8601. */
  mergedAt?: string | null;
  /** When the body was last edited, which ticking a box in it does. */
  bodyEditedAt?: string | null;
  /** `editedAt` is when the comment was last edited, which ticking a box in it does. */
  comments: { author: PrAuthor | null; body: string; editedAt?: string | null }[];
  /** Who opened the PR. Only PRs the bot opened count. */
  author: PrAuthor | null;
  /** True when the PR comes from a fork. Those never count. */
  isCrossRepository: boolean;
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
  /** Listed before, on review PR `again`, which was merged or closed with no decision on it. */
  again?: number;
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

const APPROVAL_LINE = /^- \[([ xX])\] (Approve|Refuse) owner (?:claim|listing) (fb_[0-9A-HJKMNP-TV-Z]{26})\b/;

/**
 * Whether `author` is the bot GitHub App named by one of `botLogins` (its
 * slug). Only forms a person's account cannot hold count: an account of type
 * `Bot` with the slug or `<slug>[bot]` as its login, `<slug>[bot]` as GitHub's
 * REST API writes it, or `app/<slug>` as the GitHub CLI writes it. A login
 * equal to the bare slug with no account type never counts.
 */
export function isBotAuthor(author: PrAuthor | null | undefined, botLogins: readonly string[]): boolean {
  if (!author) return false;
  return botLogins.some(
    (slug) =>
      author.login === `${slug}[bot]` || author.login === `app/${slug}` || (author.type === "Bot" && author.login === slug),
  );
}

/** The PRs in `prs`, in order, that the bot opened from the data repository itself (`isBotAuthor`). */
export function botPrs<Pr extends Pick<ReviewPr, "isCrossRepository" | "author">>(prs: readonly Pr[], botLogins: readonly string[]): Pr[] {
  return prs.filter((pr) => pr.isCrossRepository === false && isBotAuthor(pr.author, botLogins));
}

/**
 * The decision boxes in a review PR: in its body, and in comments written by
 * the bot. Only a box at the start of a line counts, and lines end only at a
 * newline, so text quoted from a traveller or an owner (always on one line,
 * after the box) cannot add or tick one. A PR from a fork, or one the bot did
 * not open, has none. In a merged PR, the ticks of a text edited after the
 * merge do not count, because ticking a box edits the text: its claims are
 * still `listed`. `ticked` are the claims with "Approve" ticked, `refused`
 * those with "Refuse" ticked.
 */
export function parseApprovals(pr: ReviewPr, botLogins: readonly string[]): { ticked: string[]; refused: string[]; listed: string[] } {
  const ticked: string[] = [];
  const refused: string[] = [];
  const listed: string[] = [];
  if (pr.isCrossRepository !== false || !isBotAuthor(pr.author, botLogins)) return { ticked, refused, listed };
  const late = (editedAt: string | null | undefined) =>
    pr.state === "MERGED" && typeof pr.mergedAt === "string" && typeof editedAt === "string" && Date.parse(editedAt) > Date.parse(pr.mergedAt);
  const texts = [
    { text: pr.body, late: late(pr.bodyEditedAt) },
    ...pr.comments.filter((c) => isBotAuthor(c.author, botLogins)).map((c) => ({ text: c.body, late: late(c.editedAt) })),
  ];
  for (const { text, late: ticksIgnored } of texts) {
    for (const line of text.split("\n")) {
      const m = APPROVAL_LINE.exec(line.replace(/\r$/, ""));
      if (!m) continue;
      const id = m[3]!;
      if (!listed.includes(id)) listed.push(id);
      if (m[1] === " " || ticksIgnored) continue;
      const into = m[2] === "Approve" ? ticked : refused;
      if (!into.includes(id)) into.push(id);
    }
  }
  return { ticked, refused, listed };
}

/** The two boxes for a claim in the review PR, as two lines. Keep in step with APPROVAL_LINE. */
export function approvalLine(claim: ClaimForReview, summary: string): string {
  const what = claim.type === "owner_listing" ? "listing" : "claim";
  return `- [ ] Approve owner ${what} ${claim.claim}: ${summary}\n- [ ] Refuse owner ${what} ${claim.claim}`;
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
  unverify();
  reopenDue();

  for (const [id, place] of working) {
    const original = input.places.get(id);
    if (!original || JSON.stringify(original) !== JSON.stringify(place)) {
      place.updated = nowIso;
      out.places.set(id, place);
    }
  }
  return out;

  /**
   * Decisions on claims waiting in `owner-claims/`, from the review PRs. Only a
   * merged PR decides, by one ticked box. A claim no open PR lists and no
   * merged PR decided is listed again, so merging or closing a PR without
   * looking at a claim never refuses it.
   */
  function approve(): void {
    const seen = input.reviewPrs.map((pr) => ({ pr, ...parseApprovals(pr, input.botLogins) }));
    for (const waiting of input.awaiting) {
      const id = waiting.item.id;
      const mine = seen.filter((s) => s.listed.includes(id));
      const merged = mine.filter((s) => s.pr.state === "MERGED");
      const approved = merged.find((s) => s.ticked.includes(id) && !s.refused.includes(id));
      const refused = merged.find((s) => s.refused.includes(id) && !s.ticked.includes(id));
      if (approved) {
        grant(waiting, approved.pr.number);
      } else if (refused) {
        out.approvals.push({ claim: id, outcome: "refused", reason: `refused on review PR #${refused.pr.number}` });
      } else if (now - Date.parse(waiting.sent) > DECISION_DAYS * DAY_MS) {
        out.approvals.push({ claim: id, outcome: "refused", reason: `no decision within ${DECISION_DAYS} days` });
      } else if (mine.length > 0 && !mine.some((s) => s.pr.state === "OPEN") && out.forReview.length < MAX_CLAIMS_PER_RUN) {
        const { item } = waiting;
        const current = owners.get(waiting.place);
        const last = mine[0]!.pr.number;
        out.forReview.push({
          claim: id,
          type: item.type,
          place: waiting.place,
          proof: waiting.proof,
          proofUrl: item.claim.proof_url,
          code: item.code,
          replaces: current && current.claim !== id ? { claim: current.claim, approved: current.approved } : undefined,
          again: last,
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
      if (!input.places.has(target) && !working.has(target)) {
        const stay = farmStay(item, target);
        const problems = placeProblems(stay, { now: nowIso, ...(input.kinds ? { kinds: input.kinds } : {}) });
        if (problems.length > 0) {
          // Sent before the listing check: the record waits for a person, who writes it by hand.
          out.edits.push({ kind: "note", place: target, feedback: item.id });
          note(target, `owner listing ${item.id} approved, but its farm stay would fail the data checks (${problems.join("; ")}): add the record by hand`, false, [item.id]);
        } else {
          working.set(target, stay);
        }
      }
      note(target, `owner listing ${item.id} approved on review PR #${prNumber}: new farm stay "${item.listing.name}"${replaces}`, true, [item.id]);
    } else {
      record(target).owner_verified = true;
      note(target, `owner claim ${item.id} approved on review PR #${prNumber}${replaces}`, true, [item.id]);
    }
    out.approvals.push({ claim: item.id, outcome: "approved", reason: `approved on review PR #${prNumber}` });
  }

  function farmStay(item: Listing, id: string): Place {
    const facts: Record<string, FactValue> = { ...item.listing.facts, entry: "private", booking_required: true };
    const place: Place = {
      id,
      name: item.listing.name,
      kind: FARM_STAY_KIND,
      group: input.kinds?.get(FARM_STAY_KIND) ?? "overnight",
      location: { lat: roundCoord(item.location.lat), lon: roundCoord(item.location.lon) },
      osm: null,
      facts,
      fact_sources: {},
      status: "open",
      rating: null,
      owner_verified: true,
      updated: nowIso,
    };
    const owned: SourceKey[] = [...(Object.keys(facts) as SourceKey[]), "name", "location"];
    if (item.listing.description) {
      place.description = item.listing.description;
      owned.push("description");
    }
    for (const key of owned) setSource(place, key, "owner", nowIso);
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
      // The farm stay a person would approve must be one the data validator accepts.
      const problems = placeProblems(farmStay(item, target), { now: nowIso, ...(input.kinds ? { kinds: input.kinds } : {}) });
      if (problems.length > 0) {
        decide(item, "refused", `the listing would fail the data checks: ${problems.join("; ")}`);
        return;
      }
    }
    const proof = input.proofs.get(item.id);
    if (!proof) {
      // Its clock does not run out for want of a check: a person sees only a proof checked this run.
      decide(item, "waiting", "waiting for its proof address to be checked", item.place);
      return;
    }
    const age = now - Date.parse(item.received);
    if (!proof.found && age < PROOF_WAIT_DAYS * DAY_MS) {
      decide(item, "waiting", `waiting for ${item.code} to appear at the proof address`, item.place);
      return;
    }
    if (out.forReview.length >= MAX_CLAIMS_PER_RUN) {
      decide(item, "waiting", `waiting for room on the review PR: ${MAX_CLAIMS_PER_RUN} claims go to a person each run`, item.place);
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
    // Only a person reopens a closed place, so it cannot close temporarily and reopen by itself.
    if (u.status === "temporarily_closed" && (working.get(target) ?? input.places.get(target))?.status === "closed") {
      decide(item, "refused", "the place is closed: a person must reopen it before it can close temporarily");
      return;
    }

    // The update is worked out on a copy, and written only when the data validator would accept the result.
    const current = working.get(target) ?? input.places.get(target)!;
    const place = structuredClone(current);
    const changed: string[] = [];
    let forPerson = false;
    for (const [fact, value] of Object.entries(u.facts ?? {})) {
      // pets_months goes when pets is no longer seasonal, unless the update sets it too.
      for (const cleared of factsClearedBy(place.facts, fact as FactName, value as FactValue)) {
        if ((u.facts as Record<string, unknown>)[cleared] !== undefined) continue;
        delete (place.facts as Record<string, FactValue | undefined>)[cleared];
        dropSource(place, cleared);
      }
      (place.facts as Record<string, FactValue>)[fact] = value as FactValue;
      setSource(place, fact as SourceKey, "owner", nowIso);
      changed.push(fact);
    }
    if (u.description !== undefined) {
      if (u.description === "") {
        delete place.description;
        dropSource(place, "description");
      } else {
        place.description = u.description;
        setSource(place, "description", "owner", nowIso);
      }
      changed.push("description");
    }
    if (u.status === "temporarily_closed") {
      place.status = "temporarily_closed";
      place.reopens = u.reopens!;
      setSource(place, "status", "owner", nowIso);
      changed.push(`status temporarily_closed until ${u.reopens}`);
    } else if (u.status === "open") {
      if (place.status === "temporarily_closed" || place.status === "reported_closed") {
        place.status = "open";
        delete place.reopens;
        setSource(place, "status", "owner", nowIso);
        changed.push("status open");
      } else if (place.status === "closed") {
        out.edits.push({ kind: "note", place: target, feedback: item.id });
        note(target, "the owner says this closed place is open again (check before reopening)", false, [item.id]);
        forPerson = true;
      }
    }
    if (changed.length > 0) {
      place.owner_verified = true;
      const check = { now: nowIso, ...(input.kinds ? { kinds: input.kinds } : {}) };
      const problems = newProblems(placeProblems(current, check), placeProblems({ ...place, updated: nowIso }, check));
      if (problems.length > 0) {
        const why = `the update would fail the data checks (${problems.join("; ")})`;
        out.edits.push({ kind: "note", place: target, feedback: item.id });
        note(target, `owner update: ${why}, so a person decides (apply it by hand if it is right)`, false, [item.id]);
        decide(item, "needs_review", `${why}, so a person decides`, target);
        return;
      }
      working.set(target, place);
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
    if (changed.length > 0) note(target, `owner update: ${changed.join(", ")}`, true, [item.id]);
    decide(
      item,
      forPerson ? "needs_review" : "applied",
      forPerson ? "owner update applied, with a change for a person to check" : "owner update applied",
      target,
    );
  }

  /**
   * Places marked `owner_verified` with no owner record: someone removed the
   * owner by deleting `owners/<place id>.json`. The mark comes off, so one
   * step ends a claim. Values the owner set stay until a person edits them.
   */
  function unverify(): void {
    for (const [id, original] of input.places) {
      const place = working.get(id) ?? original;
      if (place.owner_verified !== true || owners.has(id)) continue;
      delete record(id).owner_verified;
      note(id, "the place has no owner record any more, so it is no longer owner verified", true, []);
    }
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
