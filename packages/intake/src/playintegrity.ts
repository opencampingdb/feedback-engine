/**
 * Google Play Integrity, standard requests. The app's token carries the
 * body's SHA-256 as its requestHash. The intake decodes the token with
 * Google's decodeIntegrityToken call, as a service account with the
 * playintegrity scope, and checks the verdicts.
 */

import { toBase64Url } from "./bytes.js";
import type { Fetch } from "./github.js";
import { importPrivateKey } from "./github.js";

export interface AndroidConfig {
  /** Package name, for example `app.camporacle`. */
  package: string;
  /**
   * SHA-256 digests of the app signing certificates to accept, as Play
   * reports them. Any certificate when left out.
   */
  certificate_sha256?: string[];
}

/** The parts of a Google service account key file the intake uses. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export class IntegrityError extends Error {}

const SCOPE = "https://www.googleapis.com/auth/playintegrity";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
/** A token older than this is refused. */
export const MAX_TOKEN_AGE_MS = 5 * 60 * 1000;

const encode = (text: string) => toBase64Url(new TextEncoder().encode(text));

export class PlayIntegrity {
  #token: { value: string; expiresAt: number; email: string } | undefined;

  constructor(
    private readonly fetch: Fetch,
    private readonly now: () => number,
  ) {}

  async #accessToken(account: ServiceAccount): Promise<string> {
    const nowMs = this.now();
    if (this.#token && this.#token.email === account.client_email && this.#token.expiresAt - 60_000 > nowMs) return this.#token.value;
    const iat = Math.floor(nowMs / 1000);
    const audience = account.token_uri ?? TOKEN_URI;
    const input = `${encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${encode(
      JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: audience, iat, exp: iat + 3600 }),
    )}`;
    const key = await importPrivateKey(account.private_key);
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input)));
    const res = await this.fetch(audience, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${input}.${toBase64Url(signature)}`,
    });
    if (!res.ok) throw new IntegrityError(`Google sign-in failed with ${res.status}`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new IntegrityError("Google sign-in gave no token");
    this.#token = { value: body.access_token, expiresAt: nowMs + (body.expires_in ?? 3600) * 1000, email: account.client_email };
    return body.access_token;
  }

  /**
   * Decodes `token` and checks it: the request came from this package with
   * `requestHash` (the body's SHA-256, lower case hex) within the last five
   * minutes, Play recognises the app, and the device meets device integrity.
   * Throws IntegrityError with the reason otherwise.
   */
  async verify(input: { token: string; requestHash: string; config: AndroidConfig; account: ServiceAccount }): Promise<void> {
    const { config } = input;
    const res = await this.fetch(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(config.package)}:decodeIntegrityToken`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.#accessToken(input.account)}`, "content-type": "application/json" },
      body: JSON.stringify({ integrity_token: input.token }),
    });
    if (res.status === 400) throw new IntegrityError("Google could not decode the token");
    if (!res.ok) throw new IntegrityError(`Google answered ${res.status}`);
    const payload = ((await res.json()) as { tokenPayloadExternal?: Record<string, Record<string, unknown>> }).tokenPayloadExternal;
    const request = payload?.requestDetails;
    const app = payload?.appIntegrity;
    const device = payload?.deviceIntegrity;
    if (!request || request.requestPackageName !== config.package) throw new IntegrityError("token is for another package");
    if (request.requestHash !== input.requestHash) throw new IntegrityError("token is for another request");
    const age = this.now() - Number(request.timestampMillis);
    if (!Number.isFinite(age) || age > MAX_TOKEN_AGE_MS || age < -MAX_TOKEN_AGE_MS) throw new IntegrityError("token is too old");
    if (app?.appRecognitionVerdict !== "PLAY_RECOGNIZED" || app.packageName !== config.package) {
      throw new IntegrityError("Play does not recognise the app");
    }
    const digests = Array.isArray(app.certificateSha256Digest) ? app.certificateSha256Digest : [];
    if (config.certificate_sha256 && !digests.some((d) => config.certificate_sha256!.includes(String(d)))) {
      throw new IntegrityError("app is signed with another certificate");
    }
    const verdicts = Array.isArray(device?.deviceRecognitionVerdict) ? device.deviceRecognitionVerdict : [];
    if (!verdicts.includes("MEETS_DEVICE_INTEGRITY")) throw new IntegrityError("device does not meet device integrity");
  }
}
