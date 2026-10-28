import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { badRequest, notFound, ok, parse } from "../../lib/http.js";
import { randomToken } from "../../lib/crypto.js";
import { detectImageType, extensionFor, stripMetadata } from "../../lib/images.js";
import { requireActive } from "../../middleware/auth.js";
import { messageLimiter } from "../../middleware/security.js";
import { publicProfileInclude, toPublicProfile } from "../profiles/serialize.js";
import { assertMember, markRead, MAX_MESSAGE_LENGTH, sendMessage, serializeMessage } from "./service.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });
const idParam = z.object({ id: z.string().uuid() });

export const conversationsRouter = Router();
conversationsRouter.use(requireActive);

conversationsRouter.get("/", async (req, res) => {
  const me = req.user!.id;
  const convos = await prisma.conversation.findMany({
    where: { members: { some: { userId: me } }, match: { status: "ACTIVE" } },
    include: {
      match: { include: { userA: { include: publicProfileInclude }, userB: { include: publicProfileInclude } } },
      members: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1, where: { deletedAt: null } },
    },
    orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
  });
  const out = [];
  for (const c of convos) {
    const other = c.match.userAId === me ? c.match.userB : c.match.userA;
    if (other.status !== "ACTIVE" || !other.profile) continue;
    const mine = c.members.find((m) => m.userId === me);
    const unread = await prisma.message.count({
      where: {
        conversationId: c.id,
        senderId: { not: me },
        deletedAt: null,
        ...(mine?.lastReadAt ? { createdAt: { gt: mine.lastReadAt } } : {}),
      },
    });
    const last = c.messages[0];
    out.push({
      id: c.id,
      matchId: c.matchId,
      other: toPublicProfile(other),
      lastMessage: last ? { body: last.kind === "IMAGE" ? "Photo" : last.body, senderId: last.senderId, createdAt: last.createdAt } : null,
      unread,
      createdAt: c.createdAt,
    });
  }
  ok(res, out);
});

conversationsRouter.get("/:id", async (req, res) => {
  const { id } = parse(idParam, req.params);
  const me = req.user!.id;
  const { convo, otherId } = await assertMember(me, id);
  const other = await prisma.user.findUniqueOrThrow({ where: { id: otherId }, include: publicProfileInclude });
  const otherMember = convo.members.find((m) => m.userId === otherId);
  const otherSettings = await prisma.userSettings.findUnique({ where: { userId: otherId } });
  ok(res, {
    id: convo.id,
    matchId: convo.matchId,
    other: toPublicProfile(other),
    otherLastReadAt: otherSettings?.readReceipts === false ? null : (otherMember?.lastReadAt ?? null),
  });
});

conversationsRouter.get("/:id/messages", async (req, res) => {
  const { id } = parse(idParam, req.params);
  const q = parse(z.object({ before: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(50).default(30) }), req.query);
  await assertMember(req.user!.id, id);
  let beforeDate: Date | undefined;
  if (q.before) {
    const anchor = await prisma.message.findFirst({ where: { id: q.before, conversationId: id } });
    if (!anchor) throw notFound("Message not found.");
    beforeDate = anchor.createdAt;
  }
  const rows = await prisma.message.findMany({
    where: { conversationId: id, deletedAt: null, ...(beforeDate ? { createdAt: { lt: beforeDate } } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit).reverse();
  ok(res, { items: page.map(serializeMessage), hasMore, nextBefore: hasMore ? page[0]?.id : null });
});

conversationsRouter.post("/:id/messages", messageLimiter, async (req, res) => {
  const { id } = parse(idParam, req.params);
  const body = parse(
    z.object({ body: z.string().min(1).max(MAX_MESSAGE_LENGTH + 100), clientId: z.string().min(6).max(64).optional() }),
    req.body,
  );
  ok(res, await sendMessage(req.user!.id, id, body), 201);
});

conversationsRouter.post("/:id/attachments", messageLimiter, upload.single("image"), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await assertMember(req.user!.id, id);
  if (!req.file) throw badRequest("Choose an image to send.");
  const type = detectImageType(req.file.buffer);
  if (!type) throw badRequest("Images must be JPEG, PNG or WebP.");
  let clean: Buffer;
  try {
    clean = stripMetadata(req.file.buffer, type);
  } catch {
    throw badRequest("That image could not be read.");
  }
  const key = `msg_${randomToken(18)}.${extensionFor(type)}`;
  await fs.mkdir(config.uploadDir, { recursive: true });
  await fs.writeFile(path.join(config.uploadDir, key), clean, { mode: 0o640 });
  const caption = typeof req.body?.caption === "string" ? req.body.caption.slice(0, 500) : undefined;
  ok(res, await sendMessage(req.user!.id, id, { attachmentKey: key, body: caption }), 201);
});

conversationsRouter.get("/:id/attachments/:messageId", async (req, res) => {
  const { id, messageId } = parse(z.object({ id: z.string().uuid(), messageId: z.string().uuid() }), req.params);
  await assertMember(req.user!.id, id);
  const msg = await prisma.message.findFirst({ where: { id: messageId, conversationId: id, deletedAt: null } });
  if (!msg?.attachmentKey) throw notFound();
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(path.resolve(config.uploadDir, msg.attachmentKey));
});

conversationsRouter.post("/:id/read", async (req, res) => {
  const { id } = parse(idParam, req.params);
  ok(res, await markRead(req.user!.id, id));
});
