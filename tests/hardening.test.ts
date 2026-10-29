// QA sprint 2: sessions, blocking, message ordering and interrupted uploads.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import { prisma } from "../src/db.js";
import { config } from "../src/config.js";
import { createSocketServer } from "../src/realtime/socket.js";
import { app, createUser, loginAs, match, ORIGIN, PASSWORD, resetDb } from "./helpers.js";

let server: HttpServer;
let url: string;
const sockets: Socket[] = [];
beforeAll(async () => {
  server = createServer(app);
  createSocketServer(server);
  await new Promise<void>((r) => server.listen(0, r));
  url = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  sockets.forEach((s) => s.close());
  server.close();
});
beforeEach(resetDb);

type Session = Awaited<ReturnType<typeof loginAs>>;
const cookieOf = async (s: Session) => ((await s.get("/api/auth/me")).request as unknown as { cookies: string }).cookies ?? "";
const connect = (cookie: string) =>
  new Promise<Socket>((resolve, reject) => {
    const s = ioClient(url, { extraHeaders: { cookie, origin: ORIGIN }, transports: ["websocket"], reconnection: false });
    sockets.push(s);
    s.on("connect", () => resolve(s));
    s.on("connect_error", reject);
  });
const emit = <T = { ok: boolean; data?: { id: string }; error?: { code: string } }>(s: Socket, ev: string, payload: unknown) => new Promise<T>((r) => s.emit(ev, payload, r));

describe("sessions", () => {
  it("rejects an expired session on the API and on sockets", async () => {
    const u = await createUser();
    const s = await loginAs(u);
    const cookie = await cookieOf(s);
    await prisma.session.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await s.get("/api/profiles/me")).status).toBe(401);
    await expect(connect(cookie)).rejects.toThrow("UNAUTHENTICATED");
  });

  it("changing the password signs out other devices but keeps this one", async () => {
    const u = await createUser();
    const phone = await loginAs(u);
    const laptop = await loginAs(u);
    expect((await laptop.post("/api/auth/change-password", { currentPassword: PASSWORD, newPassword: "BrandNewPass42" })).status).toBe(200);
    expect((await phone.get("/api/profiles/me")).status).toBe(401);
    expect((await laptop.get("/api/profiles/me")).status).toBe(200);
  });
});

describe("after a block", () => {
  it("the blocked person can't like, view, message, play, or join the chat room — and their earlier like disappears", async () => {
    const a = await createUser({ name: "Asha" });
    const b = await createUser({ name: "Bilal" });
    const { sa, sb, conversationId } = await match(a, b);
    const game = (await sb.post(`/api/conversations/${conversationId}/games`, { gameSlug: "red-flag-green-flag" })).body.data;
    const photo = await prisma.profilePhoto.findFirstOrThrow({ where: { userId: a.id } });
    const wb = await connect(await cookieOf(sb));

    expect((await sa.post("/api/safety/blocks", { userId: b.id })).status).toBe(201);

    expect((await sb.post("/api/likes", { userId: a.id })).status).toBe(404);
    expect((await sb.get(`/api/profiles/${a.id}`)).status).toBe(404);
    expect((await sb.agent.get(`/api/photos/${photo.id}`)).status).toBe(404);
    expect((await sb.post(`/api/conversations/${conversationId}/messages`, { body: "still there?" })).status).toBe(404);
    expect((await sb.get(`/api/conversations/${conversationId}/games/${game.id}`)).status).toBe(404);
    expect((await emit(wb, "conversation:join", { conversationId })).ok).toBe(false);
    expect((await emit(wb, "message:send", { conversationId, body: "socket attempt" })).ok).toBe(false);
    expect((await sa.get("/api/likes/received")).body.data.some((l: { profile: { id: string } }) => l.profile.id === b.id)).toBe(false);
    expect(await prisma.message.count({ where: { conversationId, body: { in: ["still there?", "socket attempt"] } } })).toBe(0);
    // Reporting stays possible after a block.
    expect((await sb.post("/api/safety/reports", { userId: a.id, target: "PROFILE", reason: "OTHER", details: "Reporting after being blocked" })).status).toBe(201);
  });
});

describe("message ordering", () => {
  it("keeps one sender's rapid-fire messages in the order they were sent", async () => {
    const { sa, sb, conversationId } = await match(await createUser(), await createUser());
    const wa = await connect(await cookieOf(sa));
    await emit(wa, "conversation:join", { conversationId });
    // Fire without waiting for acknowledgements, as a fast typist on a good connection would.
    const acks = await Promise.all(Array.from({ length: 12 }, (_, i) => emit(wa, "message:send", { conversationId, body: `m${i}`, clientId: `order-${i}-${Date.now()}` })));
    expect(acks.every((a) => a.ok)).toBe(true);
    const items = (await sb.get(`/api/conversations/${conversationId}/messages?limit=30`)).body.data.items as { body: string }[];
    expect(items.map((m) => m.body)).toEqual(Array.from({ length: 12 }, (_, i) => `m${i}`));
  });

  it("gives every message a distinct, increasing time, so paging older messages never skips or repeats", async () => {
    const { sa, sb, conversationId } = await match(await createUser(), await createUser());
    const [wa, wb] = await Promise.all([connect(await cookieOf(sa)), connect(await cookieOf(sb))]);
    // Both people typing at once.
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => emit(wa, "message:send", { conversationId, body: `a${i}`, clientId: `pa-${i}-${Date.now()}` })),
      ...Array.from({ length: 15 }, (_, i) => emit(wb, "message:send", { conversationId, body: `b${i}`, clientId: `pb-${i}-${Date.now()}` })),
    ]);
    const rows = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } });
    expect(new Set(rows.map((r) => r.createdAt.getTime())).size).toBe(35);

    const page1 = (await sa.get(`/api/conversations/${conversationId}/messages?limit=30`)).body.data;
    const page2 = (await sa.get(`/api/conversations/${conversationId}/messages?limit=30&before=${page1.nextBefore}`)).body.data;
    const all = [...page2.items, ...page1.items].map((m: { body: string }) => m.body);
    expect(all).toHaveLength(35);
    expect(new Set(all).size).toBe(35);
    // Each person's own messages stay in their order, and both people see the same conversation.
    expect(all.filter((b: string) => b.startsWith("a"))).toEqual(Array.from({ length: 20 }, (_, i) => `a${i}`));
    expect(all.filter((b: string) => b.startsWith("b"))).toEqual(Array.from({ length: 15 }, (_, i) => `b${i}`));
    const asB = (await sb.get(`/api/conversations/${conversationId}/messages?limit=50`)).body.data.items.map((m: { body: string }) => m.body);
    expect(asB).toEqual(all);
  });
});

describe("interrupted uploads", () => {
  it("leaves no partial file behind when the connection drops mid-upload", async () => {
    const u = await createUser();
    await prisma.profilePhoto.deleteMany({ where: { userId: u.id } });
    const cookie = await cookieOf(await loginAs(u));
    const incoming = path.join(config.uploadDir, ".incoming");
    const boundary = "----knotqa";
    await new Promise<void>((resolve) => {
      const req = http.request(`${url}/api/profiles/me/videos`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(900 * 1024) } });
      req.on("error", () => resolve());
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n`);
      req.write(Buffer.alloc(300 * 1024));
      // Give the server time to start writing the file, then drop the connection.
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 300);
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(fs.existsSync(incoming) ? fs.readdirSync(incoming) : []).toEqual([]);
    expect(await prisma.profilePhoto.count({ where: { userId: u.id } })).toBe(0);
  });
});
