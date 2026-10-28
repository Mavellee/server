import type { NotificationType, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { emitToUser } from "../realtime/bus.js";

export async function notify(
  userId: string,
  type: NotificationType,
  title: string,
  body?: string,
  data: Prisma.InputJsonValue = {},
) {
  const n = await prisma.notification.create({ data: { userId, type, title, body, data } });
  emitToUser(userId, "notification", { id: n.id, type, title, body, data, createdAt: n.createdAt });
  return n;
}
