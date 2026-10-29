import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { io as ioClient, type Socket } from "socket.io-client";
import { prisma } from "../src/db.js";
import { createSocketServer } from "../src/realtime/socket.js";
import { canTransition } from "../src/modules/chatgames/stateMachine.js";
import { app, createUser, loginAs, match, ORIGIN, resetDb } from "./helpers.js";

beforeEach(resetDb);

type Session = Awaited<ReturnType<typeof loginAs>>;
const base = (c: string) => `/api/conversations/${c}/games`;

/** Starts a game in a fresh match and has the partner join. */
async function started(slug: string, { join = true } = {}) {
  const a = await createUser({ name: "Asha" });
  const b = await createUser({ name: "Bilal" });
  const m = await match(a, b);
  const res = await m.sa.post(base(m.conversationId), { gameSlug: slug });
  expect(res.status).toBe(201);
  const id = res.body.data.id as string;
  if (join) expect((await m.sb.post(`${base(m.conversationId)}/${id}/join`)).status).toBe(200);
  const url = (p = "") => `${base(m.conversationId)}/${id}${p}`;
  return { ...m, a, b, id, url };
}

const view = async (s: Session, url: string) => (await s.get(url)).body.data;

describe("state machine", () => {
  it("allows only the documented transitions", () => {
    expect(canTransition("WAITING", "ACTIVE")).toBe(true);
    expect(canTransition("ACTIVE", "PAUSED")).toBe(true);
    expect(canTransition("PAUSED", "ACTIVE")).toBe(true);
    expect(canTransition("COMPLETED", "ACTIVE")).toBe(false);
    expect(canTransition("CANCELLED", "ACTIVE")).toBe(false);
    expect(canTransition("WAITING", "COMPLETED")).toBe(false);
  });
});

describe("starting and joining a game in a conversation", () => {
  it("creates a waiting session, a timeline card and an invitation; the partner joins to begin", async () => {
    const g = await started("red-flag-green-flag", { join: false });
    const before = await view(g.sa, g.url());
    expect(before.status).toBe("WAITING");
    expect(before.round).toBeNull();
    const card = await prisma.message.findFirstOrThrow({ where: { gameSessionId: g.id } });
    expect(card).toMatchObject({ kind: "GAME", senderId: g.a.id });
    expect(await prisma.notification.count({ where: { userId: g.b.id, type: "GAME_INVITE" } })).toBe(1);
    // The starter cannot "join" on the partner's behalf.
    expect((await g.sa.post(g.url("/join"))).status).toBe(409);

    const after = (await g.sb.post(g.url("/join"))).body.data;
    expect(after.status).toBe("ACTIVE");
    expect(after.round.index).toBe(0);
    expect(after.round.options).toEqual(["Green flag", "Yellow flag", "Red flag"]);
    // Joining again (e.g. after a refresh) is harmless.
    expect((await g.sb.post(g.url("/join"))).status).toBe(200);
  });

  it("rejects people outside the conversation and allows only one live game per conversation", async () => {
    const g = await started("deep-questions");
    const outsider = await loginAs(await createUser());
    expect((await outsider.post(base(g.conversationId), { gameSlug: "deep-questions" })).status).toBe(404);
    expect((await outsider.get(g.url())).status).toBe(404);
    expect((await outsider.post(g.url("/answer"), { roundIndex: 0, text: "hi" })).status).toBe(404);
    expect((await g.sb.post(base(g.conversationId), { gameSlug: "would-you-rather" })).status).toBe(409);
  });

  it("cannot reach a session through a different conversation id", async () => {
    const g = await started("deep-questions");
    const other = await match(g.a, await createUser());
    expect((await other.sa.get(`${base(other.conversationId)}/${g.id}`)).status).toBe(404);
  });
});

describe("private answers and reveal", () => {
  it("hides the partner's answer until both have answered, then shows both the same result", async () => {
    const g = await started("red-flag-green-flag");
    const afterA = (await g.sa.post(g.url("/answer"), { roundIndex: 0, choice: "Red flag" })).body.data;
    expect(afterA.round.status).toBe("OPEN");
    expect(afterA.round.you.answer.choice).toBe("Red flag");

    const bSees = await view(g.sb, g.url());
    expect(bSees.round.partner.answered).toBe(true);
    expect(bSees.round.partner.answer).toBeNull();
    expect(JSON.stringify(bSees)).not.toContain('"choice":"Red flag"');
    expect(JSON.stringify(await g.sb.get(base(g.conversationId)))).not.toContain('"choice":"Red flag"');

    const afterB = (await g.sb.post(g.url("/answer"), { roundIndex: 0, choice: "Red flag" })).body.data;
    expect(afterB.round.status).toBe("REVEALED");
    expect(afterB.round.partner.answer.choice).toBe("Red flag");
    expect(afterB.round.agreed).toBe(true);
    const aSees = await view(g.sa, g.url());
    expect(aSees.round.partner.answer.choice).toBe("Red flag");
    expect(aSees.summary.agreements).toBe(1);
  });

  it("validates answers and rejects duplicates and stale rounds", async () => {
    const g = await started("would-you-rather");
    const v = await view(g.sa, g.url());
    expect((await g.sa.post(g.url("/answer"), { roundIndex: 0, choice: "Not an option" })).status).toBe(400);
    expect((await g.sa.post(g.url("/answer"), { roundIndex: 0, choice: v.round.options[0] })).status).toBe(200);
    expect((await g.sa.post(g.url("/answer"), { roundIndex: 0, choice: v.round.options[1] })).status).toBe(409);
    expect((await g.sa.post(g.url("/answer"), { roundIndex: 3, choice: v.round.options[0] })).status).toBe(409);
    expect(await prisma.gameRoundAnswer.count()).toBe(1);
  });

  it("handles simultaneous submissions: exactly one reveal and no duplicate rows", async () => {
    const g = await started("deep-questions");
    const results = await Promise.all([
      g.sa.post(g.url("/answer"), { roundIndex: 0, text: "Outdoors" }),
      g.sb.post(g.url("/answer"), { roundIndex: 0, text: "Cooking" }),
      g.sa.post(g.url("/answer"), { roundIndex: 0, text: "Outdoors again" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 409]);
    const round = await prisma.gameRound.findFirstOrThrow({ where: { sessionId: g.id, index: 0 } });
    expect(round.status).toBe("REVEALED");
    expect(await prisma.gameRoundAnswer.count({ where: { roundId: round.id } })).toBe(2);
  });

  it("lets a player pass on a card without penalty, and either player skip the whole card", async () => {
    const g = await started("fun-challenges");
    await g.sa.post(g.url("/answer"), { roundIndex: 0, skip: true });
    const r0 = (await g.sb.post(g.url("/answer"), { roundIndex: 0, text: "Kind, curious, funny" })).body.data;
    expect(r0.round.status).toBe("REVEALED");
    expect(r0.round.partner.answer.skipped).toBe(true);
    await g.sa.post(g.url("/next"), { roundIndex: 0 });
    const skipped = (await g.sb.post(g.url("/skip"), { roundIndex: 1 })).body.data;
    expect(skipped.currentRound).toBe(2);
    expect(skipped.history.map((h: { status: string }) => h.status)).toEqual(["REVEALED", "SKIPPED"]);
  });
});

describe("rounds, notes and completion", () => {
  it("advances once even if both players press next, explains answers, and posts a summary card", async () => {
    const g = await started("red-flag-green-flag");
    const total = (await view(g.sa, g.url())).totalRounds;
    for (let i = 0; i < total; i++) {
      await g.sa.post(g.url("/answer"), { roundIndex: i, choice: "Green flag" });
      await g.sb.post(g.url("/answer"), { roundIndex: i, choice: i === 0 ? "Red flag" : "Green flag" });
      if (i === 0) {
        expect((await g.sa.post(g.url("/note"), { roundIndex: 0, note: "Remembering details is care." })).status).toBe(200);
        const bView = await view(g.sb, g.url());
        expect(bView.round.partner.answer.note).toBe("Remembering details is care.");
        expect(bView.round.agreed).toBe(false);
      }
      await Promise.all([g.sa.post(g.url("/next"), { roundIndex: i }), g.sb.post(g.url("/next"), { roundIndex: i })]);
    }
    const done = await view(g.sa, g.url());
    expect(done.status).toBe("COMPLETED");
    expect(await prisma.gameRound.count({ where: { sessionId: g.id } })).toBe(total);
    expect(done.summary).toMatchObject({ agreements: total - 1, comparableRounds: total });
    const summaryCard = await prisma.message.findFirstOrThrow({ where: { gameSessionId: g.id, senderId: null } });
    expect(summaryCard.metadata).toMatchObject({ event: "completed", agreements: total - 1 });
    // A completed game accepts nothing more.
    expect((await g.sa.post(g.url("/answer"), { roundIndex: total - 1, choice: "Green flag" })).status).toBe(409);
    expect((await g.sa.post(g.url("/resume"))).status).toBe(409);
  });

  it("does not let anyone advance before the reveal", async () => {
    const g = await started("deep-questions");
    await g.sa.post(g.url("/answer"), { roundIndex: 0, text: "When I'm outdoors" });
    expect((await g.sa.post(g.url("/next"), { roundIndex: 0 })).status).toBe(409);
  });
});

describe("How Well Do You Know Each Other", () => {
  it("alternates the subject, reveals after the guess and only the subject marks it", async () => {
    const g = await started("know-each-other");
    const r0 = await view(g.sa, g.url());
    expect(r0.round.subjectUserId).toBe(g.a.id);
    await g.sa.post(g.url("/answer"), { roundIndex: 0, text: "Rajma chawal" });
    expect((await view(g.sb, g.url())).round.partner.answer).toBeNull();
    await g.sb.post(g.url("/answer"), { roundIndex: 0, text: "Rajma chawal" });
    expect((await g.sb.post(g.url("/verdict"), { roundIndex: 0, correct: true })).status).toBe(403);
    const marked = (await g.sa.post(g.url("/verdict"), { roundIndex: 0, correct: true })).body.data;
    expect(marked.summary.correct[g.b.id]).toBe(1);
    expect((await g.sa.post(g.url("/verdict"), { roundIndex: 0, correct: false })).status).toBe(409);
    await g.sb.post(g.url("/next"), { roundIndex: 0 });
    expect((await view(g.sa, g.url())).round.subjectUserId).toBe(g.b.id);
  });
});

describe("pause, end and match changes", () => {
  it("pauses and resumes, and an ended game cannot restart", async () => {
    const g = await started("loyalty-boundaries");
    expect((await g.sb.post(g.url("/pause"))).body.data.status).toBe("PAUSED");
    const opt = (await view(g.sa, g.url())).round.options[0];
    expect((await g.sa.post(g.url("/answer"), { roundIndex: 0, choice: opt })).body.error.code).toBe("PAUSED");
    expect((await g.sa.post(g.url("/resume"))).body.data.status).toBe("ACTIVE");
    const ended = (await g.sa.post(g.url("/end"))).body.data;
    expect(ended).toMatchObject({ status: "CANCELLED", endedById: g.a.id });
    expect((await g.sb.post(g.url("/resume"))).status).toBe(409);
    expect((await g.sb.post(g.url("/join"))).status).toBe(200); // already joined: idempotent, no restart
    expect((await view(g.sb, g.url())).status).toBe("CANCELLED");
    // A new game can now be started in the same conversation.
    expect((await g.sb.post(base(g.conversationId), { gameSlug: "deep-questions" })).status).toBe(201);
  });

  it("lets the invited partner decline, and unmatching cancels live games", async () => {
    const g = await started("would-you-rather", { join: false });
    expect((await g.sb.post(g.url("/end"))).body.data.status).toBe("CANCELLED");
    const card = await prisma.message.findFirstOrThrow({ where: { gameSessionId: g.id, senderId: null } });
    expect(card.metadata).toMatchObject({ event: "declined" });

    const h = await started("deep-questions");
    await h.sa.delete(`/api/matches/${h.matchId}`);
    expect((await prisma.gameSession.findUniqueOrThrow({ where: { id: h.id } })).status).toBe("CANCELLED");
  });
});

describe("refresh restoration", () => {
  it("rebuilds the whole state, including your own pending answer, from the database", async () => {
    const g = await started("deep-questions");
    await g.sa.post(g.url("/answer"), { roundIndex: 0, text: "Mountains at dawn" });
    // A brand-new session (a "refreshed" browser) sees exactly the same state.
    const fresh = await loginAs(g.a);
    const list = (await fresh.get(base(g.conversationId))).body.data;
    expect(list[0]).toMatchObject({ id: g.id, status: "ACTIVE", currentRound: 0 });
    expect(list[0].round.you.answer.text).toBe("Mountains at dawn");
    expect(list[0].round.partner.answered).toBe(false);
  });
});

describe("real-time events", () => {
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
  const cookieOf = async (s: Session) => (((await s.get("/api/auth/me")).request as unknown as { cookies: string }).cookies ?? "");
  const connect = (cookie: string) =>
    new Promise<Socket>((resolve, reject) => {
      const s = ioClient(url, { extraHeaders: { cookie, origin: ORIGIN }, transports: ["websocket"], reconnection: false });
      sockets.push(s);
      s.on("connect", () => resolve(s));
      s.on("connect_error", reject);
    });

  it("notifies both players without leaking answers or reaching other conversations", async () => {
    const g = await started("deep-questions");
    const outsider = await loginAs(await createUser());
    const [wa, wb, wo] = await Promise.all([connect(await cookieOf(g.sa)), connect(await cookieOf(g.sb)), connect(await cookieOf(outsider))]);
    await new Promise((r) => wa.emit("conversation:join", { conversationId: g.conversationId }, r));
    const received: unknown[] = [];
    wb.on("game:updated", (p) => received.push(p));
    let leaked = false;
    wo.on("game:updated", () => (leaked = true));

    await g.sa.post(g.url("/answer"), { roundIndex: 0, text: "secret answer" });
    await new Promise((r) => setTimeout(r, 200));
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]).toMatchObject({ sessionId: g.id, conversationId: g.conversationId });
    expect(JSON.stringify(received)).not.toContain("secret answer");
    expect(leaked).toBe(false);
  });

  it("tells the partner when a player disconnects and reconnects; the session survives", async () => {
    const g = await started("deep-questions");
    const wb = await connect(await cookieOf(g.sb));
    const events: { userId: string; online: boolean }[] = [];
    wb.on("presence", (e) => events.push(e));
    const cookieA = await cookieOf(g.sa);
    const wa = await connect(cookieA);
    await new Promise((r) => setTimeout(r, 150));
    expect((await view(g.sb, g.url())).participants.find((p: { isYou: boolean }) => !p.isYou).online).toBe(true);
    wa.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(events).toContainEqual({ userId: g.a.id, online: false });
    expect((await view(g.sb, g.url())).participants.find((p: { isYou: boolean }) => !p.isYou).online).toBe(false);
    await connect(cookieA);
    await new Promise((r) => setTimeout(r, 150));
    expect(events.at(-1)).toEqual({ userId: g.a.id, online: true });
    expect((await view(g.sa, g.url())).status).toBe("ACTIVE");
  });
});
