import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { getProvider } from "./provider.js";
import * as curated from "./curated.js";

export type Feature = "conversation_starter" | "icebreaker" | "bio_help" | "reflection" | "first_date" | "explain_compatibility";

export interface Suggestion {
  source: "ai" | "curated";
  label: string; // shown verbatim in the UI so AI content is always identified
  suggestions: string[];
  note?: string;
}

const SYSTEM = [
  "You are Knot AI, an optional, gentle helper inside a dating app for adults.",
  "Write short, warm, respectful suggestions. Never be sexual, manipulative or pushy.",
  "Never claim to know whether two people are compatible, never diagnose a relationship,",
  "never encourage anyone to keep chatting or to buy anything.",
  "Return 3 suggestions, one per line, without numbering.",
].join(" ");

// Concurrency cap: requests beyond it fall back to curated content instead of queueing.
let inFlight = 0;

function startOfDay() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function usageToday(userId: string) {
  const since = startOfDay();
  const [mine, global] = await Promise.all([
    prisma.aIUsage.count({ where: { userId, createdAt: { gte: since }, status: { in: ["OK", "ERROR"] } } }),
    prisma.aIUsage.count({ where: { createdAt: { gte: since }, status: { in: ["OK", "ERROR"] } } }),
  ]);
  return { mine, global, userLimit: config.ai.dailyUserLimit, globalLimit: config.ai.dailyGlobalLimit };
}

/** Splits model output into clean suggestion lines and enforces the output cap. */
export function parseSuggestions(text: string, maxChars: number) {
  return text
    .slice(0, maxChars)
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["“]|["”]$/g, "").trim())
    .filter((l) => l.length >= 8)
    .slice(0, 3);
}

function pick<T>(list: T[], n: number) {
  return [...list].sort(() => Math.random() - 0.5).slice(0, n);
}

export interface FeatureInput {
  feature: Feature;
  prompt: string; // built by the caller from consented, minimal context
  fallback: string[];
  note?: string;
}

/**
 * Runs one AI request with every guard: user opt-out, daily per-user and global limits,
 * a concurrency cap, a timeout and an output-length cap. Any failure returns the curated
 * fallback. Only metadata is logged — never the prompt or the generated text.
 */
export async function suggest(userId: string, input: FeatureInput): Promise<Suggestion> {
  const fallback = (note?: string): Suggestion => ({
    source: "curated",
    label: "Suggestions from the Knot team",
    suggestions: input.fallback,
    note: note ?? input.note,
  });
  const provider = getProvider();
  const settings = await prisma.userSettings.findUnique({ where: { userId } });
  if (settings?.aiEnabled === false || !provider.enabled) return fallback();

  const log = (status: "OK" | "FALLBACK" | "ERROR" | "RATE_LIMITED", extra: { outputChars?: number; latencyMs?: number; model?: string } = {}) =>
    prisma.aIUsage.create({
      data: { userId, feature: input.feature, provider: provider.name, status, inputChars: input.prompt.length, ...extra },
    });

  const usage = await usageToday(userId);
  if (usage.mine >= usage.userLimit || usage.global >= usage.globalLimit) {
    await log("RATE_LIMITED");
    return fallback("You've reached today's Knot AI limit, so here are some of our favourites instead.");
  }
  if (inFlight >= config.ai.maxConcurrency) {
    await log("FALLBACK");
    return fallback();
  }

  inFlight++;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);
  try {
    const result = await provider.generate({ system: SYSTEM, prompt: input.prompt, maxChars: config.ai.maxOutputChars, signal: controller.signal });
    const suggestions = parseSuggestions(result.text, config.ai.maxOutputChars);
    if (!suggestions.length) throw new Error("empty AI output");
    await log("OK", { outputChars: suggestions.join("\n").length, latencyMs: Date.now() - started, model: result.model });
    return { source: "ai", label: "Suggested by Knot AI — edit or ignore freely", suggestions, note: input.note };
  } catch (err) {
    logger.warn({ feature: input.feature, provider: provider.name, reason: (err as Error).name }, "AI request failed, using curated fallback");
    await log("ERROR", { latencyMs: Date.now() - started });
    return fallback();
  } finally {
    clearTimeout(timer);
    inFlight--;
  }
}

export const curatedFor = {
  starters: (interestSlugs: string[]) => {
    const fromInterests = interestSlugs.flatMap((s) => curated.INTEREST_STARTERS[s] ?? []);
    return pick([...pick(fromInterests, 2), ...pick(curated.CONVERSATION_STARTERS, 3)], 3);
  },
  bio: () => pick(curated.BIO_TIPS, 3),
  reflection: () => pick(curated.REFLECTION_PROMPTS, 3),
  firstDate: () => pick(curated.FIRST_DATE_IDEAS, 3),
};
