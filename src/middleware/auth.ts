import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { prisma } from "../db.js";
import { sha256 } from "../lib/crypto.js";
import { forbidden, unauthorized } from "../lib/http.js";

export const SESSION_COOKIE = "knot_session";

/** Resolves a raw session token to its user, or null if the session is invalid. */
export async function userForToken(token: string | undefined) {
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { select: { id: true, email: true, role: true, status: true, emailVerifiedAt: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (session.user.status === "BANNED" || session.user.status === "PENDING_DELETION") return null;
  return { session, user: session.user };
}

/** Attaches req.user when a valid session cookie is present. Never fails the request. */
export async function loadSession(req: Request, _res: Response, next: NextFunction) {
  const found = await userForToken(req.cookies?.[SESSION_COOKIE]);
  if (found) {
    req.user = found.user;
    req.sessionId = found.session.id;
    // Coarse activity tracking: at most one write per 5 minutes per session.
    if (Date.now() - found.session.lastUsedAt.getTime() > 5 * 60 * 1000) {
      const now = new Date();
      await prisma.$transaction([
        prisma.session.update({ where: { id: found.session.id }, data: { lastUsedAt: now } }),
        prisma.user.update({ where: { id: found.user.id }, data: { lastActiveAt: now } }),
      ]);
    }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw unauthorized();
  next();
}

/** Verified, non-suspended accounts only (social features). */
export function requireActive(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) throw unauthorized();
  if (req.user.status === "PENDING_VERIFICATION") throw forbidden("Please verify your email address first.");
  if (req.user.status !== "ACTIVE") throw forbidden("Your account is currently restricted. Contact support for help.");
  next();
}

export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };
