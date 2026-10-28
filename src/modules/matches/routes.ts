import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { ok, parse } from "../../lib/http.js";
import { blockedUserIds } from "../../lib/safety.js";
import { requireActive } from "../../middleware/auth.js";
import { publicProfileInclude, toPublicProfile } from "../profiles/serialize.js";
import { viewerFor } from "../discovery/service.js";
import { endMatch, likeUser, passUser } from "./service.js";

const target = z.object({ userId: z.string().uuid() });

export const likesRouter = Router();
likesRouter.use(requireActive);

likesRouter.post("/", async (req, res) => {
  const { userId } = parse(target, req.body);
  const result = await likeUser(req.user!.id, userId);
  ok(res, result, result.alreadyLiked ? 200 : 201);
});

likesRouter.post("/pass", async (req, res) => {
  const { userId } = parse(target, req.body);
  ok(res, await passUser(req.user!.id, userId));
});

/** People who liked me and I have not responded to yet. Real likes only. */
likesRouter.get("/received", async (req, res) => {
  const me = req.user!.id;
  const [blocked, mine, passed] = await Promise.all([
    blockedUserIds(me),
    prisma.like.findMany({ where: { fromUserId: me }, select: { toUserId: true } }),
    prisma.pass.findMany({ where: { fromUserId: me }, select: { toUserId: true } }),
  ]);
  const exclude = [...blocked, ...mine.map((l) => l.toUserId), ...passed.map((p) => p.toUserId)];
  const likes = await prisma.like.findMany({
    where: {
      toUserId: me,
      fromUserId: { notIn: exclude },
      from: { status: "ACTIVE", profile: { isPublished: true } },
    },
    include: { from: { include: publicProfileInclude } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const viewer = await viewerFor(me);
  ok(res, likes.map((l) => ({ likedAt: l.createdAt, profile: toPublicProfile(l.from, viewer) })));
});

likesRouter.get("/sent", async (req, res) => {
  const me = req.user!.id;
  const blocked = await blockedUserIds(me);
  const likes = await prisma.like.findMany({
    where: { fromUserId: me, toUserId: { notIn: [...blocked] }, to: { status: "ACTIVE", profile: { isPublished: true } } },
    include: { to: { include: publicProfileInclude } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const viewer = await viewerFor(me);
  ok(res, likes.map((l) => ({ likedAt: l.createdAt, profile: toPublicProfile(l.to, viewer) })));
});

export const matchesRouter = Router();
matchesRouter.use(requireActive);

matchesRouter.get("/", async (req, res) => {
  const me = req.user!.id;
  const matches = await prisma.match.findMany({
    where: { status: "ACTIVE", OR: [{ userAId: me }, { userBId: me }] },
    include: {
      userA: { include: publicProfileInclude },
      userB: { include: publicProfileInclude },
      conversation: { select: { id: true, lastMessageAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const viewer = await viewerFor(me);
  ok(
    res,
    matches
      .map((m) => ({ m, other: m.userAId === me ? m.userB : m.userA }))
      .filter(({ other }) => other.status === "ACTIVE" && other.profile)
      .map(({ m, other }) => ({
        id: m.id,
        createdAt: m.createdAt,
        conversationId: m.conversation?.id ?? null,
        lastMessageAt: m.conversation?.lastMessageAt ?? null,
        profile: toPublicProfile(other, viewer),
      })),
  );
});

matchesRouter.delete("/:id", async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  await endMatch(req.user!.id, id);
  ok(res, { unmatched: true });
});
