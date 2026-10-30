import { Router, type Request } from "express";
import path from "node:path";
import { z } from "zod";
import { ApiError, ok, parse } from "../../lib/http.js";
import { requireActive } from "../../middleware/auth.js";
import { limiter, messageLimiter } from "../../middleware/security.js";
import { fileOf } from "../profiles/media.js";
import * as reviews from "./service.js";

export const friendReviewRouter = Router();

const id = (p: unknown) => parse(z.object({ id: z.string().uuid() }), p).id;
const tokenSchema = z.string().min(20).max(100);
// Per network, since the friend has no account. Tokens travel in bodies and headers so they never reach the access logs.
const sharedLimiter = limiter({ windowMs: 60 * 1000, limit: 60, keyGenerator: (req) => req.ip ?? "unknown" });

friendReviewRouter.post("/shared/open", sharedLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  ok(res, await reviews.sharedView(parse(z.object({ token: tokenSchema }), req.body).token));
});

friendReviewRouter.post("/shared/reply", sharedLimiter, async (req, res) => {
  const { token, ...input } = parse(z.object({ token: tokenSchema, friendName: z.string().min(1).max(40), verdict: z.enum(["GOOD_FEELING", "ASK_MORE", "NOT_SURE"]), comment: z.string().max(300).optional() }), req.body);
  ok(res, await reviews.reply(token, input));
});

const headerToken = (req: Request) => {
  const r = tokenSchema.safeParse(req.get("x-friend-token"));
  if (!r.success) throw new ApiError(404, "NOT_FOUND", "Not found.");
  return r.data;
};

friendReviewRouter.get("/shared/photos/:id", sharedLimiter, async (req, res) => {
  const photo = await reviews.sharedPhoto(headerToken(req), id(req.params));
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(photo.mimeType);
  res.sendFile(path.resolve(fileOf(photo.storageKey)));
});

friendReviewRouter.get("/matches/:id", requireActive, async (req, res) => ok(res, await reviews.listForMatch(req.user!.id, id(req.params))));
friendReviewRouter.post("/matches/:id", requireActive, messageLimiter, async (req, res) => ok(res, await reviews.request(req.user!.id, id(req.params)), 201));
for (const action of ["allow", "decline", "revoke"] as const) {
  friendReviewRouter.post(`/:id/${action}`, requireActive, messageLimiter, async (req, res) => ok(res, await reviews[action](req.user!.id, id(req.params))));
}
friendReviewRouter.post("/:id/link", requireActive, messageLimiter, async (req, res) => ok(res, await reviews.createLink(req.user!.id, id(req.params))));
