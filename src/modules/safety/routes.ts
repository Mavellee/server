import { Router } from "express";
import { z } from "zod";
import { ReportReason, ReportTarget } from "@prisma/client";
import { prisma } from "../../db.js";
import { badRequest, notFound, ok, parse } from "../../lib/http.js";
import { orderedPair } from "../../lib/safety.js";
import { requireAuth } from "../../middleware/auth.js";
import { reportLimiter } from "../../middleware/security.js";
import { endMatch } from "../matches/service.js";

export async function blockUser(blockerId: string, blockedId: string) {
  if (blockerId === blockedId) throw badRequest("You can't block yourself.");
  const target = await prisma.user.findUnique({ where: { id: blockedId }, select: { id: true } });
  if (!target) throw notFound("User not found.");
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId },
    update: {},
  });
  const [a, b] = orderedPair(blockerId, blockedId);
  const match = await prisma.match.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } });
  if (match?.status === "ACTIVE") await endMatch(blockerId, match.id, "BLOCKED");
}

export const safetyRouter = Router();
safetyRouter.use(requireAuth);

safetyRouter.get("/blocks", async (req, res) => {
  const blocks = await prisma.block.findMany({
    where: { blockerId: req.user!.id },
    include: { blocked: { select: { id: true, profile: { select: { displayName: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  ok(res, blocks.map((b) => ({ userId: b.blockedId, displayName: b.blocked.profile?.displayName ?? "Member", blockedAt: b.createdAt })));
});

safetyRouter.post("/blocks", async (req, res) => {
  const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
  await blockUser(req.user!.id, userId);
  ok(res, { blocked: true }, 201);
});

safetyRouter.delete("/blocks/:userId", async (req, res) => {
  const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
  await prisma.block.deleteMany({ where: { blockerId: req.user!.id, blockedId: userId } });
  // Unblocking does not restore an ended match.
  ok(res, { unblocked: true });
});

const reportSchema = z.object({
  userId: z.string().uuid(),
  target: z.nativeEnum(ReportTarget),
  messageId: z.string().uuid().optional(),
  reason: z.nativeEnum(ReportReason),
  details: z.string().trim().max(1000).optional(),
  alsoBlock: z.boolean().default(false),
});

safetyRouter.post("/reports", reportLimiter, async (req, res) => {
  const body = parse(reportSchema, req.body);
  const me = req.user!.id;
  if (body.userId === me) throw badRequest("You can't report yourself.");
  const reported = await prisma.user.findUnique({ where: { id: body.userId }, select: { id: true } });
  if (!reported) throw notFound("User not found.");

  if (body.target === "MESSAGE") {
    if (!body.messageId) throw badRequest("Choose the message you want to report.");
    // The reporter must have been part of the conversation and the message must be from the reported user.
    const msg = await prisma.message.findFirst({
      where: { id: body.messageId, senderId: body.userId, conversation: { members: { some: { userId: me } } } },
    });
    if (!msg) throw notFound("Message not found.");
  }

  const report = await prisma.report.create({
    data: {
      reporterId: me,
      reportedUserId: body.userId,
      target: body.target,
      messageId: body.target === "MESSAGE" ? body.messageId : undefined,
      reason: body.reason,
      details: body.details,
    },
  });
  if (body.alsoBlock) await blockUser(me, body.userId);
  ok(res, { id: report.id, status: report.status }, 201);
});

safetyRouter.get("/reports", async (req, res) => {
  const reports = await prisma.report.findMany({
    where: { reporterId: req.user!.id },
    orderBy: { createdAt: "desc" },
    select: { id: true, reason: true, target: true, status: true, createdAt: true, resolvedAt: true },
  });
  ok(res, reports);
});
