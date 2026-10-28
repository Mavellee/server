import { createHash } from "node:crypto";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { orderedPair } from "../../lib/safety.js";
import { computeCompatibility, ENGINE_VERSION, type CompatibilityResult, type PersonInput, type QuestionInput } from "./engine.js";

async function loadPeople(ids: string[]): Promise<Map<string, PersonInput & { updatedAt: string[] }>> {
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      preferences: { select: { kind: true, intention: true } },
      interests: { select: { interestId: true } },
      answers: { where: { question: { isActive: true } } },
    },
  });
  return new Map(
    users.map((u) => [
      u.id,
      {
        intentions: u.preferences.filter((p) => p.kind === "OWN").map((p) => p.intention),
        soughtIntentions: u.preferences.filter((p) => p.kind === "SOUGHT").map((p) => p.intention),
        interestIds: u.interests.map((i) => i.interestId),
        answers: u.answers.map((a) => ({
          questionId: a.questionId,
          answer: a.answer,
          acceptable: a.acceptable,
          importance: a.importance,
          isDealbreaker: a.isDealbreaker,
        })),
        updatedAt: u.answers.map((a) => `${a.id}:${a.updatedAt.toISOString()}`),
      },
    ]),
  );
}

let questionCache: { at: number; list: QuestionInput[] } | null = null;
async function activeQuestions(): Promise<QuestionInput[]> {
  if (questionCache && Date.now() - questionCache.at < 60_000) return questionCache.list;
  const list = await prisma.compatibilityQuestion.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
  questionCache = { at: Date.now(), list: list.map((q) => ({ id: q.id, key: q.key, prompt: q.prompt, dimension: q.dimension })) };
  return questionCache.list;
}
export const clearQuestionCache = () => (questionCache = null);

/** Computes and records results. A new audit row is written only when inputs or version change. */
async function computeAndRecord(viewerId: string, otherIds: string[]) {
  if (!otherIds.length) return new Map<string, CompatibilityResult>();
  const [people, questions] = await Promise.all([loadPeople([viewerId, ...otherIds]), activeQuestions()]);
  const me = people.get(viewerId);
  const results = new Map<string, CompatibilityResult>();
  if (!me) return results;
  const rows = [];
  for (const otherId of otherIds) {
    const other = people.get(otherId);
    if (!other) continue;
    const result = computeCompatibility(me, other, questions, config.compatibilityWeights);
    results.set(otherId, result);
    const [a, b] = orderedPair(viewerId, otherId);
    // Inputs are references (answer ids + timestamps), not the private answers themselves.
    const inputs = {
      weights: config.compatibilityWeights,
      [a]: summariseInputs(a === viewerId ? me : other),
      [b]: summariseInputs(b === viewerId ? me : other),
    };
    const inputsHash = createHash("sha256").update(JSON.stringify(inputs)).digest("hex").slice(0, 32);
    rows.push({ userAId: a, userBId: b, version: ENGINE_VERSION, inputsHash, score: result.score, inputs, breakdown: result.dimensions as object[] });
  }
  await prisma.compatibilityResult.createMany({ data: rows, skipDuplicates: true });
  return results;
}

function summariseInputs(p: PersonInput & { updatedAt: string[] }) {
  return { intentions: p.intentions, sought: p.soughtIntentions, interestCount: p.interestIds.length, answers: [...p.updatedAt].sort() };
}

const DIMENSION_LABEL = {
  RELATIONSHIP_GOALS: "relationship goals",
  COMMUNICATION: "communication",
  LIFESTYLE: "lifestyle",
  INTERESTS: "interests",
  VALUES: "long-term values",
} as const;

/** Compact version for profile cards. */
export async function compatibilitySummaries(viewerId: string, otherIds: string[]) {
  const results = await computeAndRecord(viewerId, otherIds);
  const out = new Map<string, { score: number | null; confidence: string; highlights: string[]; dealbreakerConflicts: number }>();
  for (const [id, r] of results) {
    const highlights = r.dimensions
      .filter((d) => d.score !== null && d.score >= 75)
      .sort((x, y) => y.score! - x.score!)
      .slice(0, 2)
      .map((d) => `Aligned on ${DIMENSION_LABEL[d.dimension]}`);
    out.set(id, { score: r.score, confidence: r.confidence, highlights, dealbreakerConflicts: r.dealbreakerConflicts });
  }
  return out;
}

/** Full explanation for one pair, from the viewer's perspective. Never contains the other person's answers. */
export async function compatibilityFor(viewerId: string, otherId: string) {
  const results = await computeAndRecord(viewerId, [otherId]);
  return results.get(otherId) ?? null;
}
