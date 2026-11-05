import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { ApiError, badRequest, ok, parse, unauthorized } from "../../lib/http.js";
import { ageFrom } from "../../lib/age.js";
import { requireAuth } from "../../middleware/auth.js";
import { accountLimiter, authLimiter, sensitiveLimiter } from "../../middleware/security.js";
import { securityEvent } from "../../lib/securityEvents.js";
import { mailer } from "../../lib/mailer.js";
import { config } from "../../config.js";
import { accountView, consumeToken, hashPassword, sendPasswordResetEmail, sendVerificationEmail, verifyPassword } from "./service.js";
import {
  REFRESH_COOKIE,
  clearWebCookies,
  createSession,
  refreshSession,
  revokeAllSessions,
  revokeSession,
  sessionIdForRefresh,
  setWebCookies,
  type TokenPair,
} from "./sessions.js";

export const password = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(128, "Use at most 128 characters.")
  .refine((v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v), "Include at least one letter and one number.");
const email = z.string().trim().toLowerCase().email("Enter a valid email address.").max(254);
export const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD.")
  .transform((v) => new Date(`${v}T00:00:00Z`))
  .refine((d) => !Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1900, "Enter a valid date.");

const registerSchema = z.object({
  email,
  password,
  dateOfBirth,
  ageConfirmed: z.literal(true, { errorMap: () => ({ message: "You must confirm you are 18 or older." }) }),
  acceptTerms: z.literal(true, { errorMap: () => ({ message: "Please accept the terms and community guidelines." }) }),
});

export const authRouter = Router();

const credentials = z.object({ email, password: z.string().min(1).max(128) });
const mobileTokens = (pair: TokenPair) => ({ accessToken: pair.accessToken, refreshToken: pair.refreshToken, tokenType: "Bearer", expiresIn: pair.expiresIn });

/**
 * Registration never says whether an email is already in use. A new address gets a verification email; an
 * existing one gets a note telling its owner someone tried to sign up. Both answer the same way, after the same work.
 */
authRouter.post("/register", authLimiter, accountLimiter, async (req, res) => {
  const body = parse(registerSchema, req.body);
  // Age is always computed on the server from the date of birth.
  if (ageFrom(body.dateOfBirth) < 18) {
    throw new ApiError(422, "UNDERAGE", "Mavelle is only for adults aged 18 and over.");
  }
  const passwordHash = await hashPassword(body.password);
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) {
    await mailer.send({
      to: existing.email,
      subject: "Someone tried to create a Mavelle account with your email",
      text: `Someone tried to create a new Mavelle account using this email address.\n\nIf it was you, you already have an account: log in at ${config.appOrigin}/login, or reset your password at ${config.appOrigin}/forgot-password.\n\nIf it wasn't you, you can ignore this email. Nothing about your account has changed.`,
    });
    await securityEvent("REGISTER_EXISTING_EMAIL", req, { userId: existing.id });
  } else {
    const user = await prisma.user.create({
      data: { email: body.email, passwordHash, dateOfBirth: body.dateOfBirth, ageConfirmedAt: new Date(), settings: { create: {} }, subscription: { create: {} } },
    });
    await sendVerificationEmail(user.id, user.email);
    await securityEvent("REGISTER", req, { userId: user.id });
  }
  ok(res, { checkEmail: true }, 202);
});

async function checkLogin(req: Request) {
  const body = parse(credentials, req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  const valid = await verifyPassword(user?.passwordHash ?? null, body.password);
  if (!user || !valid) {
    await securityEvent("LOGIN_FAILED", req, user ? { userId: user.id } : { email: body.email });
    throw new ApiError(401, "INVALID_CREDENTIALS", "That email and password do not match.");
  }
  if (user.status === "BANNED") throw new ApiError(403, "ACCOUNT_BANNED", "This account has been closed for violating our community guidelines.");
  if (user.status === "PENDING_DELETION") throw new ApiError(403, "ACCOUNT_DELETED", "This account is scheduled for deletion. Contact support within 30 days to restore it.");
  return user;
}

authRouter.post("/login", authLimiter, accountLimiter, async (req, res) => {
  const user = await checkLogin(req);
  const pair = await createSession(req, user.id, "WEB");
  setWebCookies(res, pair);
  await securityEvent("LOGIN_SUCCESS", req, { userId: user.id, sessionId: pair.sessionId, metadata: { client: "WEB" } });
  ok(res, await accountView(user.id));
});

/** Web: the refresh cookie (SameSite=Strict, path /api/auth) buys a new access token and rotates itself. */
authRouter.post("/refresh", authLimiter, async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE];
  if (typeof raw !== "string" || !raw) throw new ApiError(401, "INVALID_REFRESH", "Your session has ended. Please log in again.");
  try {
    setWebCookies(res, await refreshSession(req, raw, "WEB"));
  } catch (e) {
    clearWebCookies(res);
    throw e;
  }
  ok(res, { refreshed: true });
});

authRouter.post("/logout", async (req, res) => {
  const sessionId = req.sessionId ?? (await sessionIdForRefresh(req.cookies?.[REFRESH_COOKIE]))?.id;
  if (sessionId) {
    await revokeSession(sessionId, "LOGOUT");
    await securityEvent("LOGOUT", req, { userId: req.user?.id, sessionId });
  }
  clearWebCookies(res);
  ok(res, { loggedOut: true });
});

/** Signs out every device, this one included. Asks for the password again. */
authRouter.post("/logout-all", requireAuth, sensitiveLimiter, async (req, res) => {
  const { password: pw } = parse(z.object({ password: z.string().min(1).max(128) }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!(await verifyPassword(user.passwordHash, pw))) throw new ApiError(401, "INVALID_CREDENTIALS", "That password is incorrect.");
  await revokeAllSessions(user.id, "LOGOUT_ALL");
  await securityEvent("LOGOUT_ALL", req, { userId: user.id, sessionId: req.sessionId });
  if (req.authVia === "cookie") clearWebCookies(res);
  ok(res, { loggedOut: true });
});

// ---------- native apps: tokens in the body, never cookies ----------

authRouter.post("/mobile/login", authLimiter, accountLimiter, async (req, res) => {
  const user = await checkLogin(req);
  const { deviceName } = parse(z.object({ deviceName: z.string().trim().max(80).optional() }).passthrough(), req.body);
  const pair = await createSession(req, user.id, "MOBILE", deviceName);
  await securityEvent("LOGIN_SUCCESS", req, { userId: user.id, sessionId: pair.sessionId, metadata: { client: "MOBILE" } });
  ok(res, { ...mobileTokens(pair), account: await accountView(user.id) });
});

/** Mobile refresh: no grace window, so a replayed refresh token always closes the session. */
authRouter.post("/mobile/refresh", authLimiter, async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
  ok(res, mobileTokens(await refreshSession(req, refreshToken, "MOBILE")));
});

authRouter.post("/mobile/logout", async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20).max(200).optional() }), req.body ?? {});
  const fromRefresh = await sessionIdForRefresh(refreshToken);
  const sessionId = req.authVia === "bearer" ? req.sessionId : fromRefresh?.id;
  if (sessionId) {
    await revokeSession(sessionId, "LOGOUT");
    await securityEvent("LOGOUT", req, { userId: req.user?.id ?? fromRefresh?.userId, sessionId });
  }
  ok(res, { loggedOut: true });
});

authRouter.get("/me", async (req, res) => {
  if (!req.user) throw unauthorized();
  ok(res, await accountView(req.user.id));
});

/**
 * The emailed link proves the address belongs to whoever opens it, so it also signs them in on the web,
 * unless they are already signed in as that account.
 */
authRouter.post("/verify-email", authLimiter, async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
  const userId = await consumeToken(token, "EMAIL_VERIFICATION");
  if (!userId) throw badRequest("This verification link is invalid or has expired. Request a new one from your account.");
  await prisma.user.updateMany({
    where: { id: userId, status: "PENDING_VERIFICATION" },
    data: { status: "ACTIVE" },
  });
  const user = await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  await securityEvent("EMAIL_VERIFIED", req, { userId });
  if (req.user?.id !== userId && req.authVia !== "bearer" && user.status === "ACTIVE") {
    const pair = await createSession(req, userId, "WEB");
    setWebCookies(res, pair);
    await securityEvent("LOGIN_SUCCESS", req, { userId, sessionId: pair.sessionId, metadata: { client: "WEB", via: "email-verification" } });
  }
  ok(res, { verified: true });
});

/** Signed in: resend to yourself. Signed out: resend by email, with the same answer whether or not it exists. */
authRouter.post("/resend-verification", authLimiter, accountLimiter, async (req, res) => {
  if (req.user) {
    if (req.user.emailVerifiedAt) throw badRequest("Your email is already verified.");
    await sendVerificationEmail(req.user.id, req.user.email);
    return ok(res, { sent: true });
  }
  const body = parse(z.object({ email }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (user && user.status === "PENDING_VERIFICATION") await sendVerificationEmail(user.id, user.email);
  ok(res, { sent: true });
});

authRouter.post("/forgot-password", authLimiter, accountLimiter, async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (user && user.status !== "BANNED") {
    await sendPasswordResetEmail(user.id, user.email);
    await securityEvent("PASSWORD_RESET_REQUESTED", req, { userId: user.id });
  }
  // Same response either way so the endpoint cannot be used to discover accounts.
  ok(res, { sent: true });
});

authRouter.post("/reset-password", authLimiter, async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10).max(200), password }), req.body);
  const userId = await consumeToken(body.token, "PASSWORD_RESET");
  if (!userId) throw badRequest("This reset link is invalid or has expired. Request a new one.");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(body.password) } });
  await revokeAllSessions(userId, "PASSWORD_RESET");
  await securityEvent("PASSWORD_RESET", req, { userId });
  ok(res, { reset: true });
});

authRouter.post("/change-password", requireAuth, sensitiveLimiter, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Your current password is incorrect.");
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
  await revokeAllSessions(user.id, "PASSWORD_CHANGED", req.sessionId);
  await securityEvent("PASSWORD_CHANGED", req, { userId: user.id, sessionId: req.sessionId });
  ok(res, { changed: true });
});
