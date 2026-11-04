import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const WORKFLOW = new URL("../../../.github/workflows/apply-feedback.yml", import.meta.url);

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
        DATA_REPO: "example/data",
        BASE_BRANCH: "main",
        PR_OPEN: "true",
        PR_NUMBER: "7",
        OWNER_CLAIMS: "false",
        RUN_ID: "2",
        RUNNER_TEMP: temp,
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
