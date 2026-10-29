import fs from "node:fs/promises";

/**
 * Minimal, dependency-free video inspection for profile clips.
 *
 * - Identifies MP4 and WebM from their file signatures (never the extension or the client's MIME type).
 * - Reads the duration from the container (MP4 `mvhd`, WebM `Segment/Info/Duration`), so length limits are
 *   enforced on the server without decoding any video.
 * - Blanks MP4 metadata boxes (`udta`, `meta`), where phones store capture location and device details.
 *   Boxes are overwritten in place as `free` of the same size, so media offsets stay valid.
 *
 * It does not transcode, re-encode or generate thumbnails; a poster frame is captured by the browser
 * before upload. Server-side transcoding would need ffmpeg in the API image (see docs/ARCHITECTURE.md).
 */

export type VideoType = "video/mp4" | "video/webm";

export interface VideoInfo {
  type: VideoType;
  durationMs: number | null; // null when the container doesn't record a duration
}

// Brands browsers play as MP4. QuickTime ("qt  ") is rejected: not reliably playable outside Safari.
const MP4_BRANDS = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VP", "dash", "mp71", "MSNV"]);

export function sniffVideo(head: Buffer): VideoType | null {
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp" && MP4_BRANDS.has(head.toString("latin1", 8, 12))) return "video/mp4";
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3 && head.includes(Buffer.from("webm", "latin1"))) return "video/webm";
  return null;
}

export const extensionForVideo = (t: VideoType) => (t === "video/mp4" ? "mp4" : "webm");

/** Identifies, measures and (for MP4) scrubs metadata in place. Throws if the file is not a supported video. */
export async function inspectAndScrub(file: string): Promise<VideoInfo> {
  const fh = await fs.open(file, "r+");
  try {
    const head = Buffer.alloc(64);
    await fh.read(head, 0, 64, 0);
    const type = sniffVideo(head);
    if (!type) throw new Error("UNSUPPORTED");
    const size = (await fh.stat()).size;
    return { type, durationMs: type === "video/mp4" ? await mp4(fh, size) : await webm(fh, size) };
  } finally {
    await fh.close();
  }
}

// ---------- MP4 / ISO BMFF ----------

type Box = { type: string; start: number; header: number; size: number };

async function readBox(fh: fs.FileHandle, at: number, end: number): Promise<Box | null> {
  if (at + 8 > end) return null;
  const h = Buffer.alloc(16);
  await fh.read(h, 0, 16, at);
  let size = h.readUInt32BE(0);
  const type = h.toString("latin1", 4, 8);
  let header = 8;
  if (size === 1) {
    size = Number(h.readBigUInt64BE(8));
    header = 16;
  } else if (size === 0) size = end - at;
  if (size < header || at + size > end) return null;
  return { type, start: at, header, size };
}

async function children(fh: fs.FileHandle, parent: { start: number; header: number; size: number }) {
  const out: Box[] = [];
  const end = parent.start + parent.size;
  for (let at = parent.start + parent.header; at < end; ) {
    const b = await readBox(fh, at, end);
    if (!b) break;
    out.push(b);
    at += b.size;
  }
  return out;
}

async function blank(fh: fs.FileHandle, b: Box) {
  // Same size, type "free", zeroed payload: players skip it and no byte offsets move.
  const payload = b.size - b.header;
  await fh.write(Buffer.from("free", "latin1"), 0, 4, b.start + 4);
  for (let off = 0; off < payload; off += 65536) {
    const n = Math.min(65536, payload - off);
    await fh.write(Buffer.alloc(n), 0, n, b.start + b.header + off);
  }
}

async function mp4(fh: fs.FileHandle, size: number): Promise<number | null> {
  const top = await children(fh, { start: 0, header: 0, size });
  const moov = top.find((b) => b.type === "moov");
  if (!moov) return null;
  let durationMs: number | null = null;
  for (const b of await children(fh, moov)) {
    if (b.type === "mvhd") {
      const h = Buffer.alloc(32);
      await fh.read(h, 0, 32, b.start + b.header);
      const version = h[0];
      const timescale = version === 1 ? h.readUInt32BE(20) : h.readUInt32BE(12);
      const duration = version === 1 ? Number(h.readBigUInt64BE(24)) : h.readUInt32BE(16);
      if (timescale > 0) durationMs = Math.round((duration / timescale) * 1000);
    } else if (b.type === "udta" || b.type === "meta") {
      await blank(fh, b);
    } else if (b.type === "trak") {
      for (const t of await children(fh, b)) if (t.type === "udta" || t.type === "meta") await blank(fh, t);
    }
  }
  return durationMs;
}

// ---------- WebM / Matroska (EBML) ----------

const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const CLUSTER = 0x1f43b675;

function vint(buf: Buffer, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = buf[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23; // 1..8
  if (at + length > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + buf[at + i];
    if (buf[at + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

async function webm(fh: fs.FileHandle, size: number): Promise<number | null> {
  // Segment Info sits near the start; 1 MB is far more than any real header needs.
  const buf = Buffer.alloc(Math.min(size, 1024 * 1024));
  await fh.read(buf, 0, buf.length, 0);
  const element = (at: number) => {
    const id = vint(buf, at, true);
    if (!id) return null;
    const len = vint(buf, at + id.length, false);
    if (!len) return null;
    return { id: id.value, dataStart: at + id.length + len.length, size: len.unknown ? Infinity : len.value };
  };
  // EBML header, then Segment.
  const ebml = element(0);
  if (!ebml || !Number.isFinite(ebml.size)) return null;
  const segment = element(ebml.dataStart + ebml.size);
  if (!segment || segment.id !== SEGMENT) return null;
  for (let at = segment.dataStart; at < buf.length; ) {
    const el = element(at);
    if (!el || el.id === CLUSTER) return null;
    if (el.id === INFO) {
      let scale = 1_000_000; // nanoseconds per tick (Matroska default)
      let duration: number | null = null;
      const end = Math.min(buf.length, el.dataStart + el.size);
      for (let p = el.dataStart; p < end; ) {
        const c = element(p);
        if (!c || !Number.isFinite(c.size)) break;
        if (c.id === TIMECODE_SCALE) scale = buf.readUIntBE(c.dataStart, Math.min(6, c.size));
        if (c.id === DURATION) duration = c.size === 4 ? buf.readFloatBE(c.dataStart) : buf.readDoubleBE(c.dataStart);
        p = c.dataStart + c.size;
      }
      return duration === null ? null : Math.round((duration * scale) / 1_000_000);
    }
    if (!Number.isFinite(el.size)) return null;
    at = el.dataStart + el.size;
  }
  return null;
}
