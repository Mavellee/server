import { z } from "zod";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { logger } from "../../logger.js";
import { getProvider } from "../ai/provider.js";
import { NAKSHATRAS, RASHIS, type ChartData } from "./engine.js";
import type { gunaMilan } from "./gunaMilan.js";

const text = z.string().trim().min(10).max(900);
export const interpretationSchema = z.object({
  overview: z.string().trim().min(10).max(500),
  chartInsights: z.object({ personA: text, personB: text }),
  emotionalConnection: text,
  communication: text,
  attraction: text,
  harmony: z.array(text).min(1).max(4),
  differences: z.array(text).min(1).max(4),
  reflectionPrompts: z.array(text).min(1).max(4),
  narrative: text,
  starters: z.array(z.string().trim().min(10).max(200)).length(3),
});
export type Interpretation = z.infer<typeof interpretationSchema>;

export const SYSTEM = [
  "You are the Knot Astro interpreter inside a dating app. You receive already-calculated Vedic astrology results for two adults who matched and both want a long-term relationship.",
  "Interpret ONLY the supplied data. Never add a planet, sign, score or calculation that isn't given, and treat anything listed as unavailable as unknown.",
  "Astrology is a reflective tradition, not science: use tentative language such as 'may', 'tradition suggests', 'worth exploring'. Never claim certainty about the future.",
  "Never say anyone is destined to do anything, will cheat, is unsuitable for marriage, or that the relationship will fail or succeed. Never advise against talking. Never give percentages. Do not be sexual.",
  "This is read just after two people matched, so be warm and never discouraging. Never call a Guna Milan total or koota low, high, poor, weak, good or bad, never say it is a concern or needs caution, and never repeat the total or koota scores: the report already shows them. Describe each theme as a difference to get curious about or something to enjoy.",
  "Keep the overview to at most 40 words, about the two people's themes rather than scores.",
  "Refer to the two people only as 'Person A' and 'Person B'.",
  'Reply with one JSON object only, with these keys: overview, chartInsights {personA, personB}, emotionalConnection, communication, attraction, harmony (1-4 strings), differences (1-4 strings), reflectionPrompts (1-4 strings), narrative, starters (exactly 3 questions they could ask each other). Each string at most 80 words.',
].join(" ");

/** Deterministic claims and invented numbers are rejected, whatever the model says. */
const FORBIDDEN = [/\bdestined\b/i, /\bdoomed\b/i, /\bwill (?:cheat|fail|divorce|break up|leave)\b/i, /\bunsuitable\b/i, /\bguarantee/i, /\bcertain(?:ly)? (?:to|will)\b/i, /\d+\s?%/, /\bscientific(?:ally)? proven\b/i, /\bdo not (?:talk|marry|pursue)\b/i, /\b(?:low|poor|weak|bad)\s+(?:guna|score|total|compatibility)/i, /\b(?:total|score)\s+(?:is|of)\s+(?:\w+\s+)?(?:low|poor|weak)\b/i, /\bscores?\s+zero\b/i, /\bcareful attention\b/i];
export const violatesPolicy = (i: Interpretation) => FORBIDDEN.some((re) => re.test(JSON.stringify(i)));

const describe = (c: ChartData) => ({
  sun: c.sunRashi === null ? "unavailable" : RASHIS[c.sunRashi],
  moon: c.moon ? RASHIS[c.moon.rashi] : "unavailable",
  nakshatra: c.moon ? NAKSHATRAS[c.moon.nakshatra] : "unavailable",
  lagna: c.lagnaRashi === null ? "unavailable" : RASHIS[c.lagnaRashi],
  planets: c.planets.filter((p) => p.rashi !== null).map((p) => ({ planet: p.name, sign: RASHIS[p.rashi!], house: p.house })),
  unavailable: c.unavailable.map((u) => u.field),
});

/** Only sign-level results reach the provider: no names, dates, times, places or profile text. */
export function buildPrompt(a: ChartData, b: ChartData, guna: ReturnType<typeof gunaMilan> | null, sharedInterests: string[]) {
  return JSON.stringify({
    conventions: a.conventions,
    personA: describe(a),
    personB: describe(b),
    gunaMilan: guna ? { total: guna.total, max: guna.max, kootas: guna.kootas.map((k) => ({ name: k.label, score: k.score, max: k.max })) } : "not available",
    sharedInterests,
    bothLookingFor: "long-term relationship or marriage",
  });
}

export type AiOutcome = { state: "DONE"; data: Interpretation; model: string } | { state: "NOT_CONFIGURED" | "OVER_BUDGET" | "FAILED" };

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/** One guarded LLM call: spending cap, per-user cap, timeout, validation. Logs metadata only, never the prompt or reply. */
export async function interpret(userId: string, prompt: string): Promise<AiOutcome> {
  const provider = getProvider();
  if (!provider.enabled) return { state: "NOT_CONFIGURED" };
  const count = (where: object) => prisma.aIUsage.count({ where: { feature: "astro_report", status: { in: ["OK", "ERROR"] }, ...where } });
  const dayAgo = new Date(Date.now() - 86400000);
  if ((await count({ createdAt: { gte: monthStart() } })) >= config.astro.monthlyReportLimit || (await count({ userId, createdAt: { gte: dayAgo } })) >= config.astro.userDailyLimit) return { state: "OVER_BUDGET" };

  const started = Date.now();
  const log = (status: "OK" | "ERROR", outputChars = 0, model?: string) => prisma.aIUsage.create({ data: { userId, feature: "astro_report", provider: provider.name, status, model, inputChars: prompt.length, outputChars, latencyMs: Date.now() - started } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.astro.aiTimeoutMs);
  try {
    const result = await provider.generate({ system: SYSTEM, prompt, maxChars: config.astro.maxOutputChars, signal: controller.signal, json: true });
    const raw = result.text.replace(/^```(?:json)?\s*|\s*```$/g, "");
    const data = interpretationSchema.parse(JSON.parse(raw));
    if (violatesPolicy(data)) throw new Error("policy");
    await log("OK", raw.length, result.model);
    return { state: "DONE", data, model: result.model };
  } catch (err) {
    logger.warn({ feature: "astro_report", provider: provider.name, reason: (err as Error).name }, "Astro interpretation failed");
    await log("ERROR");
    return { state: "FAILED" };
  } finally {
    clearTimeout(timer);
  }
}
