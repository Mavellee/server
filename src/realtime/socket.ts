import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ApiError } from "../lib/http.js";
import { SESSION_COOKIE, userForToken } from "../middleware/auth.js";
import { assertMember, markRead, sendMessage, MAX_MESSAGE_LENGTH } from "../modules/chat/service.js";
import { prisma } from "../db.js";
import { conversationRoom, sessionRoom, setIo, userRoom } from "./bus.js";
import { socketConnected, socketDisconnected } from "./presence.js";

function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

type Ack = (res: { ok: true; data?: unknown } | { ok: false; error: { code: string; message: string } }) => void;

function toAckError(e: unknown) {
  if (e instanceof ApiError) return { code: e.code, message: e.message };
  if (e instanceof z.ZodError) return { code: "VALIDATION_FAILED", message: "Invalid input." };
  logger.error({ err: e }, "socket handler error");
  return { code: "INTERNAL", message: "Something went wrong." };
}

const convoInput = z.object({ conversationId: z.string().uuid() });
const sendInput = convoInput.extend({ body: z.string().min(1).max(MAX_MESSAGE_LENGTH + 100), clientId: z.string().min(6).max(64).optional() });
const typingInput = convoInput.extend({ isTyping: z.boolean() });

export function createSocketServer(http: HttpServer) {
  const io = new Server(http, {
    path: "/socket.io",
    cors: { origin: config.appOrigin, credentials: true },
    serveClient: false,
    maxHttpBufferSize: 16 * 1024,
  });

  // Same session cookie as the REST API; unauthenticated sockets are rejected.
  io.use(async (socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (origin && origin !== config.appOrigin) return next(new Error("BAD_ORIGIN"));
    const found = await userForToken(readCookie(socket.handshake.headers.cookie, SESSION_COOKIE)).catch(() => null);
    if (!found || found.user.status !== "ACTIVE") return next(new Error("UNAUTHENTICATED"));
    socket.data.userId = found.user.id;
    socket.data.sessionId = found.session.id;
    next();
  });

  io.on("connection", (socket) => {
    const userId: string = socket.data.userId;
    socket.join([userRoom(userId), sessionRoom(socket.data.sessionId)]);
    socketConnected(userId);
    socket.on("disconnect", () => socketDisconnected(userId));

    const handle =
      <T>(schema: z.ZodSchema<T>, fn: (input: T) => Promise<unknown>) =>
      async (raw: unknown, ack?: Ack) => {
        try {
          // Re-check the session on every action so logout/ban takes effect immediately.
          const s = await prisma.session.findUnique({ where: { id: socket.data.sessionId }, include: { user: { select: { status: true } } } });
          if (!s || s.revokedAt || s.expiresAt < new Date() || s.user.status !== "ACTIVE") {
            socket.disconnect(true);
            return;
          }
          const data = await fn(schema.parse(raw));
          ack?.({ ok: true, data });
        } catch (e) {
          ack?.({ ok: false, error: toAckError(e) });
        }
      };

    socket.on(
      "conversation:join",
      handle(convoInput, async ({ conversationId }) => {
        await assertMember(userId, conversationId);
        await socket.join(conversationRoom(conversationId));
        return { joined: conversationId };
      }),
    );

    socket.on(
      "conversation:leave",
      handle(convoInput, async ({ conversationId }) => {
        await socket.leave(conversationRoom(conversationId));
        return { left: conversationId };
      }),
    );

    // One device's messages are handled strictly in the order it sent them; otherwise a later message
    // can finish saving first and the conversation shows them out of order.
    const send = handle(sendInput, ({ conversationId, body, clientId }) => sendMessage(userId, conversationId, { body, clientId }));
    let sending: Promise<void> = Promise.resolve();
    socket.on("message:send", (raw: unknown, ack?: Ack) => {
      sending = sending.then(() => send(raw, ack));
    });

    socket.on(
      "typing",
      handle(typingInput, async ({ conversationId, isTyping }) => {
        await assertMember(userId, conversationId);
        const settings = await prisma.userSettings.findUnique({ where: { userId } });
        if (settings?.typingIndicators === false) return { sent: false };
        socket.to(conversationRoom(conversationId)).emit("typing", { conversationId, userId, isTyping });
        return { sent: true };
      }),
    );

    socket.on(
      "conversation:read",
      handle(convoInput, ({ conversationId }) => markRead(userId, conversationId)),
    );
  });

  setIo(io);
  return io;
}
