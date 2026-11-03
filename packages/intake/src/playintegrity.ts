/**
 * Google Play Integrity, standard requests. The app's token carries the
 * body's SHA-256 as its requestHash. The intake decodes the token with
 * Google's decodeIntegrityToken call, as a service account with the
 * playintegrity scope, and checks the verdicts.
 */

import type { Fetch } from "./github.js";
import { GoogleToken, type ServiceAccount } from "./googleauth.js";
import type { RefusalReason } from "./refusal.js";

export interface AndroidConfig {
  /** Package name, for example `com.example.app`. */
  package: string;
  /**
   * SHA-256 digests of the app signing certificates to accept, as Play
   * reports them. Any certificate when left out.
   */
  certificate_sha256?: string[];
}

export type { ServiceAccount } from "./googleauth.js";

/** A token Play Integrity refused, with the reason code the intake answers with. */
export class IntegrityError extends Error {
  constructor(
    readonly reason: Extract<RefusalReason, "integrity_not_met" | "malformed">,
    message: string,
  ) {
    super(message);
  }
}

/** Google could not be asked about the token. Not a refusal: the app tries again later. */
export class IntegrityUnavailable extends Error {}

const SCOPE = "https://www.googleapis.com/auth/playintegrity";
/** A token older than this is refused. */
export const MAX_TOKEN_AGE_MS = 5 * 60 * 1000;

export class PlayIntegrity {
  readonly #token: GoogleToken;

  constructor(
    private readonly fetch: Fetch,
    private readonly now: () => number,
  ) {
    this.#token = new GoogleToken(fetch, now, SCOPE);
  }

  async #accessToken(account: ServiceAccount): Promise<string> {
    try {
      return await this.#token.get(account);
    } catch (error) {
      throw new IntegrityUnavailable(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Decodes `token` and checks it: the request came from this package with
   * `requestHash` (the body's SHA-256, lower case hex) within the last five
   * minutes, Play recognises the app, and the device meets device integrity.
   * Throws IntegrityError with the reason code otherwise, and
   * IntegrityUnavailable when Google cannot be reached or fails.
   */
  async verify(input: { token: string; requestHash: string; config: AndroidConfig; account: ServiceAccount }): Promise<void> {
    const { config } = input;
    const res = await this.fetch(`https://playintegrity.googleapis.com/v1/${encodeURIComponent(config.package)}:decodeIntegrityToken`, {
      method: "POST",
      headers: { authorization: `Bearer ${await this.#accessToken(input.account)}`, "content-type": "application/json" },
      body: JSON.stringify({ integrity_token: input.token }),
    });
    if (res.status === 400) throw new IntegrityError("malformed", "Google could not decode the token");
    if (!res.ok) throw new IntegrityUnavailable(`Google answered ${res.status}`);
    let answer: unknown;
    try {
      answer = await res.json();
    } catch {
      throw new IntegrityUnavailable("Google answered with no JSON");
    }
    const payload = (answer as { tokenPayloadExternal?: Record<string, Record<string, unknown>> } | null)?.tokenPayloadExternal;
    const request = payload?.requestDetails;
    const app = payload?.appIntegrity;
    const device = payload?.deviceIntegrity;
    if (!request || request.requestPackageName !== config.package) throw new IntegrityError("integrity_not_met", "token is for another package");
    if (request.requestHash !== input.requestHash) throw new IntegrityError("integrity_not_met", "token is for another request");
    const age = this.now() - Number(request.timestampMillis);
    if (!Number.isFinite(age) || age > MAX_TOKEN_AGE_MS || age < -MAX_TOKEN_AGE_MS) throw new IntegrityError("integrity_not_met", "token is too old");
    if (app?.appRecognitionVerdict !== "PLAY_RECOGNIZED" || app.packageName !== config.package) {
      throw new IntegrityError("integrity_not_met", "Play does not recognise the app");
    }
    const digests = Array.isArray(app.certificateSha256Digest) ? app.certificateSha256Digest : [];
    if (config.certificate_sha256 && !digests.some((d) => config.certificate_sha256!.includes(String(d)))) {
      throw new IntegrityError("integrity_not_met", "app is signed with another certificate");
    }
    const verdicts = Array.isArray(device?.deviceRecognitionVerdict) ? device.deviceRecognitionVerdict : [];
    if (!verdicts.includes("MEETS_DEVICE_INTEGRITY")) throw new IntegrityError("integrity_not_met", "device does not meet device integrity");
  }
}
