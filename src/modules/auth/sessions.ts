import type { Request, Response } from "express";
import type { Session, SessionClient } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { ApiError } from "../../lib/http.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { signAccessToken, type Audience } from "../../lib/jwt.js";
import { securityEvent } from "../../lib/securityEvents.js";
import { disconnectSessions } from "../../realtime/bus.js";

/**
 * Sessions and tokens. Each signed-in device is one Session row. It carries a refresh token (only its hash is
 * stored) that rotates on every use. Presenting the previous token again after rotation means it was copied, so
 * the whole session is closed. Access tokens are 15-minute JWTs that name the session they belong to.
 */

export const ACCESS_COOKIE = "mv_access";
export const REFRESH_COOKIE = "mv_refresh";
export const LEGACY_SESSION_COOKIE = "knot_session";

// Two tabs can refresh at once: within this window the older token still gets a new access token (web only).
export const REFRESH_GRACE_MS = 10_000;

export const audienceFor = (client: SessionClient): Audience => (client === "MOBILE" ? "mavelle-mobile" : "mavelle-web");
const unusable = (s: Pick<Session, "revokedAt" | "expiresAt" | "idleExpiresAt">, now = new Date()) => !!s.revokedAt || s.expiresAt <= now || (!!s.idleExpiresAt && s.idleExpiresAt <= now);

export type TokenPair = { accessToken: string; refreshToken: string | null; expiresIn: number; sessionId: string; userId: string };

function nextRefresh() {
  const token = randomToken(32);
  return { token, hash: sha256(token) };
}

export async function createSession(req: Request, userId: string, client: SessionClient, deviceName?: string): Promise<TokenPair> {
  const refresh = nextRefresh();
  const now = Date.now();
  const session = await prisma.session.create({
    data: {
      userId,
      client,
      refreshHash: refresh.hash,
      rotatedAt: new Date(now),
      idleExpiresAt: new Date(now + config.auth.sessionIdleMs),
      expiresAt: new Date(now + config.sessionTtlMs),
      userAgent: (deviceName || req.get("user-agent"))?.slice(0, 255),
      ip: req.ip,
    },
  });
  const access = await signAccessToken(userId, session.id, audienceFor(client));
  return { accessToken: access.token, refreshToken: refresh.token, expiresIn: access.expiresIn, sessionId: session.id, userId };
}

/** Closes a session and drops its live sockets. */
export async function revokeSession(sessionId: string, reason: string) {
  const { count } = await prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  if (count) disconnectSessions([sessionId]);
}

export async function revokeAllSessions(userId: string, reason: string, exceptSessionId?: string) {
  const where = { userId, revokedAt: null, ...(exceptSessionId ? { NOT: { id: exceptSessionId } } : {}) };
  const live = await prisma.session.findMany({ where, select: { id: true } });
  await prisma.session.updateMany({ where, data: { revokedAt: new Date(), revokedReason: reason } });
  disconnectSessions(live.map((s) => s.id));
}

const invalidRefresh = () => new ApiError(401, "INVALID_REFRESH", "Your session has ended. Please log in again.");

/**
 * Exchanges a refresh token for new tokens, rotating it. Runs under a per-session lock so concurrent refreshes
 * can't fork the session. Returns refreshToken null when an older web token arrives inside the grace window:
 * the browser already holds the newer one.
 */
export async function refreshSession(req: Request, rawToken: string, client: SessionClient): Promise<TokenPair> {
  const hash = sha256(rawToken);
  const found = await prisma.session.findFirst({ where: { OR: [{ refreshHash: hash }, { previousRefreshHash: hash }] }, select: { id: true } });
  if (!found) throw invalidRefresh();

  const outcome = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`session:${found.id}`}, 0))`;
    const s = await tx.session.findUniqueOrThrow({ where: { id: found.id }, include: { user: { select: { status: true } } } });
    if (s.client !== client || unusable(s) || s.user.status === "BANNED" || s.user.status === "PENDING_DELETION") return { kind: "invalid" as const };
    const now = new Date();
    if (s.refreshHash === hash) {
      const next = nextRefresh();
      await tx.session.update({
        where: { id: s.id },
        data: { refreshHash: next.hash, previousRefreshHash: hash, rotatedAt: now, idleExpiresAt: new Date(now.getTime() + config.auth.sessionIdleMs), lastUsedAt: now, ip: req.ip },
      });
      return { kind: "rotated" as const, session: s, refreshToken: next.token };
    }
    // The previous token: a racing browser tab, or a copy being replayed.
    if (client === "WEB" && s.rotatedAt && now.getTime() - s.rotatedAt.getTime() <= REFRESH_GRACE_MS) return { kind: "grace" as const, session: s };
    await tx.session.update({ where: { id: s.id }, data: { revokedAt: now, revokedReason: "REFRESH_REUSE" } });
    return { kind: "reused" as const, session: s };
  });

  if (outcome.kind === "invalid") throw invalidRefresh();
  if (outcome.kind === "reused") {
    disconnectSessions([outcome.session.id]);
    await securityEvent("REFRESH_REUSE_DETECTED", req, { userId: outcome.session.userId, sessionId: outcome.session.id, metadata: { client } });
    throw invalidRefresh();
  }
  const access = await signAccessToken(outcome.session.userId, outcome.session.id, audienceFor(client));
  return {
    accessToken: access.token,
    refreshToken: outcome.kind === "rotated" ? outcome.refreshToken : null,
    expiresIn: access.expiresIn,
    sessionId: outcome.session.id,
    userId: outcome.session.userId,
  };
}

/**
 * A cookie from before tokens existed is accepted once: its session is given a refresh token and the old cookie
 * stops working, so nobody is signed out by the upgrade.
 */
export async function migrateLegacySession(req: Request, rawToken: string): Promise<TokenPair | null> {
  const hash = sha256(rawToken);
  const next = nextRefresh();
  const now = new Date();
  const s = await prisma.session.findUnique({ where: { tokenHash: hash }, include: { user: { select: { status: true } } } });
  if (!s || unusable(s) || s.user.status === "BANNED" || s.user.status === "PENDING_DELETION") return null;
  const { count } = await prisma.session.updateMany({
    where: { id: s.id, tokenHash: hash, revokedAt: null },
    data: { tokenHash: null, refreshHash: next.hash, rotatedAt: now, idleExpiresAt: new Date(now.getTime() + config.auth.sessionIdleMs), client: "WEB", lastUsedAt: now },
  });
  if (count !== 1) return null;
  const access = await signAccessToken(s.userId, s.id, "mavelle-web");
  await securityEvent("LEGACY_SESSION_MIGRATED", req, { userId: s.userId, sessionId: s.id });
  return { accessToken: access.token, refreshToken: next.token, expiresIn: access.expiresIn, sessionId: s.id, userId: s.userId };
}

// ---------- web cookies ----------

const base = () => ({ httpOnly: true, secure: config.cookieSecure });

/**
 * Web keeps both tokens in HttpOnly cookies, out of reach of page scripts. The access cookie goes to every API
 * and media request; the refresh cookie only to /api/auth and only from our own site.
 */
export function setWebCookies(res: Response, pair: TokenPair) {
  res.cookie(ACCESS_COOKIE, pair.accessToken, { ...base(), sameSite: "lax", path: "/", maxAge: pair.expiresIn * 1000 });
  if (pair.refreshToken) res.cookie(REFRESH_COOKIE, pair.refreshToken, { ...base(), sameSite: "strict", path: "/api/auth", maxAge: config.sessionTtlMs });
  res.clearCookie(LEGACY_SESSION_COOKIE, { ...base(), sameSite: "lax", path: "/" });
}

export function clearWebCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...base(), sameSite: "lax", path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...base(), sameSite: "strict", path: "/api/auth" });
  res.clearCookie(LEGACY_SESSION_COOKIE, { ...base(), sameSite: "lax", path: "/" });
}

/** The session behind a refresh cookie or token, if any (used by logout when the access token has expired). */
export async function sessionIdForRefresh(rawToken: string | undefined) {
  if (!rawToken) return null;
  const hash = sha256(rawToken);
  const s = await prisma.session.findFirst({ where: { OR: [{ refreshHash: hash }, { previousRefreshHash: hash }] }, select: { id: true, userId: true } });
  return s;
}

/** Deletes sessions that ended more than `days` ago (purge job). */
export async function purgeOldSessions(days = 30) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const { count } = await prisma.session.deleteMany({ where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }, { idleExpiresAt: { lt: cutoff } }] } });
  return count;
}
