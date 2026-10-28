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
  const origin = req.get("origin") ?? (req.get("referer") ? new URL(req.get("referer")!).origin : undefined);
  if (origin !== config.appOrigin) throw new ApiError(403, "BAD_ORIGIN", "Request origin not allowed.");
  next();
}

const limiter = (opts: Partial<Options>) =>
  rateLimit({
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Tests exercise the limiters explicitly via the x-test-rate-limit header.
    skip: (req) => config.isTest && req.get("x-test-rate-limit") !== "on",
    keyGenerator: (req) => req.user?.id ?? req.ip ?? "unknown",
    handler: (_req, _res, next) => next(new ApiError(429, "RATE_LIMITED", "Too many requests. Please wait a moment and try again.")),
    ...opts,
  });

export const authLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 20, keyGenerator: (req) => req.ip ?? "unknown" });
export const sensitiveLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 10 });
export const apiLimiter = limiter({ windowMs: 60 * 1000, limit: 300 });
export const messageLimiter = limiter({ windowMs: 60 * 1000, limit: 30 });
export const reportLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 20 });
