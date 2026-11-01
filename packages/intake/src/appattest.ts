/**
 * Apple App Attest, checked as Apple's "Validating apps that connect to your
 * server" describes: an attestation once per install (registering its key),
 * then an assertion over the body of each submission.
 */

import { APPLE_APP_ATTEST_ROOT_CA } from "./appleroot.js";
import { concat, equal, fromBase64, sha256 } from "./bytes.js";
import { decodeCbor, decodeCborAll, type CborValue } from "./cbor.js";
import { ecdsaDerToRaw, firstOctetString, parseCertificate, type Certificate } from "./der.js";

export type AppAttestEnvironment = "production" | "development";

export interface IosConfig {
  /** Team id, a dot and the bundle id, for example `ABCDE12345.app.camporacle`. */
  app_id: string;
  /** Which App Attest environment's keys to accept. Default `production`. */
  environment?: AppAttestEnvironment;
}

/** A registered key, kept in KV under `aa:<key id>`. */
export interface AttestedKey {
  app: string;
  /** SubjectPublicKeyInfo of the P-256 key, base64. */
  public_key: string;
  /** Counter from the last accepted assertion. */
  counter: number;
}

export class AttestError extends Error {}

const NONCE_EXTENSION = "1.2.840.113635.100.8.2";
const CURVES: Record<string, { name: string; size: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
};
const HASHES: Record<string, string> = { "1.2.840.10045.4.3.2": "SHA-256", "1.2.840.10045.4.3.3": "SHA-384" };
const AAGUID: Record<AppAttestEnvironment, Uint8Array> = {
  production: concat(new TextEncoder().encode("appattest"), new Uint8Array(7)),
  development: new TextEncoder().encode("appattestdevelop"),
};
/**
 * Launch validation categories accepted in each environment: TestFlight (2)
 * and App Store (4) in production, development signing (3) in development.
 */
const CATEGORIES: Record<AppAttestEnvironment, ReadonlySet<number>> = {
  production: new Set([2, 4]),
  development: new Set([3]),
};

function pemToDer(pem: string): Uint8Array {
  const der = fromBase64(pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, ""));
  if (!der) throw new AttestError("bad root certificate");
  return der;
}

function importKey(cert: Certificate): Promise<CryptoKey> {
  const curve = CURVES[cert.curve ?? ""];
  if (!curve) throw new AttestError("unsupported key");
  return crypto.subtle.importKey("spki", cert.spki as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
}

async function signedBy(cert: Certificate, issuer: Certificate, now: number): Promise<boolean> {
  const hash = HASHES[cert.signatureAlgorithm];
  const curve = CURVES[issuer.curve ?? ""];
  if (!hash || !curve || !equal(cert.issuer, issuer.subject)) return false;
  if (now < cert.notBefore || now > cert.notAfter) return false;
  const signature = ecdsaDerToRaw(cert.signature, curve.size);
  return crypto.subtle.verify({ name: "ECDSA", hash }, await importKey(issuer), signature, cert.tbs as Uint8Array<ArrayBuffer>);
}

interface AuthData {
  rpIdHash: Uint8Array;
  counter: number;
  aaguid?: Uint8Array;
  credentialId?: Uint8Array;
  extensions?: Map<CborValue, CborValue>;
}

function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new AttestError("authenticator data too short");
  const flags = data[32]!;
  const out: AuthData = {
    rpIdHash: data.subarray(0, 32),
    counter: new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0),
  };
  let offset = 37;
  if (flags & 0x40) {
    if (data.length < offset + 18) throw new AttestError("authenticator data too short");
    out.aaguid = data.subarray(offset, offset + 16);
    const length = (data[offset + 16]! << 8) | data[offset + 17]!;
    offset += 18;
    if (data.length < offset + length) throw new AttestError("authenticator data too short");
    out.credentialId = data.subarray(offset, offset + length);
    offset = decodeCbor(data, offset + length).end; // the COSE public key
  }
  if (flags & 0x80) {
    const extensions = decodeCbor(data, offset);
    if (!(extensions.value instanceof Map)) throw new AttestError("bad extensions");
    out.extensions = extensions.value;
    offset = extensions.end;
  }
  if (offset !== data.length) throw new AttestError("trailing authenticator data");
  return out;
}

/** The launch validation category, when the device reports one, must suit the environment. */
function checkCategory(auth: AuthData, environment: AppAttestEnvironment): void {
  const category = auth.extensions?.get("apple_validation_category_01");
  if (category === undefined) return;
  if (typeof category !== "number" || !CATEGORIES[environment].has(category)) {
    throw new AttestError(`app validation category ${String(category)} is not accepted`);
  }
}

/**
 * Checks an attestation object for `keyId` (the base64 key identifier) made
 * with `clientDataHash` = SHA-256 of `challenge`. Returns the key to store.
 * Throws AttestError with the reason when any check fails.
 */
export async function verifyAttestation(input: {
  attestation: Uint8Array;
  keyId: string;
  challenge: string;
  config: IosConfig;
  now: number;
  rootPem?: string;
}): Promise<{ publicKey: string }> {
  const environment = input.config.environment ?? "production";
  const keyId = fromBase64(input.keyId);
  if (!keyId || keyId.length !== 32) throw new AttestError("key id must be 32 bytes of base64");
  const object = decodeCborAll(input.attestation);
  if (!(object instanceof Map) || object.get("fmt") !== "apple-appattest") throw new AttestError("not an App Attest object");
  const statement = object.get("attStmt");
  const authBytes = object.get("authData");
  const x5c = statement instanceof Map ? statement.get("x5c") : undefined;
  if (!(authBytes instanceof Uint8Array) || !Array.isArray(x5c) || x5c.length < 2 || !x5c.every((c) => c instanceof Uint8Array)) {
    throw new AttestError("not an App Attest object");
  }

  // 1. The leaf and intermediate chain to Apple's App Attest root.
  const [leaf, intermediate] = (x5c as Uint8Array[]).map(parseCertificate) as [Certificate, Certificate];
  const root = parseCertificate(pemToDer(input.rootPem ?? APPLE_APP_ATTEST_ROOT_CA));
  if (!intermediate.isCa || !(await signedBy(intermediate, root, input.now)) || !(await signedBy(leaf, intermediate, input.now))) {
    throw new AttestError("certificate chain does not lead to the App Attest root");
  }

  // 2 to 4. The nonce in the leaf is SHA-256 of authData and SHA-256 of the challenge.
  const nonce = await sha256(concat(authBytes, await sha256(input.challenge)));
  const extension = leaf.extensions.get(NONCE_EXTENSION);
  const embedded = extension ? firstOctetString(extension) : undefined;
  if (!embedded || !equal(embedded, nonce)) throw new AttestError("nonce does not match the challenge");

  // 5. The key id is SHA-256 of the leaf's public key.
  if (!equal(await sha256(leaf.publicKey), keyId)) throw new AttestError("key id does not match the certificate");

  const auth = parseAuthData(authBytes);
  // 6. The RP ID is this app.
  if (!equal(auth.rpIdHash, await sha256(input.config.app_id))) throw new AttestError("attestation is for another app");
  // 7. A new key has used no assertions.
  if (auth.counter !== 0) throw new AttestError("counter is not 0");
  // 8. The environment.
  if (!auth.aaguid || !equal(auth.aaguid, AAGUID[environment])) throw new AttestError(`key is not from the ${environment} environment`);
  // 9. The credential id is the key id.
  if (!auth.credentialId || !equal(auth.credentialId, keyId)) throw new AttestError("credential id does not match the key id");
  // 10. The launch validation category.
  checkCategory(auth, environment);

  let binary = "";
  for (const b of leaf.spki) binary += String.fromCharCode(b);
  return { publicKey: btoa(binary) };
}

/**
 * Checks an assertion over `clientData` (the exact request body) with a
 * registered key. Returns the new counter to store. The counter must rise
 * with each assertion, which stops an old assertion from being replayed.
 */
export async function verifyAssertion(input: {
  assertion: Uint8Array;
  clientData: Uint8Array;
  key: AttestedKey;
  config: IosConfig;
}): Promise<{ counter: number }> {
  const object = decodeCborAll(input.assertion);
  const signature = object instanceof Map ? object.get("signature") : undefined;
  const authBytes = object instanceof Map ? object.get("authenticatorData") : undefined;
  if (!(signature instanceof Uint8Array) || !(authBytes instanceof Uint8Array)) throw new AttestError("not an App Attest assertion");

  const nonce = await sha256(concat(authBytes, await sha256(input.clientData)));
  const spki = fromBase64(input.key.public_key);
  if (!spki) throw new AttestError("stored key is unreadable");
  const key = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, ecdsaDerToRaw(signature, 32), nonce))) {
    throw new AttestError("signature does not match");
  }
  const auth = parseAuthData(authBytes);
  if (!equal(auth.rpIdHash, await sha256(input.config.app_id))) throw new AttestError("assertion is for another app");
  if (auth.counter <= input.key.counter) throw new AttestError("counter did not increase");
  checkCategory(auth, input.config.environment ?? "production");
  return { counter: auth.counter };
}
