import { generateKeyPairSync } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { reviewPrBody } from "../../apply/src/prbody.js";
import type { HeldCase } from "../../apply/src/review.js";
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
  user: { type: string };
  author_association: string;
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}

/** The data repository's review branch, its open PR and its comments, behind the GitHub REST API. */
function fakeDataRepo(prBody: string | null) {
  const files = new Map<string, { text: string; sha: string }>();
  const comments: Comment[] = [];
  const calls: Call[] = [];
  const conflicts = new Set<string>();
  let shas = 0;
  const put = (p: Place) => files.set(placePath(p.id), { text: dumpPlace(p), sha: `sha${++shas}` });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

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
      comments.push({ body: body!.body as string, user: { type: "Bot" }, author_association: "NONE" });
      return json(201, {});
    }
    if (rest.startsWith("contents/")) {
      const path = rest.slice("contents/".length);
      if (method === "GET") {
        expect(url.searchParams.get("ref")).toBe(REVIEW_BRANCH);
        const file = files.get(path);
        return file ? json(200, { encoding: "base64", content: Buffer.from(file.text).toString("base64"), sha: file.sha }) : json(404, {});
      }
      if (method === "PUT") {
        expect(body!.branch).toBe(REVIEW_BRANCH);
        if (conflicts.has(path) || files.get(path)?.sha !== body!.sha) return json(409, {});
        files.set(path, { text: Buffer.from(body!.content as string, "base64").toString("utf8"), sha: `sha${++shas}` });
        return json(200, {});
      }
    }
    return json(404, {});
  }

  const read = (n: number) => JSON.parse(files.get(placePath(id(n)))!.text) as Place;
  const commits = () => calls.filter((c) => c.method === "PUT");
  const posted = () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments")).map((c) => c.body!.body as string);
  return { fetch, files, comments, calls, conflicts, put, read, commits, posted };
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

  it("restores a withdrawn contact, and takes down a first place that is clear spam", async () => {
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
    expect(gh.commits()).toHaveLength(2);
  });

  it("leaves a case when the model is unsure, answers a decision the case doesn't allow, or can't be read", async () => {
    const cases = [
      heldCase(0, { case: "duplicate", standing: "held", duplicate_of: id(9), distance_m: 30 }),
      heldCase(1, { case: "contact_withdrawn", fact: "email", value: "stay@park.example.org", reasons: ["spam"] }),
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
    expect(gh.commits()).toHaveLength(2);
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
    gh.comments.push({ body: later, user: { type: "Bot" }, author_association: "NONE" });
    gh.comments.push({ body: forged, user: { type: "User" }, author_association: "NONE" });
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
    expect(gh.commits()).toHaveLength(MAX_MODEL_CASES + 2);
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
