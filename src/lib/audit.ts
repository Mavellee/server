import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

/** Records a sensitive administrative or moderation action. The table is append-only. */
export async function audit(
  req: Request,
  action: string,
  target: { type: string; id: string },
  metadata: Prisma.InputJsonValue = {},
) {
  await prisma.adminAuditLog.create({
    data: {
      actorId: req.user?.id,
      actorRole: req.user?.role,
      action,
      targetType: target.type,
      targetId: target.id,
      metadata,
      ip: req.ip,
    },
  });
}
