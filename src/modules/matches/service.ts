import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { badRequest, notFound } from "../../lib/http.js";
import { promptText } from "../../lib/prompts.js";
import { cleanText } from "../chat/service.js";
import { isBlockedBetween, orderedPair } from "../../lib/safety.js";
import { notify } from "../../lib/notify.js";
import { closeConversationRoom, emitToUser } from "../../realtime/bus.js";
import { cancelLiveGamesForConversation } from "../chatgames/service.js";

/** Can `fromId` act on `toId` at all (like, pass, view)? */
async function assertActionable(fromId: string, toId: string) {
  if (fromId === toId) throw badRequest("You can't like your own profile.");
  const target = await prisma.user.findFirst({
    where: { id: toId, status: "ACTIVE", profile: { isPublished: true } },
    select: { id: true },
  });
  if (!target || (await isBlockedBetween(fromId, toId))) throw notFound("This profile is not available.");
}

/**
 * Records a like and creates a match only when the like is mutual.
 * A per-pair advisory lock serialises the two people's likes so a simultaneous
 * "like back" can never be missed, and unique constraints prevent duplicates.
 */
export interface LikeDetail {
  kind: "PROMPT" | "INTEREST" | "MEDIA";
  ref: string;
  comment?: string;
}

/** Resolves a profile detail to what both people will see: the prompt and answer, or the interest. */
export async function describeDetail(ownerId: string, kind: string | null, ref: string | null) {
  if (!kind || !ref) return null;
  if (kind === "PROMPT") {
    const p = await prisma.profilePrompt.findUnique({ where: { userId_promptKey: { userId: ownerId, promptKey: ref } } });
    return p && promptText(ref) ? { kind, ref, label: promptText(ref)!, quote: p.answer } : null;
  }
  if (kind === "MEDIA") {
    // Only an approved photo or video that is still on their profile.
    const m = /^[0-9a-f-]{36}$/i.test(ref) ? await prisma.profilePhoto.findFirst({ where: { id: ref, userId: ownerId, status: "APPROVED" } }) : null;
    return m ? { kind, ref, label: m.kind === "VIDEO" ? "Video" : "Photo", quote: m.caption ?? "", mediaKind: m.kind, mediaId: m.id } : null;
  }
  const ui = await prisma.userInterest.findFirst({ where: { userId: ownerId, interest: { slug: ref } }, include: { interest: true } });
  return ui ? { kind, ref, label: "Interest", quote: ui.interest.name } : null;
}

export async function likeUser(fromId: string, toId: string, detail?: LikeDetail) {
  await assertActionable(fromId, toId);
  // A detail must exist on the other person's profile right now; comments are only allowed with a detail.
  const context = detail ? await describeDetail(toId, detail.kind, detail.ref) : null;
  if (detail && !context) throw badRequest("That detail isn't on their profile any more.");
  const comment = detail?.comment ? cleanText(detail.comment) : undefined;
  if (comment && comment.length > 300) throw badRequest("Keep your note under 300 characters.");
  const [a, b] = orderedPair(fromId, toId);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${a}:${b}`}, 0))`;
    const existingLike = await tx.like.findUnique({ where: { fromUserId_toUserId: { fromUserId: fromId, toUserId: toId } } });
    if (!existingLike) {
      await tx.like.create({ data: { fromUserId: fromId, toUserId: toId, detailKind: detail?.kind, detailRef: detail?.ref, comment: comment || null } });
      await tx.pass.deleteMany({ where: { fromUserId: fromId, toUserId: toId } });
    }
    const reciprocal = await tx.like.findUnique({ where: { fromUserId_toUserId: { fromUserId: toId, toUserId: fromId } } });
    if (!reciprocal) return { matched: false, matchId: null, created: false, alreadyLiked: !!existingLike };

    const existingMatch = await tx.match.findUnique({ where: { userAId_userBId: { userAId: a, userBId: b } } });
    if (existingMatch) return { matched: existingMatch.status === "ACTIVE", matchId: existingMatch.id, created: false, alreadyLiked: !!existingLike };

    const match = await tx.match.create({
      data: {
        userAId: a,
        userBId: b,
        conversation: { create: { members: { create: [{ userId: a }, { userId: b }] } } },
      },
      include: { conversation: true },
    });
    // Notes left with likes become the conversation's first messages, quoting the detail they respond to.
    const notes = await tx.like.findMany({ where: { OR: [{ fromUserId: fromId, toUserId: toId }, { fromUserId: toId, toUserId: fromId }], comment: { not: null } }, orderBy: { createdAt: "asc" } });
    let last: Date | null = null;
    for (const n of notes) {
      const ctx = await describeDetail(n.toUserId, n.detailKind, n.detailRef);
      const m = await tx.message.create({ data: { conversationId: match.conversation!.id, senderId: n.fromUserId, body: n.comment!, metadata: ctx ? { detail: ctx } : undefined } });
      last = m.createdAt;
    }
    if (last) await tx.conversation.update({ where: { id: match.conversation!.id }, data: { lastMessageAt: last } });
    return { matched: true, matchId: match.id, conversationId: match.conversation!.id, created: true, alreadyLiked: false };
  });

  if (result.created) {
    const names = await prisma.profile.findMany({ where: { userId: { in: [fromId, toId] } }, select: { userId: true, displayName: true } });
    const nameOf = (id: string) => names.find((n) => n.userId === id)?.displayName ?? "Someone";
    for (const [me, other] of [[fromId, toId], [toId, fromId]]) {
      await notify(me, "MATCH", `You and ${nameOf(other)} liked each other`, "Say hello when you're ready — there's no rush.", {
        matchId: result.matchId,
        conversationId: result.conversationId,
      });
      emitToUser(me, "match:new", { matchId: result.matchId, conversationId: result.conversationId });
    }
  }
  return { matched: result.matched, matchId: result.matchId, alreadyLiked: result.alreadyLiked };
}

export async function passUser(fromId: string, toId: string) {
  await assertActionable(fromId, toId);
  try {
    await prisma.pass.create({ data: { fromUserId: fromId, toUserId: toId } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
  }
  return { passed: true };
}

/** Ends a match. The conversation becomes read-only and disappears from both lists. */
export async function endMatch(userId: string, matchId: string, status: "UNMATCHED" | "BLOCKED" = "UNMATCHED") {
  const match = await prisma.match.findFirst({
    where: { id: matchId, OR: [{ userAId: userId }, { userBId: userId }] },
    include: { conversation: true },
  });
  if (!match) throw notFound("Match not found.");
  if (match.status !== "ACTIVE") return match;
  const updated = await prisma.match.update({
    where: { id: match.id },
    data: { status, endedById: userId, endedAt: new Date() },
  });
  await prisma.gameSession.updateMany({ where: { matchId: match.id, status: "ACTIVE" }, data: { status: "ENDED", endedAt: new Date() } });
  if (match.conversation) await cancelLiveGamesForConversation(match.conversation.id, userId);
  if (match.conversation) closeConversationRoom(match.conversation.id);
  const otherId = match.userAId === userId ? match.userBId : match.userAId;
  for (const id of [userId, otherId]) emitToUser(id, "match:ended", { matchId: match.id, conversationId: match.conversation?.id });
  return updated;
}

/** The other person in an active match, or null. */
export async function activeMatchBetween(a: string, b: string) {
  const [x, y] = orderedPair(a, b);
  return prisma.match.findFirst({ where: { userAId: x, userBId: y, status: "ACTIVE" } });
}
