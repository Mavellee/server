import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { ApiError, badRequest, ok, parse, unauthorized } from "../../lib/http.js";
import { ageFrom } from "../../lib/age.js";
import { requireAuth } from "../../middleware/auth.js";
import { authLimiter, sensitiveLimiter } from "../../middleware/security.js";
import {
  accountView,
  clearSessionCookie,
  consumeToken,
  hashPassword,
  revokeAllSessions,
  sendPasswordResetEmail,
  sendVerificationEmail,
  startSession,
  verifyPassword,
} from "./service.js";

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

authRouter.post("/register", authLimiter, async (req, res) => {
  const body = parse(registerSchema, req.body);
  // Age is always computed on the server from the date of birth.
  if (ageFrom(body.dateOfBirth) < 18) {
    throw new ApiError(422, "UNDERAGE", "Knot is only for adults aged 18 and over.");
  }
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists. Try logging in.");

  const user = await prisma.user.create({
    data: {
      email: body.email,
      passwordHash: await hashPassword(body.password),
      dateOfBirth: body.dateOfBirth,
      ageConfirmedAt: new Date(),
      settings: { create: {} },
      subscription: { create: {} },
    },
  });
  await sendVerificationEmail(user.id, user.email);
  await startSession(req, res, user.id);
  ok(res, await accountView(user.id), 201);
});

authRouter.post("/login", authLimiter, async (req, res) => {
  const body = parse(z.object({ email, password: z.string().min(1).max(128) }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  const valid = await verifyPassword(user?.passwordHash ?? null, body.password);
  if (!user || !valid) throw new ApiError(401, "INVALID_CREDENTIALS", "That email and password do not match.");
  if (user.status === "BANNED") throw new ApiError(403, "ACCOUNT_BANNED", "This account has been closed for violating our community guidelines.");
  if (user.status === "PENDING_DELETION") throw new ApiError(403, "ACCOUNT_DELETED", "This account is scheduled for deletion. Contact support within 30 days to restore it.");
  await startSession(req, res, user.id);
  ok(res, await accountView(user.id));
});

authRouter.post("/logout", async (req, res) => {
  if (req.sessionId) await prisma.session.update({ where: { id: req.sessionId }, data: { revokedAt: new Date() } });
  clearSessionCookie(res);
  ok(res, { loggedOut: true });
});

authRouter.get("/me", async (req, res) => {
  if (!req.user) throw unauthorized();
  ok(res, await accountView(req.user.id));
});

authRouter.post("/verify-email", authLimiter, async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(10).max(200) }), req.body);
  const userId = await consumeToken(token, "EMAIL_VERIFICATION");
  if (!userId) throw badRequest("This verification link is invalid or has expired. Request a new one from your account.");
  await prisma.user.updateMany({
    where: { id: userId, status: "PENDING_VERIFICATION" },
    data: { status: "ACTIVE" },
  });
  await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  ok(res, { verified: true });
});

authRouter.post("/resend-verification", requireAuth, sensitiveLimiter, async (req, res) => {
  if (req.user!.emailVerifiedAt) throw badRequest("Your email is already verified.");
  await sendVerificationEmail(req.user!.id, req.user!.email);
  ok(res, { sent: true });
});

authRouter.post("/forgot-password", authLimiter, async (req, res) => {
  const body = parse(z.object({ email }), req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (user && user.status !== "BANNED") await sendPasswordResetEmail(user.id, user.email);
  // Same response either way so the endpoint cannot be used to discover accounts.
  ok(res, { sent: true });
});

authRouter.post("/reset-password", authLimiter, async (req, res) => {
  const body = parse(z.object({ token: z.string().min(10).max(200), password }), req.body);
  const userId = await consumeToken(body.token, "PASSWORD_RESET");
  if (!userId) throw badRequest("This reset link is invalid or has expired. Request a new one.");
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(body.password) } });
  await revokeAllSessions(userId);
  ok(res, { reset: true });
});

authRouter.post("/change-password", requireAuth, sensitiveLimiter, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: password }), req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Your current password is incorrect.");
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
  await revokeAllSessions(user.id, req.sessionId);
  ok(res, { changed: true });
});
