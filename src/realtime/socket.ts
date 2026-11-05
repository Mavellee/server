import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { ApiError } from "../lib/http.js";
import { userForAccessToken } from "../middleware/auth.js";
import { ACCESS_COOKIE } from "../modules/auth/sessions.js";
import { assertMember, markRead, sendMessage, MAX_MESSAGE_LENGTH } from "../modules/chat/service.js";
import { prisma } from "../db.js";
import { addStroke, assertTogether, undoStroke } from "../modules/couple/service.js";
import { conversationRoom, coupleRoom, sessionRoom, setIo, userRoom } from "./bus.js";
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

const brush = { c: z.string().regex(/^#[0-9a-fA-F]{6}$/), s: z.number().int().min(1).max(60), e: z.boolean() };
const coord = z.number().int().min(0).max(1000);
const strokeInput = z.object({ doodleId: z.string().uuid(), stroke: z.object({ id: z.string().min(6).max(40), ...brush, p: z.array(coord).min(2).max(800) }) });
const undoInput = z.object({ doodleId: z.string().uuid() });
const liveInput = z.object({ matchId: z.string().uuid(), doodleId: z.string().uuid(), strokeId: z.string().min(6).max(40), ...brush, p: z.array(coord).min(2).max(200) });
const MAX_LIVE_PER_SECOND = 40;
const MAX_EVENTS_PER_10S = 100;

export function createSocketServer(http: HttpServer) {
  const io = new Server(http, {
    path: "/socket.io",
    cors: { origin: config.appOrigin, credentials: true },
    serveClient: false,
    maxHttpBufferSize: 16 * 1024,
  });

  // Same access token as the REST API: the web's HttpOnly cookie, or `auth.token` from a native app.
  // Unauthenticated sockets are rejected; the client refreshes its token and reconnects.
  io.use(async (socket, next) => {
    const origin = socket.handshake.headers.origin;
    if (origin && origin !== config.appOrigin) return next(new Error("BAD_ORIGIN"));
    const mobileToken = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : undefined;
    const found = await (mobileToken ? userForAccessToken(mobileToken, "mavelle-mobile") : userForAccessToken(readCookie(socket.handshake.headers.cookie, ACCESS_COOKIE), "mavelle-web")).catch(() => null);
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

    // Every handled event counts toward a per-socket budget, on top of each action's own limits.
    let eventWindow = 0;
    let eventCount = 0;
    const handle =
      <T>(schema: z.ZodSchema<T>, fn: (input: T) => Promise<unknown>) =>
      async (raw: unknown, ack?: Ack) => {
        const now = Date.now();
        if (now - eventWindow > 10_000) {
          eventWindow = now;
          eventCount = 0;
        }
        if (++eventCount > MAX_EVENTS_PER_10S) return ack?.({ ok: false, error: { code: "RATE_LIMITED", message: "Slow down a little." } });
        try {
          // Re-check the session on every action so logout/ban takes effect immediately.
          const s = await prisma.session.findUnique({ where: { id: socket.data.sessionId }, include: { user: { select: { status: true } } } });
          if (!s || s.revokedAt || s.expiresAt < new Date() || (s.idleExpiresAt && s.idleExpiresAt < new Date()) || s.user.status !== "ACTIVE") {
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
      "couple:join",
      handle(z.object({}), async () => {
        const r = await assertTogether(userId);
        await socket.join(coupleRoom(r.matchId));
        return { matchId: r.matchId };
      }),
    );

    socket.on(
      "doodle:stroke",
      handle(strokeInput, async ({ doodleId, stroke }) => {
        const saved = await addStroke(userId, doodleId, stroke);
        socket.to(coupleRoom(saved.matchId)).emit("doodle:stroke", { doodleId, stroke: saved.stroke });
        return { saved: true };
      }),
    );

    socket.on(
      "doodle:undo",
      handle(undoInput, async ({ doodleId }) => {
        const { matchId, strokeId } = await undoStroke(userId, doodleId);
        if (strokeId) socket.to(coupleRoom(matchId)).emit("doodle:undo", { doodleId, strokeId });
        return { strokeId };
      }),
    );

    // Pen movement in progress: relayed, never stored. Room membership is the check, so no database hit per point.
    let liveWindow = 0;
    let liveCount = 0;
    socket.on("doodle:live", (raw: unknown) => {
      const now = Date.now();
      if (now - liveWindow > 1000) {
        liveWindow = now;
        liveCount = 0;
      }
      if (++liveCount > MAX_LIVE_PER_SECOND) return;
      const live = liveInput.safeParse(raw);
      if (!live.success || !socket.rooms.has(coupleRoom(live.data.matchId))) return;
      socket.to(coupleRoom(live.data.matchId)).volatile.emit("doodle:live", live.data);
    });

    socket.on(
      "conversation:read",
      handle(convoInput, ({ conversationId }) => markRead(userId, conversationId)),
    );
  });

  setIo(io);
  return io;
}
