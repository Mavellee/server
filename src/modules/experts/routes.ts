import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { ApiError, badRequest, conflict, forbidden, notFound, ok, parse } from "../../lib/http.js";
import { notify } from "../../lib/notify.js";
import { ageFrom } from "../../lib/age.js";
import { requireActive } from "../../middleware/auth.js";
import { sensitiveLimiter } from "../../middleware/security.js";
import { writeExpertReview } from "../ai/service.js";
import { compatibilityFor } from "../compatibility/service.js";

export const expertsRouter = Router();
expertsRouter.use(requireActive);

const OPEN_STATUSES = ["PENDING", "IN_REVIEW", "INFO_REQUESTED"] as const;

/** Public, honest description of an expert. "Verified" only when an admin actually checked credentials. */
function publicExpert(e: Prisma.ExpertProfileGetPayload<{ include: { user: { select: { profile: { select: { displayName: true } } } } } }>) {
  return {
    userId: e.userId,
    displayName: e.user.profile?.displayName ?? "Mavelle expert",
    headline: e.headline,
    bio: e.bio,
    experienceYears: e.experienceYears,
    specialties: e.specialties,
    credentials: e.credentials,
    credentialsVerified: !!e.credentialsVerifiedAt,
  };
}

// ---------- Applying to be an expert ----------

const applicationSchema = z.object({
  headline: z.string().trim().min(5).max(80),
  bio: z.string().trim().min(40, "Tell us a little more (at least 40 characters).").max(1200),
  experienceYears: z.number().int().min(0).max(60),
  credentials: z.string().trim().max(500).optional(),
  specialties: z.array(z.string().trim().min(2).max(40)).min(1).max(6),
});

expertsRouter.post("/apply", sensitiveLimiter, async (req, res) => {
  const body = parse(applicationSchema, req.body);
  const userId = req.user!.id;
  const existing = await prisma.expertProfile.findUnique({ where: { userId } });
  if (existing && existing.status !== "REJECTED") throw conflict("You already have an expert application.");
  const app = await prisma.expertProfile.upsert({
    where: { userId },
    create: { userId, ...body },
    update: { ...body, status: "PENDING", decisionNote: null, decidedAt: null, decidedById: null },
  });
  ok(res, app, 201);
});

expertsRouter.get("/application", async (req, res) => {
  ok(res, await prisma.expertProfile.findUnique({ where: { userId: req.user!.id } }));
});

expertsRouter.get("/", async (_req, res) => {
  const experts = await prisma.expertProfile.findMany({
    where: { status: "APPROVED", user: { status: "ACTIVE" } },
    include: { user: { select: { profile: { select: { displayName: true } } } } },
    orderBy: { experienceYears: "desc" },
  });
  ok(res, experts.map(publicExpert));
});

// ---------- Members requesting a review ----------

const requestSchema = z.object({
  topic: z.string().trim().min(3).max(80),
  question: z.string().trim().min(10).max(1500),
  share: z.object({
    profile: z.boolean().default(false),
    intentions: z.boolean().default(false),
    compatibilityAnswers: z.boolean().default(false),
    // Optional: share the deterministic compatibility summary with one of your matches.
    matchId: z.string().uuid().optional(),
  }),
  consent: z.literal(true, { errorMap: () => ({ message: "Please confirm what you are sharing." }) }),
});

/** Builds a snapshot containing ONLY what the member ticked. Experts never see anything else. */
async function buildSharedData(userId: string, share: z.infer<typeof requestSchema>["share"]) {
  const data: Record<string, unknown> = {};
  const fields: string[] = [];
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      profile: true,
      preferences: true,
      interests: { include: { interest: true } },
      answers: { include: { question: true } },
    },
  });
  if (share.profile && user.profile) {
    fields.push("profile");
    data.profile = {
      displayName: user.profile.displayName,
      age: user.dateOfBirth ? ageFrom(user.dateOfBirth) : null,
      city: user.profile.city,
      bio: user.profile.bio,
      interests: user.interests.map((i) => i.interest.name),
    };
  }
  if (share.intentions) {
    fields.push("intentions");
    data.intentions = {
      own: user.preferences.filter((p) => p.kind === "OWN").map((p) => p.intention),
      sought: user.preferences.filter((p) => p.kind === "SOUGHT").map((p) => p.intention),
    };
  }
  if (share.compatibilityAnswers) {
    fields.push("compatibilityAnswers");
    data.compatibilityAnswers = user.answers.map((a) => {
      const options = a.question.options as { value: string; label: string }[];
      const label = (v: string) => options.find((o) => o.value === v)?.label ?? v;
      return {
        question: a.question.prompt,
        answer: label(a.answer),
        openTo: a.acceptable.map(label),
        importance: a.importance,
        dealbreaker: a.isDealbreaker,
      };
    });
  }
  if (share.matchId) {
    const match = await prisma.match.findFirst({ where: { id: share.matchId, status: "ACTIVE", OR: [{ userAId: userId }, { userBId: userId }] } });
    if (!match) throw notFound("Match not found.");
    const otherId = match.userAId === userId ? match.userBId : match.userAId;
    const result = await compatibilityFor(userId, otherId);
    fields.push("matchCompatibility");
    // Only the summary: the match's own answers and messages are never shared.
    data.matchCompatibility = result && {
      score: result.score,
      confidence: result.confidence,
      dimensions: result.dimensions.map((d) => ({ dimension: d.dimension, score: d.score })),
      items: result.items.map((i) => ({ label: i.label, status: i.status })),
    };
  }
  return { data, fields };
}

expertsRouter.post("/requests", sensitiveLimiter, async (req, res) => {
  const body = parse(requestSchema, req.body);
  const userId = req.user!.id;
  const open = await prisma.expertReviewRequest.count({ where: { requesterId: userId, status: { in: [...OPEN_STATUSES] } } });
  if (open >= 2) throw badRequest("You can have up to two open review requests at a time.");
  const { data, fields } = await buildSharedData(userId, body.share);
  const request = await prisma.expertReviewRequest.create({
    data: {
      requesterId: userId,
      topic: body.topic,
      question: body.question,
      sharedData: data as Prisma.InputJsonValue,
      sharedFields: fields,
      consentedAt: new Date(),
    },
  });
  ok(res, { ...request, status: await tryAiReview(request.id, userId, body, data) }, 201);
});

/**
 * Mavelle AI answers first, from the same consented snapshot an expert would see (minus the name).
 * When it can't, the request simply stays in the experts' queue.
 */
async function tryAiReview(id: string, userId: string, body: { topic: string; question: string }, data: Record<string, unknown>) {
  const { displayName: _name, ...profile } = (data.profile ?? {}) as Record<string, unknown>;
  const message = await writeExpertReview(userId, { topic: body.topic, question: body.question, shared: { ...data, ...(data.profile ? { profile } : {}) } });
  if (!message) return "PENDING" as const;
  // Atomic: if an expert claimed it or the member cancelled meanwhile, their action stands.
  const { count } = await prisma.expertReviewRequest.updateMany({ where: { id, status: "PENDING", expertId: null }, data: { status: "COMPLETED", completedAt: new Date() } });
  if (count !== 1) return (await prisma.expertReviewRequest.findUniqueOrThrow({ where: { id } })).status;
  await prisma.expertReview.create({ data: { requestId: id, action: "COMPLETED", message, aiWritten: true } });
  await notify(userId, "EXPERT_UPDATE", "Your AI review is ready", undefined, { requestId: id });
  return "COMPLETED" as const;
}

const historyInclude = {
  reviews: { orderBy: { createdAt: "asc" }, select: { id: true, action: true, message: true, aiWritten: true, createdAt: true, authorId: true } },
  expert: { select: { profile: { select: { displayName: true } } } },
} satisfies Prisma.ExpertReviewRequestInclude;

expertsRouter.get("/requests", async (req, res) => {
  const items = await prisma.expertReviewRequest.findMany({
    where: { requesterId: req.user!.id },
    include: historyInclude,
    orderBy: { createdAt: "desc" },
  });
  ok(res, items.map(({ expert, ...r }) => ({ ...r, expertName: expert?.profile?.displayName ?? null })));
});

async function ownRequest(req: Request) {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const r = await prisma.expertReviewRequest.findFirst({ where: { id, requesterId: req.user!.id } });
  if (!r) throw notFound("Request not found.");
  return r;
}

expertsRouter.post("/requests/:id/respond", async (req, res) => {
  const r = await ownRequest(req);
  const { message } = parse(z.object({ message: z.string().trim().min(2).max(1500) }), req.body);
  if (r.status !== "INFO_REQUESTED") throw badRequest("This request is not waiting for more information.");
  await prisma.$transaction([
    prisma.expertReviewRequest.update({ where: { id: r.id }, data: { status: "IN_REVIEW" } }),
    prisma.expertReview.create({ data: { requestId: r.id, authorId: req.user!.id, action: "INFO_PROVIDED", message } }),
  ]);
  if (r.expertId) await notify(r.expertId, "EXPERT_UPDATE", "A member replied to your question", undefined, { requestId: r.id });
  ok(res, { status: "IN_REVIEW" });
});

expertsRouter.post("/requests/:id/cancel", async (req, res) => {
  const r = await ownRequest(req);
  if (!OPEN_STATUSES.includes(r.status as (typeof OPEN_STATUSES)[number])) throw badRequest("This request is already closed.");
  await prisma.$transaction([
    prisma.expertReviewRequest.update({ where: { id: r.id }, data: { status: "CANCELLED" } }),
    prisma.expertReview.create({ data: { requestId: r.id, authorId: req.user!.id, action: "CANCELLED" } }),
  ]);
  ok(res, { status: "CANCELLED" });
});

// ---------- Expert workspace ----------

async function requireApprovedExpert(req: Request) {
  if (req.user!.role !== "EXPERT") throw forbidden("This area is for approved Compatibility Experts.");
  const profile = await prisma.expertProfile.findUnique({ where: { userId: req.user!.id } });
  if (profile?.status !== "APPROVED") throw forbidden("Your expert account is not active.");
}

const workspace = Router();
workspace.use(async (req, _res, next) => {
  await requireApprovedExpert(req);
  next();
});

workspace.get("/queue", async (req, res) => {
  const me = req.user!.id;
  const [pending, mine] = await Promise.all([
    // Unclaimed requests show only the topic and question until claimed.
    prisma.expertReviewRequest.findMany({
      where: { status: "PENDING", expertId: null, requesterId: { not: me } },
      select: { id: true, topic: true, question: true, sharedFields: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 50,
    }),
    prisma.expertReviewRequest.findMany({
      where: { expertId: me, status: { in: ["IN_REVIEW", "INFO_REQUESTED"] } },
      include: historyInclude,
      orderBy: { updatedAt: "desc" },
    }),
  ]);
  ok(res, { pending, assigned: mine });
});

workspace.get("/history", async (req, res) => {
  const items = await prisma.expertReviewRequest.findMany({
    where: { expertId: req.user!.id, status: { in: ["COMPLETED", "DECLINED", "CANCELLED"] } },
    include: historyInclude,
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  ok(res, items);
});

async function assignedRequest(req: Request) {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const r = await prisma.expertReviewRequest.findFirst({ where: { id, expertId: req.user!.id }, include: historyInclude });
  if (!r) throw notFound("Request not found.");
  return r;
}

workspace.get("/queue/:id", async (req, res) => {
  ok(res, await assignedRequest(req));
});

workspace.post("/queue/:id/claim", async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const me = req.user!.id;
  // Atomic: only one expert can claim a request.
  const { count } = await prisma.expertReviewRequest.updateMany({
    where: { id, status: "PENDING", expertId: null, requesterId: { not: me } },
    data: { expertId: me, status: "IN_REVIEW" },
  });
  if (count !== 1) throw conflict("This request is no longer available.");
  const r = await prisma.expertReviewRequest.findUniqueOrThrow({ where: { id } });
  await prisma.expertReview.create({ data: { requestId: id, authorId: me, action: "CLAIMED" } });
  await notify(r.requesterId, "EXPERT_UPDATE", "An expert has started on your request", undefined, { requestId: id });
  ok(res, await assignedRequest(req));
});

const messageBody = z.object({ message: z.string().trim().min(10, "Please write a short explanation.").max(3000) });

async function transition(
  req: Request,
  action: "INFO_REQUESTED" | "COMPLETED" | "DECLINED",
  status: "INFO_REQUESTED" | "COMPLETED" | "DECLINED",
  title: string,
) {
  const r = await assignedRequest(req);
  const { message } = parse(messageBody, req.body);
  if (r.status !== "IN_REVIEW" && !(action === "DECLINED" && r.status === "INFO_REQUESTED")) {
    throw new ApiError(409, "BAD_STATE", "This request can't be updated right now.");
  }
  await prisma.$transaction([
    prisma.expertReviewRequest.update({
      where: { id: r.id },
      data: { status, completedAt: status === "INFO_REQUESTED" ? null : new Date() },
    }),
    prisma.expertReview.create({ data: { requestId: r.id, authorId: req.user!.id, action, message } }),
  ]);
  await notify(r.requesterId, "EXPERT_UPDATE", title, undefined, { requestId: r.id });
  return { status };
}

workspace.post("/queue/:id/request-info", async (req, res) => {
  ok(res, await transition(req, "INFO_REQUESTED", "INFO_REQUESTED", "Your expert has a question for you"));
});

// Completing a review is guidance only. It never creates, approves or blocks a match.
workspace.post("/queue/:id/complete", async (req, res) => {
  ok(res, await transition(req, "COMPLETED", "COMPLETED", "Your expert review is ready"));
});

workspace.post("/queue/:id/decline", async (req, res) => {
  ok(res, await transition(req, "DECLINED", "DECLINED", "An update on your expert request"));
});

expertsRouter.use("/workspace", workspace);
