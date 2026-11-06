import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewPrBody } from "../../apply/src/prbody.js";
import type { HeldCase } from "../../apply/src/review.js";
import { majorRoads } from "../../apply/src/roads.js";
import { dumpPlace, placePath } from "../../apply/src/serialise.js";
import type { Place } from "../../apply/src/types.js";
import type { AiLike } from "../src/checks.js";
import { createReviewer, createScheduled, type Env } from "../src/index.js";
import { decidedKeys, DEFAULT_REVIEW_MODEL, MAX_MODEL_CASES, REVIEW_BRANCH } from "../src/reviewer.js";
import { REVIEW_EVERY_MS } from "../src/runs.js";
import { fakeD1 } from "./fake-d1.js";

const NOW = Date.parse("2026-11-04T09:00:00Z");
const AT = "2026-11-04T09:00:00Z";
const REPO = "opencampingdb/data";
const API = "https://api.github.com";
const REVIEWER = `ai:${DEFAULT_REVIEW_MODEL}`;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** Place ids that end in two given characters, so each has a file of its own. */
const id = (n: number) => `ocdb_01JBXK3M8Q4R5S6T7V8W9X0Y${"ABCDEFGHJK"[n]}${"ABCDEFGHJK"[n]}`;

function place(n: number, overrides: { [K in keyof Place]?: Place[K] | undefined } = {}): Place {
  return {
    id: id(n),
    name: `Creek Bend ${n}`,
    kind: "free_camp",
    group: "overnight",
    location: { lat: -36.85, lon: 144.55 },
    osm: null,
    facts: { toilets: true },
    status: "open",
    rating: null,
    fact_sources: { name: "contributed", toilets: "contributed" },
    fact_dates: { name: "2026-11-01T00:00:00Z", toilets: "2026-11-01T00:00:00Z" },
    standing: "held",
    updated: "2026-11-01T00:00:00Z",
    ...overrides,
  } as Place;
}

function heldCase(n: number, c: Partial<HeldCase> & Pick<HeldCase, "case">): HeldCase {
  return { place: id(n), location: { lat: -36.85, lon: 144.55 }, kind: "free_camp", feedback: [`fb_01JC00000000000000000000${String(n).padStart(2, "0")}`], ...c };
}

interface Comment {
  body: string;
  user: { type: string; login?: string };
  author_association: string;
}

/** The apply's GitHub App, which posts held cases, and the intake's, which posts decisions. */
const APPLY_BOT = "example-apply[bot]";
const INTAKE_BOT = "example-intake[bot]";

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/**
 * The data repository's review branch, its open PR and its comments, behind
 * the GitHub REST API: the contents API for reads, and the Git Data API
 * (refs, commits, trees with inline content on a base tree) for writes.
 * `files` is the branch as it is now. Setting a file there is another writer
 * committing it. A path in `conflicts` is changed by another writer just
 * before each ref update, so the reviewer's commit has lost the race for it.
 * `refStatus` answers the next ref updates with these statuses instead, and
 * `meanwhile` runs one function before each, as another writer would.
 */
function fakeDataRepo(prBody: string | null) {
  type Snapshot = Map<string, { text: string; sha: string }>;
  const files: Snapshot = new Map();
  const comments: Comment[] = [];
  const calls: Call[] = [];
  const conflicts = new Set<string>();
  const refStatus: number[] = [];
  const meanwhile: (() => void)[] = [];
  const commitObjects = new Map<string, { files: Snapshot; parents: string[]; message: string }>();
  const treeObjects = new Map<string, Snapshot>();
  let shas = 0;
  const next = (prefix: string) => `${prefix}${String(++shas).padStart(6, "0")}`;
  const put = (p: Place) => files.set(placePath(p.id), { text: dumpPlace(p), sha: next("blob") });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const same = (a: Snapshot, b: Snapshot) => a.size === b.size && [...a].every(([path, f]) => b.get(path)?.sha === f.sha);
  let head = next("commit");
  commitObjects.set(head, { files: new Map(), parents: [], message: "first" });
  /** The head commit, after committing what other writers set in `files` since. */
  const tip = () => {
    if (!same(commitObjects.get(head)!.files, files)) {
      const sha = next("commit");
      commitObjects.set(sha, { files: new Map(files), parents: [head], message: "another writer" });
      head = sha;
    }
    return head;
  };

  async function fetch(input: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url: input, ...(body ? { body } : {}) });
    const url = new URL(input);
    if (url.pathname === "/app/installations/678/access_tokens") return json(201, { token: "tok", expires_at: "2026-11-05T00:00:00Z" });
    if (!url.pathname.startsWith(`/repos/${REPO}/`)) return json(404, {});
    const rest = url.pathname.slice(`/repos/${REPO}/`.length);
    if (rest === "pulls" && method === "GET") {
      expect(url.searchParams.get("head")).toBe(`opencampingdb:${REVIEW_BRANCH}`);
      return json(200, prBody === null ? [] : [{ number: 7, body: prBody }]);
    }
    if (rest === "issues/7/comments" && method === "GET") return json(200, url.searchParams.get("page") === "1" ? comments : []);
    if (rest === "issues/7/comments" && method === "POST") {
      comments.push({ body: body!.body as string, user: { type: "Bot", login: INTAKE_BOT }, author_association: "NONE" });
      return json(201, {});
    }
    if (rest.startsWith("contents/") && method === "GET") {
      const ref = url.searchParams.get("ref")!;
      const snapshot = ref === REVIEW_BRANCH ? files : commitObjects.get(ref)?.files;
      if (!snapshot) return json(404, {});
      const file = snapshot.get(rest.slice("contents/".length));
      return file ? json(200, { encoding: "base64", content: Buffer.from(file.text).toString("base64"), sha: file.sha }) : json(404, {});
    }
    if (rest === `git/ref/heads/${REVIEW_BRANCH}` && method === "GET") return json(200, { object: { type: "commit", sha: tip() } });
    if (rest.startsWith("git/commits/") && method === "GET") {
      const sha = rest.slice("git/commits/".length);
      if (!commitObjects.has(sha)) return json(404, {});
      treeObjects.set(`tree-${sha}`, commitObjects.get(sha)!.files);
      return json(200, { sha, tree: { sha: `tree-${sha}` } });
    }
    if (rest === "git/trees" && method === "POST") {
      const base = treeObjects.get(body!.base_tree as string);
      if (!base) return json(422, {});
      const out: Snapshot = new Map(base);
      for (const entry of body!.tree as { path: string; mode: string; type: string; content?: string }[]) {
        if (entry.mode !== "100644" || entry.type !== "blob" || typeof entry.content !== "string") return json(422, {});
        out.set(entry.path, { text: entry.content, sha: next("blob") });
      }
      const sha = next("tree");
      treeObjects.set(sha, out);
      return json(201, { sha });
    }
    if (rest === "git/commits" && method === "POST") {
      const tree = treeObjects.get(body!.tree as string);
      const parents = body!.parents as string[];
      if (!tree || !parents.every((p) => commitObjects.has(p))) return json(422, {});
      const sha = next("commit");
      commitObjects.set(sha, { files: tree, parents, message: body!.message as string });
      return json(201, { sha });
    }
    if (rest === `git/refs/heads/${REVIEW_BRANCH}` && method === "PATCH") {
      meanwhile.shift()?.();
      for (const path of conflicts) {
        const file = files.get(path);
        if (file) files.set(path, { text: file.text, sha: next("blob") });
      }
      const forced = refStatus.shift();
      if (forced !== undefined) return json(forced, { message: "Update is not a fast forward" });
      if (body!.force !== false) return json(400, { message: "the reviewer must never force" });
      const sha = body!.sha as string;
      if (commitObjects.get(sha)?.parents[0] !== tip()) return json(422, { message: "Update is not a fast forward" });
      head = sha;
      files.clear();
      for (const [path, f] of commitObjects.get(sha)!.files) files.set(path, f);
      return json(200, { object: { sha } });
    }
    return json(404, {});
  }

  const read = (n: number) => JSON.parse(files.get(placePath(id(n)))!.text) as Place;
  /** The commits the reviewer made, oldest first. */
  const commits = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/git/commits"));
  /** The commits on the branch that the reviewer made, oldest first. */
  const landed = () => {
    const out: string[] = [];
    for (let sha: string | undefined = head; sha; sha = commitObjects.get(sha)!.parents[0]) {
      const message = commitObjects.get(sha)!.message;
      if (message !== "first" && message !== "another writer") out.unshift(message);
    }
    return out;
  };
  const posted = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments")).map((c) => c.body!.body as string);
  return { fetch, files, comments, calls, conflicts, refStatus, meanwhile, put, read, commits, landed, posted };
}

/** A Workers AI binding that answers from `answer`, and records what it was asked. */
function fakeAi(answer: (input: Record<string, unknown>) => unknown) {
  const asked: { model: string; input: Record<string, unknown> }[] = [];
  const ai: AiLike = {
    async run(model, input) {
      asked.push({ model, input });
      return answer(input);
    },
  };
  return { ai, asked };
}

/** What the model was told about a case, from its user message. */
const caseOf = (input: Record<string, unknown>) => JSON.parse((input.messages as { content: string }[])[1]!.content) as Record<string, unknown>;

const reply = (decision: string, reason: string, sure = true) => ({ response: { decision, reason, sure } });

describe("the AI reviewer", () => {
  let env: Env;
  let clock: number;

  beforeEach(() => {
    clock = NOW;
    env = {
      APP_KEYS: "{}",
      DEVICE_SALT: "pepper",
      GH_APP_ID: "12345",
      GH_APP_PRIVATE_KEY: privateKey,
      GH_INSTALLATION_ID: "678",
      INBOX_REPO: "opencampingdb/inbox",
      RATE_LIMIT: { get: async () => null, put: async () => undefined, delete: async () => undefined },
      RECENT_LIST: fakeD1(),
      AI_REVIEWER: "on",
      DATA_REPO: REPO,
      REVIEW_BOT_LOGINS: `${APPLY_BOT}, ${INTAKE_BOT}`,
    };
  });

  const run = (gh: ReturnType<typeof fakeDataRepo>, ai: AiLike) => createReviewer({ fetch: gh.fetch, now: () => clock })({ ...env, AI: ai });

  it("approves a held duplicate the model is sure of, commits it with the reviewer and reason, and comments on the PR", async () => {
    const c = heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(1), distance_m: 140 });
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [c]));
    gh.put(place(0));
    gh.put(place(1, { standing: undefined, name: "Lakeside Park", kind: "caravan_park" }));
    const { ai, asked } = fakeAi(() => reply("approve", "A separate free camp 140 m from a caravan park."));

    const result = await run(gh, ai);
    expect(result).toMatchObject({ outcome: "reviewed", pr: 7, decisions: [{ decision: "approve", reviewer: REVIEWER, by_rules: false, committed: true }] });

    expect(asked).toHaveLength(1);
    expect(asked[0]!.model).toBe(DEFAULT_REVIEW_MODEL);
    expect(asked[0]!.input).toMatchObject({ temperature: 0, response_format: { type: "json_schema" } });
    const told = caseOf(asked[0]!.input);
    expect(told).toMatchObject({ case: "duplicate", place: { id: id(0), name: "Creek Bend 0" }, possible_duplicate_of: { id: id(1), name: "Lakeside Park" }, distance_m: 140 });
    const schema = (asked[0]!.input.response_format as { json_schema: { properties: { decision: { enum: string[] } } } }).json_schema;
    // Different names, and no road data: a merge is not offered.
    expect(schema.properties.decision.enum).toEqual(["approve", "take_down", "leave"]);

    expect(gh.read(0)).toMatchObject({ standing: "shown", updated: AT });
    expect(gh.files.get(placePath(id(0)))!.text).toBe(dumpPlace({ ...place(0), standing: "shown", updated: AT }));
    const message = gh.commits()[0]!.body!.message as string;
    expect(message).toContain(`${REVIEWER}: approve held case duplicate on ${id(0)}`);
    expect(message).toContain("A separate free camp 140 m from a caravan park.");

    const [comment] = gh.posted();
    expect(comment).toContain("`ai:");
    // A mention in a code span notifies no one.
    expect(comment!.replace(/`[^`]*`/g, "")).not.toContain("@");
    expect(decidedKeys(comment!)).toHaveLength(1);

    const token = gh.calls.find((c) => c.url.endsWith("/access_tokens"))!.body!;
    expect(token).toEqual({ repositories: ["data"], permissions: { contents: "write", pull_requests: "write" } });
  });

  it("is off without REVIEW_BOT_LOGINS", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 })]));
    gh.put(place(0));
    const { ai, asked } = fakeAi(() => reply("approve", "Separate."));
    const { REVIEW_BOT_LOGINS: _, ...without } = env;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await createReviewer({ fetch: gh.fetch, now: () => clock })({ ...without, AI: ai })).toBe("off");
      expect(await createReviewer({ fetch: gh.fetch, now: () => clock })({ ...env, REVIEW_BOT_LOGINS: " , ", AI: ai })).toBe("off");
    } finally {
      warn.mockRestore();
    }
    expect(asked).toHaveLength(0);
    expect(gh.calls).toHaveLength(0);
  });

  it("leaves a contact taken down as spam to a person, without asking the model", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [heldCase(0, { case: "contact_withdrawn", fact: "email", value: "stay@park.example.org", reasons: ["spam", "wrong"] })]));
    gh.put(place(0, { standing: undefined }));
    const { ai, asked } = fakeAi(() => reply("restore", "The email is the park's own."));
    const result = await run(gh, ai);
    expect(asked).toHaveLength(0);
    expect(gh.commits()).toHaveLength(0);
    if (result === "off" || result === "failed" || result.outcome !== "reviewed") throw new Error("expected a review");
    expect(result.decisions.map((d) => [d.decision, d.by_rules])).toEqual([["leave", true]]);
  });

  it("settles what the rules can without asking the model: inbox values, owners and blocked contributors", async () => {
    const cases = [
      heldCase(0, { case: "contacts", standing: "shown", contacts: ["website"] }),
      heldCase(1, { case: "description", standing: "shown", problem: "link" }),
      heldCase(2, { case: "hidden", standing: "hidden", blocked: true }),
      heldCase(3, { case: "first_place", standing: "shown" }),
      heldCase(4, { case: "contact_withdrawn", fact: "email", value: "stay@park.example.org", reasons: ["spam"] }),
    ];
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], cases));
    gh.put(place(0, { standing: "shown" }));
    gh.put(place(1, { standing: "shown" }));
    gh.put(place(2, { standing: "hidden" }));
    gh.put(place(3, { standing: "shown", owner_verified: true }));
    gh.put(place(4, { standing: undefined, fact_sources: { email: "owner" } }));
    const { ai, asked } = fakeAi(() => reply("approve", "looks fine"));

    const result = await run(gh, ai);
    expect(asked).toHaveLength(0);
    expect(gh.commits()).toHaveLength(0);
    if (result === "off" || result === "failed" || result.outcome !== "reviewed") throw new Error("expected a review");
    expect(result.decisions.map((d) => [d.case, d.decision, d.by_rules])).toEqual([
      ["contacts", "leave", true],
      ["description", "leave", true],
      ["hidden", "leave", true],
      ["first_place", "leave", true],
      ["contact_withdrawn", "leave", true],
    ]);
    expect(decidedKeys(gh.posted()[0]!)).toHaveLength(5);
  });

  it("restores a withdrawn contact, and takes down a first place that is clear spam, in one commit for the run", async () => {
    const cases = [
      heldCase(0, { case: "contact_withdrawn", fact: "email", value: "stay@park.example.org", reasons: ["wrong"] }),
      heldCase(1, { case: "first_place", standing: "shown", contributor: "ctr_0123456789abcdef" }),
    ];
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], cases));
    gh.put(place(0, { standing: undefined, osm: { type: "node", id: 1, version: 1 } }));
    gh.put(place(1, { standing: "shown", name: "CHEAP PILLS BUY NOW" }));
    const { ai, asked } = fakeAi((input) =>
      caseOf(input).case === "contact_withdrawn" ? reply("restore", "The email is the park's own.") : reply("take_down", "Advertising, not a place."),
    );

    await run(gh, ai);
    expect(caseOf(asked[0]!.input)).toMatchObject({ contact: "email", published_value: "stay@park.example.org", report_reasons: ["wrong"] });
    expect(gh.read(0).facts).toMatchObject({ email: "stay@park.example.org" });
    expect(gh.read(0).fact_sources.email).toBe("feedback");
    expect(gh.read(1)).toMatchObject({ standing: "hidden", moderator: { action: "hide", at: AT } });
    expect(gh.commits()).toHaveLength(1);
    const message = gh.commits()[0]!.body!.message as string;
    expect(message).toContain(`${REVIEWER}: restore held case contact_withdrawn on ${id(0)}`);
    expect(message).toContain(`${REVIEWER}: take_down held case first_place on ${id(1)}`);
    expect(message).toContain("The email is the park's own.");
  });

  describe("fact_doubted cases", () => {
    const doubted = (n: number, takenDown: boolean, extra: Partial<HeldCase> = {}) =>
      heldCase(n, {
        case: "fact_doubted",
        fact: "toilets",
        value: true,
        taken_down: takenDown,
        sources: takenDown ? 2 : 1,
        doubts: [`fb_01JC00000000000000000000${String(n).padStart(2, "0")}`],
        confirmations: [],
        ...extra,
      });
    const down = (n: number, overrides: Partial<Place> = {}) =>
      place(n, { standing: undefined, facts: {}, fact_sources: { name: "contributed", toilets: "feedback" }, ...overrides });

    it("restores a fact doubts took down, keeps one down, and dismisses a single doubt, telling the model what was weighed", async () => {
      const cases = [doubted(0, true), doubted(1, true), doubted(2, false)];
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], cases));
      gh.put(down(0));
      gh.put(down(1));
      gh.put(place(2, { standing: undefined }));
      const answers: Record<string, ReturnType<typeof reply>> = {
        [id(0)]: reply("restore", "Toilets are common at this kind of place."),
        [id(1)]: reply("keep_down", "Two travellers found none."),
        [id(2)]: reply("dismiss", "One doubt against a long-standing fact."),
      };
      const { ai, asked } = fakeAi((input) => answers[(caseOf(input).place as { id: string }).id]!);

      const result = await run(gh, ai);
      expect(caseOf(asked[0]!.input)).toMatchObject({ case: "fact_doubted", fact: "toilets", last_value: true, taken_down: true, doubting_sources: 2, doubts: 1, confirmations: 0 });
      const system = (asked[2]!.input.messages as { content: string }[])[0]!.content;
      expect(system).toContain("dismiss, leave");
      expect(system).not.toContain("- restore:");
      expect(gh.read(0).facts).toEqual({ toilets: true });
      expect(gh.read(0).fact_dates?.toilets).toBe(AT);
      expect(gh.read(1).facts).toEqual({});
      expect(gh.commits()).toHaveLength(1);
      expect(result).toMatchObject({ decisions: [{ decision: "restore", committed: true }, { decision: "keep_down", committed: false }, { decision: "dismiss", committed: false }] });
    });

    it("never acts on a fact the owner set, and settles a case the rules closed, without asking the model", async () => {
      const cases = [doubted(0, true), doubted(1, true)];
      const closed = [{ case: "fact_doubted" as const, place: id(1), fact: "toilets" as const, settles: "restored" as const, feedback: ["fb_01JC0000000000000000000099"] }];
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], cases, new Map(), closed));
      gh.put(down(0, { fact_sources: { name: "contributed", toilets: "owner" } }));
      gh.put(down(1));
      const { ai, asked } = fakeAi(() => reply("restore", "should not be asked"));

      const result = await run(gh, ai);
      expect(asked).toHaveLength(0);
      expect(gh.commits()).toHaveLength(0);
      expect(result).toMatchObject({
        decisions: [
          { place: id(0), decision: "leave", by_rules: true, reason: "the owner set this fact" },
          { place: id(1), decision: "leave", by_rules: true, reason: "the rules closed this case: travellers restored the fact" },
        ],
      });
    });
  });

  describe("merging a duplicate", () => {
    const dup = (n: number, of: number) => heldCase(n, { case: "duplicate", standing: "held", duplicate_of: id(of), distance_m: 70 });
    const existing = (n: number, overrides: Partial<Place> = {}) =>
      place(n, { standing: undefined, name: "Creek Bend 0", facts: { toilets: true }, fact_sources: { name: "osm", toilets: "osm" }, fact_dates: undefined, ...overrides });
    const enumOf = (input: Record<string, unknown>) =>
      (input.response_format as { json_schema: { properties: { decision: { enum: string[] } } } }).json_schema.properties.decision.enum;

    it("merges a held new place into the place it duplicates: the kept place and the tombstone in one commit", async () => {
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [dup(0, 1)]));
      gh.put(place(0, { facts: { fee: false }, fact_sources: { name: "feedback", location: "feedback", fee: "feedback" }, fact_dates: { name: AT, location: AT, fee: AT } }));
      gh.put(existing(1));
      const { ai } = fakeAi(() => reply("merge", "The same camp, 70 m apart, mapped twice."));

      const result = await run(gh, ai);
      expect(result).toMatchObject({ decisions: [{ decision: "merge", committed: true }] });
      expect(gh.commits()).toHaveLength(1);
      expect(gh.read(1)).toMatchObject({ facts: { toilets: true, fee: false }, fact_sources: { fee: "feedback" }, fact_dates: { fee: AT }, updated: AT });
      expect(gh.read(0)).toMatchObject({ status: "merged", merged_into: id(1) });
      expect(gh.commits()[0]!.body!.message as string).toContain(`${REVIEWER}: merge held case duplicate on ${id(0)}`);
    });

    it("without road data, offers a merge only for the same name, in the same group, less than 25 m apart", async () => {
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [dup(0, 1), dup(2, 3), dup(4, 5)]));
      gh.put(place(0));
      gh.put(existing(1, { location: { lat: -36.85018, lon: 144.55 } }));
      gh.put(place(2));
      gh.put(existing(3, { name: "Creek Bend 2", location: { lat: -36.85036, lon: 144.55 } }));
      gh.put(place(4));
      gh.put(existing(5, { name: "Creek Bend North" }));
      const { ai, asked } = fakeAi(() => reply("leave", "unsure", false));
      await run(gh, ai);
      expect(asked.map((a) => enumOf(a.input))).toEqual([["approve", "merge", "take_down", "leave"], ["approve", "take_down", "leave"], ["approve", "take_down", "leave"]]);
    });

    it("with road data, refuses a merge across a major road and offers one otherwise, whatever the names", async () => {
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [dup(0, 1), dup(2, 3)]));
      gh.put(place(0, { location: { lat: -36.85, lon: 144.55 } }));
      gh.put(existing(1, { name: "Another Name", location: { lat: -36.8504, lon: 144.55 } }));
      gh.put(place(2, { location: { lat: -36.86, lon: 144.55 } }));
      gh.put(existing(3, { name: "Another Name", location: { lat: -36.8604, lon: 144.55 } }));
      // A primary road between places 2 and 3 only.
      const roads = majorRoads(['{"coords":[[144.549,-36.8602],[144.551,-36.8602]],"highway":"primary","name":"Example Road","road":5}']);
      const { ai, asked } = fakeAi(() => reply("leave", "unsure", false));
      await createReviewer({ fetch: gh.fetch, now: () => clock, roads })({ ...env, AI: ai });
      expect(asked.map((a) => enumOf(a.input))).toEqual([["approve", "merge", "take_down", "leave"], ["approve", "take_down", "leave"]]);
    });

    it("does not offer a merge into an owner's place or a pair a person found separate", async () => {
      const [a, b] = [id(3), id(2)].sort();
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [dup(0, 1), dup(3, 2)]));
      gh.files.set("moderation/distinct_places.json", { text: JSON.stringify({ pairs: [{ a, b, added: "2026-11-01", reason: "other" }] }), sha: "shaD" });
      gh.put(place(0));
      gh.put(place(3));
      gh.put(existing(1, { owner_verified: true }));
      gh.put(existing(2));
      const { ai, asked } = fakeAi(() => reply("merge", "should not be allowed"));

      const result = await run(gh, ai);
      expect(asked.map((a) => enumOf(a.input))).toEqual([["approve", "take_down", "leave"], ["approve", "take_down", "leave"]]);
      expect(result).toMatchObject({ decisions: [{ decision: "leave" }, { decision: "leave" }] });
      expect(gh.commits()).toHaveLength(0);
    });
  });

  describe("commons_mismatch cases", () => {
    const FILE = "Brunswick River and Pool Precinct 6.jpg";
    const LIST = "moderation/commons-do-not-match.json";
    const mismatch = (n: number, file = FILE) => heldCase(n, { case: "commons_mismatch", file, sources: 1 });
    const park = (n: number) => place(n, { standing: undefined, name: "Brunswick Heads Caravan Park", kind: "caravan_park" });

    it("puts a photo the model confirms is not of the place on the do-not-match list, and dismisses one it finds is", async () => {
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [mismatch(0), mismatch(1, "Brunswick Heads Caravan Park entrance.jpg")]));
      gh.put(park(0));
      gh.put(park(1));
      const answers: Record<string, ReturnType<typeof reply>> = {
        [id(0)]: reply("confirm", "The file names a river pool, not the park."),
        [id(1)]: reply("dismiss", "The file names this park."),
      };
      const { ai, asked } = fakeAi((input) => answers[(caseOf(input).place as { id: string }).id]!);

      const result = await run(gh, ai);
      expect(caseOf(asked[0]!.input)).toMatchObject({ case: "commons_mismatch", place: { name: "Brunswick Heads Caravan Park" }, file: FILE, reporting_sources: 1 });
      expect((asked[0]!.input.messages as { content: string }[])[0]!.content).toContain("confirm, dismiss, leave");
      expect(JSON.parse(gh.files.get(LIST)!.text)).toEqual({ pairs: [{ added: "2026-11-04", file: FILE, place: id(0), source: "reviewer" }] });
      expect(gh.commits()).toHaveLength(1);
      expect(gh.commits()[0]!.body!.message as string).toContain(`${REVIEWER}: confirm held case commons_mismatch on ${id(0)}`);
      expect(result).toMatchObject({ decisions: [{ decision: "confirm", committed: true }, { decision: "dismiss", committed: false }] });
    });

    it("puts two photos on the do-not-match list in one run, the second on top of the first", async () => {
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [mismatch(0), mismatch(1, "Another River Pool.jpg")]));
      gh.put(park(0));
      gh.put(park(1));
      const { ai } = fakeAi(() => reply("confirm", "The file names a river pool, not the park."));
      await run(gh, ai);
      expect(JSON.parse(gh.files.get(LIST)!.text).pairs.map((p: { place: string }) => p.place)).toEqual([id(0), id(1)]);
      expect(gh.commits()).toHaveLength(1);
    });

    it("leaves a pair already on the list without asking the model", async () => {
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [mismatch(0)]));
      gh.put(park(0));
      gh.files.set(LIST, { text: JSON.stringify({ pairs: [{ added: "2026-11-01", file: FILE, place: id(0), source: "reports" }] }), sha: "shaL" });
      const { ai, asked } = fakeAi(() => reply("confirm", "should not be asked"));
      expect(await run(gh, ai)).toMatchObject({ decisions: [{ decision: "leave", by_rules: true, reason: "the Commons photo is on the do-not-match list already" }] });
      expect(asked).toHaveLength(0);
    });
  });

  describe("vehicle_access_candidate cases", () => {
    const candidate = (n: number): HeldCase => ({ ...heldCase(n, { case: "vehicle_access_candidate", fact: "vehicle_access", value: "heavy_vehicles_only" }), kind: "rest_area", feedback: [] });
    const restArea = (n: number, overrides: Partial<Place> = {}) =>
      place(n, { standing: undefined, name: "Truck Parking Bay", kind: "rest_area", group: "stopover", fact_sources: { name: "osm", toilets: "osm" }, fact_dates: undefined, ...overrides });

    it("leaves every candidate without asking the model: a name alone never sets a fact", async () => {
      const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [candidate(0)]));
      gh.put(restArea(0));
      const { ai, asked } = fakeAi(() => reply("confirm", "should not be asked"));
      expect(await run(gh, ai)).toMatchObject({
        decisions: [{ decision: "leave", by_rules: true, reason: "a name alone never sets a fact, so the place is tagged in OpenStreetMap" }],
      });
      expect(asked).toHaveLength(0);
      expect(gh.read(0).facts).toEqual({ toilets: true });
    });
  });

  it("leaves a case when the model is unsure, answers a decision the case doesn't allow, or can't be read", async () => {
    const cases = [
      heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 }),
      heldCase(1, { case: "contact_withdrawn", fact: "email", value: "stay@park.example.org", reasons: ["wrong"] }),
      heldCase(2, { case: "hidden", standing: "hidden", reports: 2, reasons: ["not_there"] }),
    ];
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], cases));
    gh.put(place(0));
    gh.put(place(1, { standing: undefined }));
    gh.put(place(2, { standing: "hidden" }));
    const answers = [reply("approve", "Probably separate.", false), reply("take_down", "Spam contact."), { response: "I think it is fine" }];
    const { ai } = fakeAi(() => answers.shift());

    const result = await run(gh, ai);
    if (result === "off" || result === "failed" || result.outcome !== "reviewed") throw new Error("expected a review");
    expect(result.decisions.map((d) => [d.decision, d.reason])).toEqual([
      ["leave", "the model was not sure: Probably separate."],
      ["leave", "the model answered take_down, which this case does not allow"],
      ["leave", "the model's answer could not be read"],
    ]);
    expect(gh.commits()).toHaveLength(0);
    expect(gh.read(0).standing).toBe("held");
  });

  it("reads an answer given as JSON text, or in OpenAI's shape", async () => {
    const cases = [heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 }), heldCase(1, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 })];
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], cases));
    gh.put(place(0));
    gh.put(place(1));
    const text = JSON.stringify({ decision: "approve", reason: "Separate.", sure: true });
    const answers: unknown[] = [{ response: `\`\`\`json\n${text}\n\`\`\`` }, { choices: [{ message: { content: text } }] }];
    const { ai } = fakeAi(() => answers.shift());
    await run(gh, ai);
    expect([gh.read(0).standing, gh.read(1).standing]).toEqual(["shown", "shown"]);
  });

  it("writes reasons without links, mentions or markup", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [heldCase(0, { case: "first_place", standing: "shown" })]));
    gh.put(place(0, { standing: "shown" }));
    const { ai } = fakeAi(() => reply("take_down", "Spam for https://spam.example.com/buy, ask @someone <b>now</b>\nreally"));
    await run(gh, ai);
    const comment = gh.posted()[0]!;
    expect(comment.replace(/`[^`]*`/g, "")).not.toMatch(/https?:|@|<b>/);
    const [line] = comment.split("\n").filter((l) => l.startsWith("- review-decision "));
    expect(JSON.parse(line!.slice("- review-decision ".length)).reason).toBe("Spam for (link) ask at someone bnow/b really");
    expect(gh.commits()[0]!.body!.message).not.toMatch(/https?:|@someone/);
  });

  it("asks about a case once: a case with a decision on the PR is not asked about again", async () => {
    const c = heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 });
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [c]));
    gh.put(place(0));
    const { ai, asked } = fakeAi(() => reply("leave", "Can't tell from the map.", false));
    await run(gh, ai);
    clock += REVIEW_EVERY_MS;
    expect(await run(gh, ai)).toEqual({ outcome: "reviewed", pr: 7, decisions: [] });
    expect(asked).toHaveLength(1);
    expect(gh.posted()).toHaveLength(1);
  });

  it("reads held cases from the apply's later comments, but not from a stranger's", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), []));
    gh.put(place(0));
    gh.put(place(1, { standing: undefined }));
    const later = reviewPrBody(AT, [], new Map(), [], [heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 })]);
    const forged = reviewPrBody(AT, [], new Map(), [], [heldCase(1, { case: "contact_withdrawn", fact: "website", value: "https://spam.example.com/", reasons: ["wrong"] })]);
    gh.comments.push({ body: later, user: { type: "Bot", login: APPLY_BOT }, author_association: "NONE" });
    gh.comments.push({ body: forged, user: { type: "User", login: "stranger" }, author_association: "NONE" });
    // Any GitHub App can comment on a public PR: one that isn't listed counts no more than a stranger.
    gh.comments.push({ body: forged, user: { type: "Bot", login: "other-app[bot]" }, author_association: "NONE" });
    const { ai, asked } = fakeAi(() => reply("restore", "Fine."));
    await run(gh, ai);
    expect(asked.map((a) => caseOf(a.input).case)).toEqual(["duplicate"]);
    expect(gh.read(1).facts).not.toHaveProperty("website");
  });

  it("asks the model about at most MAX_MODEL_CASES cases a run, and the rest on the next", async () => {
    const cases = Array.from({ length: MAX_MODEL_CASES + 2 }, (_, n) => heldCase(n, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 }));
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], cases));
    cases.forEach((_, n) => gh.put(place(n)));
    const { ai, asked } = fakeAi(() => reply("approve", "Separate."));
    await run(gh, ai);
    expect(asked).toHaveLength(MAX_MODEL_CASES);
    clock += REVIEW_EVERY_MS;
    await run(gh, ai);
    expect(asked).toHaveLength(MAX_MODEL_CASES + 2);
    // One commit a run, however many cases it decided.
    expect(gh.landed()).toHaveLength(2);
  });

  it("runs at most once every 10 minutes", async () => {
    const gh = fakeDataRepo(null);
    const { ai } = fakeAi(() => reply("leave", "", false));
    expect(await run(gh, ai)).toEqual({ outcome: "no_pr" });
    clock += REVIEW_EVERY_MS - 1;
    expect(await run(gh, ai)).toEqual({ outcome: "waiting" });
    clock += 1;
    expect(await run(gh, ai)).toEqual({ outcome: "no_pr" });
  });

  it("stops when the model fails, records what it decided, and asks about the failed case next run", async () => {
    const cases = [0, 1].map((n) => heldCase(n, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 }));
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], cases));
    gh.put(place(0));
    gh.put(place(1));
    let down = false;
    const { ai, asked } = fakeAi(() => {
      if (down) throw new Error("AI unavailable");
      down = true;
      return reply("approve", "Separate.");
    });
    await run(gh, ai);
    expect(decidedKeys(gh.posted()[0]!)).toHaveLength(1);
    down = false;
    clock += REVIEW_EVERY_MS;
    await run(gh, ai);
    expect(caseOf(asked[2]!.input).place).toMatchObject({ id: id(1) });
    expect(gh.read(1).standing).toBe("shown");
  });

  it("skips a commit that loses to a newer version of the place, to try again next run", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 })]));
    gh.put(place(0));
    gh.conflicts.add(placePath(id(0)));
    const { ai, asked } = fakeAi(() => reply("approve", "Separate."));
    expect(await run(gh, ai)).toEqual({ outcome: "reviewed", pr: 7, decisions: [] });
    expect(gh.posted()).toHaveLength(0);
    gh.conflicts.clear();
    clock += REVIEW_EVERY_MS;
    await run(gh, ai);
    expect(asked).toHaveLength(2);
    expect(gh.read(0).standing).toBe("shown");
  });

  it("commits on top of what another writer committed meanwhile, and keeps their change", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 })]));
    gh.put(place(0));
    gh.put(place(5));
    // Another writer changes a place this run does not touch, just before its first ref update.
    gh.meanwhile.push(() => gh.put(place(5, { name: "Changed meanwhile" })));
    const { ai } = fakeAi(() => reply("approve", "Separate."));
    expect(await run(gh, ai)).toMatchObject({ outcome: "reviewed", decisions: [{ decision: "approve", committed: true }] });
    expect(gh.read(0).standing).toBe("shown");
    expect(gh.read(5).name).toBe("Changed meanwhile");
    expect(gh.landed()).toHaveLength(1);
    expect(gh.posted()).toHaveLength(1);
  });

  it("starts again from the new head when a ref update is refused, as the inbox flush does", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 })]));
    gh.put(place(0));
    gh.refStatus.push(422, 409);
    const { ai } = fakeAi(() => reply("approve", "Separate."));
    expect(await run(gh, ai)).toMatchObject({ outcome: "reviewed", decisions: [{ committed: true }] });
    expect(gh.read(0).standing).toBe("shown");
    expect(gh.landed()).toHaveLength(1);
  });

  it("gives up on a branch that keeps moving, records only what changed no place, and decides the rest next run", async () => {
    const cases = [
      heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 }),
      heldCase(1, { case: "contacts", standing: "shown", contacts: ["website"] }),
    ];
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], cases));
    gh.put(place(0));
    gh.put(place(1, { standing: "shown" }));
    gh.refStatus.push(422, 422, 422);
    const { ai, asked } = fakeAi(() => reply("approve", "Separate."));
    expect(await run(gh, ai)).toMatchObject({ decisions: [{ case: "contacts", decision: "leave", committed: false }] });
    expect(gh.landed()).toHaveLength(0);
    clock += REVIEW_EVERY_MS;
    await run(gh, ai);
    expect(asked).toHaveLength(2);
    expect(gh.read(0).standing).toBe("shown");
  });

  it("uses REVIEW_MODEL when it is set", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 })]));
    gh.put(place(0));
    const { ai, asked } = fakeAi(() => reply("approve", "Separate."));
    env.REVIEW_MODEL = "@cf/example/other-model";
    await run(gh, ai);
    expect(asked[0]!.model).toBe("@cf/example/other-model");
    expect(gh.commits()[0]!.body!.message).toContain("ai:@cf/example/other-model");
  });

  it("is off without the AI binding, without AI_REVIEWER on, or without DATA_REPO", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), []));
    const review = createReviewer({ fetch: gh.fetch, now: () => clock });
    const { ai } = fakeAi(() => reply("approve", ""));
    expect(await review(env)).toBe("off");
    const { AI_REVIEWER: _on, ...notOn } = env;
    expect(await review({ ...notOn, AI: ai })).toBe("off");
    expect(await review({ ...env, AI: ai, AI_REVIEWER: "off" })).toBe("off");
    const { DATA_REPO: _repo, ...noRepo } = env;
    expect(await review({ ...noRepo, AI: ai })).toBe("off");
    expect(gh.calls).toHaveLength(0);
  });

  it("runs from the scheduled job, with the apply off", async () => {
    const gh = fakeDataRepo(reviewPrBody(AT, [], new Map(), [], [heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 })]));
    gh.put(place(0));
    const { ai, asked } = fakeAi(() => reply("approve", "Separate."));
    const scheduled = createScheduled({ fetch: gh.fetch, now: () => clock });
    expect(await scheduled({ ...env, AI: ai })).toBe("off");
    expect(asked).toHaveLength(1);
    expect(gh.read(0).standing).toBe("shown");
  });

  it("logs a GitHub failure from the scheduled job instead of throwing", async () => {
    const { ai } = fakeAi(() => reply("approve", ""));
    const failing = async () => new Response("{}", { status: 500 });
    const review = createReviewer({ fetch: failing, now: () => clock });
    expect(await review({ ...env, AI: ai })).toBe("failed");
  });
});
