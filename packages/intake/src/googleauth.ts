/**
 * An OAuth access token for a Google service account, by the JWT bearer
 * grant, kept until a minute before it ends. One per scope.
 */

import { toBase64Url } from "./bytes.js";
import type { Fetch } from "./github.js";
import { importPrivateKey } from "./github.js";

/** The parts of a Google service account key file the intake uses. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const TOKEN_URI = "https://oauth2.googleapis.com/token";

const encode = (text: string) => toBase64Url(new TextEncoder().encode(text));

export class GoogleToken {
  #token: { value: string; expiresAt: number; email: string } | undefined;

  constructor(
    private readonly fetch: Fetch,
    private readonly now: () => number,
    private readonly scope: string,
  ) {}

  /** A token for `account`. Throws when Google refuses the sign-in. */
  async get(account: ServiceAccount): Promise<string> {
    const nowMs = this.now();
    if (this.#token && this.#token.email === account.client_email && this.#token.expiresAt - 60_000 > nowMs) return this.#token.value;
    const iat = Math.floor(nowMs / 1000);
    const audience = account.token_uri ?? TOKEN_URI;
    const input = `${encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${encode(
      JSON.stringify({ iss: account.client_email, scope: this.scope, aud: audience, iat, exp: iat + 3600 }),
    )}`;
    const key = await importPrivateKey(account.private_key);
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
    const res = await this.fetch(audience, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${input}.${toBase64Url(signature)}`,
    });
    if (!res.ok) throw new Error(`Google sign-in failed with ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("Google sign-in gave no token");
    this.#token = { value: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000, email: account.client_email };
    return body.access_token;
  }
}
