import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isBotAuthor } from "../src/owners.js";
import { autoPrBody } from "../src/prbody.js";

const WORKFLOW = new URL("../../../.github/workflows/apply-feedback.yml", import.meta.url);
/** The engine checkout the publish steps source their shared shell from: this repository. */
const ENGINE_DIR = new URL("../../../", import.meta.url).pathname;

/** The `run` script of the step named `name` in the reusable apply workflow, dedented. */
async function stepScript(name: string): Promise<string> {
  const lines = (await readFile(WORKFLOW, "utf8")).split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`no step named ${name}`);
  const run = lines.findIndex((line, i) => i > start && /^\s+run: \|$/.test(line));
  const indent = lines[run]!.indexOf("run:") + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const identity = (cwd: string) => {
  git(cwd, "config", "user.name", "example-bot[bot]");
  git(cwd, "config", "user.email", "1+example-bot[bot]@users.noreply.github.com");
  // A machine that signs commits (with a prompt) would otherwise hang here.
  git(cwd, "config", "commit.gpgsign", "false");
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocdb-workflow-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the apply workflow's review publish step", () => {
  it("rebases onto a commit the AI reviewer made meanwhile, keeping the merge of the base branch, and pushes", async () => {
    const remote = join(root, "data.git");
    git(root, "init", "--bare", "-b", "main", remote);
    // The data repository: main, and the review branch with an earlier run's commit.
    const seed = join(root, "seed");
    git(root, "clone", "-q", remote, seed);
    identity(seed);
    await mkdir(join(seed, "places"), { recursive: true });
    await writeFile(join(seed, "places", "a.json"), "{}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "data");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    await writeFile(join(seed, "places", "b.json"), "{}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "Feedback for review (run 1)");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/feedback/review");
    // main moves on, as the release does.
    git(seed, "switch", "-q", "-c", "next", "origin/main");
    await writeFile(join(seed, "places", "c.json"), "{}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "more data");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");

    // The run's checkout, as "Start from the open PR branches" leaves it.
    const checkout = join(root, "data-review");
    git(root, "clone", "-q", remote, checkout);
    identity(checkout);
    git(checkout, "fetch", "-q", "origin", "feedback/review");
    git(checkout, "switch", "-q", "-c", "feedback/review", "origin/feedback/review");
    git(checkout, "merge", "-q", "--no-edit", "origin/main");
    // The apply writes its review change.
    await writeFile(join(checkout, "places", "d.json"), "{}\n");

    // Meanwhile the AI reviewer commits to the review branch.
    git(seed, "fetch", "-q", "origin");
    git(seed, "switch", "-q", "-c", "reviewer", "origin/feedback/review");
    await writeFile(join(seed, "places", "b.json"), "{\"standing\": \"shown\"}\n");
    git(seed, "commit", "-q", "-am", "ai: approve held case");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/feedback/review");

    const temp = join(root, "temp");
    const bin = join(root, "bin");
    await mkdir(temp);
    await mkdir(bin);
    await writeFile(join(temp, "review-pr-body.md"), "body\n");
    // gh records its calls instead of reaching GitHub.
    await writeFile(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${join(root, "gh.log")}"\n`);
    await chmod(join(bin, "gh"), 0o755);

    const result = spawnSync("bash", ["-e", "-c", await stepScript("Publish changes for review")], {
      cwd: checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: "x",
        ENGINE_DIR,
        DATA_REPO: "example/data",
        BASE_BRANCH: "main",
        PR_OPEN: "true",
        PR_NUMBER: "7",
        OWNER_CLAIMS: "false",
        RUN_ID: "2",
        RUNNER_TEMP: temp,
        GITHUB_OUTPUT: join(temp, "output"),
      },
    });
    expect(result.stderr).not.toContain("::error::");
    expect(result.status).toBe(0);

    const check = join(root, "check");
    git(root, "clone", "-q", "-b", "feedback/review", remote, check);
    // The reviewer's commit, the base branch's commit and this run's change are all on the branch.
    expect(JSON.parse(await readFile(join(check, "places", "b.json"), "utf8"))).toEqual({ standing: "shown" });
    expect(await readFile(join(check, "places", "c.json"), "utf8")).toBe("{}\n");
    expect(await readFile(join(check, "places", "d.json"), "utf8")).toBe("{}\n");
    expect(git(check, "log", "--format=%s")).toContain("ai: approve held case");
    expect(await readFile(join(root, "gh.log"), "utf8")).toContain("pr comment 7");
  }, 30_000);
});

describe("the apply workflow's automatic publish step", () => {
  /** A data checkout on feedback/auto with one change, a body the apply wrote, and gh answering `merge` with `mergeExit`. */
  async function setUp(mergeExit: number, autoMergeSet = "false") {
    const remote = join(root, "data.git");
    git(root, "init", "--bare", "-b", "main", remote);
    const checkout = join(root, "data-auto");
    git(root, "clone", "-q", remote, checkout);
    identity(checkout);
    await writeFile(join(checkout, "README.md"), "data\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "-q", "-m", "data");
    git(checkout, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(checkout, "switch", "-q", "-c", "feedback/auto");
    await mkdir(join(checkout, "photos"), { recursive: true });
    await writeFile(join(checkout, "photos", "a.ndjson"), "{}\n");

    const temp = join(root, "temp");
    const bin = join(root, "bin");
    await mkdir(temp);
    await mkdir(bin);
    await writeFile(join(temp, "auto-pr-body.md"), autoPrBody("2026-11-03T00:00:00Z", [], [], new Map()));
    // gh records its calls instead of reaching GitHub, and copies each body file it is given.
    await writeFile(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        `echo "$@" >> "${join(root, "gh.log")}"`,
        `for a in "$@"; do if [ "$prev" = "--body-file" ]; then cat "$a" >> "${join(root, "bodies.log")}"; fi; prev="$a"; done`,
        'case "$1 $2" in',
        '  "pr create") echo "https://github.com/example/example-app-photos/pull/9" ;;',
        `  "pr view") echo "${autoMergeSet}" ;;`,
        `  "pr merge") [ ${mergeExit} -eq 0 ] || { echo "GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)" >&2; exit ${mergeExit}; } ;;`,
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "gh"), 0o755);
    return { remote, checkout, temp, bin };
  }

  async function publish(setup: Awaited<ReturnType<typeof setUp>>, prOpen: boolean) {
    if (prOpen) git(setup.checkout, "push", "-q", "origin", "HEAD:refs/heads/feedback/auto");
    return spawnSync("bash", ["-e", "-c", await stepScript("Publish automatic changes")], {
      cwd: setup.checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${setup.bin}:${process.env.PATH}`,
        GH_TOKEN: "x",
        ENGINE_DIR,
        DATA_REPO: "example/example-app-photos",
        BASE_BRANCH: "main",
        PR_OPEN: String(prOpen),
        PR_NUMBER: prOpen ? "7" : "",
        RUN_ID: "3",
        RUNNER_TEMP: setup.temp,
        GITHUB_OUTPUT: join(setup.temp, "output"),
      },
    });
  }
  const log = (name: string) => readFile(join(root, name), "utf8").catch(() => "");

  it("says loudly when auto-merge is off, and makes the PR say it needs merging by hand, without failing the run", async () => {
    const setup = await setUp(1);
    const result = await publish(setup, false);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/::error[^\n]*example\/example-app-photos[^\n]*allow_auto_merge/);
    expect(await log("gh.log")).toMatch(/pr edit https:\/\/github.com\/example\/example-app-photos\/pull\/9 --repo example\/example-app-photos --body-file/);
    const body = await readFile(join(setup.temp, "auto-pr-body.md"), "utf8");
    expect(body).not.toContain("merges itself");
    expect(body).toContain("needs merging by hand");
    expect(await readFile(join(setup.temp, "output"), "utf8")).toContain("pr=https://github.com/example/example-app-photos/pull/9");
  }, 30_000);

  it("keeps the body when auto-merge is on", async () => {
    const setup = await setUp(0);
    const result = await publish(setup, false);
    expect(result.status).toBe(0);
    expect(await readFile(join(setup.temp, "output"), "utf8")).toContain("landed=true");
    expect(result.stdout).not.toContain("::error");
    expect(await log("gh.log")).not.toContain("pr edit");
    expect(await readFile(join(setup.temp, "auto-pr-body.md"), "utf8")).toContain("merges itself once CI passes");
  }, 30_000);

  it("comments on an open PR without auto-merge that it needs merging by hand", async () => {
    const setup = await setUp(1);
    const result = await publish(setup, true);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/::error[^\n]*allow_auto_merge/);
    expect(await log("gh.log")).toContain("pr comment 7");
    const bodies = await log("bodies.log");
    expect(bodies).toContain("needs merging by hand");
    expect(bodies).not.toContain("merges itself");
  }, 30_000);

  it("says loudly when GitHub refuses the comment on an open PR, without failing the run, so the inbox moves are still recorded", async () => {
    const setup = await setUp(0, "true");
    await writeFile(
      join(setup.bin, "gh"),
      ["#!/bin/sh", `echo "$@" >> "${join(root, "gh.log")}"`, 'if [ "$1 $2" = "pr comment" ]; then echo "Body is too long" >&2; exit 1; fi', 'if [ "$1 $2" = "pr view" ]; then echo true; fi', ""].join("\n"),
    );
    const result = await publish(setup, true);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::error title=PR comment refused::");
  }, 30_000);

  it("says loudly when GitHub refuses to open the PR, without failing the run, and does not say the changes landed", async () => {
    const setup = await setUp(0);
    await writeFile(
      join(setup.bin, "gh"),
      ["#!/bin/sh", `echo "$@" >> "${join(root, "gh.log")}"`, 'if [ "$1 $2" = "pr create" ]; then echo "GraphQL: was submitted too quickly" >&2; exit 1; fi', ""].join("\n"),
    );
    const result = await publish(setup, false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::error title=PR refused::could not open the automatic PR on example/example-app-photos");
    const output = await readFile(join(setup.temp, "output"), "utf8").catch(() => "");
    expect(output).not.toContain("landed=true");
    expect(output).not.toContain("pr=");
    expect(await log("gh.log")).not.toContain("pr merge");
  }, 30_000);

  it("leaves an open PR that will merge itself alone", async () => {
    const setup = await setUp(1, "true");
    const result = await publish(setup, true);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("::error");
    expect(await log("gh.log")).not.toContain("pr merge");
    expect(await log("bodies.log")).toContain("merges itself once CI passes");
  }, 30_000);
});

describe("the apply workflow's step that reads recent PRs", () => {
  const author = (login: string, type: string) => ({ __typename: type, login });
  /** The data repository's PRs as GitHub's GraphQL API answers for them, newest first. */
  const answer = {
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 12,
              state: "MERGED",
              body: "- [ ] Approve owner claim fb_01JC0000000000000000000001: x",
              isCrossRepository: false,
              author: author("example-bot", "Bot"),
              comments: {
                nodes: [
                  { author: author("example-bot", "Bot"), body: "from the bot" },
                  { author: author("example-bot", "User"), body: "from a person with the same login" },
                  { author: null, body: "from a deleted account" },
                ],
              },
            },
            { number: 11, state: "OPEN", body: "", isCrossRepository: false, author: author("example-bot", "User"), comments: { nodes: [] } },
            { number: 10, state: "CLOSED", body: "", isCrossRepository: true, author: author("example-bot", "Bot"), comments: { nodes: [] } },
          ],
        },
      },
    },
  };

  it("gives every author its account type, and leaves the choice of the bot's own PRs to the apply", async () => {
    const temp = join(root, "temp");
    const bin = join(root, "bin");
    await mkdir(temp);
    await mkdir(bin);
    await writeFile(join(root, "answer.json"), JSON.stringify(answer));
    await writeFile(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${join(root, "gh.log")}"\ncat "${join(root, "answer.json")}"\n`);
    await chmod(join(bin, "gh"), 0o755);
    const result = spawnSync("bash", ["-e", "-c", await stepScript("Read recent review and automatic PRs for owner approvals and progress")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x", APP_SLUG: "example-bot", DATA_REPO: "example/data", RUNNER_TEMP: temp },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    for (const kind of ["review", "auto"]) {
      const prs = JSON.parse(await readFile(join(temp, `${kind}-prs.json`), "utf8"));
      expect(prs).toEqual([
        {
          number: 12,
          state: "MERGED",
          body: "- [ ] Approve owner claim fb_01JC0000000000000000000001: x",
          isCrossRepository: false,
          author: { login: "example-bot", type: "Bot" },
          comments: [
            { author: { login: "example-bot", type: "Bot" }, body: "from the bot" },
            { author: { login: "example-bot", type: "User" }, body: "from a person with the same login" },
            { author: null, body: "from a deleted account" },
          ],
        },
        { number: 11, state: "OPEN", body: "", isCrossRepository: false, author: { login: "example-bot", type: "User" }, comments: [] },
        { number: 10, state: "CLOSED", body: "", isCrossRepository: true, author: { login: "example-bot", type: "Bot" }, comments: [] },
      ]);
    }
    const calls = await readFile(join(root, "gh.log"), "utf8");
    expect(calls).toContain("head=feedback/review");
    expect(calls).toContain("head=feedback/auto");
  }, 30_000);

  /** A PR with 100 comments on its first page and `pages` more pages of comments, each with one, the last saying no more follow. */
  async function paged(pages: number) {
    const temp = join(root, "temp");
    const bin = join(root, "bin");
    await mkdir(temp);
    await mkdir(bin);
    const comment = (body: string) => ({ author: author("example-bot", "Bot"), body });
    const first = {
      data: {
        repository: {
          pullRequests: {
            nodes: [
              {
                number: 12,
                state: "MERGED",
                body: "",
                isCrossRepository: false,
                author: author("example-bot", "Bot"),
                comments: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: Array.from({ length: 100 }, (_, n) => comment(`old ${n}`)) },
              },
            ],
          },
        },
      },
    };
    await writeFile(join(root, "first.json"), JSON.stringify(first));
    for (let n = 1; n <= pages; n++) {
      const more = { data: { repository: { pullRequest: { comments: { pageInfo: { hasNextPage: n < pages, endCursor: `c${n + 1}` }, nodes: [comment(`newer ${n}`)] } } } } };
      await writeFile(join(root, `more-c${n}.json`), JSON.stringify(more));
    }
    // gh answers the first query from first.json and each later page from the file named by its cursor.
    await writeFile(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        `echo "$@" >> "${join(root, "gh.log")}"`,
        'after=""; for a in "$@"; do case "$a" in after=*) after="${a#after=}" ;; esac; done',
        `if [ -n "$after" ]; then cat "${root}/more-$after.json"; else cat "${join(root, "first.json")}"; fi`,
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "gh"), 0o755);
    return spawnSync("bash", ["-e", "-o", "pipefail", "-c", await stepScript("Read recent review and automatic PRs for owner approvals and progress")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x", APP_SLUG: "example-bot", DATA_REPO: "example/data", RUNNER_TEMP: temp },
    });
  }

  it("reads every comment of a PR with more than 100, oldest first", async () => {
    const result = await paged(3);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const prs = JSON.parse(await readFile(join(root, "temp", "review-prs.json"), "utf8")) as { comments: { body: string }[] }[];
    const bodies = prs[0]!.comments.map((c) => c.body);
    expect(bodies).toHaveLength(103);
    expect(bodies.slice(0, 2)).toEqual(["old 0", "old 1"]);
    expect(bodies.slice(-3)).toEqual(["newer 1", "newer 2", "newer 3"]);
  }, 30_000);

  it("stops the run loudly rather than leave comments unread past its limit", async () => {
    const result = await paged(40);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toMatch(/::error::PR 12 on example\/data has more than 3000 comments/);
  }, 30_000);
});

describe("the apply workflow's step that starts from the open PR branches", () => {
  /** Runs the step with the open auto PR authored by `login`, as the GitHub CLI lists it (a login with no account type). */
  async function start(login: string) {
    const remote = join(root, "data.git");
    git(root, "init", "--bare", "-b", "main", remote);
    const seed = join(root, "seed");
    git(root, "clone", "-q", remote, seed);
    identity(seed);
    await writeFile(join(seed, "README.md"), "data\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "data");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/feedback/auto");
    for (const dir of ["data-auto", "data-review"]) git(root, "clone", "-q", remote, join(root, dir));
    const temp = join(root, "temp");
    const bin = join(root, "bin");
    await mkdir(temp);
    await mkdir(bin);
    const prs = JSON.stringify([{ number: 5, isCrossRepository: false, author: { id: "x", is_bot: login.startsWith("app/"), login, name: "" } }]);
    await writeFile(join(root, "prs.json"), prs);
    await writeFile(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        'case "$1 $2" in',
        '  "api /users/"*) echo 1 ;;',
        `  "pr list") case "$*" in *feedback/auto*) cat "${join(root, "prs.json")}" ;; *) echo "[]" ;; esac ;;`,
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "gh"), 0o755);
    const result = spawnSync("bash", ["-e", "-c", await stepScript("Start from the open PR branches")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: "x", APP_SLUG: "example-bot", DATA_REPO: "example/data", BASE_BRANCH: "main", GITHUB_OUTPUT: join(temp, "output") },
    });
    const output = await readFile(join(temp, "output"), "utf8").catch(() => "");
    return { result, output };
  }

  // The step's jq and isBotAuthor must agree for every author the GitHub CLI can list.
  for (const login of ["example-bot[bot]", "app/example-bot", "example-bot", "someone", "app/someone", "example-bot[bot]x"]) {
    it(`treats a PR by ${login} as the apply's author rule does`, async () => {
      const { result, output } = await start(login);
      if (isBotAuthor({ login } as never, ["example-bot"])) {
        expect(result.stdout + result.stderr).not.toContain("::error");
        expect(result.status).toBe(0);
        expect(output).toContain("auto_pr=5");
        expect(output).toContain("auto_open=true");
      } else {
        expect(result.status).toBe(1);
        expect(result.stdout).toContain("::error::PR #5 on feedback/auto was not opened by example-bot");
      }
    }, 30_000);
  }
});

describe("the apply workflow when the open PR merged during the run", () => {
  /** A data remote whose PR branch `branch` was squash-merged into main after the run checked it out, and the run's checkout with one new change. */
  async function mergedMidRun(branch: string, options: { change?: boolean; states?: string[] } = {}) {
    const remote = join(root, "data.git");
    git(root, "init", "--bare", "-b", "main", remote);
    const seed = join(root, "seed");
    git(root, "clone", "-q", remote, seed);
    identity(seed);
    await mkdir(join(seed, "places"), { recursive: true });
    await writeFile(join(seed, "places", "a.json"), "{}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "data");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    await writeFile(join(seed, "places", "b.json"), "{\"earlier\": true}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "an earlier run");
    git(seed, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);

    // The run's checkout, as "Start from the open PR branches" leaves it.
    const checkout = join(root, "checkout");
    git(root, "clone", "-q", remote, checkout);
    identity(checkout);
    git(checkout, "fetch", "-q", "origin", branch);
    git(checkout, "switch", "-q", "-c", branch, `origin/${branch}`);
    git(checkout, "merge", "-q", "--no-edit", "origin/main");
    if (options.change !== false) await writeFile(join(checkout, "places", "c.json"), "{\"this run\": true}\n");

    // Meanwhile the PR is squash-merged into main.
    git(seed, "switch", "-q", "-c", "squash", "origin/main");
    await writeFile(join(seed, "places", "b.json"), "{\"earlier\": true}\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "Feedback (#7)");
    git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");

    const temp = join(root, "temp");
    const bin = join(root, "bin");
    await mkdir(temp);
    await mkdir(bin);
    await writeFile(join(temp, "auto-pr-body.md"), "auto body\n");
    await writeFile(join(temp, "review-pr-body.md"), "review body\n");
    // Each read of the PR's state answers the next of `states`, the last one from then on.
    const states = options.states ?? ["MERGED"];
    await writeFile(join(root, "states"), `${states.join("\n")}\n`);
    await writeFile(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        `echo "$@" >> "${join(root, "gh.log")}"`,
        'case "$*" in',
        `  "pr view"*"--json state"*) head -n 1 "${join(root, "states")}"; if [ "$(wc -l < "${join(root, "states")}")" -gt 1 ]; then sed -i.bak 1d "${join(root, "states")}"; fi ;;`,
        '  "pr view"*) echo true ;;',
        '  "pr create"*) echo "https://github.com/example/data/pull/8" ;;',
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "gh"), 0o755);
    return { remote, checkout, temp, bin };
  }

  const publish = async (step: string, setup: Awaited<ReturnType<typeof mergedMidRun>>) =>
    spawnSync("bash", ["-e", "-c", await stepScript(step)], {
      cwd: setup.checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${setup.bin}:${process.env.PATH}`,
        GH_TOKEN: "x",
        ENGINE_DIR,
        DATA_REPO: "example/data",
        BASE_BRANCH: "main",
        PR_OPEN: "true",
        PR_NUMBER: "7",
        OWNER_CLAIMS: "false",
        RUN_ID: "4",
        RUNNER_TEMP: setup.temp,
        GITHUB_OUTPUT: join(setup.temp, "output"),
      },
    });

  for (const [step, branch] of [["Publish automatic changes", "feedback/auto"], ["Publish changes for review", "feedback/review"]] as const) {
    it(`${step}: moves this run's change to a new PR when the PR merges between the state read and the push`, async () => {
      const setup = await mergedMidRun(branch, { states: ["OPEN", "MERGED"] });
      const result = await publish(step, setup);
      expect(result.stdout + result.stderr).not.toContain("::error");
      expect(result.status).toBe(0);
      const calls = await readFile(join(root, "gh.log"), "utf8");
      expect(calls).toContain(`pr create --repo example/data --base main --head ${branch}`);
      expect(calls).not.toContain("pr comment 7");
      const check = join(root, "check");
      git(root, "clone", "-q", "-b", branch, setup.remote, check);
      expect(git(check, "rev-parse", "HEAD~1")).toBe(git(check, "rev-parse", "origin/main"));
      expect(git(check, "diff", "--name-only", "origin/main", "HEAD")).toBe("places/c.json");
      if (branch === "feedback/auto") expect(await readFile(join(setup.temp, "output"), "utf8")).toContain("landed=true");
    }, 30_000);

    it(`${step}: opens a new PR from the base branch with only this run's change`, async () => {
      const setup = await mergedMidRun(branch);
      const result = spawnSync("bash", ["-e", "-c", await stepScript(step)], {
        cwd: setup.checkout,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${setup.bin}:${process.env.PATH}`,
          GH_TOKEN: "x",
          ENGINE_DIR,
          DATA_REPO: "example/data",
          BASE_BRANCH: "main",
          PR_OPEN: "true",
          PR_NUMBER: "7",
          OWNER_CLAIMS: "false",
          RUN_ID: "4",
          RUNNER_TEMP: setup.temp,
          GITHUB_OUTPUT: join(setup.temp, "output"),
        },
      });
      expect(result.stdout + result.stderr).not.toContain("::error");
      expect(result.status).toBe(0);
      const calls = await readFile(join(root, "gh.log"), "utf8");
      expect(calls).toContain(`pr create --repo example/data --base main --head ${branch}`);
      expect(calls).not.toContain("pr comment 7");
      // The branch is main plus this run's commit alone.
      const check = join(root, "check");
      git(root, "clone", "-q", "-b", branch, setup.remote, check);
      expect(git(check, "rev-parse", "HEAD~1")).toBe(git(check, "rev-parse", "origin/main"));
      expect(git(check, "diff", "--name-only", "origin/main", "HEAD")).toBe("places/c.json");
    }, 30_000);
  }

  it("Publish changes for review: opens a new PR with an empty commit when the run changed no file", async () => {
    const setup = await mergedMidRun("feedback/review", { change: false });
    const result = await publish("Publish changes for review", setup);
    expect(result.stdout + result.stderr).not.toContain("::error");
    expect(result.status).toBe(0);
    expect(await readFile(join(root, "gh.log"), "utf8")).toContain("pr create --repo example/data --base main --head feedback/review");
    expect(await readFile(join(setup.temp, "output"), "utf8")).toContain("claims_listed=true");
    const check = join(root, "check");
    git(root, "clone", "-q", "-b", "feedback/review", setup.remote, check);
    expect(git(check, "rev-parse", "HEAD~1")).toBe(git(check, "rev-parse", "origin/main"));
    expect(git(check, "log", "-1", "--format=%s")).toBe("Feedback for review (run 4)");
  }, 30_000);
});

describe("the apply workflow's review publish step when GitHub refuses the text", () => {
  async function setUp(refuse: "create" | "comment" | "label" | "none") {
    const remote = join(root, "data.git");
    git(root, "init", "--bare", "-b", "main", remote);
    const checkout = join(root, "data-review");
    git(root, "clone", "-q", remote, checkout);
    identity(checkout);
    await writeFile(join(checkout, "README.md"), "data\n");
    git(checkout, "add", "-A");
    git(checkout, "commit", "-q", "-m", "data");
    git(checkout, "push", "-q", "origin", "HEAD:refs/heads/main");
    git(checkout, "switch", "-q", "-c", "feedback/review");
    await writeFile(join(checkout, "b.json"), "{}\n");
    const temp = join(root, "temp");
    const bin = join(root, "bin");
    await mkdir(temp);
    await mkdir(bin);
    await writeFile(join(temp, "review-pr-body.md"), "body\n");
    await writeFile(join(temp, "review-pr-body.md.2"), "more 2\n");
    await writeFile(join(temp, "review-pr-body.md.3"), "more 3\n");
    await writeFile(
      join(bin, "gh"),
      [
        "#!/bin/sh",
        `echo "$@" >> "${join(root, "gh.log")}"`,
        `for a in "$@"; do if [ "$prev" = "--body-file" ]; then cat "$a" >> "${join(root, "bodies.log")}"; fi; prev="$a"; done`,
        'case "$1 $2" in',
        `  "pr create") [ "${refuse}" = create ] && { echo "body is too long" >&2; exit 1; }; echo "https://github.com/example/data/pull/8" ;;`,
        `  "pr comment") [ "${refuse}" = comment ] && { echo "body is too long" >&2; exit 1; }; true ;;`,
        `  "pr edit") [ "${refuse}" = label ] && { echo "could not add label: 'owner-claim' not found" >&2; exit 1; }; true ;;`,
        '  "pr view") echo OPEN ;;',
        "esac",
        "",
      ].join("\n"),
    );
    await chmod(join(bin, "gh"), 0o755);
    return { remote, checkout, temp, bin };
  }
  async function publish(setup: Awaited<ReturnType<typeof setUp>>, prOpen: boolean, extraEnv: Record<string, string> = {}) {
    if (prOpen) git(setup.checkout, "push", "-q", "origin", "HEAD:refs/heads/feedback/review");
    return spawnSync("bash", ["-e", "-c", await stepScript("Publish changes for review")], {
      cwd: setup.checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${setup.bin}:${process.env.PATH}`,
        GH_TOKEN: "x",
        ENGINE_DIR,
        DATA_REPO: "example/data",
        BASE_BRANCH: "main",
        PR_OPEN: String(prOpen),
        PR_NUMBER: prOpen ? "7" : "",
        OWNER_CLAIMS: "true",
        RUN_ID: "5",
        RUNNER_TEMP: setup.temp,
        GITHUB_OUTPUT: join(setup.temp, "output"),
        ...extraEnv,
      },
    });
  }
  const output = (temp: string) => readFile(join(temp, "output"), "utf8").catch(() => "");

  it("posts the follow-up comments in order after the body, and says the claims are listed", async () => {
    const setup = await setUp("none");
    const result = await publish(setup, false);
    expect(result.status).toBe(0);
    expect(await readFile(join(root, "bodies.log"), "utf8")).toBe("body\nmore 2\nmore 3\n");
    expect(await readFile(join(root, "gh.log"), "utf8")).toContain("pr comment https://github.com/example/data/pull/8");
    expect(await output(setup.temp)).toContain("claims_listed=true");
  }, 30_000);

  it("opens the PR without labels and labels it in a call of its own", async () => {
    const setup = await setUp("none");
    const result = await publish(setup, false);
    expect(result.status).toBe(0);
    const calls = await readFile(join(root, "gh.log"), "utf8");
    expect(calls).toMatch(/^pr create (?!.*--label).*$/m);
    expect(calls).toContain("pr edit https://github.com/example/data/pull/8 --repo example/data --add-label needs-review,owner-claim");
  }, 30_000);

  for (const prOpen of [false, true]) {
    it(`mentions the claim reviewers in a comment on ${prOpen ? "the open" : "a new"} PR`, async () => {
      const setup = await setUp("none");
      const result = await publish(setup, prOpen, { CLAIM_REVIEWERS: "octocat, hubot" });
      expect(result.status).toBe(0);
      const pr = prOpen ? "7" : "https://github.com/example/data/pull/8";
      expect(await readFile(join(root, "gh.log"), "utf8")).toContain(
        `pr comment ${pr} --repo example/data --body @octocat @hubot owner claims are waiting for your decision on this PR.`,
      );
    }, 30_000);
  }

  it("mentions nobody without claim reviewers, or when the run sent no owner claims", async () => {
    const setup = await setUp("none");
    expect((await publish(setup, false)).status).toBe(0);
    expect((await publish(setup, true, { CLAIM_REVIEWERS: "octocat", OWNER_CLAIMS: "false" })).status).toBe(0);
    expect(await readFile(join(root, "gh.log"), "utf8")).not.toContain("--body @");
  }, 30_000);

  it("skips a claim reviewer that is not a GitHub login, with a warning", async () => {
    const setup = await setUp("none");
    const result = await publish(setup, false, { CLAIM_REVIEWERS: "octocat,$(id);x" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning::claim-reviewers holds a name that is not a GitHub login");
    expect(await readFile(join(root, "gh.log"), "utf8")).toContain("--body @octocat owner claims");
  }, 30_000);

  it("keeps the PR and says the claims are listed when a label is missing", async () => {
    const setup = await setUp("label");
    const result = await publish(setup, false);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning::could not label https://github.com/example/data/pull/8");
    expect(result.stdout).not.toContain("::error");
    expect(await output(setup.temp)).toContain("claims_listed=true");
  }, 30_000);

  for (const [refuse, prOpen] of [["create", false], ["comment", true]] as const) {
    it(`says loudly when GitHub refuses the ${refuse}, without failing the run, and does not say the claims are listed`, async () => {
      const setup = await setUp(refuse);
      const result = await publish(setup, prOpen);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("::error title=PR text refused::");
      expect(await output(setup.temp)).not.toContain("claims_listed=true");
      expect(await readFile(join(root, "bodies.log"), "utf8").catch(() => "")).not.toContain("more 2");
    }, 30_000);
  }
});

describe("the apply workflow's inbox commit step", () => {
  /**
   * An inbox remote with five pending items, and a checkout where the apply moved two claims to
   * owner-claims/, refused one, applied one for the review PR and one for the automatic PR.
   */
  async function setUp() {
    const remote = join(root, "inbox.git");
    git(root, "init", "--bare", "-b", "main", remote);
    const inbox = join(root, "inbox");
    git(root, "clone", "-q", remote, inbox);
    identity(inbox);
    for (const n of [1, 2, 3, 4, 5]) {
      await mkdir(join(inbox, "pending", "2026-11-01"), { recursive: true });
      await writeFile(join(inbox, "pending", "2026-11-01", `fb_${n}.json`), `{"id": "fb_${n}"}\n`);
    }
    git(inbox, "add", "-A");
    git(inbox, "commit", "-q", "-m", "pending");
    git(inbox, "push", "-q", "origin", "HEAD:refs/heads/main");
    await mkdir(join(inbox, "owner-claims"));
    await mkdir(join(inbox, "refused", "2026-11-01"), { recursive: true });
    for (const n of [1, 2]) {
      await rm(join(inbox, "pending", "2026-11-01", `fb_${n}.json`));
      await writeFile(join(inbox, "owner-claims", `fb_${n}.json`), `{"item": {"id": "fb_${n}"}}\n`);
    }
    await rm(join(inbox, "pending", "2026-11-01", "fb_3.json"));
    await writeFile(join(inbox, "refused", "2026-11-01", "fb_3.json"), `{"id": "fb_3", "outcome": {}}\n`);
    await mkdir(join(inbox, "applied", "2026-11-01"), { recursive: true });
    for (const n of [4, 5]) {
      await rm(join(inbox, "pending", "2026-11-01", `fb_${n}.json`));
      await writeFile(join(inbox, "applied", "2026-11-01", `fb_${n}.json`), `{"id": "fb_${n}", "outcome": {}}\n`);
    }
    await rm(join(inbox, "pending"), { recursive: true });
    const temp = join(root, "temp");
    await mkdir(temp);
    const move = (n: number) => ({ from: `pending/2026-11-01/fb_${n}.json`, to: `applied/2026-11-01/fb_${n}.json` });
    await writeFile(
      join(temp, "summary.json"),
      JSON.stringify({
        claim_moves: [1, 2].map((n) => ({ from: `pending/2026-11-01/fb_${n}.json`, to: `owner-claims/fb_${n}.json` })),
        review_moves: [move(4)],
        auto_moves: [move(5)],
      }),
    );
    return { remote, inbox, temp };
  }
  async function commit(setup: Awaited<ReturnType<typeof setUp>>, listed: string, landed = "true") {
    return spawnSync("bash", ["-e", "-c", await stepScript("Commit the inbox moves")], {
      cwd: setup.inbox,
      encoding: "utf8",
      env: {
        ...process.env,
        APP_SLUG: "example-bot",
        BOT_EMAIL: "1+example-bot[bot]@users.noreply.github.com",
        RUN_ID: "6",
        RUNNER_TEMP: setup.temp,
        AUTO_CHANGED: "true",
        AUTO_LANDED: landed,
        REVIEW_CHANGED: "true",
        CLAIMS_LISTED: listed,
      },
    });
  }
  const files = (setup: Awaited<ReturnType<typeof setUp>>) => {
    const check = join(root, "check");
    git(root, "clone", "-q", setup.remote, check);
    return git(check, "ls-files").split("\n");
  };

  it("puts the claims and the items for a person back in pending/ when no PR text lists them, and records the other moves", async () => {
    const setup = await setUp();
    const result = await commit(setup, "");
    expect(result.stderr).not.toContain("::error");
    expect(result.status).toBe(0);
    expect(files(setup)).toEqual([
      "applied/2026-11-01/fb_5.json",
      "pending/2026-11-01/fb_1.json",
      "pending/2026-11-01/fb_2.json",
      "pending/2026-11-01/fb_4.json",
      "refused/2026-11-01/fb_3.json",
    ]);
  }, 30_000);

  it("records every move once the PR texts were accepted and the automatic changes landed", async () => {
    const setup = await setUp();
    const result = await commit(setup, "true");
    expect(result.status).toBe(0);
    expect(files(setup)).toEqual([
      "applied/2026-11-01/fb_4.json",
      "applied/2026-11-01/fb_5.json",
      "owner-claims/fb_1.json",
      "owner-claims/fb_2.json",
      "refused/2026-11-01/fb_3.json",
    ]);
  }, 30_000);

  it("puts the automatic items back in pending/ when their changes did not land on an open PR", async () => {
    const setup = await setUp();
    const result = await commit(setup, "true", "");
    expect(result.status).toBe(0);
    expect(files(setup)).toEqual([
      "applied/2026-11-01/fb_4.json",
      "owner-claims/fb_1.json",
      "owner-claims/fb_2.json",
      "pending/2026-11-01/fb_5.json",
      "refused/2026-11-01/fb_3.json",
    ]);
  }, 30_000);
});
