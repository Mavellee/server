import { prisma } from "../../db.js";
import { randomToken, sha256 } from "../../lib/crypto.js";
import { ageFrom } from "../../lib/age.js";
import { badRequest, conflict, notFound } from "../../lib/http.js";
import { notify } from "../../lib/notify.js";
import { promptText } from "../../lib/prompts.js";
import { emitToUser } from "../../realtime/bus.js";
import { cleanText } from "../chat/service.js";

const LINK_DAYS = 7;
const ASK_AGAIN_DAYS = 7;
const MAX_PER_MATCH = 5;
const GONE = "This link is no longer available.";

const nameOf = async (userId: string) => (await prisma.profile.findUnique({ where: { userId }, select: { displayName: true } }))?.displayName ?? "Your match";

async function activeMatch(userId: string, matchId: string) {
  const match = await prisma.match.findFirst({ where: { id: matchId, status: "ACTIVE", OR: [{ userAId: userId }, { userBId: userId }] } });
  if (!match) throw notFound("Match not found.");
  return { match, otherId: match.userAId === userId ? match.userBId : match.userAId };
}

function announce(r: { matchId: string; requesterId: string; subjectId: string }) {
  for (const id of [r.requesterId, r.subjectId]) emitToUser(id, "friend-review:update", { matchId: r.matchId });
}

/** What each side may see. The person being reviewed never gets the friend's name, verdict or comment. */
export async function listForMatch(userId: string, matchId: string) {
  await activeMatch(userId, matchId);
  const rows = await prisma.friendReview.findMany({ where: { matchId }, orderBy: { createdAt: "desc" } });
  const now = new Date();
  const linkLive = (r: (typeof rows)[number]) => r.status === "ALLOWED" && !!r.tokenHash && !!r.expiresAt && r.expiresAt > now;
  return {
    mine: rows
      .filter((r) => r.requesterId === userId && r.status !== "REVOKED")
      .map((r) => ({ id: r.id, status: r.status, linkLive: linkLive(r), expiresAt: r.expiresAt, friendName: r.friendName, verdict: r.verdict, comment: r.comment, createdAt: r.createdAt })),
    aboutMe: rows
      .filter((r) => r.subjectId === userId && ["PENDING", "ALLOWED", "REVIEWED"].includes(r.status))
      .map((r) => ({ id: r.id, status: r.status, linkLive: linkLive(r), expiresAt: r.expiresAt, createdAt: r.createdAt })),
  };
}

export async function request(userId: string, matchId: string) {
  const { otherId } = await activeMatch(userId, matchId);
  const mine = await prisma.friendReview.findMany({ where: { matchId, requesterId: userId }, orderBy: { createdAt: "desc" } });
  if (mine.some((r) => r.status === "PENDING" || r.status === "ALLOWED")) throw conflict("You already have an open request for this person.");
  const declined = mine.find((r) => r.status === "DECLINED");
  if (declined?.closedAt && declined.closedAt.getTime() > Date.now() - ASK_AGAIN_DAYS * 86400000) throw conflict(`They'd prefer not to right now. You can ask again after ${ASK_AGAIN_DAYS} days.`);
  if (mine.length >= MAX_PER_MATCH) throw conflict("You've reached the limit of friend reviews for this person.");
  const r = await prisma.friendReview.create({ data: { matchId, requesterId: userId, subjectId: otherId } });
  await notify(otherId, "MATCH", `${await nameOf(userId)} wants a friend's opinion`, "They'd like to show your profile to one trusted friend. Nothing is shared unless you agree.", { path: `/app/people/${userId}` });
  announce(r);
  return { id: r.id };
}

async function open(id: string, where: object) {
  const r = await prisma.friendReview.findFirst({ where: { id, ...where } });
  if (!r) throw notFound("Request not found.");
  await activeMatch(r.requesterId, r.matchId);
  return r;
}

export async function allow(userId: string, id: string) {
  const r = await open(id, { subjectId: userId, status: "PENDING" });
  await prisma.friendReview.update({ where: { id }, data: { status: "ALLOWED" } });
  await notify(r.requesterId, "MATCH", `${await nameOf(userId)} said yes`, "You can now create a private link for your friend.", { path: `/app/people/${userId}` });
  announce(r);
  return { allowed: true };
}

export async function decline(userId: string, id: string) {
  const r = await open(id, { subjectId: userId, status: "PENDING" });
  await prisma.friendReview.update({ where: { id }, data: { status: "DECLINED", closedById: userId, closedAt: new Date() } });
  announce(r);
  return { declined: true };
}

/** The raw token exists only in this response. Making a new link kills the previous one. */
export async function createLink(userId: string, id: string) {
  const r = await open(id, { requesterId: userId, status: "ALLOWED" });
  const token = randomToken();
  const expiresAt = new Date(Date.now() + LINK_DAYS * 86400000);
  await prisma.friendReview.update({ where: { id }, data: { tokenHash: sha256(token), expiresAt } });
  announce(r);
  return { token, expiresAt };
}

/** Either person can stop a share at any time. The asker can also use this to delete a friend's reply. */
export async function revoke(userId: string, id: string) {
  const r = await prisma.friendReview.findFirst({ where: { id, OR: [{ requesterId: userId }, { subjectId: userId, status: { in: ["PENDING", "ALLOWED"] } }] } });
  if (!r) throw notFound("Request not found.");
  await prisma.friendReview.update({ where: { id }, data: { status: "REVOKED", tokenHash: null, expiresAt: null, friendName: null, verdict: null, comment: null, closedById: userId, closedAt: new Date() } });
  announce(r);
  return { revoked: true };
}

/** When a match ends, links die and replies are erased. */
export async function closeForEndedMatch(matchId: string) {
  await prisma.friendReview.updateMany({ where: { matchId, status: { not: "REVOKED" } }, data: { status: "REVOKED", tokenHash: null, expiresAt: null, friendName: null, verdict: null, comment: null, closedAt: new Date() } });
}

// ---------- the friend's side: no account, the token is the only credential ----------

async function byToken(token: string) {
  const r = await prisma.friendReview.findFirst({
    where: { tokenHash: sha256(token), status: "ALLOWED", expiresAt: { gt: new Date() }, match: { status: "ACTIVE", userA: { status: "ACTIVE" }, userB: { status: "ACTIVE" } } },
  });
  if (!r) throw notFound(GONE);
  return r;
}

/** Deliberately narrow: no location, contact details, videos, compatibility data or chat. */
export async function sharedView(token: string) {
  const r = await byToken(token);
  const [u, requesterName] = await Promise.all([
    prisma.user.findUnique({
      where: { id: r.subjectId },
      select: {
        dateOfBirth: true,
        profile: { select: { displayName: true, bio: true, languages: true, isPublished: true } },
        photos: { where: { status: "APPROVED", kind: "IMAGE" }, orderBy: { position: "asc" }, select: { id: true, caption: true } },
        prompts: { orderBy: { position: "asc" }, select: { promptKey: true, answer: true } },
        interests: { select: { interest: { select: { name: true } } } },
      },
    }),
    nameOf(r.requesterId),
  ]);
  if (!u?.profile?.isPublished) throw notFound(GONE);
  return {
    requesterName,
    expiresAt: r.expiresAt,
    profile: {
      displayName: u.profile.displayName,
      age: u.dateOfBirth ? ageFrom(u.dateOfBirth) : null,
      bio: u.profile.bio,
      languages: u.profile.languages,
      photos: u.photos,
      prompts: u.prompts.filter((p) => promptText(p.promptKey)).map((p) => ({ text: promptText(p.promptKey)!, answer: p.answer })),
      interests: u.interests.map((i) => i.interest.name),
    },
  };
}

export async function sharedPhoto(token: string, photoId: string) {
  const r = await byToken(token);
  const photo = await prisma.profilePhoto.findFirst({ where: { id: photoId, userId: r.subjectId, status: "APPROVED", kind: "IMAGE" } });
  if (!photo) throw notFound();
  return photo;
}

/** One reply per link. The update is conditional, so two submissions can't both win. */
export async function reply(token: string, input: { friendName: string; verdict: "GOOD_FEELING" | "ASK_MORE" | "NOT_SURE"; comment?: string }) {
  const r = await byToken(token);
  const friendName = cleanText(input.friendName);
  if (!friendName) throw badRequest("Add your first name so they know who this is from.");
  const { count } = await prisma.friendReview.updateMany({
    where: { id: r.id, status: "ALLOWED", tokenHash: sha256(token) },
    data: { status: "REVIEWED", tokenHash: null, expiresAt: null, friendName, verdict: input.verdict, comment: input.comment ? cleanText(input.comment) || null : null },
  });
  if (!count) throw notFound(GONE);
  // Says only that a reply exists: the content stays inside the asker's account.
  await notify(r.requesterId, "MATCH", `${friendName} replied`, "See what your friend thinks. Only you can read this.", { path: `/app/people/${r.subjectId}` });
  announce(r);
  return { sent: true };
}
