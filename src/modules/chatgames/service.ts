import { randomInt } from "node:crypto";
import { Prisma, type GameSessionStatus } from "@prisma/client";
import { prisma } from "../../db.js";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../../lib/http.js";
import { notify } from "../../lib/notify.js";
import { emitToConversation, emitToUser } from "../../realtime/bus.js";
import { isOnline } from "../../realtime/presence.js";
import { assertMember, cleanText, nextMessageTime, serializeMessage } from "../chat/service.js";
import { COUPLE_CATEGORIES, GAME_RULES, MAX_NOTE, MAX_TEXT, RULES_VERSION, type GameRules } from "./rules.js";
import { assertCanAnswer, assertRoundTransition, assertTransition, LIVE_STATUSES } from "./stateMachine.js";

type Tx = Prisma.TransactionClient;

const sessionInclude = {
  game: true,
  participants: { include: { user: { select: { profile: { select: { displayName: true } } } } }, orderBy: { createdAt: "asc" } },
  rounds: { include: { question: true, answers: true }, orderBy: { index: "asc" } },
} satisfies Prisma.GameSessionInclude;
type FullSession = Prisma.GameSessionGetPayload<{ include: typeof sessionInclude }>;

const rulesOf = (s: { game: { category: keyof typeof GAME_RULES } }): GameRules => GAME_RULES[s.game.category];

// ---------- serialisation (per viewer; the only place answers leave the server) ----------

function summarise(s: FullSession) {
  const rules = rulesOf(s);
  const revealed = s.rounds.filter((r) => r.status === "REVEALED");
  const agreements = rules.agreement
    ? revealed.filter((r) => r.answers.length === 2 && r.answers.every((a) => !a.skipped && a.choice) && r.answers[0].choice === r.answers[1].choice).length
    : null;
  const correct: Record<string, number> = {};
  if (rules.mode === "guess") {
    for (const p of s.participants) correct[p.userId] = 0;
    for (const r of revealed) for (const a of r.answers) if (a.userId !== r.subjectUserId && a.correct) correct[a.userId] = (correct[a.userId] ?? 0) + 1;
  }
  return {
    revealedRounds: revealed.length,
    skippedRounds: s.rounds.filter((r) => r.status === "SKIPPED").length,
    comparableRounds: rules.agreement ? revealed.filter((r) => r.answers.every((a) => !a.skipped)).length : null,
    agreements,
    correct: rules.mode === "guess" ? correct : null,
  };
}

function roundView(r: FullSession["rounds"][number], viewerId: string, partnerId: string | undefined, rules: GameRules) {
  const mine = r.answers.find((a) => a.userId === viewerId);
  const theirs = partnerId ? r.answers.find((a) => a.userId === partnerId) : undefined;
  const revealed = r.status === "REVEALED";
  const answer = (a: typeof mine) => a && { choice: a.choice, text: a.text, skipped: a.skipped, note: a.note, correct: a.correct };
  return {
    index: r.index,
    status: r.status,
    prompt: r.question.prompt,
    theme: r.question.theme,
    // A neutral conversation starter, shown only once both answers are revealed.
    discussion: revealed ? r.question.discussion : null,
    options: rules.answer === "choice" ? ((r.question.options as string[] | null) ?? []) : null,
    subjectUserId: r.subjectUserId,
    you: { answered: !!mine, answer: answer(mine) ?? null },
    // The partner's answer is withheld until the round is revealed.
    partner: { answered: !!theirs, answer: revealed ? (answer(theirs) ?? null) : null },
    agreed: revealed && rules.agreement && mine && theirs && !mine.skipped && !theirs.skipped ? mine.choice === theirs.choice : null,
    revealedAt: r.revealedAt,
  };
}

export function toView(s: FullSession, viewerId: string) {
  const rules = rulesOf(s);
  const partner = s.participants.find((p) => p.userId !== viewerId);
  const current = s.rounds.find((r) => r.index === s.currentIndex) ?? null;
  return {
    id: s.id,
    conversationId: s.conversationId,
    game: { slug: s.game.slug, name: s.game.name, category: s.game.category, description: s.game.description },
    rules: { mode: rules.mode, answer: rules.answer, agreement: rules.agreement, notes: rules.notes, rulesVersion: s.rulesVersion },
    status: s.status as GameSessionStatus,
    version: s.version,
    totalRounds: (s.config as { rounds?: number }).rounds ?? s.questionIds.length,
    currentRound: s.currentIndex,
    startedById: s.hostId,
    endedById: s.endedById,
    participants: s.participants.map((p) => ({
      userId: p.userId,
      displayName: p.user.profile?.displayName ?? "Member",
      isYou: p.userId === viewerId,
      joined: !!p.joinedAt,
      online: isOnline(p.userId),
    })),
    round: current ? roundView(current, viewerId, partner?.userId, rules) : null,
    // Finished rounds are visible to both players; open rounds never appear here.
    history: s.rounds.filter((r) => r.status !== "OPEN").map((r) => roundView(r, viewerId, partner?.userId, rules)),
    summary: summarise(s),
    createdAt: s.createdAt,
    startedAt: s.startedAt,
    pausedAt: s.pausedAt,
    endedAt: s.endedAt,
  };
}
export type GameView = ReturnType<typeof toView>;

// ---------- access ----------

/** Conversation membership (active match, not blocked) AND session participation are both required. */
async function authorise(userId: string, conversationId: string, sessionId: string) {
  await assertMember(userId, conversationId);
  const participant = await prisma.gameParticipant.findFirst({ where: { sessionId, userId, session: { conversationId } } });
  if (!participant) throw notFound("Game not found.");
}

const load = (tx: Tx | typeof prisma, sessionId: string) => tx.gameSession.findUniqueOrThrow({ where: { id: sessionId }, include: sessionInclude });

/** Serialises every mutation of one session (concurrent answers, double "next" taps). */
async function locked<T>(sessionId: string, fn: (tx: Tx) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`game:${sessionId}`}, 0))`;
    return fn(tx);
  });
}

function announce(s: { id: string; conversationId: string | null; version: number }, participantIds: string[]) {
  // Only a "something changed" signal is broadcast; each client fetches its own private view.
  const payload = { conversationId: s.conversationId, sessionId: s.id, version: s.version };
  if (s.conversationId) emitToConversation(s.conversationId, "game:updated", payload);
  for (const id of participantIds) emitToUser(id, "game:updated", payload);
}

async function postTimelineCard(tx: Tx, s: { id: string; conversationId: string | null }, senderId: string | null, metadata: Prisma.InputJsonValue) {
  const createdAt = await nextMessageTime(tx, s.conversationId!);
  const m = await tx.message.create({ data: { createdAt, conversationId: s.conversationId!, senderId, kind: "GAME", gameSessionId: s.id, metadata } });
  await tx.conversation.update({ where: { id: s.conversationId! }, data: { lastMessageAt: m.createdAt } });
  return m;
}

function shuffle<T>(list: T[]) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Random questions, spread across as many different themes as possible (one per theme before any repeats). */
export function pickQuestions(questions: { id: string; theme?: string | null }[], n: number) {
  const byTheme = new Map<string, string[]>();
  for (const q of shuffle(questions)) byTheme.set(q.theme ?? "", [...(byTheme.get(q.theme ?? "") ?? []), q.id]);
  const groups = shuffle([...byTheme.values()]);
  const picked: string[] = [];
  while (picked.length < n && groups.some((g) => g.length)) for (const g of groups) if (g.length && picked.length < n) picked.push(g.shift()!);
  return picked;
}

// ---------- queries ----------

export async function catalog({ couple = false } = {}) {
  const games = await prisma.game.findMany({
    where: { isActive: true, category: couple ? { in: COUPLE_CATEGORIES } : { notIn: COUPLE_CATEGORIES } },
    include: { questions: { where: { isActive: true }, orderBy: { sortOrder: "asc" }, take: 1 }, _count: { select: { questions: { where: { isActive: true } } } } },
    orderBy: { name: "asc" },
  });
  // Red Flag or Green Flag is the featured in-chat game, so it leads the selector.
  games.sort((a, b) => Number(b.category === "RED_FLAG_GREEN_FLAG") - Number(a.category === "RED_FLAG_GREEN_FLAG"));
  return games.map((g) => {
    const r = GAME_RULES[g.category];
    const sample = g.questions[0];
    return {
      slug: g.slug,
      name: g.name,
      description: g.description,
      category: g.category,
      players: r.players,
      minutes: r.minutes,
      rounds: Math.min(r.rounds, g._count.questions),
      mode: r.mode,
      answer: r.answer,
      preview: sample ? { prompt: sample.prompt, options: r.answer === "choice" ? ((sample.options as string[] | null) ?? []) : null } : null,
    };
  });
}

async function togetherInConversation(conversationId: string) {
  return !!(await prisma.relationship.findFirst({ where: { status: "ACTIVE", match: { status: "ACTIVE", conversation: { id: conversationId } } }, select: { id: true } }));
}

export async function listForConversation(userId: string, conversationId: string) {
  await assertMember(userId, conversationId);
  const sessions = await prisma.gameSession.findMany({
    where: { conversationId, participants: { some: { userId } } },
    include: sessionInclude,
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  return sessions.map((s) => toView(s, userId));
}

export async function getView(userId: string, conversationId: string, sessionId: string) {
  await authorise(userId, conversationId, sessionId);
  return toView(await load(prisma, sessionId), userId);
}

// ---------- commands ----------

export async function startGame(userId: string, conversationId: string, gameSlug: string) {
  const { otherId } = await assertMember(userId, conversationId);
  const game = await prisma.game.findFirst({ where: { slug: gameSlug, isActive: true }, include: { questions: { where: { isActive: true }, select: { id: true, theme: true } } } });
  if (!game) throw notFound("Game not found.");
  // Same answer as an unknown game, so couple decks stay invisible to everyone else.
  if (COUPLE_CATEGORIES.includes(game.category) && !(await togetherInConversation(conversationId))) throw notFound("Game not found.");
  const rules = GAME_RULES[game.category];
  if (game.questions.length < 1) throw badRequest("This game has no questions yet.");
  const rounds = Math.min(rules.rounds, game.questions.length);
  const live = await prisma.gameSession.count({ where: { conversationId, status: { in: LIVE_STATUSES } } });
  if (live) throw conflict("There's already a game in progress in this conversation. Finish or end it first.");

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const s = await tx.gameSession.create({
        data: {
          gameId: game.id,
          hostId: userId,
          partnerId: otherId,
          conversationId,
          status: "WAITING",
          rulesVersion: RULES_VERSION,
          config: { rounds, mode: rules.mode, answer: rules.answer },
          questionIds: pickQuestions(game.questions, rounds),
          participants: { create: [{ userId, joinedAt: new Date() }, { userId: otherId }] },
        },
      });
      const card = await postTimelineCard(tx, s, userId, { event: "started" });
      return { s, card };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("There's already a game in progress in this conversation. Finish or end it first.");
    throw e;
  }

  emitToConversation(conversationId, "message:new", serializeMessage(created.card));
  emitToUser(otherId, "conversation:updated", { conversationId });
  const name = (await prisma.profile.findUnique({ where: { userId }, select: { displayName: true } }))?.displayName ?? "Your match";
  await notify(otherId, "GAME_INVITE", `${name} started ${game.name}`, "Join from your conversation whenever you like — it's optional.", { conversationId, sessionId: created.s.id });
  announce(created.s, [userId, otherId]);
  return getView(userId, conversationId, created.s.id);
}

type Action = (tx: Tx, s: FullSession, userId: string) => Promise<void | { timeline?: Prisma.InputJsonValue }>;

/** Runs a validated command under the session lock, bumps the version and notifies both players. */
async function command(userId: string, conversationId: string, sessionId: string, action: Action) {
  await authorise(userId, conversationId, sessionId);
  const { session, card } = await locked(sessionId, async (tx) => {
    const s = await load(tx, sessionId);
    const result = await action(tx, s, userId);
    const bumped = await tx.gameSession.update({ where: { id: sessionId }, data: { version: { increment: 1 } } });
    const card = result && result.timeline ? await postTimelineCard(tx, s, null, result.timeline) : null;
    return { session: bumped, card };
  });
  if (card) emitToConversation(conversationId, "message:new", serializeMessage(card));
  const participants = await prisma.gameParticipant.findMany({ where: { sessionId }, select: { userId: true } });
  announce(session, participants.map((p) => p.userId));
  return getView(userId, conversationId, sessionId);
}

async function setStatus(tx: Tx, s: FullSession, to: GameSessionStatus, extra: Prisma.GameSessionUpdateInput = {}) {
  assertTransition(s.status, to);
  await tx.gameSession.update({ where: { id: s.id }, data: { status: to, ...extra } });
}

async function openRound(tx: Tx, s: FullSession, index: number) {
  const rules = rulesOf(s);
  // "Know each other": players take turns being the subject, starting with whoever started the game.
  const order = s.participants.map((p) => p.userId);
  const subjectUserId = rules.mode === "guess" ? order[index % order.length] : null;
  await tx.gameRound.create({ data: { sessionId: s.id, index, questionId: s.questionIds[index], subjectUserId } });
  await tx.gameSession.update({ where: { id: s.id }, data: { currentIndex: index } });
}

function finalSummary(s: FullSession, extra: Record<string, unknown>) {
  const sum = summarise(s);
  return { ...extra, game: s.game.name, revealedRounds: sum.revealedRounds, agreements: sum.agreements, comparableRounds: sum.comparableRounds, correct: sum.correct } as Prisma.InputJsonValue;
}

export const join = (userId: string, conversationId: string, sessionId: string) =>
  command(userId, conversationId, sessionId, async (tx, s) => {
    const me = s.participants.find((p) => p.userId === userId)!;
    if (s.status !== "WAITING") {
      if (me.joinedAt) return; // idempotent re-join after refresh
      throw new ApiError(409, "BAD_STATE", "This game has already finished.");
    }
    if (me.joinedAt) throw new ApiError(409, "WAITING_FOR_PARTNER", "Waiting for your match to join.");
    await tx.gameParticipant.update({ where: { id: me.id }, data: { joinedAt: new Date() } });
    await setStatus(tx, s, "ACTIVE", { startedAt: new Date() });
    await openRound(tx, s, 0);
  });

export const answer = (userId: string, conversationId: string, sessionId: string, input: { roundIndex: number; choice?: string; text?: string }) =>
  command(userId, conversationId, sessionId, async (tx, s) => {
    const rules = rulesOf(s);
    const round = s.rounds.find((r) => r.index === s.currentIndex) ?? null;
    if (input.roundIndex !== s.currentIndex) throw new ApiError(409, "STALE_ROUND", "That round has moved on. Refresh to see the current card.");
    assertCanAnswer(s.status, round);
    if (round!.answers.some((a) => a.userId === userId)) throw conflict("You've already answered this round.");
    const now = new Date();

    let choice: string | null = null;
    let text: string | null = null;
    if (rules.answer === "choice") {
      const options = (round!.question.options as string[] | null) ?? [];
      if (!input.choice || !options.includes(input.choice)) throw badRequest("Choose one of the options.");
      choice = input.choice;
    } else {
      text = cleanText(input.text ?? "");
      if (!text) throw badRequest("Write an answer, or skip this card.");
      if (text.length > MAX_TEXT) throw badRequest(`Answers can be up to ${MAX_TEXT} characters.`);
    }
    try {
      // One clock for submission and reveal times, so a reveal is never recorded before the answer that caused it.
      await tx.gameRoundAnswer.create({ data: { roundId: round!.id, userId, choice, text, createdAt: now } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("You've already answered this round.");
      throw e;
    }
    // Reveal only once every participant has responded.
    if (round!.answers.length + 1 >= s.participants.length) {
      assertRoundTransition(round!.status, "REVEALED");
      await tx.gameRound.update({ where: { id: round!.id }, data: { status: "REVEALED", revealedAt: now } });
    }
  });

/**
 * Skip rule (server-enforced, the same for every game): either player may skip the current card while it
 * is open. It is skipped for both of you, and any answer already given to it is never revealed.
 */
export const skipRound =(userId: string, conversationId: string, sessionId: string, roundIndex: number) =>
  command(userId, conversationId, sessionId, async (tx, s) => {
    if (roundIndex !== s.currentIndex) throw new ApiError(409, "STALE_ROUND", "That round has moved on.");
    const round = s.rounds.find((r) => r.index === s.currentIndex) ?? null;
    assertCanAnswer(s.status, round);
    assertRoundTransition(round!.status, "SKIPPED");
    await tx.gameRound.update({ where: { id: round!.id }, data: { status: "SKIPPED" } });
    return advance(tx, await load(tx, s.id));
  });

/** Moves to the next round or completes the game. Callers pass the round they saw, so double taps are harmless. */
async function advance(tx: Tx, s: FullSession) {
  const total = (s.config as { rounds?: number }).rounds ?? s.questionIds.length;
  if (s.currentIndex + 1 < total) {
    await openRound(tx, s, s.currentIndex + 1);
    return;
  }
  await setStatus(tx, s, "COMPLETED", { endedAt: new Date() });
  return { timeline: finalSummary(s, { event: "completed" }) };
}

export const next = (userId: string, conversationId: string, sessionId: string, roundIndex: number) =>
  command(userId, conversationId, sessionId, async (tx, s) => {
    if (roundIndex !== s.currentIndex || s.status === "COMPLETED") return; // already advanced by the other player
    if (s.status !== "ACTIVE") throw new ApiError(409, s.status === "PAUSED" ? "PAUSED" : "BAD_STATE", s.status === "PAUSED" ? "The game is paused." : "This game has finished.");
    const round = s.rounds.find((r) => r.index === s.currentIndex);
    if (!round || round.status === "OPEN") throw new ApiError(409, "NOT_REVEALED", "Wait until you've both answered.");
    return advance(tx, s);
  });

export const addNote = (userId: string, conversationId: string, sessionId: string, roundIndex: number, note: string) =>
  command(userId, conversationId, sessionId, async (tx, s) => {
    if (!rulesOf(s).notes) throw badRequest("This game doesn't use explanations.");
    const round = s.rounds.find((r) => r.index === roundIndex);
    if (!round || round.status !== "REVEALED") throw new ApiError(409, "NOT_REVEALED", "You can explain your answer after the reveal.");
    if (s.status === "CANCELLED") throw new ApiError(409, "BAD_STATE", "This game has ended.");
    const mine = round.answers.find((a) => a.userId === userId);
    if (!mine) throw notFound("Answer not found.");
    const clean = cleanText(note);
    if (!clean || clean.length > MAX_NOTE) throw badRequest(`Keep it between 1 and ${MAX_NOTE} characters.`);
    await tx.gameRoundAnswer.update({ where: { id: mine.id }, data: { note: clean } });
  });

export const verdict = (userId: string, conversationId: string, sessionId: string, roundIndex: number, correct: boolean) =>
  command(userId, conversationId, sessionId, async (tx, s) => {
    if (rulesOf(s).mode !== "guess") throw badRequest("This game doesn't use guesses.");
    const round = s.rounds.find((r) => r.index === roundIndex);
    if (!round || round.status !== "REVEALED") throw new ApiError(409, "NOT_REVEALED", "Wait for the reveal.");
    // Only the person the question was about can say whether the guess was right.
    if (round.subjectUserId !== userId) throw forbidden("Only the person this card was about can mark the guess.");
    const guess = round.answers.find((a) => a.userId !== userId);
    if (!guess || guess.skipped) throw badRequest("There's no guess to mark.");
    if (guess.correct !== null) throw conflict("You've already marked this guess.");
    await tx.gameRoundAnswer.update({ where: { id: guess.id }, data: { correct } });
  });

export const pause = (userId: string, conversationId: string, sessionId: string) =>
  command(userId, conversationId, sessionId, async (tx, s) => {
    if (s.status === "PAUSED") return;
    await setStatus(tx, s, "PAUSED", { pausedAt: new Date() });
  });

export const resume = (userId: string, conversationId: string, sessionId: string) =>
  command(userId, conversationId, sessionId, async (tx, s) => {
    if (s.status === "ACTIVE") return;
    await setStatus(tx, s, "ACTIVE", { pausedAt: null });
  });

/** Ends the game early (or declines an invitation). Ended games cannot be restarted. */
export const end = (userId: string, conversationId: string, sessionId: string) =>
  command(userId, conversationId, sessionId, async (tx, s) => {
    if (s.status === "CANCELLED") return;
    const declined = s.status === "WAITING" && userId !== s.hostId;
    await setStatus(tx, s, "CANCELLED", { endedAt: new Date(), endedById: userId });
    return { timeline: finalSummary(s, { event: declined ? "declined" : "cancelled", byUserId: userId }) };
  });

/** Called when a match ends: live games in that conversation are cancelled. */
export async function cancelLiveGamesForConversation(conversationId: string, byUserId: string) {
  await prisma.gameSession.updateMany({
    where: { conversationId, status: { in: LIVE_STATUSES } },
    data: { status: "CANCELLED", endedAt: new Date(), endedById: byUserId, version: { increment: 1 } },
  });
}
