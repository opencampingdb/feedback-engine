/**
 * A small CBOR (RFC 8949) reader for App Attest objects: integers, byte and
 * text strings, arrays, maps (as `Map`), tags (skipped), booleans and null.
 * Indefinite lengths and floats are refused, as App Attest never uses them.
 */

export type CborValue = number | Uint8Array | string | CborValue[] | Map<CborValue, CborValue> | boolean | null | undefined;

export class CborError extends Error {}

/** Decodes the item at `offset` and returns it with the offset just past it. */
export function decodeCbor(data: Uint8Array, offset = 0, depth = 0): { value: CborValue; end: number } {
  if (depth > 16) throw new CborError("nested too deeply");
  const need = (n: number) => {
    if (offset + n > data.length) throw new CborError("truncated");
  };
  need(1);
  const initial = data[offset++]!;
  const major = initial >> 5;
  const info = initial & 0x1f;
  let length: number;
  if (info < 24) length = info;
  else if (info === 24) {
    need(1);
    length = data[offset]!;
    offset += 1;
  } else if (info === 25) {
    need(2);
    length = (data[offset]! << 8) | data[offset + 1]!;
    offset += 2;
  } else if (info === 26) {
    need(4);
    length = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0);
    offset += 4;
  } else if (info === 27) {
    need(8);
    const big = new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError("integer too large");
    length = Number(big);
    offset += 8;
  } else throw new CborError("indefinite lengths are not supported");

  switch (major) {
    case 0:
      return { value: length, end: offset };
    case 1:
      return { value: -1 - length, end: offset };
    case 2:
      need(length);
      return { value: data.slice(offset, offset + length), end: offset + length };
    case 3:
      need(length);
      return { value: new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset, offset + length)), end: offset + length };
    case 4: {
      const items: CborValue[] = [];
      for (let i = 0; i < length; i++) {
        const item = decodeCbor(data, offset, depth + 1);
        items.push(item.value);
        offset = item.end;
      }
      return { value: items, end: offset };
    }
    case 5: {
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < length; i++) {
        const key = decodeCbor(data, offset, depth + 1);
        const value = decodeCbor(data, key.end, depth + 1);
        map.set(key.value, value.value);
        offset = value.end;
      }
      return { value: map, end: offset };
    }
    case 6:
      return decodeCbor(data, offset, depth + 1);
    default:
      if (info === 20) return { value: false, end: offset };
      if (info === 21) return { value: true, end: offset };
      if (info === 22) return { value: null, end: offset };
      if (info === 23) return { value: undefined, end: offset };
      throw new CborError("unsupported simple value");
  }
}

/** Decodes a whole buffer holding exactly one item. */
export function decodeCborAll(data: Uint8Array): CborValue {
  const { value, end } = decodeCbor(data);
  if (end !== data.length) throw new CborError("trailing bytes");
  return value;
}
