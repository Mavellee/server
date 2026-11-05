import { cipherReady, open } from "../astro/cipher.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { ApiError, ok, parse } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import { sensitiveLimiter } from "../../middleware/security.js";
import { verifyPassword } from "../auth/service.js";
import { clearWebCookies, revokeAllSessions, revokeSession } from "../auth/sessions.js";
import { securityEvent } from "../../lib/securityEvents.js";
import { endMatch } from "../matches/service.js";
import { zodiacApplies, zodiacSign } from "../../lib/zodiac.js";

export const DELETION_GRACE_DAYS = 30;

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

const settingsSchema = z
  .object({
    aiEnabled: z.boolean(),
    readReceipts: z.boolean(),
    typingIndicators: z.boolean(),
    emailNotifications: z.boolean(),
    showDistance: z.boolean(),
    showZodiacSign: z.boolean(),
  })
  .partial();

settingsRouter.get("/", async (req, res) => {
  const userId = req.user!.id;
  const [settings, profile, user] = await Promise.all([
    prisma.userSettings.upsert({ where: { userId }, create: { userId }, update: {} }),
    prisma.profile.findUnique({ where: { userId }, select: { isDiscoverable: true, discoveryPausedAt: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { dateOfBirth: true, preferences: { where: { kind: "OWN" }, select: { intention: true } } } }),
  ]);
  const zodiac = user?.dateOfBirth && zodiacApplies(user.preferences.map((p) => p.intention)) ? zodiacSign(user.dateOfBirth) : null;
  const { userId: _u, updatedAt: _t, ...rest } = settings;
  ok(res, { ...rest, isDiscoverable: profile?.isDiscoverable ?? true, discoveryPaused: !!profile?.discoveryPausedAt, zodiac });
});

settingsRouter.patch("/", async (req, res) => {
  const body = parse(settingsSchema, req.body);
  const userId = req.user!.id;
  const s = await prisma.userSettings.upsert({ where: { userId }, create: { userId, ...body }, update: body });
  const { userId: _u, updatedAt: _t, ...rest } = s;
  ok(res, rest);
});

/** Pause hides you from Discover without affecting existing matches. */
settingsRouter.post("/discovery", async (req, res) => {
  const body = parse(z.object({ paused: z.boolean().optional(), isDiscoverable: z.boolean().optional() }), req.body);
  const userId = req.user!.id;
  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (!profile) throw new ApiError(400, "NO_PROFILE", "Create your profile first.");
  const updated = await prisma.profile.update({
    where: { userId },
    data: {
      ...(body.paused !== undefined ? { discoveryPausedAt: body.paused ? new Date() : null } : {}),
      ...(body.isDiscoverable !== undefined ? { isDiscoverable: body.isDiscoverable } : {}),
    },
  });
  ok(res, { discoveryPaused: !!updated.discoveryPausedAt, isDiscoverable: updated.isDiscoverable });
});

settingsRouter.get("/sessions", async (req, res) => {
  const now = new Date();
  const sessions = await prisma.session.findMany({
    where: { userId: req.user!.id, revokedAt: null, expiresAt: { gt: now }, OR: [{ idleExpiresAt: null }, { idleExpiresAt: { gt: now } }] },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, userAgent: true, client: true, createdAt: true, lastUsedAt: true },
  });
  ok(res, sessions.map((s) => ({ ...s, current: s.id === req.sessionId })));
});

/** Signing out another device asks for the password again, so a borrowed session can't lock the owner out. */
settingsRouter.delete("/sessions/:id", sensitiveLimiter, async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const { password } = parse(z.object({ password: z.string().min(1).max(128) }), req.body ?? {});
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!(await verifyPassword(user.passwordHash, password))) throw new ApiError(401, "INVALID_CREDENTIALS", "That password is incorrect.");
  const session = await prisma.session.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (session) {
    await revokeSession(session.id, "REVOKED_BY_USER");
    await securityEvent("SESSION_REVOKED", req, { userId: user.id, sessionId: session.id });
    if (session.id === req.sessionId && req.authVia === "cookie") clearWebCookies(res);
  }
  ok(res, { revoked: true });
});

/** Download a copy of your own data. */
settingsRouter.get("/export", sensitiveLimiter, async (req, res) => {
  const userId = req.user!.id;
  const data = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      email: true,
      dateOfBirth: true,
      createdAt: true,
      profile: true,
      settings: true,
      preferences: { select: { kind: true, intention: true } },
      interests: { select: { interest: { select: { name: true } } } },
      answers: { select: { question: { select: { prompt: true } }, answer: true, acceptable: true, importance: true, isDealbreaker: true } },
      likesSent: { select: { toUserId: true, createdAt: true } },
      messages: { select: { conversationId: true, body: true, createdAt: true } },
      reportsMade: { select: { reason: true, status: true, createdAt: true } },
      expertRequests: { select: { topic: true, question: true, status: true, createdAt: true } },
      doodlesStarted: { select: { createdAt: true, strokes: true } },
    },
  });
  res.setHeader("Content-Disposition", 'attachment; filename="knot-data.json"');
  const astro = await prisma.astroProfile.findUnique({ where: { userId } });
  const relationships = await prisma.relationship.findMany({ where: { match: { OR: [{ userAId: userId }, { userBId: userId }] } }, select: { status: true, startedAt: true, closedAt: true } });
  const friendReviews = await prisma.friendReview.findMany({ where: { requesterId: userId }, select: { status: true, friendName: true, verdict: true, comment: true, createdAt: true } });
  ok(res, { ...data, relationships, friendReviews, astrology: astro && cipherReady() ? { birthDetails: open(astro.birthCipher), accuracy: astro.accuracy, lastUsedAt: astro.lastUsedAt } : null });
});

/**
 * Deletion: the account is hidden and signed out immediately, then permanently removed by
 * `npm run db:purge-deleted` after the grace period (so accidental deletions can be reversed via support).
 */
settingsRouter.post("/delete-account", sensitiveLimiter, async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1).max(128), reason: z.string().max(500).optional() }), req.body);
  const userId = req.user!.id;
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await verifyPassword(user.passwordHash, password))) throw new ApiError(401, "INVALID_CREDENTIALS", "That password is incorrect.");

  const matches = await prisma.match.findMany({ where: { status: "ACTIVE", OR: [{ userAId: userId }, { userBId: userId }] } });
  for (const m of matches) await endMatch(userId, m.id);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { status: "PENDING_DELETION", deletionRequestedAt: new Date() } }),
    prisma.profile.updateMany({ where: { userId }, data: { isPublished: false } }),
    prisma.expertReviewRequest.updateMany({ where: { requesterId: userId, status: { in: ["PENDING", "IN_REVIEW", "INFO_REQUESTED"] } }, data: { status: "CANCELLED" } }),
  ]);
  await revokeAllSessions(userId, "ACCOUNT_DELETED");
  await securityEvent("ACCOUNT_DELETION_REQUESTED", req, { userId });
  clearWebCookies(res);
  ok(res, { scheduledFor: new Date(Date.now() + DELETION_GRACE_DAYS * 86400000) });
});
