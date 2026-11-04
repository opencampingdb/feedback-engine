import { createHash } from "node:crypto";

/**
 * A GitHub repository behind the REST calls the intake makes to write the
 * inbox: installation tokens, the contents API (one commit per file) and the
 * Git Data API (refs, commits, trees with inline content on a base tree,
 * compare). Trees are flat maps of path to text, and a tree's sha is the hash
 * of its entries, so the same files give the same tree.
 *
 * `refStatus` answers the next ref updates with these statuses instead (422 is
 * GitHub's answer to an update that is not a fast forward), and `beforeRefUpdate`
 * runs before each one, to move the branch on as another writer would.
 */
export function fakeGit(options: { repo?: string; branch?: string; now?: () => number } = {}) {
  const repo = options.repo ?? "opencampingdb/inbox";
  const branches = new Map<string, string>();
  const commits = new Map<string, { tree: string; parents: string[]; message: string }>();
  const trees = new Map<string, Map<string, string>>();
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  const control = {
    refStatus: [] as number[],
    beforeRefUpdate: undefined as (() => void) | undefined,
    /** Runs before each tree is created, to act as another writer would meanwhile. */
    beforeTree: undefined as (() => void | Promise<void>) | undefined,
    /** Calls whose URL contains this never answer, until aborted. */
    hang: undefined as string | undefined,
    /** Answers every Git Data and contents call with this status while set. */
    down: undefined as number | undefined,
  };

  const hash = (text: string) => createHash("sha1").update(text).digest("hex");
  const putTree = (files: Map<string, string>) => {
    const sha = hash(JSON.stringify([...files].sort(([a], [b]) => (a < b ? -1 : 1))));
    trees.set(sha, files);
    return sha;
  };
  const putCommit = (tree: string, parents: string[], message: string) => {
    const sha = hash(`${tree}:${parents.join(",")}:${message}:${commits.size}`);
    commits.set(sha, { tree, parents, message });
    return sha;
  };
  const root = putCommit(putTree(new Map([["README.md", "inbox\n"]])), [], "first");
  branches.set(options.branch ?? "main", root);

  const files = (branch = options.branch ?? "main") => trees.get(commits.get(branches.get(branch)!)!.tree)!;
  const ancestors = (sha: string): Set<string> => {
    const out = new Set<string>();
    const stack = [sha];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (out.has(next)) continue;
      out.add(next);
      stack.push(...(commits.get(next)?.parents ?? []));
    }
    return out;
  };
  /** Another writer adds a file to `branch`, as the apply's inbox commit or a direct write does. */
  const commitOnBranch = (path: string, content: string, branch = options.branch ?? "main") => {
    const next = new Map(files(branch));
    next.set(path, content);
    branches.set(branch, putCommit(putTree(next), [branches.get(branch)!], `Add ${path}`));
  };
  /** Items in `pending/` on the branch, parsed. */
  const pending = (branch = options.branch ?? "main") =>
    [...files(branch)].filter(([path]) => path.startsWith("pending/")).map(([, text]) => JSON.parse(text) as Record<string, unknown>);
  const log = (branch = options.branch ?? "main") => {
    const out: { sha: string; message: string; parents: string[] }[] = [];
    for (let sha: string | undefined = branches.get(branch); sha; sha = commits.get(sha)!.parents[0]) out.push({ sha, ...commits.get(sha)! });
    return out;
  };

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  async function fetch(input: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    calls.push({ method, url: input, ...(body ? { body } : {}) });
    if (control.hang !== undefined && input.includes(control.hang)) {
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const url = new URL(input);
    if (url.pathname.endsWith("/access_tokens")) {
      return json(201, { token: "ghs_test", expires_at: new Date((options.now?.() ?? Date.now()) + 3_600_000).toISOString() });
    }
    const prefix = `/repos/${repo}/`;
    if (!url.pathname.startsWith(prefix)) return json(404, {});
    if (control.down !== undefined) return json(control.down, {});
    const rest = url.pathname.slice(prefix.length);
    let match: RegExpExecArray | null;
    if (method === "PUT" && rest.startsWith("contents/")) {
      const path = decodeURIComponent(rest.slice("contents/".length));
      const branch = (body!.branch as string) ?? "main";
      if (files(branch).has(path)) return json(422, { message: "sha wasn't supplied" });
      commitOnBranch(path, Buffer.from(body!.content as string, "base64").toString("utf8"), branch);
      return json(201, {});
    }
    if (method === "GET" && (match = /^git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = branches.get(match[1]!);
      return sha ? json(200, { ref: `refs/heads/${match[1]}`, object: { type: "commit", sha } }) : json(404, {});
    }
    if (method === "GET" && (match = /^git\/commits\/([0-9a-f]+)$/.exec(rest))) {
      const commit = commits.get(match[1]!);
      return commit ? json(200, { sha: match[1], tree: { sha: commit.tree }, parents: commit.parents.map((sha) => ({ sha })) }) : json(404, {});
    }
    if (method === "POST" && rest === "git/trees") {
      await control.beforeTree?.();
      const base = trees.get(body!.base_tree as string);
      if (!base) return json(422, {});
      const next = new Map(base);
      for (const entry of body!.tree as { path: string; mode: string; type: string; content?: string; sha?: string }[]) {
        if (entry.mode !== "100644" || entry.type !== "blob" || typeof entry.content !== "string" || "sha" in entry) return json(422, {});
        next.set(entry.path, entry.content);
      }
      return json(201, { sha: putTree(next) });
    }
    if (method === "POST" && rest === "git/commits") {
      const parents = body!.parents as string[];
      if (!trees.has(body!.tree as string) || !parents.every((p) => commits.has(p))) return json(422, {});
      return json(201, { sha: putCommit(body!.tree as string, parents, body!.message as string) });
    }
    if (method === "PATCH" && (match = /^git\/refs\/heads\/(.+)$/.exec(rest))) {
      control.beforeRefUpdate?.();
      const forced = control.refStatus.shift();
      if (forced !== undefined) return json(forced, { message: "Update is not a fast forward" });
      const branch = match[1]!;
      const sha = body!.sha as string;
      if (body!.force !== false) return json(400, { message: "the intake must never force" });
      if (!ancestors(sha).has(branches.get(branch)!)) return json(422, { message: "Update is not a fast forward" });
      branches.set(branch, sha);
      return json(200, { object: { sha } });
    }
    if (method === "GET" && (match = /^compare\/([0-9a-f]+)\.\.\.(.+)$/.exec(rest))) {
      const base = match[1]!;
      const head = branches.get(match[2]!);
      if (!commits.has(base) || !head) return json(404, {});
      return json(200, { status: base === head ? "identical" : ancestors(head).has(base) ? "ahead" : "diverged" });
    }
    return json(404, {});
  }

  return { fetch, calls, control, files, pending, log, commitOnBranch, branches };
}
