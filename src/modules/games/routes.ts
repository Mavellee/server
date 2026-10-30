import { Router, type Request } from "express";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { prisma } from "../../db.js";
import { badRequest, notFound, ok, parse } from "../../lib/http.js";
import { notify } from "../../lib/notify.js";
import { requireActive } from "../../middleware/auth.js";
import { emitToUser } from "../../realtime/bus.js";
import { cleanText } from "../chat/service.js";
import { COUPLE_CATEGORIES } from "../chatgames/rules.js";
import { catalog } from "../chatgames/service.js";

export const gamesRouter = Router();
gamesRouter.use(requireActive);

/** Catalogue for the in-chat launcher: players, duration and a preview of each deck. */
gamesRouter.get("/catalog", async (_req, res) => {
  ok(res, await catalog());
});

gamesRouter.get("/", async (_req, res) => {
  const games = await prisma.game.findMany({
    where: { isActive: true, category: { notIn: COUPLE_CATEGORIES } },
    include: { _count: { select: { questions: { where: { isActive: true } } } } },
    orderBy: { name: "asc" },
  });
  ok(res, games.map((g) => ({ slug: g.slug, name: g.name, description: g.description, category: g.category, questionCount: g._count.questions })));
});

function shuffle<T>(list: T[]) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const createSchema = z.object({
  gameSlug: z.string().max(60),
  matchId: z.string().uuid().optional(),
  questionCount: z.number().int().min(3).max(20).default(8),
});

gamesRouter.post("/sessions", async (req, res) => {
  const body = parse(createSchema, req.body);
  const me = req.user!.id;
  const game = await prisma.game.findFirst({ where: { slug: body.gameSlug, isActive: true, category: { notIn: COUPLE_CATEGORIES } }, include: { questions: { where: { isActive: true }, select: { id: true } } } });
  if (!game) throw notFound("Game not found.");
  if (!game.questions.length) throw badRequest("This game has no questions yet.");

  let partnerId: string | null = null;
  if (body.matchId) {
    throw badRequest("Games with a match are played inside your conversation. Open the chat and tap the games button.");
  }
  if (partnerId) {
    const match = await prisma.match.findFirst({ where: { id: body.matchId, status: "ACTIVE", OR: [{ userAId: me }, { userBId: me }] } });
    if (!match) throw notFound("Match not found.");
    partnerId = match.userAId === me ? match.userBId : match.userAId;
    const already = await prisma.gameSession.findFirst({ where: { matchId: match.id, status: "ACTIVE" } });
    if (already) throw badRequest("You already have a game in progress with this match. Finish or end it first.");
  }

  const questionIds = shuffle(game.questions.map((q) => q.id)).slice(0, body.questionCount);
  const session = await prisma.gameSession.create({
    data: { gameId: game.id, hostId: me, partnerId, matchId: body.matchId, questionIds, turnUserId: me },
  });
  if (partnerId) {
    const host = await prisma.profile.findUnique({ where: { userId: me }, select: { displayName: true } });
    await notify(partnerId, "GAME_INVITE", `${host?.displayName ?? "Your match"} started a game of ${game.name}`, "Join whenever you like — it's optional.", { sessionId: session.id });
  }
  ok(res, await sessionView(session.id, me), 201);
});

gamesRouter.get("/sessions", async (req, res) => {
  const me = req.user!.id;
  const sessions = await prisma.gameSession.findMany({
    where: { status: "ACTIVE", OR: [{ hostId: me }, { partnerId: me }] },
    include: { game: true, host: { select: { profile: { select: { displayName: true } } } }, partner: { select: { profile: { select: { displayName: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  ok(
    res,
    sessions.map((s) => ({
      id: s.id,
      game: { slug: s.game.slug, name: s.game.name, category: s.game.category },
      progress: { current: Math.min(s.currentIndex + 1, s.questionIds.length), total: s.questionIds.length },
      withName: s.hostId === me ? (s.partner?.profile?.displayName ?? null) : (s.host.profile?.displayName ?? null),
      isShared: !!s.partnerId,
      createdAt: s.createdAt,
    })),
  );
});

/** Only the two players can see a session, and a shared session closes if the match ends. */
async function loadSession(id: string, me: string) {
  const s = await prisma.gameSession.findFirst({
    where: { id, OR: [{ hostId: me }, { partnerId: me }] },
    include: { game: true, match: true },
  });
  if (!s) throw notFound("Game not found.");
  if (s.match && s.match.status !== "ACTIVE") throw notFound("Game not found.");
  return s;
}

async function sessionView(id: string, me: string) {
  const s = await loadSession(id, me);
  const total = s.questionIds.length;
  const done = s.status !== "ACTIVE" || s.currentIndex >= total;
  const questionId = done ? null : s.questionIds[s.currentIndex];
  const question = questionId ? await prisma.gameQuestion.findUnique({ where: { id: questionId } }) : null;
  const answers = questionId ? await prisma.gameAnswer.findMany({ where: { sessionId: s.id, questionId } }) : [];
  const mine = answers.find((a) => a.userId === me);
  const otherId = s.hostId === me ? s.partnerId : s.hostId;
  const theirs = otherId ? answers.find((a) => a.userId === otherId) : undefined;
  const names = await prisma.profile.findMany({ where: { userId: { in: [s.hostId, s.partnerId].filter(Boolean) as string[] } }, select: { userId: true, displayName: true } });

  // Partner's answer is revealed only once you have answered (or skipped) too.
  const canReveal = !!mine;
  const history = await prisma.gameAnswer.findMany({
    where: { sessionId: s.id, questionId: { in: s.questionIds.slice(0, s.currentIndex) } },
    include: { question: { select: { prompt: true } } },
    orderBy: { createdAt: "asc" },
  });

  return {
    id: s.id,
    status: done && s.status === "ACTIVE" ? "COMPLETED" : s.status,
    game: { slug: s.game.slug, name: s.game.name, category: s.game.category, description: s.game.description },
    isShared: !!s.partnerId,
    players: names.map((n) => ({ userId: n.userId, displayName: n.displayName, isYou: n.userId === me })),
    turnUserId: s.turnUserId,
    progress: { index: Math.min(s.currentIndex, total), total },
    question: question ? { id: question.id, prompt: question.prompt, options: (question.options as string[] | null) ?? null } : null,
    myAnswer: mine ? { answer: mine.answer, skipped: mine.skipped } : null,
    partnerAnswered: !!theirs,
    partnerAnswer: theirs && canReveal ? { answer: theirs.answer, skipped: theirs.skipped } : null,
    recap: done
      ? history.map((h) => ({ prompt: h.question.prompt, userId: h.userId, answer: h.answer, skipped: h.skipped, isYou: h.userId === me }))
      : undefined,
  };
}

gamesRouter.get("/sessions/:id", async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  ok(res, await sessionView(id, req.user!.id));
});

function broadcast(s: { hostId: string; partnerId: string | null; id: string }) {
  for (const uid of [s.hostId, s.partnerId]) if (uid) emitToUser(uid, "game:update", { sessionId: s.id });
}

async function advance(sessionId: string) {
  const s = await prisma.gameSession.update({ where: { id: sessionId }, data: { currentIndex: { increment: 1 } } });
  if (s.currentIndex >= s.questionIds.length) {
    await prisma.gameSession.update({ where: { id: s.id }, data: { status: "COMPLETED", endedAt: new Date() } });
  }
  return s;
}

async function actOnCurrent(req: Request, input: { answer?: string; skip?: boolean }) {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const me = req.user!.id;
  const s = await loadSession(id, me);
  if (s.status !== "ACTIVE" || s.currentIndex >= s.questionIds.length) throw badRequest("This game has finished.");
  const questionId = s.questionIds[s.currentIndex];
  const question = await prisma.gameQuestion.findUniqueOrThrow({ where: { id: questionId } });

  let answer: string | null = null;
  if (!input.skip) {
    const options = question.options as string[] | null;
    answer = cleanText(input.answer ?? "");
    if (!answer) throw badRequest("Choose or write an answer, or skip this one.");
    if (options && !options.includes(answer)) throw badRequest("Choose one of the options.");
    if (answer.length > 500) throw badRequest("Keep answers under 500 characters.");
  }

  await prisma.gameAnswer.upsert({
    where: { sessionId_questionId_userId: { sessionId: s.id, questionId, userId: me } },
    create: { sessionId: s.id, questionId, userId: me, answer, skipped: !!input.skip },
    update: { answer, skipped: !!input.skip },
  });

  // Solo sessions move on immediately. Shared sessions hold on the card until a player taps
  // "next" (POST /next), so both can see the reveal.
  if (!s.partnerId) await advance(s.id);
  broadcast(s);
  return sessionView(s.id, me);
}

gamesRouter.post("/sessions/:id/answer", async (req, res) => {
  const body = parse(z.object({ answer: z.string().max(600) }), req.body);
  ok(res, await actOnCurrent(req, { answer: body.answer }));
});

gamesRouter.post("/sessions/:id/skip", async (req, res) => {
  ok(res, await actOnCurrent(req, { skip: true }));
});

/** Shared sessions: after both have answered (the reveal), either player moves to the next card. */
gamesRouter.post("/sessions/:id/next", async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const me = req.user!.id;
  const s = await loadSession(id, me);
  if (s.status !== "ACTIVE") throw badRequest("This game has finished.");
  if (!s.partnerId) throw badRequest("Solo games move on automatically.");
  const questionId = s.questionIds[s.currentIndex];
  const count = await prisma.gameAnswer.count({ where: { sessionId: s.id, questionId } });
  if (count < 2) throw badRequest("Wait for both players to answer or skip.");
  // Take turns: whoever did not lead this round leads the next one.
  const nextTurn = s.turnUserId === s.hostId ? s.partnerId : s.hostId;
  // Guard against both players pressing "next" at once.
  const { count: moved } = await prisma.gameSession.updateMany({
    where: { id: s.id, currentIndex: s.currentIndex, status: "ACTIVE" },
    data: { currentIndex: { increment: 1 }, turnUserId: nextTurn },
  });
  if (moved && s.currentIndex + 1 >= s.questionIds.length) {
    await prisma.gameSession.update({ where: { id: s.id }, data: { status: "COMPLETED", endedAt: new Date() } });
  }
  broadcast(s);
  ok(res, await sessionView(s.id, me));
});

gamesRouter.post("/sessions/:id/end", async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const me = req.user!.id;
  const s = await loadSession(id, me);
  if (s.status === "ACTIVE") await prisma.gameSession.update({ where: { id: s.id }, data: { status: "ENDED", endedAt: new Date() } });
  broadcast(s);
  ok(res, { ended: true });
});
