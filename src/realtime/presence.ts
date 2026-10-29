import { prisma } from "../db.js";
import { emitToUser } from "./bus.js";

// Connected-socket counts per user (single API instance; use the Socket.IO Redis adapter to scale out).
const sockets = new Map<string, number>();

export const isOnline = (userId: string) => (sockets.get(userId) ?? 0) > 0;

/** Tells a user's active matches when they come online or go offline. */
async function broadcast(userId: string, online: boolean) {
  const matches = await prisma.match.findMany({
    where: { status: "ACTIVE", OR: [{ userAId: userId }, { userBId: userId }] },
    select: { userAId: true, userBId: true },
  });
  for (const m of matches) emitToUser(m.userAId === userId ? m.userBId : m.userAId, "presence", { userId, online });
}

export function socketConnected(userId: string) {
  const n = (sockets.get(userId) ?? 0) + 1;
  sockets.set(userId, n);
  if (n === 1) void broadcast(userId, true).catch(() => {});
}

export function socketDisconnected(userId: string) {
  const n = Math.max(0, (sockets.get(userId) ?? 0) - 1);
  if (n === 0) sockets.delete(userId);
  else sockets.set(userId, n);
  if (n === 0) void broadcast(userId, false).catch(() => {});
}
