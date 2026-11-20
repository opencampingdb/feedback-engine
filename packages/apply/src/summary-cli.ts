#!/usr/bin/env node
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import type { StoredFeedback } from "@opencampingdb/feedback";
import { readHistory } from "./io.js";
import { isBotAuthor, type ReviewPr } from "./owners.js";
import { placeOf, reviewSummary, type ChangedPlace, type ContributorRecord, type OsmTags, type ReviewerDecision } from "./summary.js";
import type { Place, Review } from "./types.js";

const USAGE = `Usage: ocdb-review-summary --data <dir> --base <ref> --inbox <dir> --repo <owner/name>
                  --branch <name> --out <file> [--review-prs <file> --pr <number>]
                  [--bot-login <login>] [--reviewer-login <login>] [--no-osm]

Writes the body of the review PR to <file>: every place the PR branch checked
out in <dir> changes against <ref>, grouped by place, with each field's value
before and after, why it was held, the reporters' standing as counts, the AI
reviewer's decisions from the PR's comments (by --bot-login or
--reviewer-login only) and what OpenStreetMap holds for it. OpenStreetMap is
read from its API for changed places with an OSM id, unless --no-osm.`;

const run = promisify(execFile);
const git = async (dir: string, ...args: string[]) => (await run("git", ["-C", dir, ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout;

/** At most this many OSM objects are read in one run, four at a time. */
const MAX_OSM = 60;
const OSM_TIMEOUT_MS = 10_000;

const DECISION = /^- review-decision (\{.*\})\s*$/;

/** The reviewer's decisions in a PR's comments by the bot or the reviewer App, oldest first. */
export function reviewerDecisions(pr: ReviewPr | undefined, logins: readonly string[]): ReviewerDecision[] {
  if (!pr) return [];
  const out: ReviewerDecision[] = [];
  for (const c of pr.comments.filter((c) => isBotAuthor(c.author, logins))) {
    for (const line of c.body.split("\n")) {
      const m = DECISION.exec(line);
      if (!m) continue;
      try {
        const d = JSON.parse(m[1]!) as Partial<ReviewerDecision>;
        if (typeof d.place === "string" && typeof d.case === "string" && typeof d.decision === "string") {
          out.push({ place: d.place, case: d.case, decision: d.decision, reviewer: String(d.reviewer ?? ""), reason: String(d.reason ?? "") });
        }
      } catch {
        // A line that does not parse is not a decision.
      }
    }
  }
  return out;
}

/** Counts of each contributor's items by outcome. */
export function contributorRecords(applied: readonly StoredFeedback[], refused: readonly StoredFeedback[]): Map<string, ContributorRecord> {
  const records = new Map<string, ContributorRecord>();
  const add = (item: StoredFeedback, key: keyof ContributorRecord) => {
    const who = (item as { contributor?: string }).contributor;
    if (!who) return;
    const r = records.get(who) ?? { applied: 0, toPerson: 0, refused: 0 };
    r[key] += 1;
    records.set(who, r);
  };
  for (const item of applied) add(item, (item as { outcome?: { result?: string } }).outcome?.result === "needs_review" ? "toPerson" : "applied");
  for (const item of refused) add(item, "refused");
  return records;
}

/** The tags of each place's OSM object, or null for one that could not be read. */
async function osmTags(places: readonly Place[]): Promise<Map<string, OsmTags>> {
  const out = new Map<string, OsmTags>();
  const queue = places.filter((p) => p.osm !== null).slice(0, MAX_OSM);
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < queue.length) {
        const p = queue[next++]!;
        try {
          const res = await fetch(`https://api.openstreetmap.org/api/0.6/${p.osm!.type}/${p.osm!.id}.json`, {
            headers: { "user-agent": "opencampingdb-apply-feedback" },
            signal: AbortSignal.timeout(OSM_TIMEOUT_MS),
          });
          const json = res.ok ? ((await res.json()) as { elements?: { tags?: Record<string, string> }[] }) : null;
          out.set(p.id, json?.elements?.[0]?.tags ?? (res.ok ? {} : null));
        } catch {
          out.set(p.id, null);
        }
      }
    }),
  );
  return out;
}

const readJsonLines = (text: string): Review[] =>
  text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Review);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      data: { type: "string" },
      base: { type: "string" },
      inbox: { type: "string" },
      repo: { type: "string" },
      branch: { type: "string" },
      out: { type: "string" },
      "review-prs": { type: "string" },
      pr: { type: "string" },
      "bot-login": { type: "string", multiple: true },
      "reviewer-login": { type: "string" },
      "no-osm": { type: "boolean" },
    },
  });
  const { data, base, inbox, repo, branch, out } = values;
  if (!data || !base || !inbox || !repo || !branch || !out) {
    console.error(USAGE);
    process.exit(2);
  }

  const paths = (await git(data, "diff", "--name-only", base, "HEAD", "--", "places", "reviews")).split("\n").filter(Boolean);
  const show = async (path: string) => {
    try {
      return await git(data, "show", `${base}:${path}`);
    } catch {
      return null;
    }
  };
  const current = async (path: string) => readFile(join(data, path), "utf8").catch(() => null);

  const changed = new Map<string, ChangedPlace>();
  for (const path of paths.filter((p) => p.startsWith("places/") && p.endsWith(".json"))) {
    const afterText = await current(path);
    if (afterText === null) continue;
    const beforeText = await show(path);
    const after = JSON.parse(afterText) as Place;
    changed.set(after.id, { before: beforeText === null ? null : (JSON.parse(beforeText) as Place), after, path, reviews: [] });
  }
  for (const path of paths.filter((p) => p.startsWith("reviews/") && p.endsWith(".ndjson"))) {
    const after = readJsonLines((await current(path)) ?? "");
    const before = new Set(readJsonLines((await show(path)) ?? "").map((r) => r.id));
    const added = after.filter((r) => !before.has(r.id) && !r.hidden);
    const placeId = path.replace(/^reviews\//, "").replace(/\.ndjson$/, "");
    const entry = changed.get(placeId);
    if (entry) changed.set(placeId, { ...entry, reviews: added });
  }

  // Items a run sent to this PR: sent to a person since the branch's first commit, about a changed place.
  const firstCommit = (await git(data, "log", "--reverse", "--format=%cI", `${base}..HEAD`)).split("\n").find(Boolean);
  const since = firstCommit ? new Date(Date.parse(firstCommit) - 60 * 60 * 1000).toISOString() : new Date(0).toISOString();
  const applied = await readHistory(inbox, "0000-00-00", "applied");
  const refused = await readHistory(inbox, "0000-00-00", "refused");
  const items = [...applied, ...refused].filter((i) => {
    const place = placeOf(i);
    return place !== null && changed.has(place);
  });
  const forPerson = new Set(
    items
      .filter((i) => {
        const o = (i as { outcome?: { result?: string; run?: string } }).outcome;
        return o?.result === "needs_review" && (o.run ?? "") >= since;
      })
      .map((i) => i.id),
  );

  const prs = values["review-prs"] ? (JSON.parse(await readFile(values["review-prs"], "utf8")) as ReviewPr[]) : [];
  const pr = values.pr ? prs.find((p) => String(p.number) === values.pr) : undefined;
  const logins = [...(values["bot-login"] ?? []), ...(values["reviewer-login"] ? [values["reviewer-login"]] : [])];

  const kindsText = await readFile(join(data, "schema", "kinds.json"), "utf8").catch(() => null);
  const kindLabels = new Map<string, string>(
    kindsText ? (JSON.parse(kindsText) as { kinds: { code: string; label: string }[] }).kinds.map((k) => [k.code, k.label]) : [],
  );

  const places = [...changed.values()].sort((a, b) => (a.after.name ?? "").localeCompare(b.after.name ?? "") || a.after.id.localeCompare(b.after.id));
  const body = reviewSummary({
    repo,
    branch,
    places,
    items,
    forPerson,
    decisions: reviewerDecisions(pr, logins),
    osm: values["no-osm"] ? new Map() : await osmTags(places.map((c) => c.after)),
    records: contributorRecords(applied, refused),
    kindLabels,
  });
  await writeFile(out, body, "utf8");
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("summary-cli.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
