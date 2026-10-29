// Acceptance tests for Red Flag or Green Flag played inside a conversation.
// Real HTTP + Socket.IO clients against the app, backed by the test database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import { prisma } from "../src/db.js";
import { createSocketServer } from "../src/realtime/socket.js";
import { pickQuestions } from "../src/modules/chatgames/service.js";
import { FLAG_OPTIONS, FLAG_SCENARIOS } from "../prisma/seed-data/redFlagScenarios.js";
import { app, createUser, loginAs, match, ORIGIN, resetDb } from "./helpers.js";

type Session = Awaited<ReturnType<typeof loginAs>>;
type Event = { event: string; payload: unknown };

const SLUG = "red-flag-green-flag";
const games = (c: string) => `/api/conversations/${c}/games`;

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
beforeEach(resetDb);

const cookieOf = async (s: Session) => ((await s.get("/api/auth/me")).request as unknown as { cookies: string }).cookies ?? "";

/** A logged-in socket that records every event it receives. */
async function connect(s: Session) {
  const socket = ioClient(url, { extraHeaders: { cookie: await cookieOf(s), origin: ORIGIN }, transports: ["websocket"], reconnection: false });
  sockets.push(socket);
  const events: Event[] = [];
  socket.onAny((event, payload) => events.push({ event, payload }));
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve());
    socket.on("connect_error", reject);
  });
  return { socket, events };
}
const emit = <T = { ok: boolean; error?: { code: string } }>(s: Socket, ev: string, payload: unknown) => new Promise<T>((r) => s.emit(ev, payload, r));
const waitFor = <T>(s: Socket, event: string, test: (p: T) => boolean = () => true, ms = 2000) =>
  new Promise<T | null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    const h = (p: T) => {
      if (!test(p)) return;
      clearTimeout(t);
      s.off(event, h);
      resolve(p);
    };
    s.on(event, h);
  });

/** A matched pair with both players connected and in the conversation room. */
async function pair() {
  const a = await createUser({ name: "Asha" });
  const b = await createUser({ name: "Bilal" });
  const m = await match(a, b);
  const [wa, wb] = await Promise.all([connect(m.sa), connect(m.sb)]);
  for (const w of [wa, wb]) expect((await emit(w.socket, "conversation:join", { conversationId: m.conversationId })).ok).toBe(true);
  return { ...m, a, b, wa, wb };
}

async function startAndJoin(p: Awaited<ReturnType<typeof pair>>) {
  const id = (await p.sa.post(games(p.conversationId), { gameSlug: SLUG })).body.data.id as string;
  await p.sb.post(`${games(p.conversationId)}/${id}/join`);
  return { id, at: (path = "") => `${games(p.conversationId)}/${id}${path}` };
}

const view = async (s: Session, path: string) => (await s.get(path)).body.data;

describe("acceptance: Red Flag or Green Flag in chat", () => {
  it("1. lets User A start the game from an authorised chat", async () => {
    const p = await pair();
    const res = await p.sa.post(games(p.conversationId), { gameSlug: SLUG });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: "WAITING", totalRounds: 5, game: { slug: SLUG, category: "RED_FLAG_GREEN_FLAG" } });
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: res.body.data.id }, include: { participants: true } });
    expect(session.conversationId).toBe(p.conversationId);
    expect(session.questionIds).toHaveLength(5);
    expect(session.participants.map((x) => x.userId).sort()).toEqual([p.a.id, p.b.id].sort());
  });

  it("2. shows User B the game card in real time, without refreshing", async () => {
    const p = await pair();
    const card = waitFor<{ kind: string; gameSessionId: string }>(p.wb.socket, "message:new", (m) => m.kind === "GAME");
    const signal = waitFor<{ sessionId: string }>(p.wb.socket, "game:updated");
    const id = (await p.sa.post(games(p.conversationId), { gameSlug: SLUG })).body.data.id;
    expect(await card).toMatchObject({ kind: "GAME", gameSessionId: id });
    expect(await signal).toMatchObject({ sessionId: id, conversationId: p.conversationId });
  });

  it("3. gives both users the same scenario with exactly three answers", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    const [va, vb] = await Promise.all([view(p.sa, g.at()), view(p.sb, g.at())]);
    expect(va.round.prompt).toBe(vb.round.prompt);
    expect(va.round.index).toBe(vb.round.index);
    expect(va.round.theme).toBe(vb.round.theme);
    expect(va.round.options).toEqual(["Red Flag", "Green Flag", "It Depends"]);
  });

  it("4. keeps User A's answer private — in API responses and socket payloads — until User B answers", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    p.wb.events.length = 0;
    const signal = waitFor(p.wb.socket, "game:updated");
    await p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag" });
    await signal;

    const vb = await view(p.sb, g.at());
    expect(vb.round).toMatchObject({ status: "OPEN", partner: { answered: true, answer: null }, discussion: null, agreed: null });
    const list = (await p.sb.get(games(p.conversationId))).body;
    for (const body of [vb, list, p.wb.events]) expect(JSON.stringify(body)).not.toContain('"choice":"Red Flag"');
    // Nothing that reached B's socket carries answer data at all.
    expect(JSON.stringify(p.wb.events)).not.toMatch(/"choice"|"answer"/);
  });

  it("5. reveals both answers together, with agreement and a neutral discussion prompt", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    await p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag" });
    const signal = waitFor(p.wa.socket, "game:updated");
    await p.sb.post(g.at("/answer"), { roundIndex: 0, choice: "It Depends" });
    await signal;
    const [va, vb] = await Promise.all([view(p.sa, g.at()), view(p.sb, g.at())]);
    expect(va.round).toMatchObject({ status: "REVEALED", you: { answer: { choice: "Red Flag" } }, partner: { answer: { choice: "It Depends" } }, agreed: false });
    expect(vb.round).toMatchObject({ status: "REVEALED", you: { answer: { choice: "It Depends" } }, partner: { answer: { choice: "Red Flag" } }, agreed: false });
    expect(va.round.discussion).toBeTruthy();
    expect(va.round.discussion).toBe(vb.round.discussion);
    const round = await prisma.gameRound.findFirstOrThrow({ where: { sessionId: g.id, index: 0 }, include: { answers: true } });
    expect(round.revealedAt).not.toBeNull();
    for (const a of round.answers) expect(a.createdAt.getTime()).toBeLessThanOrEqual(round.revealedAt!.getTime());
  });

  it("6. moves both users to the next round consistently, even if both press continue at once", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    await p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Green Flag" });
    await p.sb.post(g.at("/answer"), { roundIndex: 0, choice: "Green Flag" });
    const [na, nb] = await Promise.all([p.sa.post(g.at("/next"), { roundIndex: 0 }), p.sb.post(g.at("/next"), { roundIndex: 0 })]);
    expect([na.status, nb.status]).toEqual([200, 200]);
    const [va, vb] = await Promise.all([view(p.sa, g.at()), view(p.sb, g.at())]);
    expect(va.currentRound).toBe(1);
    expect(vb.currentRound).toBe(1);
    expect(va.round.prompt).toBe(vb.round.prompt);
    expect(va.version).toBe(vb.version);
    expect(await prisma.gameRound.count({ where: { sessionId: g.id } })).toBe(2);
  });

  it("7. restores the active session from PostgreSQL after either browser refreshes", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    await p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "It Depends" });
    // A "refresh": a brand-new client with no in-memory state, loading only from the API.
    const freshA = await loginAs(p.a);
    const list = (await freshA.get(games(p.conversationId))).body.data;
    const live = list.find((s: { status: string }) => s.status === "ACTIVE");
    expect(live.id).toBe(g.id);
    expect(live.round).toMatchObject({ index: 0, status: "OPEN", you: { answered: true, answer: { choice: "It Depends" } }, partner: { answered: false } });
    const freshB = await loginAs(p.b);
    expect((await view(freshB, g.at())).round).toMatchObject({ index: 0, you: { answered: false }, partner: { answered: true, answer: null } });
    // The game card is still in the persisted conversation timeline.
    const msgs = (await freshB.get(`/api/conversations/${p.conversationId}/messages`)).body.data.items;
    expect(msgs.some((m: { kind: string; gameSessionId: string }) => m.kind === "GAME" && m.gameSessionId === g.id)).toBe(true);
  });

  it("8. denies an unrelated account any access to the game or its answers", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    await p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag" });
    const outsider = await createUser({ name: "Chen" });
    const sc = await loginAs(outsider);
    const wc = await connect(sc);

    for (const res of [
      await sc.get(games(p.conversationId)),
      await sc.get(g.at()),
      await sc.post(g.at("/answer"), { roundIndex: 0, choice: "Green Flag" }),
      await sc.post(g.at("/skip"), { roundIndex: 0 }),
      await sc.post(g.at("/next"), { roundIndex: 0 }),
      await sc.post(g.at("/end")),
      await sc.post(games(p.conversationId), { gameSlug: SLUG }),
    ]) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain("Red Flag\"");
    }
    // Swapping in a conversation the outsider *does* belong to doesn't unlock someone else's game.
    const other = await match(outsider, await createUser());
    expect((await sc.get(`${games(other.conversationId)}/${g.id}`)).status).toBe(404);
    expect((await sc.post(`${games(other.conversationId)}/${g.id}/answer`, { roundIndex: 0, choice: "Green Flag" })).status).toBe(404);
    // Nor can a real participant reach the game through a different conversation of theirs.
    const asha2 = await match(p.a, await createUser());
    expect((await p.sa.get(`${games(asha2.conversationId)}/${g.id}`)).status).toBe(404);

    expect((await emit(wc.socket, "conversation:join", { conversationId: p.conversationId })).ok).toBe(false);
    await p.sb.post(g.at("/answer"), { roundIndex: 0, choice: "Green Flag" });
    await new Promise((r) => setTimeout(r, 200));
    expect(wc.events.filter((e) => e.event.startsWith("game") || e.event === "message:new")).toEqual([]);
    expect(await prisma.gameRoundAnswer.count({ where: { userId: outsider.id } })).toBe(0);
  });
});

describe("Red Flag or Green Flag: integrity", () => {
  it("rejects duplicate submissions and keeps exactly one answer per player", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    const results = await Promise.all([1, 2, 3].map(() => p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag" })));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Green Flag" })).status).toBe(409);
    expect(await prisma.gameRoundAnswer.count({ where: { userId: p.a.id } })).toBe(1);
  });

  it("handles simultaneous answers: one reveal, both answers stored", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    const [ra, rb] = await Promise.all([p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Green Flag" }), p.sb.post(g.at("/answer"), { roundIndex: 0, choice: "Green Flag" })]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const round = await prisma.gameRound.findFirstOrThrow({ where: { sessionId: g.id, index: 0 }, include: { answers: true } });
    expect(round.status).toBe("REVEALED");
    expect(round.answers).toHaveLength(2);
    expect((await view(p.sa, g.at())).round.agreed).toBe(true);
  });

  it("rejects invalid answers, client-supplied state, and actions while paused", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    expect((await p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Yellow flag" })).status).toBe(400);
    expect((await p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag", status: "COMPLETED", agreements: 5 })).status).toBe(422);
    expect((await p.sa.post(g.at("/answer"), { roundIndex: 3, choice: "Red Flag" })).status).toBe(409);
    expect((await p.sa.post(g.at("/next"), { roundIndex: 0 })).status).toBe(409); // not revealed yet
    expect((await p.sa.post(g.at("/pause"))).status).toBe(200);
    expect((await p.sb.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag" })).status).toBe(409);
    expect((await p.sb.post(g.at("/resume"))).status).toBe(200);
    expect((await p.sb.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag" })).status).toBe(200);
  });

  it("completes after five rounds with an agreement summary in the timeline, then accepts no more answers", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    for (let i = 0; i < 5; i++) {
      await p.sa.post(g.at("/answer"), { roundIndex: i, choice: "Green Flag" });
      await p.sb.post(g.at("/answer"), { roundIndex: i, choice: i < 3 ? "Green Flag" : "It Depends" });
      await p.sb.post(g.at("/next"), { roundIndex: i });
    }
    const done = await view(p.sa, g.at());
    expect(done).toMatchObject({ status: "COMPLETED", summary: { revealedRounds: 5, comparableRounds: 5, agreements: 3 } });
    expect(done.history).toHaveLength(5);
    expect(new Set(done.history.map((h: { theme: string }) => h.theme)).size).toBe(5); // five different themes
    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: g.id } });
    expect(session.startedAt).not.toBeNull();
    expect(session.endedAt).not.toBeNull();
    const summary = await prisma.message.findFirstOrThrow({ where: { gameSessionId: g.id, senderId: null } });
    expect(summary.metadata).toMatchObject({ event: "completed", agreements: 3, comparableRounds: 5 });
    expect((await p.sa.post(g.at("/answer"), { roundIndex: 4, choice: "Red Flag" })).status).toBe(409);
    expect((await p.sa.post(games(p.conversationId), { gameSlug: SLUG })).status).toBe(201); // a new game can start
  });

  it("recovers after a socket disconnect: missed changes are loaded on reconnect", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    p.wa.socket.disconnect();
    await p.sa.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag" });
    await p.sb.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag" });
    await p.sb.post(g.at("/next"), { roundIndex: 0 });
    const back = await connect(p.sa);
    expect((await emit(back.socket, "conversation:join", { conversationId: p.conversationId })).ok).toBe(true);
    const signal = waitFor<{ sessionId: string; version: number }>(back.socket, "game:updated");
    await p.sb.post(g.at("/pause"));
    const s = await signal;
    expect(s?.sessionId).toBe(g.id);
    const v = await view(p.sa, g.at());
    expect(v).toMatchObject({ status: "PAUSED", currentRound: 1, version: s!.version });
    expect(v.history[0]).toMatchObject({ status: "REVEALED", agreed: true });
  });

  it("cancels the game for both players when either ends it", async () => {
    const p = await pair();
    const g = await startAndJoin(p);
    const signal = waitFor(p.wb.socket, "game:updated");
    expect((await p.sa.post(g.at("/end"))).status).toBe(200);
    await signal;
    expect(await view(p.sb, g.at())).toMatchObject({ status: "CANCELLED", endedById: p.a.id });
    expect((await p.sb.post(g.at("/answer"), { roundIndex: 0, choice: "Red Flag" })).status).toBe(409);
  });
});

describe("scenario content", () => {
  it("covers all eight themes with a neutral discussion prompt and stable keys", () => {
    expect(new Set(FLAG_SCENARIOS.map((s) => s.theme))).toEqual(
      new Set(["Communication and honesty", "Boundaries with ex-partners", "Jealousy and trust", "Privacy and independence", "Effort and emotional availability", "Conflict resolution", "Long-distance relationships", "Commitment and expectations"]),
    );
    expect(new Set(FLAG_SCENARIOS.map((s) => s.key)).size).toBe(FLAG_SCENARIOS.length);
    expect(FLAG_OPTIONS).toEqual(["Red Flag", "Green Flag", "It Depends"]);
    for (const s of FLAG_SCENARIOS) {
      expect(s.discussion.length).toBeGreaterThan(10);
      // No prompt declares an answer to be the right one.
      expect(s.discussion).not.toMatch(/\b(correct|right answer|wrong|should)\b/i);
    }
  });

  it("spreads a game's rounds across different themes", () => {
    const qs = FLAG_SCENARIOS.map((s) => ({ id: s.key, theme: s.theme }));
    for (let i = 0; i < 20; i++) {
      const picked = pickQuestions(qs, 5);
      expect(new Set(picked)).toHaveProperty("size", 5);
      expect(new Set(picked.map((id) => qs.find((q) => q.id === id)!.theme)).size).toBe(5);
    }
  });
});
