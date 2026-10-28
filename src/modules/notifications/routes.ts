import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { ok, parse } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get("/", async (req, res) => {
  const items = await prisma.notification.findMany({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const unread = await prisma.notification.count({ where: { userId: req.user!.id, readAt: null } });
  ok(res, { items, unread });
});

notificationsRouter.post("/read-all", async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user!.id, readAt: null }, data: { readAt: new Date() } });
  ok(res, { read: true });
});

notificationsRouter.post("/:id/read", async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  await prisma.notification.updateMany({ where: { id, userId: req.user!.id }, data: { readAt: new Date() } });
  ok(res, { read: true });
});
