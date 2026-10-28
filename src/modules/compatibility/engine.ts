/**
 * Knot compatibility engine — deterministic and explainable.
 *
 * It compares only what two people explicitly told us: their relationship intentions,
 * their interests and the optional questions they chose to answer. It never looks at photos
 * or messages. The score describes overlap in stated preferences; it does not and cannot
 * predict whether a relationship will succeed.
 *
 * Bump ENGINE_VERSION whenever the scoring rules change so stored results stay auditable.
 */
export const ENGINE_VERSION = "2026-10.v1";

export type Dimension = "RELATIONSHIP_GOALS" | "COMMUNICATION" | "LIFESTYLE" | "INTERESTS" | "VALUES";
export type Intention = "SINGLE" | "SITUATIONSHIP" | "MARRIAGE";
export type Weights = Record<Dimension, number>;

export interface AnswerInput {
  questionId: string;
  answer: string;
  acceptable: string[]; // empty = any answer is fine
  importance: number; // 0..3
  isDealbreaker: boolean;
}

export interface QuestionInput {
  id: string;
  key: string;
  prompt: string;
  dimension: Dimension;
}

export interface PersonInput {
  intentions: Intention[];
  soughtIntentions: Intention[];
  interestIds: string[];
  answers: AnswerInput[];
}

export type ItemStatus = "aligned" | "partly_aligned" | "different" | "missing_you" | "missing_them" | "missing_both";

export interface ExplanationItem {
  key: string;
  label: string;
  dimension: Dimension;
  status: ItemStatus;
  dealbreaker?: "yours" | "theirs";
}

export interface DimensionResult {
  dimension: Dimension;
  score: number | null; // null = not enough information
  weight: number;
  compared: number;
  missing: number;
}

export interface CompatibilityResult {
  version: string;
  score: number | null;
  confidence: "not_enough_information" | "limited" | "moderate" | "good";
  dimensions: DimensionResult[];
  items: ExplanationItem[];
  dealbreakerConflicts: number;
  sharedInterests: number;
}

const DIMENSIONS: Dimension[] = ["RELATIONSHIP_GOALS", "COMMUNICATION", "LIFESTYLE", "INTERESTS", "VALUES"];
// Importance 0..3 maps to these multipliers (0 = "doesn't matter to me").
const IMPORTANCE_WEIGHT = [0, 1, 3, 6];

const INTENTION_LABEL: Record<Intention, string> = {
  SINGLE: "Exploring connections",
  SITUATIONSHIP: "Casual or undefined",
  MARRIAGE: "Long-term commitment",
};

interface Acc {
  earned: number;
  possible: number;
  compared: number;
  missing: number;
}

/**
 * Computes compatibility from `you`'s point of view. Symmetric in score; the explanation
 * labels ("missing_you" vs "missing_them") are relative to `you`.
 */
export function computeCompatibility(
  you: PersonInput,
  them: PersonInput,
  questions: QuestionInput[],
  weights: Weights,
): CompatibilityResult {
  const acc = Object.fromEntries(DIMENSIONS.map((d) => [d, { earned: 0, possible: 0, compared: 0, missing: 0 }])) as Record<Dimension, Acc>;
  const items: ExplanationItem[] = [];
  let dealbreakerConflicts = 0;

  // 1. Relationship intentions (always available once both have onboarded).
  const goals = acc.RELATIONSHIP_GOALS;
  const wantsYou = you.soughtIntentions.length ? you.soughtIntentions : you.intentions;
  const wantsThem = them.soughtIntentions.length ? them.soughtIntentions : them.intentions;
  if (you.intentions.length && them.intentions.length) {
    const youHappy = them.intentions.some((i) => wantsYou.includes(i));
    const themHappy = you.intentions.some((i) => wantsThem.includes(i));
    const shared = you.intentions.filter((i) => them.intentions.includes(i));
    goals.earned += (youHappy ? 6 : 0) + (themHappy ? 6 : 0);
    goals.possible += 12;
    goals.compared++;
    items.push({
      key: "intentions",
      label: shared.length ? `Both open to: ${shared.map((i) => INTENTION_LABEL[i]).join(", ")}` : "Relationship intentions",
      dimension: "RELATIONSHIP_GOALS",
      status: youHappy && themHappy ? "aligned" : youHappy || themHappy ? "partly_aligned" : "different",
    });
  } else {
    goals.missing++;
    items.push({ key: "intentions", label: "Relationship intentions", dimension: "RELATIONSHIP_GOALS", status: statusMissing(!you.intentions.length, !them.intentions.length) });
  }

  // 2. Interests: overlap relative to the smaller list, so a long list is not penalised.
  const sharedInterests = you.interestIds.filter((id) => them.interestIds.includes(id)).length;
  if (you.interestIds.length && them.interestIds.length) {
    const ratio = Math.min(1, sharedInterests / Math.min(3, you.interestIds.length, them.interestIds.length));
    acc.INTERESTS.earned += ratio;
    acc.INTERESTS.possible += 1;
    acc.INTERESTS.compared++;
    items.push({
      key: "interests",
      label: sharedInterests ? `${sharedInterests} shared interest${sharedInterests === 1 ? "" : "s"}` : "Interests",
      dimension: "INTERESTS",
      status: ratio >= 1 ? "aligned" : ratio > 0 ? "partly_aligned" : "different",
    });
  } else {
    acc.INTERESTS.missing++;
    items.push({ key: "interests", label: "Interests", dimension: "INTERESTS", status: statusMissing(!you.interestIds.length, !them.interestIds.length) });
  }

  // 3. Optional questions. Each side's importance decides how much its own satisfaction counts.
  const yours = new Map(you.answers.map((a) => [a.questionId, a]));
  const theirs = new Map(them.answers.map((a) => [a.questionId, a]));
  for (const q of questions) {
    const a = yours.get(q.id);
    const b = theirs.get(q.id);
    const d = acc[q.dimension];
    if (!a || !b) {
      if (a || b) d.missing++;
      if (a || b) items.push({ key: q.key, label: q.prompt, dimension: q.dimension, status: statusMissing(!a, !b) });
      continue;
    }
    const youOk = a.acceptable.length === 0 || a.acceptable.includes(b.answer);
    const themOk = b.acceptable.length === 0 || b.acceptable.includes(a.answer);
    const wA = IMPORTANCE_WEIGHT[clampImportance(a.importance)];
    const wB = IMPORTANCE_WEIGHT[clampImportance(b.importance)];
    d.earned += (youOk ? wA : 0) + (themOk ? wB : 0);
    d.possible += wA + wB;
    d.compared++;

    const item: ExplanationItem = {
      key: q.key,
      label: q.prompt,
      dimension: q.dimension,
      status: youOk && themOk ? "aligned" : youOk || themOk ? "partly_aligned" : "different",
    };
    if (a.isDealbreaker && !youOk) item.dealbreaker = "yours";
    else if (b.isDealbreaker && !themOk) item.dealbreaker = "theirs";
    if (item.dealbreaker) dealbreakerConflicts++;
    items.push(item);
  }

  const dimensions: DimensionResult[] = DIMENSIONS.map((dimension) => {
    const x = acc[dimension];
    return {
      dimension,
      score: x.possible > 0 ? Math.round((x.earned / x.possible) * 100) : null,
      weight: Math.max(0, weights[dimension] ?? 0),
      compared: x.compared,
      missing: x.missing,
    };
  });

  const scored = dimensions.filter((d) => d.score !== null && d.weight > 0);
  const totalWeight = scored.reduce((s, d) => s + d.weight, 0);
  const itemsCompared = dimensions.reduce((s, d) => s + d.compared, 0);

  let score: number | null = null;
  if (scored.length >= 2 && totalWeight > 0) {
    score = Math.round(scored.reduce((s, d) => s + d.score! * d.weight, 0) / totalWeight);
  }

  const confidence: CompatibilityResult["confidence"] =
    score === null ? "not_enough_information" : itemsCompared >= 8 ? "good" : itemsCompared >= 4 ? "moderate" : "limited";

  return { version: ENGINE_VERSION, score, confidence, dimensions, items, dealbreakerConflicts, sharedInterests };
}

function clampImportance(v: number) {
  return Math.max(0, Math.min(3, Math.round(v)));
}

function statusMissing(youMissing: boolean, themMissing: boolean): ItemStatus {
  if (youMissing && themMissing) return "missing_both";
  return youMissing ? "missing_you" : "missing_them";
}
