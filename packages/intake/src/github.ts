/**
 * GitHub App authentication with WebCrypto (RS256 JWT, installation tokens
 * cached until near expiry), file creation through the contents API, many
 * files in one commit through the Git Data API,
 * starting a workflow through the Actions API, and the calls the AI reviewer
 * makes on the data repository's review PR.
 */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubAppConfig {
  appId: string;
  privateKeyPem: string;
  installationId: string;
  /** `owner/name` of the repository the token is limited to. */
  repo: string;
}

const API = "https://api.github.com";
const USER_AGENT = "opencampingdb-feedback-intake";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Permissions an installation token asks for, as the access_tokens endpoint takes them. */
export type TokenPermissions = Partial<Record<"contents" | "actions" | "pull_requests", "read" | "write">>;

/** What writing to the inbox needs. */
const CONTENTS_WRITE: TokenPermissions = { contents: "write" };
/** What starting a workflow needs, and nothing else. */
const ACTIONS_WRITE: TokenPermissions = { actions: "write" };
/** What the AI reviewer needs on the data repository: commits to the review branch and comments on its PR. */
const REVIEW_WRITE: TokenPermissions = { contents: "write", pull_requests: "write" };

/** An open pull request, as the reviewer reads it. */
export interface PullRequest {
  number: number;
  body: string;
}

/** A comment on a pull request, with who wrote it. */
export interface IssueComment {
  body: string;
  /** The author's login: `<app slug>[bot]` for a GitHub App. */
  login: string;
  /** `Bot` for a GitHub App. */
  userType: string;
  /** `OWNER`, `MEMBER`, `COLLABORATOR`, `CONTRIBUTOR`, `NONE` and so on. */
  association: string;
}

/** Comments read from one PR at most, 100 a page. */
const MAX_COMMENT_PAGES = 10;

function base64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const b of data) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64Utf8(text: string): string {
  const data = new TextEncoder().encode(text);
  let binary = "";
  for (const b of data) binary += String.fromCharCode(b);
  return btoa(binary);
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

/** Wraps a PKCS#1 RSA key (what GitHub issues) in a PKCS#8 envelope, which WebCrypto needs. */
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLength(pkcs1.length)];
  const bodyLength = version.length + algorithm.length + octet.length + pkcs1.length;
  const out = new Uint8Array([0x30, ...derLength(bodyLength), ...version, ...algorithm, ...octet, ...pkcs1]);
  return out;
}

export async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const normalised = pem.replace(/\\n/g, "\n").trim();
  const isPkcs1 = normalised.includes("BEGIN RSA PRIVATE KEY");
  const body = normalised.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  const der = isPkcs1 ? pkcs1ToPkcs8(raw) : raw;
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

/** Signs the short-lived JWT GitHub accepts from an App. */
export async function createAppJwt(appId: string, key: CryptoKey, nowMs: number): Promise<string> {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

export class GitHubError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
  }
}

export class GitHubApp {
  #cached = new Map<string, CachedToken>();
  #key: { pem: string; key: Promise<CryptoKey> } | undefined;

  constructor(
    private readonly fetchImpl: Fetch,
    private readonly now: () => number,
  ) {}

  #importKey(pem: string): Promise<CryptoKey> {
    if (!this.#key || this.#key.pem !== pem) this.#key = { pem, key: importPrivateKey(pem) };
    return this.#key.key;
  }

  /**
   * Returns an installation token limited to the configured repository and
   * the given permissions (`contents: write` by default). Each set of
   * permissions gets a token of its own, so a permission the App lacks never
   * stops the inbox writes.
   */
  async token(config: GitHubAppConfig, permissions: TokenPermissions = CONTENTS_WRITE): Promise<string> {
    const cacheKey = `${config.appId}/${config.installationId}/${config.repo}/${JSON.stringify(permissions)}`;
    const cached = this.#cached.get(cacheKey);
    if (cached && cached.expiresAt - this.now() > REFRESH_MARGIN_MS) {
      return cached.token;
    }
    const jwt = await createAppJwt(config.appId, await this.#importKey(config.privateKeyPem), this.now());
    const repoName = config.repo.split("/")[1];
    const res = await this.fetchImpl(`${API}/app/installations/${config.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify({ repositories: [repoName], permissions }),
    });
    if (!res.ok) throw new GitHubError(`installation token request failed with ${res.status}`, res.status);
    const body = (await res.json()) as { token: string; expires_at: string };
    this.#cached.set(cacheKey, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  forgetToken(): void {
    this.#cached.clear();
  }

  /** Creates a file. Fails if the path already exists. Retries once with a new token on 401. */
  async createFile(config: GitHubAppConfig, branch: string, path: string, content: string, message: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(config);
      const res = await this.fetchImpl(`${API}/repos/${config.repo}/contents/${path}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": USER_AGENT,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message, content: base64Utf8(content), branch }),
      });
      if (res.ok) return;
      if (res.status === 401 && attempt === 0) {
        this.forgetToken();
        continue;
      }
      throw new GitHubError(`creating ${path} failed with ${res.status}`, res.status);
    }
  }

  /**
   * Starts a workflow that runs on `workflow_dispatch`, named by its file name
   * (`apply-feedback.yml`) or its id, on `ref`. Needs the App's `actions: write`.
   * Retries once with a new token on 401.
   */
  async dispatchWorkflow(config: GitHubAppConfig, workflow: string, ref: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(config, ACTIONS_WRITE);
      const res = await this.fetchImpl(`${API}/repos/${config.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": USER_AGENT,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ref }),
      });
      if (res.ok) return;
      if (res.status === 401 && attempt === 0) {
        this.forgetToken();
        continue;
      }
      throw new GitHubError(`starting ${workflow} failed with ${res.status}`, res.status);
    }
  }
  /** One REST call with a token for `permissions`. Retries once with a new token on 401. */
  async #call(config: GitHubAppConfig, permissions: TokenPermissions, method: string, path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.token(config, permissions);
      const res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": USER_AGENT,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 401 && attempt === 0) {
        this.forgetToken();
        continue;
      }
      return res;
    }
  }

  /** The commit `branch` points at. */
  async branchHead(config: GitHubAppConfig, branch: string): Promise<string> {
    const res = await this.#call(config, CONTENTS_WRITE, "GET", `/repos/${config.repo}/git/ref/heads/${branch}`);
    if (!res.ok) throw new GitHubError(`reading the head of ${branch} failed with ${res.status}`, res.status);
    return ((await res.json()) as { object: { sha: string } }).object.sha;
  }

  /** The tree of commit `sha`. */
  async commitTree(config: GitHubAppConfig, sha: string): Promise<string> {
    const res = await this.#call(config, CONTENTS_WRITE, "GET", `/repos/${config.repo}/git/commits/${sha}`);
    if (!res.ok) throw new GitHubError(`reading commit ${sha} failed with ${res.status}`, res.status);
    return ((await res.json()) as { tree: { sha: string } }).tree.sha;
  }

  /**
   * A tree of `baseTree` with each file added or replaced, its text given
   * inline so GitHub writes the blobs. The same files on the same base give
   * the same tree, so a tree equal to `baseTree` means nothing changed.
   */
  async createTree(config: GitHubAppConfig, baseTree: string, files: readonly { path: string; content: string }[]): Promise<string> {
    const tree = files.map((f) => ({ path: f.path, mode: "100644", type: "blob", content: f.content }));
    const res = await this.#call(config, CONTENTS_WRITE, "POST", `/repos/${config.repo}/git/trees`, { base_tree: baseTree, tree });
    if (!res.ok) throw new GitHubError(`creating a tree of ${files.length} files failed with ${res.status}`, res.status);
    return ((await res.json()) as { sha: string }).sha;
  }

  /** A commit of `tree` on `parents`, by the App. */
  async createCommit(config: GitHubAppConfig, message: string, tree: string, parents: readonly string[]): Promise<string> {
    const res = await this.#call(config, CONTENTS_WRITE, "POST", `/repos/${config.repo}/git/commits`, { message, tree, parents });
    if (!res.ok) throw new GitHubError(`creating a commit failed with ${res.status}`, res.status);
    return ((await res.json()) as { sha: string }).sha;
  }

  /**
   * Moves `branch` to `sha`, never by force. False when the branch has moved
   * on and `sha` is not a fast forward of it (GitHub answers 422, or 409).
   */
  async updateBranch(config: GitHubAppConfig, branch: string, sha: string): Promise<boolean> {
    const res = await this.#call(config, CONTENTS_WRITE, "PATCH", `/repos/${config.repo}/git/refs/heads/${branch}`, { sha, force: false });
    if (res.ok) return true;
    if (res.status === 422 || res.status === 409) return false;
    throw new GitHubError(`moving ${branch} failed with ${res.status}`, res.status);
  }

  /** Whether commit `sha` is on `branch`: the branch is that commit or one after it. False for a commit GitHub doesn't have. */
  async isOnBranch(config: GitHubAppConfig, sha: string, branch: string): Promise<boolean> {
    const res = await this.#call(config, CONTENTS_WRITE, "GET", `/repos/${config.repo}/compare/${sha}...${branch}?per_page=1`);
    if (res.status === 404) return false;
    if (!res.ok) throw new GitHubError(`comparing ${sha} with ${branch} failed with ${res.status}`, res.status);
    const status = ((await res.json()) as { status?: string }).status;
    return status === "ahead" || status === "identical";
  }

  /** The open PR from `branch` in the configured repository, or null when there is none. */
  async openPullRequest(config: GitHubAppConfig, branch: string): Promise<PullRequest | null> {
    const owner = config.repo.split("/")[0];
    const head = encodeURIComponent(`${owner}:${branch}`);
    const res = await this.#call(config, REVIEW_WRITE, "GET", `/repos/${config.repo}/pulls?head=${head}&state=open&per_page=1`);
    if (!res.ok) throw new GitHubError(`listing PRs from ${branch} failed with ${res.status}`, res.status);
    const list = (await res.json()) as { number: number; body: string | null }[];
    const pr = list[0];
    return pr ? { number: pr.number, body: pr.body ?? "" } : null;
  }

  /** Comments on PR `number`, oldest first, up to 1,000. */
  async pullRequestComments(config: GitHubAppConfig, number: number): Promise<IssueComment[]> {
    const out: IssueComment[] = [];
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const res = await this.#call(config, REVIEW_WRITE, "GET", `/repos/${config.repo}/issues/${number}/comments?per_page=100&page=${page}`);
      if (!res.ok) throw new GitHubError(`reading comments on #${number} failed with ${res.status}`, res.status);
      const list = (await res.json()) as { body?: string | null; user?: { login?: string; type?: string } | null; author_association?: string }[];
      for (const c of list) {
        out.push({ body: c.body ?? "", login: c.user?.login ?? "", userType: c.user?.type ?? "", association: c.author_association ?? "NONE" });
      }
      if (list.length < 100) break;
    }
    return out;
  }

  /** A text file on `ref`, with the blob sha an update needs, or null when there is none. */
  async readFile(config: GitHubAppConfig, path: string, ref: string): Promise<{ text: string; sha: string } | null> {
    const res = await this.#call(config, REVIEW_WRITE, "GET", `/repos/${config.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(`reading ${path} failed with ${res.status}`, res.status);
    const body = (await res.json()) as { content?: string; encoding?: string; sha: string };
    if (body.encoding !== "base64" || typeof body.content !== "string") throw new GitHubError(`reading ${path} gave no content`, res.status);
    const bytes = Uint8Array.from(atob(body.content.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    return { text: new TextDecoder().decode(bytes), sha: body.sha };
  }

  /**
   * Commits a new version of a file to `branch`. `sha` is the blob the change
   * was made against, or undefined to create the file: GitHub answers 409
   * when the file has moved on since (or 422 when it exists already), which
   * throws a GitHubError with that status.
   */
  async updateFile(config: GitHubAppConfig, branch: string, path: string, content: string, sha: string | undefined, message: string): Promise<void> {
    const res = await this.#call(config, REVIEW_WRITE, "PUT", `/repos/${config.repo}/contents/${path}`, { message, content: base64Utf8(content), sha, branch });
    if (!res.ok) throw new GitHubError(`updating ${path} failed with ${res.status}`, res.status);
  }

  /** Adds a comment to PR `number`. */
  async commentOnPullRequest(config: GitHubAppConfig, number: number, body: string): Promise<void> {
    const res = await this.#call(config, REVIEW_WRITE, "POST", `/repos/${config.repo}/issues/${number}/comments`, { body });
    if (!res.ok) throw new GitHubError(`commenting on #${number} failed with ${res.status}`, res.status);
  }
}
