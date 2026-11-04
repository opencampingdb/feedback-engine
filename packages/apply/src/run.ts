import { resolve } from "node:path";
import { isOwnerSubmission, type StoredFeedback, type StoredOwnerSubmission } from "@opencampingdb/feedback";
import {
  DataRepo,
  moveDecided,
  readAwaiting,
  readHistory,
  readOwners,
  readPending,
  refuseMalformed,
  settleAwaiting,
  writeOwners,
} from "./io.js";
import { applyOwnerRules, PROOF_WAIT_DAYS, type ReviewPr } from "./owners.js";
import { autoPrBody, reviewPrBody } from "./prbody.js";
import { checkProof as realCheckProof, type ProofResult } from "./proof.js";
import { applyEdit, applyHeldReview, applyRules, newPlaceIdOf, resolvePlace, WINDOW_DAYS, type Decision } from "./rules.js";
import type { RecentList } from "./recent.js";
import type { Fee, Place, Review } from "./types.js";

export interface RunOptions {
  inbox: string;
  /**
   * Checkout of `data` for automatic changes: the `feedback/auto` branch when
   * its PR is open, otherwise `main`. The rules read the current data here.
   */
  data: string;
  /**
   * Checkout of `data` for changes a person decides on: the `feedback/review`
   * branch when its PR is open, otherwise `main`. Defaults to `data`, which
   * puts both kinds of change in one tree (handy when running by hand).
   */
  reviewData?: string;
  /** Recent PRs from `feedback/review`, to read owner approvals from. */
  reviewPrs?: readonly ReviewPr[];
  /** Logins whose comments on those PRs count: the bot's. */
  botLogins?: readonly string[];
  /** Checks a proof page. Defaults to fetching it. */
  checkProof?: (url: string, code: string) => Promise<ProofResult>;
  /** Time the run may spend on proof checks, and how many run at once. Defaults to 3 minutes and 4. */
  proofBudget?: { ms: number; concurrency: number };
  /** Time of the run. Defaults to now. */
  now?: Date;
  /**
   * A checkout of Open Camping DB's data, read only, for an app's own photo
   * repository. When set, `data` and `reviewData` hold only photos and
   * moderation files, places come from here, and anything in the inbox that
   * isn't a photo, photo report or photo erasure is refused.
   */
  places?: string;
  /** Licence id for new photo lines. Defaults to CC-BY-4.0. */
  photoLicence?: string;
  /**
   * The intake's recent list. Feedback about a new place on it that is not in
   * the data yet stays in `pending/`, and so does all feedback about places
   * not in the data when the list cannot be read. Left out, that feedback is
   * refused.
   */
  recentList?: RecentList;
}

export interface RunSummary {
  run_at: string;
  /** Files changed in the automatic checkout. */
  auto_changed: boolean;
  /** Files changed in the review checkout, or items for a person to read. */
  review_changed: boolean;
  /** The review PR gains owner claims or listings (label `owner-claim`). */
  owner_claims: boolean;
  inbox_changed: boolean;
  counts: Record<Decision["outcome"], number>;
  auto_files: string[];
  review_files: string[];
  /** Empty when `auto_changed` is false. */
  auto_pr_body: string;
  /** Empty when `review_changed` is false. */
  review_pr_body: string;
  /** New places this run wrote into the automatic checkout for the first time. */
  new_places: string[];
  /**
   * Feedback this run decided other than applying it: refused, for a person,
   * or an owner claim sent. Sorted. The intake takes any recent change it put
   * live for one of them off the list.
   */
  not_applied: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const PROOF_BUDGET = { ms: 3 * 60_000, concurrency: 4 };

/**
 * One apply run. Writes automatic changes to `data`, review edits to
 * `reviewData`, owner records and claims to the inbox, and moves decided inbox
 * files. Running it again with no new inbox files writes nothing: decided
 * items have left `pending/`, waiting items decide the same way, and every
 * write is skipped when the file already holds that content.
 */
export async function run(options: RunOptions): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const runAt = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  // One extra day so an item received just after midnight UTC 90 days ago is still found.
  const sinceDay = new Date(now.getTime() - (WINDOW_DAYS + 1) * DAY_MS).toISOString().slice(0, 10);
  const checkProof = options.checkProof ?? ((url: string, code: string) => realCheckProof(url, code));

  const { files: pendingFiles, malformed } = await readPending(options.inbox);
  const photoTypes = new Set(["photo", "photo_report", "photo_erasure"]);
  const photosOnly = options.places !== undefined;
  // A photo repository takes photos only: everything else is refused here.
  const notPhotos: Decision[] = photosOnly
    ? pendingFiles
        .map((f) => f.item)
        .filter((i) => isOwnerSubmission(i) || !photoTypes.has(i.type))
        .map((i) => ({ id: i.id, place: (i.place as string | null) ?? null, outcome: "refused" as const, reason: "this repository takes photos only" }))
    : [];
  const refusedIds = new Set(notPhotos.map((d) => d.id));
  const items = pendingFiles.map((f) => f.item).filter((i) => !refusedIds.has(i.id));
  const crowd = items.filter((i): i is StoredFeedback => !isOwnerSubmission(i));
  const ownerItems = items.filter((i): i is StoredOwnerSubmission => isOwnerSubmission(i));
  const history = await readHistory(options.inbox, sinceDay);
  const owners = await readOwners(options.inbox);
  const awaitingClaims = await readAwaiting(options.inbox);
  const auto = new DataRepo(options.data);
  const sameTree = !options.reviewData || resolve(options.reviewData) === resolve(options.data);
  const review = sameTree ? auto : new DataRepo(options.reviewData!);
  // Where place records are read: Open Camping DB's data, or the photo repository's own checkout.
  const placeSource = photosOnly ? new DataRepo(options.places!) : auto;
  const kinds = await placeSource.kinds();

  // Every record the rules may read, following merged ids to their targets.
  const wanted = new Set<string>([
    ...crowd.map((p) => p.place),
    // A new place's own record, when an earlier run already wrote it.
    ...crowd.filter((p) => p.type === "report" && p.report.kind === "new_place").map(newPlaceIdOf),
    ...ownerItems.map((p) => p.place),
    ...awaitingClaims.map((a) => a.place),
    ...owners.keys(),
  ].filter((p): p is string => typeof p === "string"));
  const places = new Map<string, Place>();
  for (let round = 0; round < 10 && wanted.size > 0; round++) {
    const loaded = await placeSource.places(wanted);
    wanted.clear();
    for (const [id, record] of loaded) {
      places.set(id, record);
      if (record.status === "merged" && record.merged_into && !places.has(record.merged_into)) wanted.add(record.merged_into);
    }
  }

  // Review lines of every place a review or a review report is about, following merged ids.
  const reviewIds = new Set(
    crowd
      .filter((p) => p.type === "review" || p.type === "review_report")
      .map((p) => resolvePlace(p.place, places))
      .filter((p): p is string => p !== undefined),
  );
  const reviews = new Map<string, Review[]>();
  for (const id of reviewIds) reviews.set(id, await auto.reviews(id));
  // Fee lines of every place a fee is about, following merged ids.
  const feeIds = new Set(
    crowd
      .filter((p) => p.type === "fee")
      .map((p) => resolvePlace(p.place, places))
      .filter((p): p is string => p !== undefined),
  );
  const fees = new Map<string, Fee[]>();
  for (const id of feeIds) fees.set(id, await auto.fees(id));
  const blocked = await auto.blocked();
  const reviewers = await auto.reviewers(blocked);
  // Every photo line, when anything in this run is about photos.
  const photos = crowd.some((p) => photoTypes.has(p.type)) ? await auto.allPhotos() : [];

  // Every record, for the duplicates check, when anything in this run is about a new place.
  const aboutNewPlaces = crowd.some(
    (p) =>
      p.type === "withdraw" ||
      (p.type === "report" && (p.report.kind === "new_place" || p.report.kind === "remove")) ||
      (p.type === "check" && p.place !== null && places.get(p.place)?.standing === "held"),
  );
  const everyPlace = aboutNewPlaces && !photosOnly ? await auto.allPlaces() : undefined;

  // The recent list, asked for only when something is about a place not in the data.
  const aboutMissingPlace = crowd.some((p) => typeof p.place === "string" && !places.has(p.place));
  const recent: ReadonlySet<string> | "unreadable" | undefined =
    options.recentList && aboutMissingPlace
      ? await options.recentList.ids().catch((error: unknown) => {
          console.warn(`the recent list could not be read, so feedback about places not in the data waits: ${String(error)}`);
          return "unreadable" as const;
        })
      : undefined;

  const crowdResult = applyRules({
    now: runAt,
    pending: crowd,
    history,
    places,
    reviews: (id) => reviews.get(id) ?? [],
    fees: (id) => fees.get(id) ?? [],
    ...(kinds ? { kinds } : {}),
    blocked,
    reviewers,
    photos,
    ...(options.photoLicence ? { photoLicence: options.photoLicence } : {}),
    ...(everyPlace ? { everyPlace } : {}),
    ...(recent !== undefined ? { recent } : {}),
  });

  // Proof pages for claims and listings still in pending/, oldest first, within
  // the budget. Claims for a missing place are refused and claims past the wait
  // go to a person without a fresh check. Claims left unchecked keep waiting.
  const proofs = new Map<string, ProofResult>();
  const budget = options.proofBudget ?? PROOF_BUDGET;
  const toCheck = ownerItems
    .filter((i): i is Exclude<StoredOwnerSubmission, { type: "owner_update" }> => i.type !== "owner_update")
    .filter((i) => i.type === "owner_listing" || resolvePlace(i.place, places) !== undefined)
    .filter((i) => now.getTime() - Date.parse(i.received) < PROOF_WAIT_DAYS * DAY_MS)
    .sort((a, b) => a.received.localeCompare(b.received) || a.id.localeCompare(b.id));
  const deadline = Date.now() + budget.ms;
  let next = 0;
  await Promise.all(
    Array.from({ length: budget.concurrency }, async () => {
      while (next < toCheck.length && Date.now() < deadline) {
        const item = toCheck[next++]!;
        // A failed check leaves only that claim unproven.
        const proof = await checkProof(item.claim.proof_url, item.code).catch(
          (): ProofResult => ({ found: false, checked: runAt, detail: "the page could not be checked" }),
        );
        proofs.set(item.id, proof);
      }
    }),
  );

  // Owner rules see the records as the crowd rules left them.
  const afterCrowd = new Map([...places, ...crowdResult.places]);
  const ownerResult = applyOwnerRules({
    now: runAt,
    pending: ownerItems,
    proofs,
    awaiting: awaitingClaims,
    reviewPrs: options.reviewPrs ?? [],
    botLogins: options.botLogins ?? [],
    owners,
    places: afterCrowd,
    ...(kinds ? { kinds } : {}),
  });

  const autoPlaces = new Map([...crowdResult.places, ...ownerResult.places]);
  const autoFiles = await auto.writePlaces(autoPlaces.values());
  for (const [placeId, lines] of crowdResult.reviews) {
    const written = await auto.writeReviews(placeId, lines);
    if (written) autoFiles.push(written);
  }
  for (const [placeId, lines] of crowdResult.fees) {
    const written = await auto.writeFees(placeId, lines);
    if (written) autoFiles.push(written);
  }
  for (const [placeId, lines] of crowdResult.photos) {
    const written = await auto.writePhotos(placeId, lines);
    if (written) autoFiles.push(written);
  }
  const removedWritten = await auto.addRemovedPhotos(crowdResult.removedPhotos);
  if (removedWritten) autoFiles.push(removedWritten);
  // Withdrawn new places leave both checkouts.
  const reviewFiles: string[] = [];
  for (const placeId of crowdResult.removed) {
    const gone = await auto.removePlace(placeId);
    if (gone) autoFiles.push(gone);
    const draft = sameTree ? undefined : await review.removePlace(placeId);
    if (draft) reviewFiles.push(draft);
  }
  const newPlaces = [...crowdResult.places.values()].filter((p) => p.standing !== undefined && !places.has(p.id)).map((p) => p.id);

  // Review edits, applied on top of whatever the review checkout already holds.
  const effective = new Set<string>();
  for (const edit of [...crowdResult.edits, ...ownerResult.edits]) {
    if (edit.kind === "note") {
      effective.add(edit.feedback);
      continue;
    }
    if (edit.kind === "photo") {
      // A held photo: its line waits in the review checkout.
      const current = (await (photosOnly ? placeSource : review).places([edit.place])).get(edit.place);
      const lines = await review.photos(edit.place);
      if (!current || current.status === "merged" || lines.some((p) => p.id === edit.photo.id)) continue;
      const written = await review.writePhotos(edit.place, [...lines, edit.photo]);
      if (written) reviewFiles.push(written);
      effective.add(edit.feedback);
      continue;
    }
    if (edit.kind === "photo_erasure") {
      // Held photos from the contributor leave the review checkout too.
      if (sameTree) continue;
      for (const placeId of new Set((await review.allPhotos()).filter((p) => p.contributor === edit.contributor).map((p) => p.place))) {
        const lines = await review.photos(placeId);
        const written = await review.writePhotos(placeId, lines.filter((p) => p.contributor !== edit.contributor));
        if (written) reviewFiles.push(written);
      }
      continue;
    }
    if (edit.kind === "review") {
      // A held review: its line, and the place's rating, wait in the review checkout.
      const current = (await review.places([edit.place])).get(edit.place);
      const held = current && current.status !== "merged" ? applyHeldReview(await review.reviews(edit.place), edit.review, await review.blocked()) : undefined;
      if (!current || !held) continue;
      const written = await review.writeReviews(edit.place, held.lines);
      if (written) reviewFiles.push(written);
      if (JSON.stringify(current.rating) !== JSON.stringify(held.rating)) {
        reviewFiles.push(...(await review.writePlaces([{ ...current, rating: held.rating, updated: runAt }])));
      }
      effective.add(edit.feedback);
      continue;
    }
    const placeId = edit.kind === "new_place" ? edit.record.id : edit.place;
    const current = (await review.places([placeId])).get(placeId);
    const next = applyEdit(current, edit, runAt);
    if (!next) continue;
    reviewFiles.push(...(await review.writePlaces([next])));
    effective.add(edit.feedback);
  }

  const decisions = [...notPhotos, ...crowdResult.decisions, ...ownerResult.decisions] as Decision[];
  const refusedMalformed = await refuseMalformed(options.inbox, malformed, runAt);
  const moved = await moveDecided(options.inbox, pendingFiles, decisions, runAt, ownerResult.awaiting);
  const ownersWritten = await writeOwners(options.inbox, ownerResult.owners.values());
  const settled = await settleAwaiting(options.inbox, ownerResult.approvals, runAt);

  const counts = { applied: 0, refused: 0, needs_review: 0, waiting: 0, awaiting_approval: 0 };
  for (const d of decisions) counts[d.outcome] += 1;
  counts.refused += refusedMalformed;
  const allPlaces = new Map([...afterCrowd, ...autoPlaces]);
  const changes = [...crowdResult.changes, ...ownerResult.changes];
  const autoChanges = changes.filter((c) => c.automatic);
  const reviewChanges = changes.filter((c) => !c.automatic && c.feedback.some((f) => effective.has(f)));
  const autoChanged = autoFiles.length > 0;
  const ownerClaims = ownerResult.forReview.length > 0;
  // A held case is listed when this run wrote its place or its edit for a person.
  const held = crowdResult.held.filter((h) => crowdResult.places.has(h.place) || h.feedback.some((f) => effective.has(f)));
  const reviewChanged = reviewFiles.length > 0 || reviewChanges.length > 0 || ownerClaims || held.length > 0;

  return {
    run_at: runAt,
    auto_changed: autoChanged,
    review_changed: reviewChanged,
    owner_claims: ownerClaims,
    inbox_changed: refusedMalformed + moved + ownersWritten + settled > 0,
    counts,
    auto_files: autoFiles,
    review_files: reviewFiles,
    auto_pr_body: autoChanged ? autoPrBody(runAt, autoChanges, decisions, allPlaces) : "",
    review_pr_body: reviewChanged ? reviewPrBody(runAt, reviewChanges, allPlaces, ownerResult.forReview, held) : "",
    new_places: newPlaces,
    not_applied: [...new Set(decisions.filter((d) => d.outcome !== "applied" && d.outcome !== "waiting").map((d) => d.id))].sort(),
  };
}
