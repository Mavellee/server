import { Router, type Request } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { Prisma, type ProfilePhoto } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { badRequest, notFound, ok, parse } from "../../lib/http.js";
import { randomToken } from "../../lib/crypto.js";
import { detectImageType, extensionFor, stripMetadata } from "../../lib/images.js";
import { extensionForVideo, inspectAndScrub } from "../../lib/video.js";
import { isBlockedBetween } from "../../lib/safety.js";
import { requireAuth } from "../../middleware/auth.js";

/**
 * Profile media: photos and short videos in one ordered gallery.
 * Files are stored under UPLOAD_DIR with random names; only keys and metadata are in PostgreSQL.
 */
const limits = config.media;
const incoming = () => path.join(config.uploadDir, ".incoming");
const fileOf = (key: string) => path.join(config.uploadDir, key);

// Uploads stream to disk (videos can be 50 MB), then are validated by content before being kept.
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => void fs.mkdir(incoming(), { recursive: true }).then(() => cb(null, incoming()), (e) => cb(e, "")),
    filename: (_req, _file, cb) => cb(null, randomToken(18)),
  }),
  limits: { fileSize: Math.max(limits.videoMaxBytes, config.maxUploadBytes), files: 2, fields: 4 },
});

type Files = Record<string, Express.Multer.File[] | undefined>;
const filesOf = (req: Request) => (req.files ?? {}) as Files;
const cleanupIncoming = (req: Request) => Promise.all(Object.values(filesOf(req)).flat().map((f) => f && fs.rm(f.path, { force: true })));
const removeFiles = (keys: (string | null | undefined)[]) => Promise.all(keys.filter((k): k is string => !!k).map((k) => fs.rm(fileOf(k), { force: true })));

// eslint-disable-next-line no-control-regex
const cleanCaption = (t: string) => t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim();

/** Validates an uploaded image by content, strips metadata and stores it. Returns the stored file. */
async function storeImage(file: Express.Multer.File, what = "Photos") {
  if (file.size > config.maxUploadBytes) throw badRequest(`${what} can be up to ${Math.round(config.maxUploadBytes / 1048576)} MB.`);
  const buf = await fs.readFile(file.path);
  const type = detectImageType(buf);
  if (!type) throw badRequest(`${what} must be JPEG, PNG or WebP images.`);
  let clean: Buffer;
  try {
    clean = stripMetadata(buf, type);
  } catch {
    throw badRequest("That image could not be read. Try a different file.");
  }
  const key = `${randomToken(18)}.${extensionFor(type)}`;
  await fs.writeFile(fileOf(key), clean, { mode: 0o640 });
  return { key, mimeType: type, sizeBytes: clean.length };
}

/** Validates a video by content and length, scrubs its metadata and stores it, with an optional poster. */
async function storeVideo(video: Express.Multer.File, poster?: Express.Multer.File) {
  if (video.size > limits.videoMaxBytes) throw badRequest(`Videos can be up to ${Math.round(limits.videoMaxBytes / 1048576)} MB.`);
  let info;
  try {
    info = await inspectAndScrub(video.path);
  } catch {
    throw badRequest("Videos must be MP4 or WebM files. On iPhone, choose “Most Compatible” in Camera › Formats, or export as MP4.");
  }
  if (info.durationMs === null) throw badRequest("We couldn't read how long this video is. Try exporting it as an MP4.");
  if (info.durationMs > limits.videoMaxSeconds * 1000 + 500) throw badRequest(`Videos can be up to ${limits.videoMaxSeconds} seconds long. This one is ${Math.round(info.durationMs / 1000)} seconds.`);
  const posterFile = poster ? await storeImage(poster, "Video thumbnails") : null;
  const key = `${randomToken(18)}.${extensionForVideo(info.type)}`;
  await fs.rename(video.path, fileOf(key));
  await fs.chmod(fileOf(key), 0o640);
  return { key, mimeType: info.type, sizeBytes: video.size, durationMs: info.durationMs, posterKey: posterFile?.key ?? null };
}

async function owned(userId: string, id: string) {
  const item = await prisma.profilePhoto.findFirst({ where: { id, userId } });
  if (!item) throw notFound("That photo or video wasn't found.");
  return item;
}

/** Makes sure exactly one image is primary when the member has any images. */
async function ensurePrimary(tx: Prisma.TransactionClient, userId: string) {
  const has = await tx.profilePhoto.count({ where: { userId, isPrimary: true } });
  if (has) return;
  const first = await tx.profilePhoto.findFirst({ where: { userId, kind: "IMAGE" }, orderBy: { position: "asc" } });
  if (first) await tx.profilePhoto.update({ where: { id: first.id }, data: { isPrimary: true } });
}

/** The fields a member sees about their own media (including pending/rejected items). */
export const ownMediaView = (m: ProfilePhoto) => ({
  id: m.id,
  kind: m.kind,
  position: m.position,
  status: m.status,
  caption: m.caption,
  isPrimary: m.isPrimary,
  focusX: m.focusX,
  focusY: m.focusY,
  durationMs: m.durationMs,
  hasPoster: !!m.posterKey,
});

export const mediaLimits = { maxPhotos: limits.maxPhotos, maxVideos: limits.maxVideos, captionMax: limits.captionMax, videoMaxSeconds: limits.videoMaxSeconds, videoMaxBytes: limits.videoMaxBytes, photoMaxBytes: config.maxUploadBytes };

// ---------- the member's own media (mounted at /api/profiles/me) ----------

export const ownMediaRouter = Router();

ownMediaRouter.post("/photos", upload.fields([{ name: "photo", maxCount: 1 }]), async (req, res) => {
  const userId = req.user!.id;
  try {
    const file = filesOf(req).photo?.[0];
    if (!file) throw badRequest("Choose a photo to upload.");
    if ((await prisma.profilePhoto.count({ where: { userId, kind: "IMAGE" } })) >= limits.maxPhotos) throw badRequest(`You can add up to ${limits.maxPhotos} photos.`);
    const stored = await storeImage(file);
    const photo = await prisma.$transaction(async (tx) => {
      const position = await tx.profilePhoto.count({ where: { userId } });
      const created = await tx.profilePhoto.create({ data: { userId, kind: "IMAGE", storageKey: stored.key, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, position } });
      await ensurePrimary(tx, userId);
      return tx.profilePhoto.findUniqueOrThrow({ where: { id: created.id } });
    });
    ok(res, ownMediaView(photo), 201);
  } finally {
    await cleanupIncoming(req);
  }
});

ownMediaRouter.post("/videos", upload.fields([{ name: "video", maxCount: 1 }, { name: "poster", maxCount: 1 }]), async (req, res) => {
  const userId = req.user!.id;
  try {
    const video = filesOf(req).video?.[0];
    if (!video) throw badRequest("Choose a video to upload.");
    if ((await prisma.profilePhoto.count({ where: { userId, kind: "VIDEO" } })) >= limits.maxVideos) throw badRequest(`You can add up to ${limits.maxVideos} videos.`);
    const stored = await storeVideo(video, filesOf(req).poster?.[0]);
    try {
      const item = await prisma.$transaction(async (tx) => {
        const position = await tx.profilePhoto.count({ where: { userId } });
        return tx.profilePhoto.create({ data: { userId, kind: "VIDEO", storageKey: stored.key, mimeType: stored.mimeType, sizeBytes: stored.sizeBytes, durationMs: stored.durationMs, posterKey: stored.posterKey, position } });
      });
      ok(res, ownMediaView(item), 201);
    } catch (e) {
      await removeFiles([stored.key, stored.posterKey]);
      throw e;
    }
  } finally {
    await cleanupIncoming(req);
  }
});

/** Swaps the file behind an item, keeping its caption, position and primary status. Old files are removed. */
ownMediaRouter.post("/photos/:id/replace", upload.fields([{ name: "photo", maxCount: 1 }, { name: "video", maxCount: 1 }, { name: "poster", maxCount: 1 }]), async (req, res) => {
  const userId = req.user!.id;
  try {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const item = await owned(userId, id);
    let data: Prisma.ProfilePhotoUpdateInput;
    if (item.kind === "IMAGE") {
      const file = filesOf(req).photo?.[0];
      if (!file) throw badRequest("Choose a photo to replace this one.");
      const s = await storeImage(file);
      data = { storageKey: s.key, mimeType: s.mimeType, sizeBytes: s.sizeBytes, focusX: 50, focusY: 50 };
    } else {
      const file = filesOf(req).video?.[0];
      if (!file) throw badRequest("Choose a video to replace this one.");
      const s = await storeVideo(file, filesOf(req).poster?.[0]);
      data = { storageKey: s.key, mimeType: s.mimeType, sizeBytes: s.sizeBytes, durationMs: s.durationMs, posterKey: s.posterKey, focusX: 50, focusY: 50 };
    }
    const updated = await prisma.profilePhoto.update({ where: { id }, data });
    await removeFiles([item.storageKey, item.posterKey]);
    ok(res, ownMediaView(updated));
  } finally {
    await cleanupIncoming(req);
  }
});

/** Caption and/or framing for one item. A caption always belongs to this item, wherever it moves. */
ownMediaRouter.patch("/photos/:id", async (req, res) => {
  const userId = req.user!.id;
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const body = parse(
    z
      .object({
        focusX: z.number().int().min(0).max(100).optional(),
        focusY: z.number().int().min(0).max(100).optional(),
        caption: z.string().max(1000).nullable().optional(),
      })
      .strict()
      .refine((b) => (b.focusX === undefined) === (b.focusY === undefined), { message: "Send both focusX and focusY.", path: ["focusX"] }),
    req.body,
  );
  const data: Prisma.ProfilePhotoUpdateManyMutationInput = {};
  if (body.focusX !== undefined) Object.assign(data, { focusX: body.focusX, focusY: body.focusY });
  if (body.caption !== undefined) {
    const caption = body.caption === null ? "" : cleanCaption(body.caption);
    if (caption.length > limits.captionMax) throw badRequest(`Captions can be up to ${limits.captionMax} characters.`);
    data.caption = caption || null;
  }
  const { count } = await prisma.profilePhoto.updateMany({ where: { id, userId }, data });
  if (!count) throw notFound("That photo or video wasn't found.");
  ok(res, ownMediaView(await prisma.profilePhoto.findUniqueOrThrow({ where: { id } })));
});

ownMediaRouter.put("/photos/:id/primary", async (req, res) => {
  const userId = req.user!.id;
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const item = await owned(userId, id);
  if (item.kind !== "IMAGE") throw badRequest("Only a photo can be your main photo.");
  await prisma.$transaction([
    prisma.profilePhoto.updateMany({ where: { userId, isPrimary: true }, data: { isPrimary: false } }),
    prisma.profilePhoto.update({ where: { id }, data: { isPrimary: true } }),
  ]);
  ok(res, { primary: id });
});

ownMediaRouter.put("/photos/order", async (req, res) => {
  const userId = req.user!.id;
  const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(limits.maxPhotos + limits.maxVideos) }), req.body);
  const mine = await prisma.profilePhoto.findMany({ where: { userId }, select: { id: true } });
  const mineIds = new Set(mine.map((o) => o.id));
  if (ids.length !== mine.length || new Set(ids).size !== ids.length || !ids.every((id) => mineIds.has(id))) throw badRequest("That list doesn't match your photos and videos.");
  await prisma.$transaction(ids.map((id, position) => prisma.profilePhoto.update({ where: { id }, data: { position } })));
  ok(res, { ordered: true });
});

ownMediaRouter.delete("/photos/:id", async (req, res) => {
  const userId = req.user!.id;
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const item = await owned(userId, id);
  await prisma.$transaction(async (tx) => {
    await tx.profilePhoto.delete({ where: { id: item.id } });
    const rest = await tx.profilePhoto.findMany({ where: { userId }, orderBy: { position: "asc" } });
    for (const [i, p] of rest.entries()) if (p.position !== i) await tx.profilePhoto.update({ where: { id: p.id }, data: { position: i } });
    await ensurePrimary(tx, userId);
  });
  await removeFiles([item.storageKey, item.posterKey]);
  ok(res, { deleted: true });
});

// ---------- serving (mounted at /api/photos) ----------

/**
 * Other members may see an item only if it is approved, its owner is active with a published profile,
 * and neither has blocked the other. Owners always see their own; staff can review reported media.
 */
async function viewable(req: Request, id: string) {
  const item = await prisma.profilePhoto.findUnique({ where: { id }, include: { user: { select: { status: true, profile: { select: { isPublished: true } } } } } });
  if (!item) throw notFound();
  const viewer = req.user!;
  if (item.userId === viewer.id || viewer.role === "ADMIN" || viewer.role === "MODERATOR") return item;
  if (viewer.status !== "ACTIVE" || item.status !== "APPROVED" || item.user.status !== "ACTIVE" || !item.user.profile?.isPublished) throw notFound();
  if (await isBlockedBetween(viewer.id, item.userId)) throw notFound();
  return item;
}

export const photosRouter = Router();

photosRouter.get("/:id", requireAuth, async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const item = await viewable(req, id);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(item.mimeType);
  // sendFile answers Range requests, so videos stream and seek without downloading the whole file.
  res.sendFile(path.resolve(fileOf(item.storageKey)));
});

photosRouter.get("/:id/poster", requireAuth, async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const item = await viewable(req, id);
  if (!item.posterKey) throw notFound();
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(path.extname(item.posterKey));
  res.sendFile(path.resolve(fileOf(item.posterKey)));
});
