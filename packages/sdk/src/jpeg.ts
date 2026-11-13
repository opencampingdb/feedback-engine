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

/** Metadata a JPEG can carry about where, when and with what it was taken, or who took it. */
export type JpegMetadata = "exif" | "xmp" | "iptc" | "comment" | "multi_picture" | "after_end" | "unreadable";

interface Walk {
  /** Segments that hold metadata, as [start, end) byte ranges, in file order. */
  metadata: { kind: JpegMetadata; start: number; end: number }[];
  /** Where the image ends: just after the end of image marker, or the file length when there is none. */
  end: number;
  /** Where the walk met bytes it could not read as JPEG segments, if it did. */
  unreadable?: number;
}

const startsWith = (bytes: Uint8Array, at: number, text: string) => {
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
};

/** What a segment holds, read from its marker and the identifier at the start of its payload. */
function metadataKind(bytes: Uint8Array, marker: number, payload: number): JpegMetadata | undefined {
  if (marker === 0xe1) return startsWith(bytes, payload, "Exif\0") ? "exif" : "xmp";
  if (marker === 0xed) return "iptc";
  if (marker === 0xfe) return "comment";
  if (marker === 0xe2 && startsWith(bytes, payload, "MPF\0")) return "multi_picture";
  return undefined;
}

/**
 * Walks every segment of a JPEG, through each scan's image data, to the end
 * of image marker, or to the end of the file when the image data runs to it
 * with no end of image marker. Inside image data a 0xFF byte followed by 0x00, by a
 * restart marker or by another 0xFF is part of the data. Any other marker
 * ends the scan.
 */
function walk(bytes: Uint8Array): Walk {
  const metadata: Walk["metadata"] = [];
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff || offset + 1 >= bytes.length) return { metadata, end: bytes.length, unreadable: offset };
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
    if (marker === 0xd9) return { metadata, end: offset + 2 };
    if (offset + 4 > bytes.length) return { metadata, end: bytes.length, unreadable: offset };
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return { metadata, end: bytes.length, unreadable: offset };
    const kind = metadataKind(bytes, marker, offset + 4);
    if (kind) metadata.push({ kind, start: offset, end: offset + 2 + length });
    offset += 2 + length;
    if (marker === 0xda) {
      // Image data runs to the next marker that is not part of it.
      while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const next = bytes[offset + 1]!;
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) offset += 2;
        else if (next === 0xff) offset += 1;
        else break;
      }
      // Image data that runs to the end of the file is a file without its end of image marker, as
      // some encoders write it. Nothing can hide after it, so the walk ends there.
      if (offset + 1 >= bytes.length) return { metadata, end: bytes.length };
    }
  }
  return { metadata, end: bytes.length };
}

/**
 * The metadata a JPEG still carries, in file order and named once each: Exif
 * and XMP (APP1), IPTC (APP13), comments (COM), a multi-picture index
 * (APP2 `MPF`), bytes other than zero after the end of image marker (often a
 * second picture with its own Exif), and `unreadable` when the bytes stop
 * being JPEG segments the walk can read. Empty for a clean file, and for any
 * file `stripJpegMetadata` gives back from a camera or picker's JPEG. A file
 * still `unreadable` after `stripJpegMetadata` is damaged: decode and encode
 * it again before sending it.
 */
export function jpegMetadata(bytes: Uint8Array): JpegMetadata[] {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return ["unreadable"];
  const found = walk(bytes);
  const kinds: JpegMetadata[] = found.metadata.map((m) => m.kind);
  if (found.unreadable !== undefined) kinds.push("unreadable");
  else if (bytes.subarray(found.end).some((b) => b !== 0)) kinds.push("after_end");
  return [...new Set(kinds)];
}

/**
 * The JPEG without its metadata: Exif and XMP (APP1, camera, time and often
 * GPS position), IPTC (APP13, author and captions), comments (COM), the
 * multi-picture index (APP2 `MPF`) and everything after the end of image
 * marker. The colour profile and the image data are kept as they are. When
 * the walk meets bytes it cannot read as JPEG segments, the metadata before
 * that point is still removed and the rest is kept. Gives back the same bytes
 * when there is nothing to remove.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const { metadata, end } = walk(bytes);
  if (metadata.length === 0 && end === bytes.length) return bytes;
  const removed = metadata.reduce((sum, { start, end: to }) => sum + (to - start), 0);
  const out = new Uint8Array(end - removed);
  let at = 0;
  let from = 0;
  for (const { start, end: to } of metadata) {
    out.set(bytes.subarray(from, start), at);
    at += start - from;
    from = to;
  }
  out.set(bytes.subarray(from, end), at);
  return out;
}
