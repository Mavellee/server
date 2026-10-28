import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import { prisma } from "../src/db.js";
import { createSocketServer } from "../src/realtime/socket.js";
import { app, createUser, loginAs, match, ORIGIN, resetDb } from "./helpers.js";

beforeEach(resetDb);

describe("conversation authorisation (REST)", () => {
  it("lets members read and write, and hides the conversation from everyone else", async () => {
    const a = await createUser();
    const b = await createUser();
    const outsider = await loginAs(await createUser());
    const { sa, sb, conversationId } = await match(a, b);

    const sent = await sa.post(`/api/conversations/${conversationId}/messages`, { body: "Hello <b>there</b>", clientId: "client-1" });
    expect(sent.status).toBe(201);
    expect(sent.body.data.body).toBe("Hello <b>there</b>"); // stored as text; the UI renders it as text
    expect((await sb.get(`/api/conversations/${conversationId}/messages`)).body.data.items).toHaveLength(1);

    // Changing the id in the URL is not enough to read someone else's chat.
    expect((await outsider.get(`/api/conversations/${conversationId}/messages`)).status).toBe(404);
    expect((await outsider.post(`/api/conversations/${conversationId}/messages`, { body: "hi" })).status).toBe(404);
    expect((await outsider.get(`/api/conversations/${conversationId}`)).status).toBe(404);
  });

  it("persists messages, paginates older ones and tracks unread counts", async () => {
    const a = await createUser();
    const b = await createUser();
    const { sa, sb, conversationId } = await match(a, b);
    for (let i = 0; i < 35; i++) await prisma.message.create({ data: { conversationId, senderId: a.id, body: `m${i}`, createdAt: new Date(Date.now() - (35 - i) * 1000) } });

    const page1 = (await sb.get(`/api/conversations/${conversationId}/messages?limit=30`)).body.data;
    expect(page1.items).toHaveLength(30);
    expect(page1.items.at(-1).body).toBe("m34");
    expect(page1.hasMore).toBe(true);
    const page2 = (await sb.get(`/api/conversations/${conversationId}/messages?limit=30&before=${page1.nextBefore}`)).body.data;
    expect(page2.items.map((m: { body: string }) => m.body)).toEqual(["m0", "m1", "m2", "m3", "m4"]);

    const list = (await sb.get("/api/conversations")).body.data;
    expect(list[0].unread).toBe(35);
    await sb.post(`/api/conversations/${conversationId}/read`);
    expect((await sb.get("/api/conversations")).body.data[0].unread).toBe(0);
    expect((await sa.get("/api/conversations")).body.data[0].unread).toBe(0);
  });

  it("de-duplicates re-sent messages using the client id", async () => {
    const { sa, conversationId } = await match(await createUser(), await createUser());
    await sa.post(`/api/conversations/${conversationId}/messages`, { body: "once", clientId: "same-id-1" });
    await sa.post(`/api/conversations/${conversationId}/messages`, { body: "once", clientId: "same-id-1" });
    expect(await prisma.message.count()).toBe(1);
  });

  it("rejects empty and over-long messages", async () => {
    const { sa, conversationId } = await match(await createUser(), await createUser());
    expect((await sa.post(`/api/conversations/${conversationId}/messages`, { body: "   " })).status).toBe(400);
    expect((await sa.post(`/api/conversations/${conversationId}/messages`, { body: "x".repeat(2050) })).status).toBe(400);
  });

  it("closes the conversation after a block", async () => {
    const a = await createUser();
    const b = await createUser();
    const { sa, sb, conversationId } = await match(a, b);
    await sb.post("/api/safety/blocks", { userId: a.id });
    expect((await sa.post(`/api/conversations/${conversationId}/messages`, { body: "hi" })).status).toBe(404);
    expect((await sa.get("/api/conversations")).body.data).toHaveLength(0);
    expect((await sb.get("/api/matches")).body.data).toHaveLength(0);
  });
});

describe("real-time messaging (Socket.IO)", () => {
  let http: HttpServer;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    http = createServer(app);
    createSocketServer(http);
    await new Promise<void>((r) => http.listen(0, r));
    url = `http://localhost:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    sockets.forEach((s) => s.close());
    http.close();
  });

  const cookieOf = async (s: Awaited<ReturnType<typeof loginAs>>) => {
    const res = await s.get("/api/auth/me");
    return (res.request as unknown as { cookies: string }).cookies ?? "";
  };
  const connect = (cookie: string) =>
    new Promise<Socket>((resolve, reject) => {
      const s = ioClient(url, { extraHeaders: { cookie, origin: ORIGIN }, transports: ["websocket"], reconnection: false });
      sockets.push(s);
      s.on("connect", () => resolve(s));
      s.on("connect_error", (e) => reject(e));
    });
  const emit = <T = { ok: boolean; data?: unknown; error?: { code: string } }>(s: Socket, ev: string, payload: unknown) =>
    new Promise<T>((r) => s.emit(ev, payload, r));

  it("rejects unauthenticated connections", async () => {
    await expect(connect("knot_session=forged")).rejects.toThrow("UNAUTHENTICATED");
  });

  it("delivers messages and typing indicators only to members", async () => {
    const a = await createUser();
    const b = await createUser();
    const c = await createUser();
    const { sa, sb, conversationId } = await match(a, b);
    const sc = await loginAs(c);
    const [ka, kb, kc] = await Promise.all([cookieOf(sa), cookieOf(sb), cookieOf(sc)]);
    const [wa, wb, wc] = await Promise.all([connect(ka), connect(kb), connect(kc)]);

    expect((await emit(wa, "conversation:join", { conversationId })).ok).toBe(true);
    expect((await emit(wb, "conversation:join", { conversationId })).ok).toBe(true);
    const denied = await emit(wc, "conversation:join", { conversationId });
    expect(denied.ok).toBe(false);
    expect(denied.error!.code).toBe("NOT_FOUND");

    const typing = new Promise((r) => wb.once("typing", r));
    await emit(wa, "typing", { conversationId, isTyping: true });
    expect(await typing).toMatchObject({ conversationId, userId: a.id, isTyping: true });

    let outsiderGotIt = false;
    wc.on("message:new", () => (outsiderGotIt = true));
    const received = new Promise<{ body: string }>((r) => wb.once("message:new", r));
    const ack = await emit<{ ok: boolean; data: { id: string } }>(wa, "message:send", { conversationId, body: "Hi from a socket", clientId: "sock-1" });
    expect(ack.ok).toBe(true);
    expect((await received).body).toBe("Hi from a socket");
    expect(await prisma.message.findUnique({ where: { id: ack.data.id } })).not.toBeNull();
    expect(outsiderGotIt).toBe(false);

    const blocked = await emit(wc, "message:send", { conversationId, body: "sneaky" });
    expect(blocked.ok).toBe(false);
  });
});
