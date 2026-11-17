import type { FactValue } from "@opencampingdb/feedback";
import { isBotAuthor, type ReviewPr } from "./owners.js";
import { heldCaseKey, parseHeldCases, type HeldCase, type ReviewDecision } from "./review.js";

/**
 * The AI reviewer's decisions on held cases, as the apply reads them from the
 * review PRs: the `review-decision` lines in comments from the reviewer, each
 * with the held case it decides (from the same PR's `held-case` lines). Only
 * PRs that are open or merged count: a person who closes a review PR without
 * merging it sets every decision on it aside.
 */

/** One decision, with the case it decides. */
export interface ReviewerDecision {
  case: HeldCase;
  decision: ReviewDecision;
}

const DECISION_LINE = /^- review-decision (\{.*\})\s*$/;

/** The `review-decision` lines in `text`: each case key with its decision. Lines that don't parse are skipped. */
function decisionLines(text: string): { key: string; decision: ReviewDecision }[] {
  const out: { key: string; decision: ReviewDecision }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = DECISION_LINE.exec(line);
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]!) as { key?: unknown; decision?: unknown };
      if (typeof value.key === "string" && typeof value.decision === "string") out.push({ key: value.key, decision: value.decision as ReviewDecision });
    } catch {
      // Not a line the reviewer wrote.
    }
  }
  return out;
}

/**
 * The reviewer's decisions on the open and merged PRs in `prs` that the bot
 * opened from the data repository. Decisions count only from comments by
 * `logins` (the apply's bot and the AI reviewer's), and only for a case the
 * same PR lists. The first decision on a case counts, as the reviewer never
 * decides a case twice.
 */
export function reviewerDecisions(prs: readonly ReviewPr[], botLogins: readonly string[], logins: readonly string[]): ReviewerDecision[] {
  const out: ReviewerDecision[] = [];
  const seen = new Set<string>();
  for (const pr of prs) {
    if (pr.isCrossRepository !== false || !isBotAuthor(pr.author, botLogins) || pr.state === "CLOSED") continue;
    const comments = pr.comments.filter((c) => isBotAuthor(c.author, logins));
    const cases = new Map<string, HeldCase>();
    for (const text of [pr.body, ...pr.comments.filter((c) => isBotAuthor(c.author, botLogins)).map((c) => c.body)]) {
      for (const c of parseHeldCases(text)) cases.set(heldCaseKey(c), c);
    }
    for (const comment of comments) {
      for (const { key, decision } of decisionLines(comment.body)) {
        const decided = cases.get(key);
        if (decided === undefined || seen.has(key)) continue;
        seen.add(key);
        out.push({ case: decided, decision });
      }
    }
  }
  return out;
}

/** The feedback ids of the items the reviewer let through on `intake_check` cases: approved, or confirmed for a fact. */
export function releasedByReviewer(decisions: readonly ReviewerDecision[]): Set<string> {
  const out = new Set<string>();
  for (const { case: c, decision } of decisions) {
    if (c.case === "intake_check" && (decision === "approve" || decision === "confirm")) for (const id of c.feedback) out.add(id);
  }
  return out;
}

/**
 * A doubt the reviewer upheld about a contributor's edit: the edit is
 * wrong, so its sender loses trust. `keep_down` of a fact doubts took down
 * (with the value), `dismiss` of a `contact_check` or of an `intake_check`
 * fact, `revert` of a `place_change`, and `take_down` of a new place.
 */
export interface UpheldByReviewer {
  /** The items the case comes from: the edit itself, or (on `keep_down`) the doubts about it. */
  feedback: readonly string[];
  /** On `keep_down`: the value taken down, which the doubts were about. */
  fact?: string;
  value?: FactValue;
  place: string;
  /** On `take_down`: the new place itself was taken down, so its sender loses trust, not the travellers in the case. */
  newPlace?: true;
}

/** The doubts `decisions` upheld (`UpheldByReviewer`). */
export function upheldByReviewer(decisions: readonly ReviewerDecision[]): UpheldByReviewer[] {
  const out: UpheldByReviewer[] = [];
  for (const { case: c, decision } of decisions) {
    const upheld =
      (c.case === "fact_doubted" && decision === "keep_down") ||
      ((c.case === "contact_check" || (c.case === "intake_check" && c.about === "fact")) && decision === "dismiss") ||
      (c.case === "place_change" && decision === "revert") ||
      decision === "take_down";
    if (!upheld) continue;
    out.push({
      feedback: c.feedback,
      place: c.place,
      ...(c.case === "fact_doubted" ? { fact: c.fact!, value: c.value! } : {}),
      ...(decision === "take_down" ? { newPlace: true as const } : {}),
    });
  }
  return out;
}
