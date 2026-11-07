import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { AUTO_PR_CLOSED, REVIEWER_DECLINED } from "../src/progress.js";
import { PHOTO_SENT_FILE, sendPhotoProgress, type PhotoProgressUpdate } from "../src/photo-progress.js";
import type { ReviewPr } from "../src/owners.js";
import { intakeRecentStore } from "../src/recent.js";

const PLACE = "ocdb_01JBXK3M8Q4R5S6T7V8W9X0YZA";
const RUN = "2026-11-01T00:00:00Z";
/** The run time sent with every update: the run's `now`. */
const RUN_AT = "2026-11-03T00:00:00Z";
const NOW = new Date("2026-11-03T00:00:00Z");
const CONTRIBUTOR = "ctr_0123456789abcdef";
const ulid = (n: number) => `01JC${String(n).padStart(22, "0")}`;
const fb = (n: number) => `fb_${ulid(n)}`;
const pho = (n: number) => `pho_${ulid(n)}`;
const BOT = "example-bot";

const execFileP = promisify(execFile);
/** Writes `file` in the git repository `repo` and commits it, with the commit time `at`. */
async function commitIn(repo: string, file: string, content: string, at: string): Promise<void> {
  const env = { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at };
  const g = (...args: string[]) => execFileP("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { env });
  await mkdir(repo, { recursive: true });
  await g("init", "-q");
  await mkdir(dirname(join(repo, file)), { recursive: true });
  await writeFile(join(repo, file), content);
  await g("add", "-A");
  await g("commit", "-q", "-m", `Add ${file}`);
}

/** A photo as the inbox keeps it once a run decided it. */
function photo(n: number, result: string, reason: string, { held, ...extra }: Record<string, unknown> = {}): StoredFeedback {
  return {
    id: fb(n),
    received: "2026-10-31T00:00:00Z",
    app: "example-app",
    type: "photo",
    place: PLACE,
    device: "aaaa",
    contributor: CONTRIBUTOR,
    app_version: "1.0.0",
    consent: true,
    photo: { full_sha256: "a".repeat(64), full_bytes: 100, thumb_sha256: "b".repeat(64), thumb_bytes: 10, width: 1600, height: 1200 },
    outcome: { result, reason, run: RUN, ...(held ? { held_reason: held } : {}) },
    ...extra,
  } as unknown as StoredFeedback;
}

/** One line of photos/<place>.ndjson. */
const line = (n: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id: pho(n), place: PLACE, contributor: CONTRIBUTOR, created: "2026-10-31T00:00:00Z", app: "example-app", licence: "CC-BY-4.0", width: 1600, height: 1200, sha256: "a".repeat(64), ...extra });

const pr = (state: ReviewPr["state"], ids: string[]): ReviewPr =>
  ({ number: 1, state, body: `Feedback (${ids.join(", ")})`, comments: [], author: { login: `${BOT}[bot]` }, isCrossRepository: false }) as unknown as ReviewPr;

describe("sendPhotoProgress", () => {
  let root: string;
  let inbox: string;
  let mainDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ocdb-photo-progress-"));
    inbox = join(root, "inbox");
    mainDir = join(root, "main");
    await commitIn(mainDir, "README.md", "photo records", "2026-10-01T00:00:00Z");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const inInbox = async (item: StoredFeedback) => {
    const folder = (item as unknown as { outcome: { result: string } }).outcome.result === "refused" ? "refused" : "applied";
    const path = join(inbox, folder, item.received.slice(0, 10), `${item.id}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(item)}\n`);
  };
  const store = () => ({ photoProgress: vi.fn(async (_items: readonly PhotoProgressUpdate[]) => {}) });
  const send = (s: ReturnType<typeof store>, extra: Partial<Parameters<typeof sendPhotoProgress>[0]> = {}) =>
    sendPhotoProgress({ inbox, main: mainDir, store: s, decisions: [], botLogins: [BOT], now: NOW, ...extra });
  const sentOf = (s: ReturnType<typeof store>) => s.photoProgress.mock.calls.flatMap((c) => c[0]);
  const byId = (s: ReturnType<typeof store>) => Object.fromEntries(sentOf(s).map((u) => [u.id, u]));

  it("is in_data once its line is on the records repository's main, dated by the commit that put it there", async () => {
    await inInbox(photo(1, "applied", "photo accepted"));
    await inInbox(photo(2, "needs_review", "first photo from this contributor, so a person checks it"));
    await commitIn(mainDir, `photos/${PLACE}.ndjson`, `${line(1)}\n${line(2)}\n`, "2026-11-02T06:00:00Z");
    const s = store();
    await send(s);
    expect(byId(s)).toEqual({
      [pho(1)]: { id: pho(1), state: "in_data", reason: "photo accepted", place: PLACE, decided_at: RUN, in_data_at: "2026-11-02T06:00:00Z", run_at: RUN_AT },
      [pho(2)]: { id: pho(2), state: "in_data", reason: "first photo from this contributor, so a person checks it", place: PLACE, decided_at: RUN, in_data_at: "2026-11-02T06:00:00Z", run_at: RUN_AT },
    });
  });

  it("is accepted while the automatic PR waits, and held with its reason while the review PR waits", async () => {
    await inInbox(photo(1, "applied", "photo accepted"));
    await inInbox(photo(2, "needs_review", "first photo from this contributor, so a person checks it", { held: "first_photo" }));
    await inInbox(photo(3, "needs_review", "the same file was sent for another place, so a person checks it", { held: "same_file" }));
    await inInbox(photo(4, "needs_review", "SafeSearch rates it adult LIKELY, violence UNLIKELY, racy POSSIBLE, so a person checks it", { held: "safesearch" }));
    await inInbox(photo(5, "needs_review", "SafeSearch could not check it, so a person checks it", { held: "check_unavailable" }));
    const s = store();
    await send(s, {
      reviewPrs: [pr("OPEN", [fb(2), fb(3), fb(4), fb(5), fb(6)])],
      autoPrs: [pr("OPEN", [fb(1)])],
      decisions: [{ id: fb(6), place: PLACE, outcome: "needs_review", reason: "first photo from this contributor, so a person checks it", held_reason: "first_photo" }],
    });
    const sent = byId(s);
    expect(sent[pho(1)]).toMatchObject({ state: "accepted" });
    expect(sent[pho(2)]).toMatchObject({ state: "held", held_reason: "first_photo", reason: "first photo from this contributor, so a person checks it" });
    expect(sent[pho(3)]).toMatchObject({ state: "held", held_reason: "same_file" });
    expect(sent[pho(4)]).toMatchObject({ state: "held", held_reason: "safesearch" });
    expect(sent[pho(5)]).toMatchObject({ state: "held", held_reason: "check_unavailable" });
    expect(sent[pho(6)]).toMatchObject({ state: "held", held_reason: "first_photo" });
  });

  it("takes the held reason from the decision, never from the words of its reason", async () => {
    await inInbox(photo(1, "needs_review", "first photo from this contributor, so a person checks it"));
    const s = store();
    await send(s, { reviewPrs: [pr("OPEN", [fb(1)])] });
    expect(byId(s)[pho(1)]).toMatchObject({ state: "held" });
    expect(byId(s)[pho(1)]).not.toHaveProperty("held_reason");
  });

  it("is refused by the rules with their reason, and waiting while its new place is not in the data", async () => {
    await inInbox(photo(1, "refused", "the contributor asked for their photos to be removed"));
    const s = store();
    await send(s, { decisions: [{ id: fb(2), place: PLACE, outcome: "waiting", reason: "place ocdb_... is a new place not in the data yet" }] });
    expect(byId(s)).toEqual({
      [pho(1)]: { id: pho(1), state: "refused", by: "rules", reason: "the contributor asked for their photos to be removed", place: PLACE, decided_at: RUN, run_at: RUN_AT },
      [pho(2)]: { id: pho(2), state: "waiting", reason: "place ocdb_... is a new place not in the data yet", place: PLACE, decided_at: "2026-11-03T00:00:00Z", run_at: RUN_AT },
    });
  });

  it("is refused by the reviewer when a person merged or closed the PR without it", async () => {
    await inInbox(photo(1, "needs_review", "first photo from this contributor, so a person checks it"));
    await inInbox(photo(2, "applied", "photo accepted"));
    await inInbox(photo(3, "applied", "photo accepted"));
    const s = store();
    await send(s, { reviewPrs: [pr("MERGED", [fb(1)])], autoPrs: [pr("CLOSED", [fb(2)]), pr("MERGED", [fb(3)])] });
    const sent = byId(s);
    expect(sent[pho(1)]).toMatchObject({ state: "refused", by: "reviewer", reason: REVIEWER_DECLINED });
    expect(sent[pho(2)]).toMatchObject({ state: "refused", by: "reviewer", reason: AUTO_PR_CLOSED });
    // Published, then taken out of the records by hand.
    expect(sent[pho(3)]).toMatchObject({ state: "refused", by: "reviewer", reason: "a person took it out of the photo records" });
  });

  it("is held after reports hide it, and refused once a person removes it or blocks the contributor", async () => {
    for (const n of [1, 2, 3, 4, 5]) await inInbox(photo(n, "applied", "photo accepted", n === 5 ? { contributor: "ctr_fedcba9876543210" } : {}));
    await commitIn(
      mainDir,
      `photos/${PLACE}.ndjson`,
      `${line(1, { hidden: "reported" })}\n${line(2, { hidden: "moderator" })}\n${line(5, { contributor: "ctr_fedcba9876543210" })}\n`,
      "2026-11-02T06:00:00Z",
    );
    await commitIn(
      mainDir,
      "moderation/removed_photos.json",
      JSON.stringify({ photos: [{ photo: pho(3), removed: "2026-11-02T00:00:00Z", reason: "moderator" }, { photo: pho(4), removed: "2026-11-02T00:00:00Z", reason: "erased" }] }),
      "2026-11-02T07:00:00Z",
    );
    await commitIn(mainDir, "moderation/blocked_contributors.json", JSON.stringify({ contributors: [{ contributor: "ctr_fedcba9876543210", added: "2026-11-02", reason: "spam" }] }), "2026-11-02T08:00:00Z");
    const s = store();
    await send(s);
    const sent = byId(s);
    expect(sent[pho(1)]).toEqual({ id: pho(1), state: "held", held_reason: "reported", reason: "hidden after reports, until a person decides", place: PLACE, decided_at: RUN, run_at: RUN_AT });
    expect(sent[pho(2)]).toMatchObject({ state: "refused", by: "reviewer", reason: "hidden by a reviewer" });
    expect(sent[pho(3)]).toMatchObject({ state: "refused", by: "reviewer", reason: "removed by a reviewer" });
    expect(sent[pho(4)]).toMatchObject({ state: "refused", by: "rules", reason: "removed at the contributor's request" });
    expect(sent[pho(5)]).toMatchObject({ state: "refused", by: "reviewer", reason: "the contributor is blocked" });
  });

  it("leaves out photos decided more than 90 days ago that main no longer names", async () => {
    await inInbox({ ...photo(2, "applied", "photo accepted"), received: "2026-07-01T00:00:00Z" } as unknown as StoredFeedback);
    const s = store();
    expect(await send(s)).toMatchObject({ sent: 0 });
    expect(s.photoProgress).not.toHaveBeenCalled();
  });

  describe("photo reports and erasures", () => {
    const OTHER = "ctr_fedcba9876543210";
    /** A report of photo `photoN`, as the inbox keeps it once a run decided it. */
    const report = (n: number, photoN: number, result: string, reason: string): StoredFeedback =>
      ({
        id: fb(n),
        received: "2026-10-31T00:00:00Z",
        app: "example-app",
        type: "photo_report",
        place: PLACE,
        device: "bbbb",
        contributor: OTHER,
        app_version: "1.0.0",
        consent: true,
        photo_report: { photo: pho(photoN), reason: "offensive" },
        outcome: { result, reason, run: RUN },
      }) as unknown as StoredFeedback;
    const erasure = (n: number, result: string, reason: string, contributor: string | undefined = CONTRIBUTOR): StoredFeedback =>
      ({
        id: fb(n),
        received: "2026-10-31T00:00:00Z",
        app: "example-app",
        type: "photo_erasure",
        place: null,
        device: "aaaa",
        ...(contributor ? { contributor } : {}),
        app_version: "1.0.0",
        consent: true,
        outcome: { result, reason, run: RUN },
      }) as unknown as StoredFeedback;

    it("sends a report held while a person reads it, in_data once main hides or removes the photo, and refused when the person kept it", async () => {
      await inInbox(report(11, 1, "needs_review", "photo reports are read by a person"));
      await inInbox(report(12, 2, "needs_review", "photo reports are read by a person"));
      await inInbox(report(13, 3, "needs_review", "photo reports are read by a person"));
      await inInbox(report(14, 4, "needs_review", "photo reports are read by a person"));
      await inInbox(report(15, 9, "refused", "photo pho_... is not in the data for this place"));
      await commitIn(mainDir, `photos/${PLACE}.ndjson`, `${line(1)}
${line(2, { hidden: "reported" })}
${line(4)}
`, "2026-11-02T06:00:00Z");
      await commitIn(mainDir, "moderation/removed_photos.json", JSON.stringify({ photos: [{ photo: pho(3), removed: "2026-11-02T00:00:00Z", reason: "moderator" }] }), "2026-11-02T07:00:00Z");
      const s = store();
      await send(s, { reviewPrs: [pr("OPEN", [fb(11), fb(12), fb(13)]), pr("MERGED", [fb(14)])] });
      const sent = byId(s);
      expect(sent[fb(11)]).toEqual({ id: fb(11), state: "held", reason: "photo reports are read by a person", place: PLACE, decided_at: RUN, run_at: RUN_AT });
      expect(sent[fb(12)]).toEqual({ id: fb(12), state: "in_data", reason: "photo reports are read by a person", place: PLACE, decided_at: RUN, in_data_at: "2026-11-02T06:00:00Z", run_at: RUN_AT });
      expect(sent[fb(13)]).toMatchObject({ state: "in_data", in_data_at: "2026-11-02T07:00:00Z" });
      expect(sent[fb(14)]).toMatchObject({ state: "refused", by: "reviewer", reason: REVIEWER_DECLINED });
      expect(sent[fb(15)]).toMatchObject({ state: "refused", by: "rules", reason: "photo pho_... is not in the data for this place" });
    });

    it("sends an erasure accepted until main has none of the contributor's photos, then in_data, and refused when its PR closed", async () => {
      await inInbox(erasure(21, "applied", "photos removed at the contributor's request, 1 published"));
      await inInbox(erasure(22, "applied", "photos removed at the contributor's request, 0 published", OTHER));
      await inInbox(erasure(23, "refused", "erasure has no contributor", undefined));
      await commitIn(mainDir, `photos/${PLACE}.ndjson`, `${line(1)}
`, "2026-11-02T06:00:00Z");
      const waiting = store();
      await send(waiting, { autoPrs: [pr("OPEN", [fb(21)])] });
      expect(byId(waiting)[fb(21)]).toMatchObject({ state: "accepted" });
      expect(byId(waiting)[fb(22)]).toMatchObject({ state: "in_data" });
      expect(byId(waiting)[fb(23)]).toMatchObject({ state: "refused", by: "rules", reason: "erasure has no contributor" });

      await commitIn(mainDir, `photos/${PLACE}.ndjson`, "", "2026-11-02T08:00:00Z");
      await commitIn(mainDir, "moderation/removed_photos.json", JSON.stringify({ photos: [{ photo: pho(1), removed: "2026-11-02T08:00:00Z", reason: "erased" }] }), "2026-11-02T08:00:00Z");
      const done = store();
      await send(done, { now: new Date("2026-11-03T01:00:00Z") });
      expect(byId(done)[fb(21)]).toMatchObject({ state: "in_data", in_data_at: "2026-11-02T08:00:00Z" });
    });

    it("sends an erasure refused by the reviewer when its automatic PR closed without merging", async () => {
      await inInbox(erasure(21, "applied", "photos removed at the contributor's request, 1 published"));
      await commitIn(mainDir, `photos/${PLACE}.ndjson`, `${line(1)}
`, "2026-11-02T06:00:00Z");
      const s = store();
      await send(s, { autoPrs: [pr("CLOSED", [fb(21)])] });
      expect(byId(s)[fb(21)]).toMatchObject({ state: "refused", by: "reviewer", reason: AUTO_PR_CLOSED });
    });
  });

  describe("the watermark", () => {
    const at = (iso: string) => new Date(iso);

    it("sends nothing on a second run when nothing changed, and records what it sent in the inbox", async () => {
      await inInbox(photo(1, "needs_review", "first photo from this contributor, so a person checks it", { held: "first_photo" }));
      const first = store();
      expect(await send(first, { now: at("2026-11-03T00:00:00Z") })).toEqual({ sent: 1, failed: 0, recorded: true });
      expect(JSON.parse(await readFile(join(inbox, PHOTO_SENT_FILE), "utf8"))).toEqual({ reconciled_at: "2026-11-03T00:00:00Z", items: { [pho(1)]: "held:first_photo" } });
      const second = store();
      expect(await send(second, { now: at("2026-11-03T01:00:00Z") })).toEqual({ sent: 0, failed: 0, recorded: false });
      expect(second.photoProgress).not.toHaveBeenCalled();
    });

    it("sends a photo again when it goes live, is hidden after reports or is removed", async () => {
      await inInbox(photo(1, "needs_review", "first photo from this contributor, so a person checks it"));
      await inInbox(photo(2, "needs_review", "first photo from this contributor, so a person checks it"));
      await send(store(), { now: at("2026-11-03T00:00:00Z") });

      await commitIn(mainDir, `photos/${PLACE}.ndjson`, `${line(1)}\n`, "2026-11-03T00:30:00Z");
      const live = store();
      await send(live, { now: at("2026-11-03T01:00:00Z") });
      expect(sentOf(live).map((u) => `${u.id}:${u.state}`)).toEqual([`${pho(1)}:in_data`]);

      await commitIn(mainDir, `photos/${PLACE}.ndjson`, `${line(1, { hidden: "reported" })}\n`, "2026-11-03T01:30:00Z");
      const hidden = store();
      await send(hidden, { now: at("2026-11-03T02:00:00Z") });
      expect(sentOf(hidden).map((u) => `${u.id}:${u.state}:${u.held_reason}`)).toEqual([`${pho(1)}:held:reported`]);

      await commitIn(mainDir, `photos/${PLACE}.ndjson`, "", "2026-11-03T02:30:00Z");
      await commitIn(mainDir, "moderation/removed_photos.json", JSON.stringify({ photos: [{ photo: pho(1), removed: "2026-11-03T02:30:00Z", reason: "moderator" }] }), "2026-11-03T02:30:00Z");
      const removed = store();
      await send(removed, { now: at("2026-11-03T03:00:00Z") });
      expect(sentOf(removed).map((u) => `${u.id}:${u.state}:${u.by}`)).toEqual([`${pho(1)}:refused:reviewer`]);
    });

    it("sends a failed batch again on the next run, and every photo on the first run after midnight UTC each Monday", async () => {
      await inInbox(photo(1, "applied", "photo accepted"));
      const failing = { photoProgress: vi.fn(async () => Promise.reject(new Error("down"))) };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await sendPhotoProgress({ inbox, main: mainDir, store: failing, decisions: [], now: at("2026-11-03T00:00:00Z") })).toMatchObject({ sent: 0, failed: 1 });
      warn.mockRestore();
      const retry = store();
      expect(await send(retry, { now: at("2026-11-03T01:00:00Z") })).toMatchObject({ sent: 1 });
      // 2026-11-09 is a Monday.
      const monday = store();
      expect(await send(monday, { now: at("2026-11-09T00:30:00Z") })).toMatchObject({ sent: 1 });
      const later = store();
      expect(await send(later, { now: at("2026-11-09T01:30:00Z") })).toMatchObject({ sent: 0 });
    });
  });

  it("sends the run's time with every update, so the intake can refuse an older run's", async () => {
    await inInbox(photo(1, "applied", "photo accepted"));
    await inInbox(photo(2, "refused", "photo has no contributor"));
    const s = store();
    await send(s, { now: new Date("2026-11-03T04:05:06.789Z") });
    expect(sentOf(s).map((u) => u.run_at)).toEqual(["2026-11-03T04:05:06Z", "2026-11-03T04:05:06Z"]);
  });

  it("sends at most 500 photos a call", async () => {
    for (let n = 1; n <= 501; n++) await inInbox(photo(n, "applied", "photo accepted"));
    const s = store();
    await send(s);
    expect(s.photoProgress.mock.calls.map((c) => c[0].length)).toEqual([500, 1]);
  });
});

describe("intakeRecentStore photoProgress", () => {
  it("posts the photos to the photo intake with the token, and throws when it refuses", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const items: PhotoProgressUpdate[] = [{ id: pho(1), state: "held", held_reason: "first_photo", run_at: RUN_AT }];
    await intakeRecentStore("https://photos-upload.example", "token-1", ok).photoProgress(items);
    expect(calls[0]!.url).toBe("https://photos-upload.example/v1/photos/progress");
    expect(calls[0]!.init.headers).toMatchObject({ authorization: "Bearer token-1" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ items });
    const refused = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(intakeRecentStore("https://photos-upload.example", "x", refused).photoProgress(items)).rejects.toThrow(/401/);
  });
});
