/**
 * Image validation by content (magic bytes), not by the client-supplied filename or MIME type,
 * plus metadata stripping so photos never leak GPS coordinates or device details.
 */
export type ImageType = "image/jpeg" | "image/png" | "image/webp";

export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

export const extensionFor = (type: ImageType) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" })[type];

/** Removes APP1 (EXIF/XMP) and APP13 (IPTC) segments from a JPEG. */
function stripJpeg(buf: Buffer): Buffer {
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw new Error("Corrupt JPEG");
    const marker = buf[i + 1];
    // Start of scan: the rest is image data.
    if (marker === 0xda) {
      parts.push(buf.subarray(i));
      return Buffer.concat(parts);
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw new Error("Corrupt JPEG");
    const segment = buf.subarray(i, i + 2 + len);
    if (marker !== 0xe1 && marker !== 0xed) parts.push(segment);
    i += 2 + len;
  }
  throw new Error("Corrupt JPEG");
}

/** Removes eXIf, tEXt, zTXt and iTXt chunks from a PNG. */
function stripPng(buf: Buffer): Buffer {
  const drop = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString("ascii", i + 4, i + 8);
    const end = i + 12 + len;
    if (end > buf.length) throw new Error("Corrupt PNG");
    if (!drop.has(type)) parts.push(buf.subarray(i, end));
    i = end;
    if (type === "IEND") return Buffer.concat(parts);
  }
  throw new Error("Corrupt PNG");
}

/** Removes EXIF and XMP chunks from a WebP and clears the matching VP8X flags. */
function stripWebp(buf: Buffer): Buffer {
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= buf.length) {
    const type = buf.toString("ascii", i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > buf.length) throw new Error("Corrupt WebP");
    const chunk = Buffer.from(buf.subarray(i, Math.min(end, buf.length)));
    if (type === "VP8X") {
      chunk[8] &= ~0x0c; // clear EXIF (0x08) and XMP (0x04) flags
    }
    if (type !== "EXIF" && type !== "XMP ") chunks.push(chunk);
    i = end;
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}

export function stripMetadata(buf: Buffer, type: ImageType): Buffer {
  if (type === "image/jpeg") return stripJpeg(buf);
  if (type === "image/png") return stripPng(buf);
  return stripWebp(buf);
}
