/**
 * Builds App Attest objects for tests: a stand-in root, intermediate and leaf
 * certificate chain made the way Apple's is, an attestation object and
 * assertions. The real chain needs a device, so the tests inject this root.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";

const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());

function len(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

const tlv = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const body = Buffer.concat(parts);
  return new Uint8Array([tag, ...len(body.length), ...body]);
};
const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts);

function oid(text: string): Uint8Array {
  const [a, b, ...rest] = text.split(".").map(Number) as [number, number, ...number[]];
  const out = [a * 40 + b];
  for (const n of rest) {
    const bytes = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) bytes.unshift((v & 0x7f) | 0x80);
    out.push(...bytes);
  }
  return tlv(0x06, new Uint8Array(out));
}

const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
const utc = (ms: number) => tlv(0x17, Buffer.from(new Date(ms).toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z"));
const ecdsa = { sha256: "1.2.840.10045.4.3.2", sha384: "1.2.840.10045.4.3.3" } as const;

interface Issued {
  der: Uint8Array;
  key: KeyObject;
  publicKey: KeyObject;
}

function certificate(input: {
  subject: string;
  issuer: string;
  issuerKey?: KeyObject;
  curve: "prime256v1" | "secp384r1";
  hash: "sha256" | "sha384";
  ca: boolean;
  extensions?: [string, Uint8Array][];
  notBefore: number;
  notAfter: number;
}): Issued {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: input.curve });
  const extensions = [
    ...(input.ca ? [seq(oid("2.5.29.19"), tlv(0x01, new Uint8Array([0xff])), tlv(0x04, seq(tlv(0x01, new Uint8Array([0xff])))))] : []),
    ...(input.extensions ?? []).map(([id, value]) => seq(oid(id), tlv(0x04, value))),
  ];
  const tbs = seq(
    tlv(0xa0, tlv(0x02, new Uint8Array([2]))),
    tlv(0x02, new Uint8Array([1])),
    seq(oid(ecdsa[input.hash])),
    name(input.issuer),
    seq(utc(input.notBefore), utc(input.notAfter)),
    name(input.subject),
    new Uint8Array(publicKey.export({ type: "spki", format: "der" })),
    tlv(0xa3, seq(...extensions)),
  );
  const signature = sign(input.hash, tbs, input.issuerKey ?? privateKey);
  const der = seq(tbs, seq(oid(ecdsa[input.hash])), tlv(0x03, new Uint8Array([0]), signature));
  return { der, key: privateKey, publicKey };
}

export function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 0x100) return [(major << 5) | 24, n];
    if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
    return [(major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  };
  if (typeof value === "number") return new Uint8Array(value >= 0 ? head(0, value) : head(1, -1 - value));
  if (value instanceof Uint8Array) return new Uint8Array([...head(2, value.length), ...value]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return new Uint8Array([...head(3, bytes.length), ...bytes]);
  }
  if (Array.isArray(value)) return new Uint8Array([...head(4, value.length), ...value.flatMap((v) => [...cbor(v)])]);
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
  return new Uint8Array([...head(5, entries.length), ...entries.flatMap(([k, v]) => [...cbor(k), ...cbor(v)])]);
}

export const APP_ID = "ABCDE12345.com.example.app";

export interface Device {
  rootPem: string;
  keyId: string;
  attest(challenge: string, options?: { appId?: string; counter?: number; aaguid?: string; category?: number | Uint8Array; keyIdOverride?: string }): Uint8Array;
  assert(body: string, counter: number, options?: { appId?: string; category?: number | Uint8Array }): Uint8Array;
}

const flags = (attested: boolean, extensions: boolean) => (attested ? 0x40 : 0) | (extensions ? 0x80 : 0);
const counterBytes = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);

/** A stand-in Apple chain and one device key on it. */
export function makeDevice(now: number): Device {
  const day = 24 * 60 * 60 * 1000;
  const root = certificate({ subject: "Test Root", issuer: "Test Root", curve: "secp384r1", hash: "sha384", ca: true, notBefore: now - day, notAfter: now + 365 * day });
  const intermediate = certificate({
    subject: "Test Intermediate",
    issuer: "Test Root",
    issuerKey: root.key,
    curve: "secp384r1",
    hash: "sha384",
    ca: true,
    notBefore: now - day,
    notAfter: now + 365 * day,
  });
  const { privateKey: leafKey, publicKey: leafPublic } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const point = new Uint8Array(leafPublic.export({ type: "spki", format: "der" })).slice(-65);
  const keyIdBytes = sha256(point);
  const keyId = Buffer.from(keyIdBytes).toString("base64");
  const rootPem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(root.der).toString("base64")}\n-----END CERTIFICATE-----`;

  const extensionsFor = (category?: number | Uint8Array) => (category === undefined ? new Uint8Array() : cbor({ apple_validation_category_01: category }));

  return {
    rootPem,
    keyId,
    attest(challenge, options = {}) {
      const credential = options.keyIdOverride ? new Uint8Array(Buffer.from(options.keyIdOverride, "base64")) : keyIdBytes;
      const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, point.slice(1, 33)], [-3, point.slice(33)]]));
      const aaguid = Buffer.alloc(16);
      Buffer.from(options.aaguid ?? "appattest").copy(aaguid);
      const ext = extensionsFor(options.category);
      const authData = Buffer.concat([
        sha256(options.appId ?? APP_ID),
        new Uint8Array([flags(true, ext.length > 0)]),
        counterBytes(options.counter ?? 0),
        aaguid,
        new Uint8Array([0, credential.length]),
        credential,
        cose,
        ext,
      ]);
      const nonce = sha256(Buffer.concat([authData, sha256(challenge)]));
      // Leaf certificate for the device key, signed by the intermediate.
      const leafTbs = (() => {
        const issued = certificate({
          subject: "Device",
          issuer: "Test Intermediate",
          issuerKey: intermediate.key,
          curve: "prime256v1",
          hash: "sha256",
          ca: false,
          extensions: [["1.2.840.113635.100.8.2", seq(tlv(0xa1, tlv(0x04, nonce)))]],
          notBefore: now - day,
          notAfter: now + 30 * day,
        });
        return issued.der;
      })();
      // Swap the generated leaf key for the device key: rebuild with the device key's SPKI.
      const leaf = rebuildWithKey(leafTbs, leafPublic, intermediate.key);
      return cbor({ fmt: "apple-appattest", attStmt: { x5c: [leaf, intermediate.der], receipt: new Uint8Array([1]) }, authData: new Uint8Array(authData) });
    },
    assert(body, counter, options = {}) {
      const ext = extensionsFor(options.category);
      const authenticatorData = Buffer.concat([
        sha256(options.appId ?? APP_ID),
        new Uint8Array([flags(false, ext.length > 0)]),
        counterBytes(counter),
        ext,
      ]);
      const nonce = sha256(Buffer.concat([authenticatorData, sha256(body)]));
      const signature = sign("sha256", nonce, leafKey);
      return cbor({ signature: new Uint8Array(signature), authenticatorData: new Uint8Array(authenticatorData) });
    },
  };
}

/** Replaces the SubjectPublicKeyInfo in a certificate and signs it again. */
function rebuildWithKey(der: Uint8Array, publicKey: KeyObject, issuerKey: KeyObject): Uint8Array {
  const read = (data: Uint8Array, offset: number) => {
    let length = data[offset + 1]!;
    let header = 2;
    if (length & 0x80) {
      const count = length & 0x7f;
      length = 0;
      for (let i = 0; i < count; i++) length = length * 256 + data[offset + 2 + i]!;
      header += count;
    }
    return { start: offset, header, end: offset + header + length };
  };
  const outer = read(der, 0);
  const tbsNode = read(der, outer.header);
  const parts: Uint8Array[] = [];
  for (let offset = tbsNode.start + tbsNode.header; offset < tbsNode.end; ) {
    const node = read(der, offset);
    parts.push(der.slice(node.start, node.end));
    offset = node.end;
  }
  parts[6] = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const tbs = seq(...parts);
  const signature = sign("sha256", tbs, issuerKey);
  return seq(tbs, seq(oid(ecdsa.sha256)), tlv(0x03, new Uint8Array([0]), signature));
}
