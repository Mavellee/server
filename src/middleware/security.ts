import type { NextFunction, Request, Response } from "express";
import rateLimit, { type Options } from "express-rate-limit";
import { config } from "../config.js";
import { ApiError } from "../lib/http.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests: state-changing requests must come
 * from our own origin. Combined with SameSite=Lax cookies.
 */
export function originCheck(req: Request, _res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  if (requestOrigin(req) !== config.appOrigin) throw new ApiError(403, "BAD_ORIGIN", "Request origin not allowed.");
  next();
}

/** Origin header, falling back to the Referer's origin; a malformed Referer counts as no origin. */
function requestOrigin(req: Request) {
  const origin = req.get("origin");
  if (origin) return origin;
  const referer = req.get("referer");
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

export const limiter = (opts: Partial<Options>) =>
  rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Tests exercise the limiters explicitly via the x-test-rate-limit header.
    skip: (req) => config.isTest && req.get("x-test-rate-limit") !== "on",
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "unknown",
    handler: (_req, _res, next) => next(new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.")),
    ...opts,
  });

// Per network: generous, so people sharing an office or campus connection don't lock each other out.
export const authLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 100, keyGenerator: (req) => req.ip ?? "unknown" });
// Per account and network: password guessing against one email stays slow.
export const accountLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: (req) => `${req.ip ?? "unknown"}|${String(req.body?.email ?? "").trim().toLowerCase().slice(0, 254)}`,
});
export const sensitiveLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 10 });
export const apiLimiter = limiter({ windowMs: 60 * 1000, limit: 300 });
export const messageLimiter = limiter({ windowMs: 60 * 1000, limit: 30 });
export const reportLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 20 });
// Photo/video uploads and replacements; checked before any file data is read.
export const uploadLimiter = limiter({ windowMs: 10 * 60 * 1000, limit: 30 });
