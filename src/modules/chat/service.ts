import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { ApiError, badRequest, notFound } from "../../lib/http.js";
import { isBlockedBetween } from "../../lib/safety.js";
import { notify } from "../../lib/notify.js";
import { emitToConversation, emitToUser } from "../../realtime/bus.js";

export const MAX_MESSAGE_LENGTH = 2000;

/**
 * The single authorisation check for every conversation action (REST and socket):
 * the caller must be a member AND the underlying match must still be active AND neither
 * person may have blocked the other. Returns 404 rather than 403 so ids cannot be probed.
 */
export async function assertMember(userId: string, conversationId: string) {
  const convo = await prisma.conversation.findFirst({
    where: { id: conversationId, members: { some: { userId } }, match: { status: "ACTIVE" } },
    include: { match: true, members: true },
  });
  if (!convo) throw notFound("Conversation not found.");
  const otherId = convo.match.userAId === userId ? convo.match.userBId : convo.match.userAId;
  if (await isBlockedBetween(userId, otherId)) throw notFound("Conversation not found.");
  return { convo, otherId };
}

/** Normalises user text: trims, removes control characters other than newlines/tabs. */
export function cleanText(text: string) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

export function serializeMessage(m: { id: string; conversationId: string; senderId: string | null; kind: string; body: string | null; attachmentKey: string | null; clientId: string | null; createdAt: Date; gameSessionId?: string | null; metadata?: unknown }) {
  return {
    gameSessionId: m.gameSessionId ?? null,
    metadata: (m.metadata as Record<string, unknown> | null) ?? null,
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    kind: m.kind,
    body: m.body,
    hasAttachment: !!m.attachmentKey,
    clientId: m.clientId,
    createdAt: m.createdAt,
  };
}

// Simple per-user sliding window so the socket path is limited like the REST path.
const recentSends = new Map<string, number[]>();
export function checkSendRate(userId: string, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const list = (recentSends.get(userId) ?? []).filter((t) => now - t < windowMs);
  if (list.length >= limit) throw new ApiError(429, "RATE_LIMITED", "You're sending messages very quickly. Take a breath and try again in a moment.");
  list.push(now);
  recentSends.set(userId, list);
}

export async function sendMessage(
  userId: string,
  conversationId: string,
  input: { body?: string; clientId?: string; attachmentKey?: string },
) {
  checkSendRate(userId);
  const { otherId } = await assertMember(userId, conversationId);
  const body = input.body ? cleanText(input.body) : undefined;
  if (!body && !input.attachmentKey) throw badRequest("Write a message first.");
  if (body && body.length > MAX_MESSAGE_LENGTH) throw badRequest(`Messages can be up to ${MAX_MESSAGE_LENGTH} characters.`);

  if (input.clientId) {
    const existing = await prisma.message.findFirst({ where: { conversationId, senderId: userId, clientId: input.clientId } });
    if (existing) return serializeMessage(existing);
  }

  let message;
  try {
    message = await prisma.$transaction(async (tx) => {
      const m = await tx.message.create({
        data: {
          conversationId,
          senderId: userId,
          kind: input.attachmentKey ? "IMAGE" : "TEXT",
          body: body || null,
          attachmentKey: input.attachmentKey,
          clientId: input.clientId,
        },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: m.createdAt } });
      await tx.conversationMember.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { lastReadAt: m.createdAt },
      });
      return m;
    });
  } catch (e) {
    // Same clientId re-sent after a reconnect: return the original instead of duplicating.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && input.clientId) {
      const existing = await prisma.message.findFirstOrThrow({ where: { conversationId, senderId: userId, clientId: input.clientId } });
      return serializeMessage(existing);
    }
    throw e;
  }

  const payload = serializeMessage(message);
  emitToConversation(conversationId, "message:new", payload);
  emitToUser(otherId, "conversation:updated", { conversationId });
  const sender = await prisma.profile.findUnique({ where: { userId }, select: { displayName: true } });
  // Notification text never includes the message content.
  await notify(otherId, "MESSAGE", `New message from ${sender?.displayName ?? "your match"}`, undefined, { conversationId });
  return payload;
}

export async function markRead(userId: string, conversationId: string) {
  await assertMember(userId, conversationId);
  const now = new Date();
  await prisma.conversationMember.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { lastReadAt: now },
  });
  const settings = await prisma.userSettings.findUnique({ where: { userId } });
  if (settings?.readReceipts !== false) emitToConversation(conversationId, "conversation:read", { conversationId, userId, at: now });
  await prisma.notification.updateMany({
    where: { userId, type: "MESSAGE", readAt: null, data: { path: ["conversationId"], equals: conversationId } },
    data: { readAt: now },
  });
  return { readAt: now };
}
