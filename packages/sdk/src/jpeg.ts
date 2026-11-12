/**
 * Reads a JPEG's pixel size from its first frame header (SOF). Undefined when
 * the bytes are not a JPEG or no frame header comes before the image data.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Markers without a length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // End of image or start of scan before any frame header.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2) return undefined;
    // SOF0 to SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return undefined;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}

/**
 * The JPEG without its APP1 segments, which hold Exif (camera, time and
 * often GPS position) and XMP metadata. Every segment before the start of
 * scan is walked, and the image data after it is kept as it is. Gives back
 * the same bytes when there is nothing to remove, or when the bytes are not
 * JPEG segments the walk can read.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const cut: [number, number][] = [];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return bytes;
    const marker = bytes[offset + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Markers without a length: TEM and the restart markers.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    // Start of scan or end of image: the rest is image data.
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return bytes;
    if (marker === 0xe1) cut.push([offset, offset + 2 + length]);
    offset += 2 + length;
  }
  if (cut.length === 0) return bytes;
  const removed = cut.reduce((sum, [from, to]) => sum + (to - from), 0);
  const out = new Uint8Array(bytes.length - removed);
  let at = 0;
  let from = 0;
  for (const [start, end] of cut) {
    out.set(bytes.subarray(from, start), at);
    at += start - from;
    from = end;
  }
  out.set(bytes.subarray(from), at);
  return out;
}
