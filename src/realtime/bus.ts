import type { Server } from "socket.io";

// Lets REST handlers push events without importing the socket server directly.
let io: Server | null = null;

export function setIo(server: Server | null) {
  io = server;
}

export const userRoom = (userId: string) => `user:${userId}`;
export const conversationRoom = (id: string) => `conversation:${id}`;

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(userRoom(userId)).emit(event, payload);
}

export function emitToConversation(conversationId: string, event: string, payload: unknown) {
  io?.to(conversationRoom(conversationId)).emit(event, payload);
}

export function getIo() {
  return io;
}

/** Removes every socket from a conversation room (after unmatch/block). */
export function closeConversationRoom(conversationId: string) {
  io?.in(conversationRoom(conversationId)).socketsLeave(conversationRoom(conversationId));
}

export const coupleRoom = (matchId: string) => `couple:${matchId}`;

/** Removes every socket from a couple's doodle room when their space closes. */
export function closeCoupleRoom(matchId: string) {
  io?.in(coupleRoom(matchId)).socketsLeave(coupleRoom(matchId));
}

export const sessionRoom = (sessionId: string) => `session:${sessionId}`;

/** Drops live sockets for revoked sessions so they stop receiving events immediately. */
export function disconnectSessions(sessionIds: string[]) {
  for (const id of sessionIds) io?.in(sessionRoom(id)).disconnectSockets(true);
}
