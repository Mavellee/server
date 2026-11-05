import type { Prisma } from "@prisma/client";
import type { Request } from "express";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { sha256 } from "./crypto.js";

export type SecurityEventType =
  | "REGISTER"
  | "REGISTER_EXISTING_EMAIL"
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILED"
  | "LOGOUT"
  | "LOGOUT_ALL"
  | "SESSION_REVOKED"
  | "REFRESH_REUSE_DETECTED"
  | "LEGACY_SESSION_MIGRATED"
  | "EMAIL_VERIFIED"
  | "PASSWORD_RESET_REQUESTED"
  | "PASSWORD_RESET"
  | "PASSWORD_CHANGED"
  | "ACCOUNT_DELETION_REQUESTED";

/**
 * Records a security event. Never stores passwords, tokens or raw unknown email addresses (only their hash).
 * Logging must never break the request it describes, so failures are reported and swallowed.
 */
export async function securityEvent(
  type: SecurityEventType,
  req: Request | null,
  opts: { userId?: string | null; sessionId?: string | null; email?: string; metadata?: Prisma.InputJsonObject } = {},
) {
  try {
    await prisma.securityEvent.create({
      data: {
        type,
        userId: opts.userId ?? null,
        sessionId: opts.sessionId ?? null,
        emailHash: opts.email ? sha256(opts.email.trim().toLowerCase()) : null,
        ip: req?.ip ?? null,
        userAgent: req?.get("user-agent")?.slice(0, 255) ?? null,
        metadata: opts.metadata ?? {},
      },
    });
  } catch (err) {
    logger.error({ err, type }, "could not record security event");
  }
}
