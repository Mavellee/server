import argon2 from "argon2";
import type { Request, Response } from "express";
import type { TokenType } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { SESSION_COOKIE } from "../../middleware/auth.js";
import { mailer } from "../../lib/mailer.js";
import { ageFrom } from "../../lib/age.js";
import { disconnectSessions } from "../../realtime/bus.js";

// Argon2id with OWASP-recommended minimums (19 MiB, 2 iterations).
const HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const hashPassword = (password: string) => argon2.hash(password, HASH_OPTIONS);

// Used so that "unknown email" and "wrong password" take similar time.
let dummyHash: Promise<string> | null = null;
export async function verifyPassword(hash: string | null, password: string) {
  if (!hash) {
    dummyHash ??= hashPassword("knot-timing-equaliser");
    await argon2.verify(await dummyHash, password).catch(() => false);
    return false;
  }
  return argon2.verify(hash, password).catch(() => false);
}

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: "lax" as const,
  path: "/",
  maxAge: config.sessionTtlMs,
});

export async function startSession(req: Request, res: Response, userId: string) {
  const token = randomToken();
  await prisma.session.create({
    data: {
      userId,
      tokenHash: sha256(token),
      userAgent: req.get("user-agent")?.slice(0, 255),
      ip: req.ip,
      expiresAt: new Date(Date.now() + config.sessionTtlMs),
    },
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

export function clearSessionCookie(res: Response) {
  const { maxAge: _maxAge, ...opts } = cookieOptions();
  res.clearCookie(SESSION_COOKIE, opts);
}

export async function revokeAllSessions(userId: string, exceptSessionId?: string) {
  const where = { userId, revokedAt: null, ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) };
  const live = await prisma.session.findMany({ where, select: { id: true } });
  await prisma.session.updateMany({ where, data: { revokedAt: new Date() } });
  disconnectSessions(live.map((s) => s.id));
}

const TOKEN_TTL: Record<TokenType, number> = {
  EMAIL_VERIFICATION: 24 * 60 * 60 * 1000,
  PASSWORD_RESET: 60 * 60 * 1000,
};

/** Creates a single-use token; only its hash is stored. Older unused tokens of the same type are invalidated. */
export async function issueToken(userId: string, type: TokenType) {
  const token = randomToken();
  await prisma.$transaction([
    prisma.authToken.updateMany({ where: { userId, type, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.authToken.create({
      data: { userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + TOKEN_TTL[type]) },
    }),
  ]);
  return token;
}

/** Atomically consumes a token, returning its user id, or null if invalid/expired/used. */
export async function consumeToken(token: string, type: TokenType) {
  const found = await prisma.authToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!found || found.type !== type || found.usedAt || found.expiresAt < new Date()) return null;
  const { count } = await prisma.authToken.updateMany({ where: { id: found.id, usedAt: null }, data: { usedAt: new Date() } });
  return count === 1 ? found.userId : null;
}

export async function sendVerificationEmail(userId: string, email: string) {
  const token = await issueToken(userId, "EMAIL_VERIFICATION");
  await mailer.send({
    to: email,
    subject: "Confirm your email for Mavelle",
    text: `Welcome to Mavelle.\n\nConfirm your email address to start meeting people:\n${config.appOrigin}/verify-email?token=${token}\n\nThis link expires in 24 hours. If you did not create an account, you can ignore this email.`,
  });
}

export async function sendPasswordResetEmail(userId: string, email: string) {
  const token = await issueToken(userId, "PASSWORD_RESET");
  await mailer.send({
    to: email,
    subject: "Reset your Mavelle password",
    text: `Someone asked to reset the password for your Mavelle account.\n\nChoose a new password here:\n${config.appOrigin}/reset-password?token=${token}\n\nThis link expires in 1 hour. If this was not you, you can ignore this email; your password will not change.`,
  });
}

/** The signed-in user's own view of their account. Never includes the password hash. */
export async function accountView(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      profile: { select: { displayName: true, isPublished: true, discoveryPausedAt: true } },
      photos: { where: { kind: "IMAGE" }, orderBy: [{ isPrimary: "desc" }, { position: "asc" }], take: 1, select: { id: true } },
      expertProfile: { select: { status: true } },
      settings: true,
    },
  });
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    status: user.status,
    emailVerified: !!user.emailVerifiedAt,
    age: user.dateOfBirth ? ageFrom(user.dateOfBirth) : null,
    onboarded: !!user.onboardedAt,
    displayName: user.profile?.displayName ?? null,
    profilePublished: user.profile?.isPublished ?? false,
    discoveryPaused: !!user.profile?.discoveryPausedAt,
    avatarPhotoId: user.photos[0]?.id ?? null,
    expertStatus: user.expertProfile?.status ?? null,
    settings: user.settings
      ? {
          aiEnabled: user.settings.aiEnabled,
          readReceipts: user.settings.readReceipts,
          typingIndicators: user.settings.typingIndicators,
          emailNotifications: user.settings.emailNotifications,
          showDistance: user.settings.showDistance,
        }
      : null,
  };
}
