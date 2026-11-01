/**
 * Just enough ASN.1 DER and X.509 reading to check an App Attest certificate
 * chain with WebCrypto: the signed part, the signature, the subject and
 * issuer, the validity, the public key and the extensions.
 */

export class DerError extends Error {}

export interface DerNode {
  tag: number;
  /** The whole element, header included. */
  raw: Uint8Array;
  contents: Uint8Array;
}

export function readDer(data: Uint8Array, offset = 0): DerNode & { end: number } {
  if (offset + 2 > data.length) throw new DerError("truncated");
  const tag = data[offset]!;
  let length = data[offset + 1]!;
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || offset + 2 + count > data.length) throw new DerError("bad length");
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + data[offset + 2 + i]!;
    header += count;
  }
  const end = offset + header + length;
  if (end > data.length) throw new DerError("truncated");
  return { tag, raw: data.subarray(offset, end), contents: data.subarray(offset + header, end), end };
}

export function children(node: DerNode): DerNode[] {
  const out: DerNode[] = [];
  for (let offset = 0; offset < node.contents.length; ) {
    const child = readDer(node.contents, offset);
    out.push(child);
    offset = child.end;
  }
  return out;
}

export function oid(node: DerNode): string {
  if (node.tag !== 0x06 || node.contents.length === 0) throw new DerError("not an OID");
  const bytes = node.contents;
  const parts = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = value * 128 + (bytes[i]! & 0x7f);
    if (!(bytes[i]! & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join(".");
}

function time(node: DerNode): number {
  const text = new TextDecoder().decode(node.contents);
  const m = node.tag === 0x17 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text) : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text);
  if (!m) throw new DerError("bad time");
  let year = Number(m[1]);
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export interface Certificate {
  tbs: Uint8Array;
  signatureAlgorithm: string;
  signature: Uint8Array;
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  /** SubjectPublicKeyInfo, as WebCrypto imports it. */
  spki: Uint8Array;
  /** Named curve of an EC key. */
  curve: string | undefined;
  /** The public key bits: for an EC key, the uncompressed point. */
  publicKey: Uint8Array;
  extensions: Map<string, Uint8Array>;
  isCa: boolean;
}

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = readDer(der);
  if (cert.end !== der.length || cert.tag !== 0x30) throw new DerError("not a certificate");
  const [tbs, algorithm, signature] = children(cert);
  if (!tbs || !algorithm || !signature || signature.tag !== 0x03) throw new DerError("not a certificate");
  const fields = children(tbs);
  let i = fields[0]?.tag === 0xa0 ? 1 : 0; // version
  i += 1; // serial number
  i += 1; // signature algorithm, repeated
  const issuer = fields[i++];
  const validity = fields[i++];
  const subject = fields[i++];
  const spki = fields[i++];
  if (!issuer || !validity || !subject || !spki) throw new DerError("not a certificate");
  const [notBefore, notAfter] = children(validity);
  const [keyAlgorithm, keyBits] = children(spki);
  if (!notBefore || !notAfter || !keyAlgorithm || !keyBits || keyBits.tag !== 0x03) throw new DerError("not a certificate");
  const algorithmParts = children(keyAlgorithm);
  const curve = algorithmParts[1]?.tag === 0x06 ? oid(algorithmParts[1]) : undefined;

  const extensions = new Map<string, Uint8Array>();
  let isCa = false;
  for (const field of fields.slice(i)) {
    if (field.tag !== 0xa3) continue;
    const [list] = children(field);
    for (const extension of list ? children(list) : []) {
      const parts = children(extension);
      const id = oid(parts[0]!);
      const value = parts[parts.length - 1]!;
      if (value.tag !== 0x04) throw new DerError("bad extension");
      extensions.set(id, value.contents);
      if (id === "2.5.29.19") {
        const constraints = children(readDer(value.contents));
        isCa = constraints[0]?.tag === 0x01 && constraints[0].contents[0] === 0xff;
      }
    }
  }

  return {
    tbs: tbs.raw,
    signatureAlgorithm: oid(children(algorithm)[0]!),
    signature: signature.contents.subarray(1),
    issuer: issuer.raw,
    subject: subject.raw,
    notBefore: time(notBefore),
    notAfter: time(notAfter),
    spki: spki.raw,
    curve,
    publicKey: keyBits.contents.subarray(1),
    extensions,
    isCa,
  };
}

/** An ECDSA signature in DER (SEQUENCE of r and s) as the fixed-size r||s WebCrypto checks. */
export function ecdsaDerToRaw(der: Uint8Array, size: number): Uint8Array<ArrayBuffer> {
  const sequence = readDer(der);
  const [r, s] = children(sequence);
  if (sequence.tag !== 0x30 || r?.tag !== 0x02 || s?.tag !== 0x02) throw new DerError("bad signature");
  const out = new Uint8Array(size * 2);
  for (const [n, part] of [r, s].entries()) {
    let bytes = part.contents;
    while (bytes.length > size && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes.length > size) throw new DerError("bad signature");
    out.set(bytes, n * size + size - bytes.length);
  }
  return out;
}

/** The first OCTET STRING found anywhere inside `data`. */
export function firstOctetString(data: Uint8Array): Uint8Array | undefined {
  const node = readDer(data);
  if (node.tag === 0x04) return node.contents;
  if (!(node.tag & 0x20)) return undefined;
  for (const child of children(node)) {
    const found = firstOctetString(child.raw);
    if (found) return found;
  }
  return undefined;
}
