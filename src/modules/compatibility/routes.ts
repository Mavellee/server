import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { badRequest, notFound, ok, parse } from "../../lib/http.js";
import { isBlockedBetween } from "../../lib/safety.js";
import { requireActive, requireAuth } from "../../middleware/auth.js";
import { ENGINE_VERSION } from "./engine.js";
import { compatibilityFor } from "./service.js";

export const compatibilityRouter = Router();
compatibilityRouter.use(requireAuth);

type Option = { value: string; label: string };

compatibilityRouter.get("/questions", async (req, res) => {
  const [questions, answers] = await Promise.all([
    prisma.compatibilityQuestion.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    prisma.compatibilityAnswer.findMany({ where: { userId: req.user!.id } }),
  ]);
  const mine = new Map(answers.map((a) => [a.questionId, a]));
  ok(
    res,
    questions.map((q) => {
      const a = mine.get(q.id);
      return {
        id: q.id,
        key: q.key,
        dimension: q.dimension,
        prompt: q.prompt,
        options: q.options,
        myAnswer: a ? { answer: a.answer, acceptable: a.acceptable, importance: a.importance, isDealbreaker: a.isDealbreaker } : null,
      };
    }),
  );
});

const answerSchema = z.object({
  answer: z.string().max(40),
  acceptable: z.array(z.string().max(40)).max(10).default([]),
  importance: z.number().int().min(0).max(3).default(1),
  isDealbreaker: z.boolean().default(false),
});

compatibilityRouter.put("/answers/:questionId", async (req, res) => {
  const { questionId } = parse(z.object({ questionId: z.string().uuid() }), req.params);
  const body = parse(answerSchema, req.body);
  const q = await prisma.compatibilityQuestion.findFirst({ where: { id: questionId, isActive: true } });
  if (!q) throw notFound("Question not found.");
  const values = new Set((q.options as Option[]).map((o) => o.value));
  if (!values.has(body.answer) || !body.acceptable.every((v) => values.has(v))) throw badRequest("Choose one of the listed options.");
  if (body.isDealbreaker && body.acceptable.length === 0) throw badRequest("To mark a dealbreaker, choose which answers you are open to.");
  const userId = req.user!.id;
  const saved = await prisma.compatibilityAnswer.upsert({
    where: { userId_questionId: { userId, questionId } },
    create: { userId, questionId, ...body },
    update: body,
  });
  ok(res, { answer: saved.answer, acceptable: saved.acceptable, importance: saved.importance, isDealbreaker: saved.isDealbreaker });
});

/** Skipping or un-answering is always allowed and needs no reason. */
compatibilityRouter.delete("/answers/:questionId", async (req, res) => {
  const { questionId } = parse(z.object({ questionId: z.string().uuid() }), req.params);
  await prisma.compatibilityAnswer.deleteMany({ where: { userId: req.user!.id, questionId } });
  ok(res, { removed: true });
});

compatibilityRouter.get("/with/:userId", requireActive, async (req, res) => {
  const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
  const viewerId = req.user!.id;
  if (userId === viewerId) throw badRequest("Compatibility is calculated between two different people.");
  const other = await prisma.user.findFirst({ where: { id: userId, status: "ACTIVE", profile: { isPublished: true } } });
  if (!other || (await isBlockedBetween(viewerId, userId))) throw notFound("This profile is not available.");
  ok(res, await compatibilityFor(viewerId, userId));
});

/** Transparency: how scores are put together. */
compatibilityRouter.get("/method", (_req, res) => {
  ok(res, {
    version: ENGINE_VERSION,
    weights: config.compatibilityWeights,
    notes: [
      "Scores compare only the intentions, interests and optional answers you and the other person chose to share.",
      "Photos and private messages are never used.",
      "Answers you skip are reported as missing, not as a mismatch.",
      "A score describes overlap in stated preferences. It does not predict whether a relationship will work.",
    ],
  });
});
