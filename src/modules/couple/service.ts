import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { badRequest, conflict, notFound } from "../../lib/http.js";
import { notify } from "../../lib/notify.js";
import { closeCoupleRoom, emitToUser } from "../../realtime/bus.js";
import { COUPLE_CATEGORIES } from "../chatgames/rules.js";
import { cancelLiveGamesForConversation, catalog } from "../chatgames/service.js";
import { viewerFor } from "../discovery/service.js";
import { publicProfileInclude, toPublicProfile } from "../profiles/serialize.js";

const ASK_AGAIN_DAYS = 7;
const MAX_DOODLES = 60;
const MAX_STROKES = 400;

export interface Stroke {
  id: string;
  c: string; // colour
  s: number; // brush size
  e: boolean; // eraser
  p: number[]; // x,y pairs on a 0-1000 square
}

const mine = (userId: string) => ({ OR: [{ userAId: userId }, { userBId: userId }] });
const otherIn = (m: { userAId: string; userBId: string }, me: string) => (m.userAId === me ? m.userBId : m.userAId);
const nameOf = async (userId: string) => (await prisma.profile.findUnique({ where: { userId }, select: { displayName: true } }))?.displayName ?? "Your match";

async function activeMatch(userId: string, matchId: string) {
  const match = await prisma.match.findFirst({ where: { id: matchId, status: "ACTIVE", ...mine(userId) }, include: { relationship: true, conversation: { select: { id: true } } } });
  if (!match) throw notFound("Match not found.");
  return match;
}

/** Serialises anything that could put one person in two relationships. */
async function lockPeople(tx: Prisma.TransactionClient, ids: string[]) {
  for (const id of [...ids].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`couple:${id}`}, 0))`;
}
const togetherElsewhere = (tx: Prisma.TransactionClient, userId: string, matchId: string) =>
  tx.relationship.findFirst({ where: { status: "ACTIVE", matchId: { not: matchId }, match: { status: "ACTIVE", ...mine(userId) } }, select: { id: true } });

function announce(m: { id: string; userAId: string; userBId: string }) {
  for (const id of [m.userAId, m.userBId]) emitToUser(id, "couple:update", { matchId: m.id });
}

export async function stateFor(userId: string, matchId: string) {
  const { relationship: r } = await activeMatch(userId, matchId);
  if (r?.status === "ACTIVE") return { status: "ACTIVE" as const, startedAt: r.startedAt };
  if (r?.status === "PENDING") return { status: r.requestedById === userId ? ("REQUESTED_BY_ME" as const) : ("REQUESTED_BY_THEM" as const), startedAt: null };
  return { status: "NONE" as const, startedAt: null };
}

export async function request(userId: string, matchId: string) {
  const match = await activeMatch(userId, matchId);
  const otherId = otherIn(match, userId);
  const accepted = await prisma.$transaction(async (tx) => {
    await lockPeople(tx, [userId, otherId]);
    const r = await tx.relationship.findUnique({ where: { matchId } });
    if (r?.status === "ACTIVE") return false;
    if (r?.status === "PENDING") {
      if (r.requestedById === userId) return false;
      throw conflict("They've already asked you. Accept their request instead.");
    }
    if (await togetherElsewhere(tx, userId, matchId)) throw conflict("You're already together with someone on Knot. End that first.");
    // Same wording for both, so this never reveals the other person's status or that they said no.
    const unavailable = "This request can't be sent right now.";
    if (await togetherElsewhere(tx, otherId, matchId)) throw conflict(unavailable);
    if (r?.closedById === otherId && r.closedAt && r.closedAt.getTime() > Date.now() - ASK_AGAIN_DAYS * 86400000) throw conflict(unavailable);
    const waiting = await tx.relationship.findFirst({ where: { status: "PENDING", requestedById: userId, matchId: { not: matchId } }, select: { id: true } });
    if (waiting) throw conflict("You already have a request waiting. Cancel it before asking someone else.");
    const fresh = { status: "PENDING" as const, requestedById: userId, startedAt: null, closedById: null, closedAt: null };
    await tx.relationship.upsert({ where: { matchId }, create: { matchId, ...fresh }, update: fresh });
    return true;
  });
  if (accepted) {
    await notify(otherId, "MATCH", `${await nameOf(userId)} says you're together`, "Accept to open your couple space. It's your call, and your chat stays the same either way.", { matchId, conversationId: match.conversation?.id });
    announce(match);
  }
  return stateFor(userId, matchId);
}

export async function accept(userId: string, matchId: string) {
  const match = await activeMatch(userId, matchId);
  const otherId = otherIn(match, userId);
  await prisma.$transaction(async (tx) => {
    await lockPeople(tx, [userId, otherId]);
    const r = await tx.relationship.findUnique({ where: { matchId } });
    if (r?.status !== "PENDING" || r.requestedById === userId) throw conflict("There's no request to accept.");
    if (await togetherElsewhere(tx, userId, matchId)) throw conflict("You're already together with someone on Knot. End that first.");
    if (await togetherElsewhere(tx, otherId, matchId)) throw conflict("This request isn't available any more.");
    const now = new Date();
    await tx.relationship.update({ where: { matchId }, data: { status: "ACTIVE", startedAt: now } });
    // Any other open request involving either person is now moot.
    await tx.relationship.updateMany({
      where: { status: "PENDING", matchId: { not: matchId }, match: { OR: [...mine(userId).OR, ...mine(otherId).OR] } },
      data: { status: "DECLINED", closedById: userId, closedAt: now },
    });
  });
  await notify(otherId, "MATCH", `${await nameOf(userId)} accepted`, "Your couple space is open. You're both hidden from Discover while you're together.", { matchId, conversationId: match.conversation?.id });
  announce(match);
  return stateFor(userId, matchId);
}

/** Declining someone's request, or cancelling your own. */
export async function decline(userId: string, matchId: string) {
  const match = await activeMatch(userId, matchId);
  const { count } = await prisma.relationship.updateMany({ where: { matchId, status: "PENDING" }, data: { status: "DECLINED", closedById: userId, closedAt: new Date() } });
  if (count) announce(match);
  return stateFor(userId, matchId);
}

/** Closes the couple space for both. Either person can do this alone; both stay hidden until each chooses to return. */
async function close(userId: string, match: { id: string; userAId: string; userBId: string; conversation?: { id: string } | null }) {
  const r = await prisma.relationship.findUnique({ where: { matchId: match.id } });
  if (!r || (r.status !== "ACTIVE" && r.status !== "PENDING")) return false;
  const now = new Date();
  await prisma.relationship.update({ where: { matchId: match.id }, data: { status: r.status === "ACTIVE" ? "ENDED" : "DECLINED", closedById: userId, closedAt: now } });
  if (r.status === "ACTIVE") {
    await prisma.profile.updateMany({ where: { userId: { in: [match.userAId, match.userBId] }, discoveryPausedAt: null }, data: { discoveryPausedAt: now } });
    closeCoupleRoom(match.id);
    const conversationId = match.conversation?.id;
    if (conversationId && (await prisma.gameSession.count({ where: { conversationId, status: { in: ["WAITING", "ACTIVE", "PAUSED"] }, game: { category: { in: COUPLE_CATEGORIES } } } }))) await cancelLiveGamesForConversation(conversationId, userId);
  }
  announce(match);
  return r.status === "ACTIVE";
}

export async function end(userId: string, matchId: string) {
  const match = await activeMatch(userId, matchId);
  if (match.relationship?.status !== "ACTIVE") throw conflict("You're not together on Knot right now.");
  await close(userId, match);
  await notify(otherIn(match, userId), "MATCH", "Your couple space has closed", "You're hidden from Discover until you choose to come back. You can change that in Settings.", { matchId, conversationId: match.conversation?.id });
  return stateFor(userId, matchId);
}

/** Called when the match itself ends (unmatch, block, account deletion, moderation). */
export async function closeForEndedMatch(userId: string, match: { id: string; userAId: string; userBId: string; conversation?: { id: string } | null }) {
  await close(userId, match);
}

async function together(userId: string) {
  return prisma.relationship.findFirst({
    where: { status: "ACTIVE", match: { status: "ACTIVE", ...mine(userId) } },
    include: { match: { include: { conversation: { select: { id: true } } } } },
  });
}

/** The only gate to everything inside the couple space. */
export async function assertTogether(userId: string) {
  const r = await together(userId);
  if (!r) throw notFound("Your couple space isn't open.");
  return r;
}

export async function mySpace(userId: string) {
  const r = await together(userId);
  if (!r) return null;
  const partner = await prisma.user.findUniqueOrThrow({ where: { id: otherIn(r.match, userId) }, include: publicProfileInclude });
  return { matchId: r.matchId, conversationId: r.match.conversation?.id ?? null, startedAt: r.startedAt, partner: toPublicProfile(partner, await viewerFor(userId)), games: await catalog({ couple: true }) };
}

// ---------- doodles ----------

const doodleView = (d: { id: string; createdById: string; createdAt: Date; updatedAt: Date }) => ({ id: d.id, createdById: d.createdById, createdAt: d.createdAt, updatedAt: d.updatedAt });

export async function listDoodles(userId: string) {
  const r = await assertTogether(userId);
  const rows = await prisma.doodle.findMany({ where: { matchId: r.matchId }, orderBy: { updatedAt: "desc" }, select: { id: true, createdById: true, createdAt: true, updatedAt: true } });
  return rows.map(doodleView);
}

export async function getDoodle(userId: string, doodleId: string) {
  const r = await assertTogether(userId);
  const d = await prisma.doodle.findFirst({ where: { id: doodleId, matchId: r.matchId } });
  if (!d) throw notFound("Doodle not found.");
  return { ...doodleView(d), strokes: d.strokes as unknown as (Stroke & { by: string })[] };
}

function announceDoodles(match: { userAId: string; userBId: string }) {
  for (const id of [match.userAId, match.userBId]) emitToUser(id, "doodle:changed", {});
}

export async function createDoodle(userId: string) {
  const r = await assertTogether(userId);
  if ((await prisma.doodle.count({ where: { matchId: r.matchId } })) >= MAX_DOODLES) throw badRequest(`You've reached ${MAX_DOODLES} doodles. Delete one to start another.`);
  const d = await prisma.doodle.create({ data: { matchId: r.matchId, createdById: userId } });
  announceDoodles(r.match);
  return { ...doodleView(d), strokes: [] };
}

export async function deleteDoodle(userId: string, doodleId: string) {
  const r = await assertTogether(userId);
  const { count } = await prisma.doodle.deleteMany({ where: { id: doodleId, matchId: r.matchId } });
  if (!count) throw notFound("Doodle not found.");
  announceDoodles(r.match);
  return { deleted: true };
}

/** Appends atomically in SQL, so two people drawing at once can't overwrite each other. */
export async function addStroke(userId: string, doodleId: string, stroke: Stroke) {
  const r = await assertTogether(userId);
  const saved = { ...stroke, by: userId };
  const count = await prisma.$executeRaw`
    UPDATE "Doodle" SET "strokes" = "strokes" || ${JSON.stringify([saved])}::jsonb, "updatedAt" = NOW()
    WHERE "id" = ${doodleId}::uuid AND "matchId" = ${r.matchId}::uuid AND jsonb_array_length("strokes") < ${MAX_STROKES}`;
  if (!count) throw badRequest("This doodle is full. Start a new one.");
  return { matchId: r.matchId, stroke: saved };
}

/** Undoes only your own most recent stroke. */
export async function undoStroke(userId: string, doodleId: string) {
  const r = await assertTogether(userId);
  const strokeId = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ strokes: (Stroke & { by: string })[] }[]>`SELECT "strokes" FROM "Doodle" WHERE "id" = ${doodleId}::uuid AND "matchId" = ${r.matchId}::uuid FOR UPDATE`;
    if (!rows[0]) throw notFound("Doodle not found.");
    const strokes = rows[0].strokes;
    const at = strokes.map((s) => s.by).lastIndexOf(userId);
    if (at < 0) return null;
    const [removed] = strokes.splice(at, 1);
    await tx.doodle.update({ where: { id: doodleId }, data: { strokes: strokes as unknown as Prisma.InputJsonValue } });
    return removed.id;
  });
  return { matchId: r.matchId, strokeId };
}
