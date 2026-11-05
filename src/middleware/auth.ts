import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { prisma } from "../db.js";
import { forbidden, unauthorized } from "../lib/http.js";
import { verifyAccessToken, type Audience } from "../lib/jwt.js";
import { ACCESS_COOKIE, LEGACY_SESSION_COOKIE, migrateLegacySession, setWebCookies } from "../modules/auth/sessions.js";

/** A bearer token from a native app, if the request carries one. */
export function bearerToken(req: Pick<Request, "get">) {
  const h = req.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() || undefined : undefined;
}

/**
 * Resolves an access token to its user. The JWT is checked first (signature, algorithm, issuer, audience, expiry),
 * then its session must still be live, so logout, "sign out everywhere" and bans take effect at once.
 */
export async function userForAccessToken(token: string | undefined, audience: Audience) {
  if (!token) return null;
  const claims = await verifyAccessToken(token, audience);
  if (!claims) return null;
  const session = await prisma.session.findUnique({
    where: { id: claims.sid },
    include: { user: { select: { id: true, email: true, role: true, status: true, emailVerifiedAt: true } } },
  });
  const now = new Date();
  if (!session || session.userId !== claims.sub || session.revokedAt || session.expiresAt < now) return null;
  if (session.user.status === "BANNED" || session.user.status === "PENDING_DELETION") return null;
  return { session, user: session.user };
}

/**
 * Attaches req.user from an access token: the Authorization header (mobile) or the HttpOnly cookie (web).
 * A cookie from before tokens existed is upgraded here, once. Never fails the request; routes decide.
 */
export async function loadSession(req: Request, res: Response, next: NextFunction) {
  const bearer = bearerToken(req);
  let found = bearer ? await userForAccessToken(bearer, "mavelle-mobile") : await userForAccessToken(req.cookies?.[ACCESS_COOKIE], "mavelle-web");
  if (bearer && !found) res.setHeader("WWW-Authenticate", 'Bearer error="invalid_token"');
  if (!found && !bearer && req.cookies?.[LEGACY_SESSION_COOKIE]) {
    const pair = await migrateLegacySession(req, req.cookies[LEGACY_SESSION_COOKIE]);
    if (pair) {
      setWebCookies(res, pair);
      found = await userForAccessToken(pair.accessToken, "mavelle-web");
    }
  }
  if (found) {
    req.user = found.user;
    req.sessionId = found.session.id;
    req.authVia = bearer ? "bearer" : "cookie";
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

/** Roles come only from the database row loaded above; nothing a client sends can change them. */
export const requireRole =
  (...roles: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!roles.includes(req.user.role)) throw forbidden();
    next();
  };
