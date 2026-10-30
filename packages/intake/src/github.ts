/**
 * GitHub App authentication with WebCrypto (RS256 JWT, installation token
 * cached until near expiry) and file creation through the contents API.
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
  cacheKey: string;
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
  #cached: CachedToken | undefined;
  #key: { pem: string; key: Promise<CryptoKey> } | undefined;

  constructor(
    private readonly fetchImpl: Fetch,
    private readonly now: () => number,
  ) {}

  #importKey(pem: string): Promise<CryptoKey> {
    if (!this.#key || this.#key.pem !== pem) this.#key = { pem, key: importPrivateKey(pem) };
    return this.#key.key;
  }

  /** Returns an installation token limited to the configured repository and `contents: write`. */
  async token(config: GitHubAppConfig): Promise<string> {
    const cacheKey = `${config.appId}/${config.installationId}/${config.repo}`;
    const cached = this.#cached;
    if (cached && cached.cacheKey === cacheKey && cached.expiresAt - this.now() > REFRESH_MARGIN_MS) {
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
      body: JSON.stringify({ repositories: [repoName], permissions: { contents: "write" } }),
    });
    if (!res.ok) throw new GitHubError(`installation token request failed with ${res.status}`, res.status);
    const body = (await res.json()) as { token: string; expires_at: string };
    this.#cached = { token: body.token, expiresAt: Date.parse(body.expires_at), cacheKey };
    return body.token;
  }

  forgetToken(): void {
    this.#cached = undefined;
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
}
