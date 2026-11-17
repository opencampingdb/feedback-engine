import { basename, relative, resolve, sep } from "node:path";
import { isOwnerSubmission, type StoredFeedback, type StoredOwnerSubmission } from "@opencampingdb/feedback";
import {
  DataRepo,
  type EarlierFact,
  moveDecided,
  readAwaiting,
  readHistory,
  readOwners,
  readPending,
  readPhotoVotes,
  readPlaceGeometry,
  readNxdomain,
  readRoads,
  readTrust,
  refuseMalformed,
  settleAwaiting,
  writeNxdomain,
  writeOwners,
  writePhotoVotes,
  writeTrust,
} from "./io.js";
import { checkContacts, type Fetch } from "./contact-checks.js";
import {
  evidenceCounts,
  isClosureReport,
  lookUpDomain,
  osmClosureEvidence,
  pruneAnswers,
  recordAnswer,
  websiteDomain,
  type DnsOptions,
  type NxdomainState,
} from "./closure-evidence.js";
import { applyOwnerRules, PROOF_WAIT_DAYS, type ReviewPr } from "./owners.js";
import { idsOnPrs } from "./progress.js";
import { reviewerDecisions } from "./reviewer-decisions.js";
import { autoPrBody, jobSummary, reviewPrTexts } from "./prbody.js";
import { previewUrl, PREVIEW_TTL_SECONDS } from "./preview.js";
import { checkProof as realCheckProof, type ProofResult, type Transport } from "./proof.js";
import { confirmSourceLinks } from "./source-link.js";
import {
  applyEdit,
  applyHeldReview,
  applyRules,
  isVisible,
  newPlaceIdOf,
  photoIdOf,
  ratingOf,
  resolvePlace,
  WINDOW_DAYS,
  type Change,
  type ClosureEvidence,
  type Decision,
} from "./rules.js";
import type { RecentList } from "./recent.js";
import type { Place, Review } from "./types.js";

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
  /**
   * The AI reviewer's GitHub App logins (`<slug>`), when it is not the bot.
   * Its `review-decision` comments on the review PRs are read too: an item
   * it let through counts, and a doubt it upheld withdraws trust.
   */
  reviewerLogins?: readonly string[];
  /** Checks a proof page. Defaults to fetching it. */
  checkProof?: (url: string, code: string) => Promise<ProofResult>;
  /** Time the run may spend on proof checks, and how many run at once. Defaults to 3 minutes and 4. */
  proofBudget?: { ms: number; concurrency: number };
  /** Fetches source link pages (`source-link.ts`). Defaults to node:https with the proof check's safeguards. */
  sourceTransport?: Transport;
  /** Time the run may spend fetching source link pages, and how many at once. Defaults to 2 minutes and 4. */
  sourceBudget?: { ms: number; concurrency: number };
  /** Time of the run. Defaults to now. */
  now?: Date;
  /**
   * A checkout of Open Camping DB's data, read only, for an app's own photo
   * repository. When set, `data` and `reviewData` hold only photos and
   * moderation files, places come from here, and anything in the inbox that
   * isn't a photo, photo report or photo erasure is refused.
   */
  places?: string;
  /**
   * The data repository's geometry sidecar (`pipeline.extract --geometry`).
   * Its major roads keep a new place on the other side of a road from the
   * place it may duplicate from being merged into it. Left out, the run has
   * no road data and merges no duplicate on its own: a reviewer decides.
   */
  geometry?: string;
  /**
   * The land mask (water lines: sea and lakes) and the building footprints
   * (building lines), in the format docs/self-hosting.md describes. With
   * them and `geometry`'s road lines, a new place in the water, on a major
   * road's carriageway or inside a building is held for the AI reviewer as
   * `implausible_location`. Each is optional: a layer left out is not
   * checked, the check passes, and the run logs it.
   */
  landMask?: string;
  buildings?: string;
  /** Licence id for new photo lines. Defaults to CC-BY-4.0. */
  photoLicence?: string;
  /** False publishes a contributor's first photo when SafeSearch passed it. Defaults to true. */
  holdFirstPhoto?: boolean;
  /**
   * The intake's recent list. Feedback about a new place on it that is not in
   * the data yet stays in `pending/`, and so does all feedback about places
   * not in the data when the list cannot be read. Left out, that feedback is
   * refused.
   */
  recentList?: RecentList;
  /**
   * Looks up, in DNS over HTTPS, the website domain of each place a traveller
   * reported closed. NXDOMAIN on two runs at least a day apart counts as a
   * second source for the closure. The first answer is kept in the inbox
   * (`evidence/nxdomain.json`). Off when left out.
   */
  dns?: DnsOptions;
  /**
   * Links to held photos in the review PR: the intake that serves them
   * (`GET /v1/photos/review/...`) and the secret it checks them with. Only
   * for a private data repository, since anyone who can read the PR can open
   * the links. Off when left out.
   */
  reviewPreview?: { url: string; secret: string };
  /**
   * The automatic contact checks (contact-checks.ts), with the fetch they
   * read websites and RDAP with. Each contact fact report is checked before
   * the rules run: one that fails a check is held for the AI reviewer, and
   * one that passes them all follows the two-source rule. Off when left out:
   * an attested contact goes live and one without attestation goes to a
   * person, as before.
   */
  contactChecks?: { fetch: Fetch; budget?: { ms: number; concurrency: number }; timeoutMs?: number };
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
  /** Follow-up comments on the review PR, posted in order after `review_pr_body`, for held and closed cases it had no room for. */
  review_pr_comments: string[];
  /**
   * The owner claims and listings this run moved from `pending/` to
   * `owner-claims/`, as paths in the inbox. They are listed only in the review
   * PR text, so when GitHub refuses that text the workflow moves them back and
   * a later run sends them again.
   */
  claim_moves: { from: string; to: string }[];
  /**
   * The moves from `pending/` of the items whose changes are on the automatic
   * branch. When the automatic PR does not open, or its changes do not land,
   * the workflow moves them back and a later run decides them again. Empty
   * when `auto_changed` is false.
   */
  auto_moves: { from: string; to: string }[];
  /**
   * The moves from `pending/` of the items that reach a person only through
   * the review PR: decided for a person, or behind a review change or a held
   * case, and not behind an automatic change. When the review PR text is not
   * accepted, the workflow moves them back as it does `claim_moves`. Empty
   * when `review_changed` is false.
   */
  review_moves: { from: string; to: string }[];
  /** Every change of the run, for the job summary the PR bodies point to when they are too long to list them all. */
  job_summary: string;
  /** New places this run wrote into the automatic checkout for the first time. */
  new_places: string[];
  /**
   * Feedback this run decided other than applying it: refused, for a person,
   * or an owner claim sent. Sorted. The intake takes any recent change it put
   * live for one of them off the list.
   */
  not_applied: string[];
  /** The ones among `not_applied` this run refused. Only these count against a contributor's track record at the intake. */
  refused: string[];
  /**
   * Every item this run decided, but photos, which apps know by their `pho_`
   * id, in the order they arrived: for the progress the intake keeps
   * (`sendProgress`).
   */
  decisions: RunDecision[];
  /** The photos this run decided, by their feedback id, in the order they arrived: for photo progress (`sendPhotoProgress`). */
  photo_decisions: RunDecision[];
}

/** An item a run decided, as the run summary lists it. */
export type RunDecision = Pick<Decision, "id" | "place" | "outcome" | "reason" | "held_reason">;

const DAY_MS = 24 * 60 * 60 * 1000;
const PROOF_BUDGET = { ms: 3 * 60_000, concurrency: 4 };
const SOURCE_BUDGET = { ms: 2 * 60_000, concurrency: 4 };

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
  const photoTypes = new Set(["photo", "photo_report", "photo_erasure", "photo_removal", "photo_vote"]);
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

  // Every review line, when a contributor erases their reviews: the places they reviewed are read too.
  const erasing = new Set(crowd.filter((p) => p.type === "review_erasure" && p.contributor !== undefined).map((p) => p.contributor as string));
  const allReviews = erasing.size > 0 ? await auto.allReviews() : [];
  const erasedPlaces = new Set(allReviews.filter((r) => erasing.has(r.contributor)).map((r) => r.place));

  // Every photo line, when anything in this run is about photos, or any helpful vote counts (its photo's counts age).
  const photoVotes = await readPhotoVotes(options.inbox);
  const trust = await readTrust(options.inbox);
  // The AI reviewer's decisions on the review PRs, and the items a person turned down on a merged one.
  const botLogins = options.botLogins ?? [];
  const decidedByReviewer = reviewerDecisions(options.reviewPrs ?? [], botLogins, [...botLogins, ...(options.reviewerLogins ?? [])]);
  const mentioned = idsOnPrs(options.reviewPrs ?? [], botLogins);
  const turnedDown = new Set([...mentioned.merged].filter((id) => !mentioned.open.has(id)));
  const turnedDownPlaces = history
    .filter((h) => turnedDown.has(h.id))
    .flatMap((h) => (h.type === "report" && h.report.kind === "new_place" ? [newPlaceIdOf(h)] : [h.place]));
  const photos = crowd.some((p) => photoTypes.has(p.type)) || Object.keys(photoVotes.photos).length > 0 ? await auto.allPhotos() : [];
  // The place a photo named by a removal is filed under, which may have been merged since.
  const removing = new Set(crowd.map((p) => (p.type === "photo_removal" ? p.photo_removal.photo : undefined)));
  const removedFrom = [
    ...photos.filter((p) => removing.has(p.id)).map((p) => p.place),
    ...history.filter((h) => h.type === "photo" && removing.has(photoIdOf(h))).map((h) => h.place),
  ];

  // Every record the rules may read, following merged ids to their targets.
  const wanted = new Set<string>([
    ...erasedPlaces,
    ...removedFrom,
    ...crowd.map((p) => p.place),
    // A new place's own record, when an earlier run already wrote it.
    ...crowd.filter((p) => p.type === "report" && p.report.kind === "new_place").map(newPlaceIdOf),
    ...ownerItems.map((p) => p.place),
    ...awaitingClaims.map((a) => a.place),
    ...owners.keys(),
    // Places travellers reported closed in earlier runs: evidence found since may close them.
    ...(photosOnly ? [] : history.filter(isClosureReport).map((h) => h.place)),
    // Places of edits a person turned down, and of held reports the AI reviewer let through.
    ...(photosOnly ? [] : turnedDownPlaces),
    ...(photosOnly ? [] : decidedByReviewer.map((d) => d.case.place)),
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
  for (const id of erasedPlaces) reviewIds.add(id);
  const reviews = new Map<string, Review[]>();
  for (const id of reviewIds) reviews.set(id, await auto.reviews(id));
  const blocked = await auto.blocked();
  const reviewers = await auto.reviewers(blocked);
  const removedReviews = crowd.some((p) => p.type === "review") ? await auto.removedReviews() : new Set<string>();
  // Every record, for the duplicates check, when anything in this run is about a new place.
  const aboutNewPlaces = crowd.some(
    (p) =>
      p.type === "withdraw" ||
      (p.type === "report" && (p.report.kind === "new_place" || p.report.kind === "remove")) ||
      (p.type === "check" && p.place !== null && places.get(p.place)?.standing === "held"),
  );
  const everyPlace = aboutNewPlaces && !photosOnly ? await auto.allPlaces() : undefined;
  // What a merge of a duplicate new place checks: pairs a person found separate, and major roads.
  const distinct = everyPlace ? await auto.distinct() : undefined;
  const roads = everyPlace && options.geometry ? await readRoads(options.geometry) : undefined;
  // The geometry near each new place in this run, for the plausibility check.
  const newPlacePoints = photosOnly
    ? []
    : crowd.flatMap((p) => (p.type === "report" && p.report.kind === "new_place" && p.location ? [p.location] : []));
  const placeGeometry = newPlacePoints.length > 0 ? await readPlaceGeometry(options, newPlacePoints) : undefined;

  // The recent list, asked for only when something is about a place not in the data.
  const aboutMissingPlace = crowd.some((p) => typeof p.place === "string" && !places.has(p.place));
  const recent: ReadonlySet<string> | "unreadable" | undefined =
    options.recentList && aboutMissingPlace
      ? await options.recentList.ids().catch((error: unknown) => {
          console.warn(`the recent list could not be read, so feedback about places not in the data waits: ${String(error)}`);
          return "unreadable" as const;
        })
      : undefined;

  // The do-not-match list, when anything in this run says a Commons photo is not of a place.
  const doNotMatch = crowd.some((p) => p.type === "report" && p.report.kind === "commons_mismatch") && !photosOnly ? await auto.doNotMatch() : undefined;

  // Earlier values of facts that doubts and contact reports name and their place no longer has: a
  // run that published its automatic changes may have taken them down and stopped before it
  // recorded its inbox moves.
  const earlierFacts = new Map<string, Map<string, EarlierFact>>();
  for (const p of crowd) {
    if (p.type !== "report" || (p.report.kind !== "doubt" && p.report.kind !== "contact") || typeof p.place !== "string" || photosOnly) continue;
    const record = places.get(p.place);
    const fact = p.report.fact as string;
    if (!record || (record.facts as Record<string, unknown>)[fact] !== undefined || earlierFacts.get(p.place)?.has(fact)) continue;
    const earlier = await auto.earlierFact(p.place, fact);
    if (earlier) earlierFacts.set(p.place, (earlierFacts.get(p.place) ?? new Map()).set(fact, earlier));
  }

  // The contact checks, against each place as the data has it before this run.
  const contactChecks = options.contactChecks && !photosOnly
    ? await checkContacts(crowd, places, {
        fetch: options.contactChecks.fetch,
        now: () => Date.now(),
        ...(options.contactChecks.budget ? { budget: options.contactChecks.budget } : {}),
        ...(options.contactChecks.timeoutMs !== undefined ? { timeoutMs: options.contactChecks.timeoutMs } : {}),
      })
    : undefined;
  // Source links on fact reports: a page that shows the reported value counts as a second source.
  // The host is checked again against the place's website in the data, whatever the intake knew.
  const linked = photosOnly
    ? []
    : crowd.flatMap((p) => {
        if (p.type !== "report" || p.report.kind !== "fact" || typeof p.report.source !== "string") return [];
        const placeId = resolvePlace(p.place, places);
        const record = placeId === undefined ? undefined : places.get(placeId);
        if (!record) return [];
        return [{ id: p.id, fact: p.report.fact as string, value: p.report.value, source: p.report.source, website: record.facts.website }];
      });
  const sourceConfirmed =
    linked.length > 0
      ? await confirmSourceLinks(linked, { ...(options.sourceBudget ?? SOURCE_BUDGET), ...(options.sourceTransport ? { transport: options.sourceTransport } : {}) })
      : new Set<string>();

  // Evidence of closure for places travellers reported closed in the window, not owner-managed.
  const nxdomain = options.dns && !photosOnly ? await readNxdomain(options.inbox) : undefined;
  const closureEvidence = photosOnly
    ? new Map<string, ClosureEvidence[]>()
    : await findClosureEvidence(auto, [...crowd, ...history], places, runAt, options.dns && nxdomain ? { ...options.dns, state: nxdomain } : undefined);

  const crowdResult = applyRules({
    now: runAt,
    pending: crowd,
    history,
    places,
    reviews: (id) => reviews.get(id) ?? [],
    ...(kinds ? { kinds } : {}),
    blocked,
    removedReviews,
    reviewers,
    allReviews,
    photos,
    photoVotes,
    trust,
    ...(decidedByReviewer.length > 0 ? { reviewerDecisions: decidedByReviewer } : {}),
    ...(turnedDown.size > 0 ? { turnedDown } : {}),
    ...(options.photoLicence ? { photoLicence: options.photoLicence } : {}),
    ...(options.holdFirstPhoto === false ? { holdFirstPhoto: false } : {}),
    ...(everyPlace ? { everyPlace } : {}),
    ...(distinct ? { distinct } : {}),
    ...(roads ? { roads } : {}),
    ...(placeGeometry ? { placeGeometry } : {}),
    ...(doNotMatch ? { doNotMatch } : {}),
    ...(recent !== undefined ? { recent } : {}),
    ...(earlierFacts.size > 0 ? { earlierFacts } : {}),
    ...(contactChecks ? { contactChecks } : {}),
    ...(closureEvidence.size > 0 ? { closureEvidence } : {}),
    ...(sourceConfirmed.size > 0 ? { sourceConfirmed } : {}),
  });

  // Proof pages for claims and listings still in pending/, oldest first, within
  // the budget. Claims for a missing place are refused. A claim left unchecked
  // keeps waiting, past its proof wait too, so a person always sees a fresh check.
  const proofs = new Map<string, ProofResult>();
  const budget = options.proofBudget ?? PROOF_BUDGET;
  const toCheck = ownerItems
    .filter((i): i is Exclude<StoredOwnerSubmission, { type: "owner_update" }> => i.type !== "owner_update")
    .filter((i) => i.type === "owner_listing" || resolvePlace(i.place, places) !== undefined)
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
  for (const [placeId, lines] of crowdResult.photos) {
    const written = await auto.writePhotos(placeId, lines);
    if (written) autoFiles.push(written);
  }
  const removedWritten = await auto.addRemovedPhotos(crowdResult.removedPhotos);
  if (removedWritten) autoFiles.push(removedWritten);
  const doNotMatchWritten = await auto.addDoNotMatch(crowdResult.doNotMatch);
  if (doNotMatchWritten) autoFiles.push(doNotMatchWritten);
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
    if (edit.kind === "review_erasure") {
      // Held reviews from the contributor leave the review checkout, and the ratings there follow.
      if (sameTree) continue;
      const heldBlocked = await review.blocked();
      for (const placeId of new Set((await review.allReviews()).filter((r) => r.contributor === edit.contributor).map((r) => r.place))) {
        const lines = (await review.reviews(placeId)).filter((r) => r.contributor !== edit.contributor);
        const written = await review.writeReviews(placeId, lines);
        if (written) reviewFiles.push(written);
        const current = (await review.places([placeId])).get(placeId);
        const rating = ratingOf(lines.filter((r) => isVisible(r, heldBlocked)));
        if (current && current.status !== "merged" && JSON.stringify(current.rating) !== JSON.stringify(rating)) {
          reviewFiles.push(...(await review.writePlaces([{ ...current, rating, updated: runAt }])));
        }
      }
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
    if (edit.kind === "photo_removal") {
      // A held photo its contributor removed leaves the review checkout.
      if (sameTree) continue;
      // The held line may be filed under a place that was merged into this one since.
      const filedUnder = (await review.photos(edit.place)).some((p) => p.id === edit.photo)
        ? edit.place
        : (await review.allPhotos()).find((p) => p.id === edit.photo)?.place;
      if (filedUnder === undefined) continue;
      const lines = await review.photos(filedUnder);
      const written = await review.writePhotos(filedUnder, lines.filter((p) => p.id !== edit.photo));
      if (written) reviewFiles.push(written);
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
  const photoIds = new Set(crowd.filter((i) => i.type === "photo").map((i) => i.id));
  const refusedMalformed = await refuseMalformed(options.inbox, malformed, runAt);
  const moved = await moveDecided(options.inbox, pendingFiles, decisions, runAt, ownerResult.awaiting);
  const ownersWritten = await writeOwners(options.inbox, ownerResult.owners.values());
  const settled = await settleAwaiting(options.inbox, ownerResult.approvals, runAt);
  const votesWritten = await writePhotoVotes(options.inbox, crowdResult.photoVotes);
  const trustWritten = await writeTrust(options.inbox, crowdResult.trust);
  const nxdomainWritten = nxdomain ? await writeNxdomain(options.inbox, nxdomain) : false;

  const counts = { applied: 0, refused: 0, needs_review: 0, waiting: 0, awaiting_approval: 0 };
  for (const d of decisions) counts[d.outcome] += 1;
  counts.refused += refusedMalformed;
  const allPlaces = new Map([...afterCrowd, ...autoPlaces]);
  const changes = [...crowdResult.changes, ...ownerResult.changes];
  const autoChanges = changes.filter((c) => c.automatic);
  const reviewChanges = changes.filter((c) => !c.automatic && c.feedback.some((f) => effective.has(f)));
  const autoChanged = autoFiles.length > 0;
  const ownerClaims = ownerResult.forReview.length > 0;
  // A held case is listed when this run wrote its place or its edit for a person, or repeated a takedown already in the data.
  const held = crowdResult.held.filter((h) => crowdResult.places.has(h.place) || h.feedback.some((f) => effective.has(f)) || crowdResult.replayed.includes(h));
  const closed = crowdResult.closed;
  const reviewChanged = reviewFiles.length > 0 || reviewChanges.length > 0 || ownerClaims || held.length > 0 || closed.length > 0;

  const reviewTexts = reviewChanged
    ? reviewPrTexts(runAt, reviewChanges, allPlaces, ownerResult.forReview, held, await previewLinks(reviewChanges, options.reviewPreview, now), closed)
    : { body: "", comments: [] };
  const sentToPerson = new Set(ownerResult.awaiting.map((a) => a.item.id));
  const inboxPath = (path: string) => relative(options.inbox, path).split(sep).join("/");
  const claimMoves = pendingFiles
    .filter((f) => sentToPerson.has(f.item.id) && decisions.some((d) => d.id === f.item.id && d.outcome === "awaiting_approval"))
    .map((f) => ({ from: inboxPath(f.path), to: `owner-claims/${basename(f.path)}` }));

  // Each decided pending file's move, as moveDecided made it.
  const movesOf = (ids: ReadonlySet<string>) =>
    pendingFiles.flatMap((f) => {
      const outcome = decisions.find((d) => d.id === f.item.id)?.outcome;
      if (!ids.has(f.item.id) || (outcome !== "applied" && outcome !== "needs_review" && outcome !== "refused")) return [];
      return [{ from: inboxPath(f.path), to: `${outcome === "refused" ? "refused" : "applied"}/${f.day}/${basename(f.path)}` }];
    });
  const autoIds = new Set(autoChanged ? autoChanges.flatMap((c) => c.feedback) : []);
  const reviewOnlyIds = new Set(
    reviewChanged
      ? [
          ...decisions.filter((d) => d.outcome === "needs_review").map((d) => d.id),
          ...reviewChanges.flatMap((c) => c.feedback),
          ...held.flatMap((h) => h.feedback),
        ].filter((id) => !autoIds.has(id))
      : [],
  );

  return {
    run_at: runAt,
    auto_changed: autoChanged,
    review_changed: reviewChanged,
    owner_claims: ownerClaims,
    inbox_changed: refusedMalformed + moved + ownersWritten + settled > 0 || votesWritten || trustWritten || nxdomainWritten,
    counts,
    auto_files: autoFiles,
    review_files: reviewFiles,
    auto_pr_body: autoChanged ? autoPrBody(runAt, autoChanges, decisions, allPlaces) : "",
    review_pr_body: reviewTexts.body,
    review_pr_comments: reviewTexts.comments,
    claim_moves: claimMoves,
    auto_moves: movesOf(autoIds),
    review_moves: movesOf(reviewOnlyIds),
    job_summary: autoChanged || reviewChanged ? jobSummary(runAt, autoChanged ? autoChanges : [], reviewChanged ? reviewChanges : [], allPlaces) : "",
    new_places: newPlaces,
    not_applied: [...new Set(decisions.filter((d) => d.outcome !== "applied" && d.outcome !== "waiting").map((d) => d.id))].sort(),
    refused: [...new Set(decisions.filter((d) => d.outcome === "refused").map((d) => d.id))].sort(),
    decisions: decisions.filter((d) => !photoIds.has(d.id)).map((d) => ({ id: d.id, place: d.place, outcome: d.outcome, reason: d.reason })),
    photo_decisions: decisions
      .filter((d) => photoIds.has(d.id))
      .map((d) => ({ id: d.id, place: d.place, outcome: d.outcome, reason: d.reason, ...(d.held_reason ? { held_reason: d.held_reason } : {}) })),
  };
}

/** Evidence of closure for each place with a traveller's closure in `items` that evidence could still close. */
async function findClosureEvidence(
  data: DataRepo,
  items: readonly StoredFeedback[],
  places: ReadonlyMap<string, Place>,
  now: string,
  dns: (DnsOptions & { state: NxdomainState }) | undefined,
): Promise<Map<string, ClosureEvidence[]>> {
  const out = new Map<string, ClosureEvidence[]>();
  const add = (id: string, evidence: ClosureEvidence) => out.set(id, [...(out.get(id) ?? []), evidence]);
  const candidates = [...new Set(items.filter(isClosureReport).map((i) => i.place))]
    .map((id) => (typeof id === "string" ? places.get(id) : undefined))
    .filter((p): p is Place => p !== undefined && evidenceCounts(p));
  if (candidates.length > 0) {
    const osmHistory = await data.osmHistory();
    for (const place of candidates) {
      const osm = osmClosureEvidence(place, osmHistory);
      if (osm) add(place.id, osm);
    }
  }
  if (dns) {
    // One lookup per domain, one at a time: a run has few places reported closed.
    const answers = new Map<string, ClosureEvidence | undefined>();
    for (const place of candidates) {
      const domain = websiteDomain(place.facts.website);
      if (domain === undefined) continue;
      if (!answers.has(domain)) answers.set(domain, recordAnswer(dns.state, domain, await lookUpDomain(domain, dns), now));
      const evidence = answers.get(domain);
      if (evidence) add(place.id, evidence);
    }
    pruneAnswers(dns.state, now);
  }
  return out;
}

/** A link to each held photo in `changes`, signed to work for 30 days from `now`. Empty when previews are off. */
async function previewLinks(changes: readonly Change[], preview: RunOptions["reviewPreview"], now: Date): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  if (!preview) return links;
  const expires = Math.floor(now.getTime() / 1000) + PREVIEW_TTL_SECONDS;
  for (const c of changes) {
    if (c.photo && !links.has(c.photo)) links.set(c.photo, await previewUrl(preview.url, preview.secret, c.photo, "full", expires));
  }
  return links;
}
