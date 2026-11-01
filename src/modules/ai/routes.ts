import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { badRequest, notFound, ok, parse } from "../../lib/http.js";
import { isBlockedBetween } from "../../lib/safety.js";
import { requireActive } from "../../middleware/auth.js";
import { apiLimiter } from "../../middleware/security.js";
import { compatibilityFor } from "../compatibility/service.js";
import { getProvider } from "./provider.js";
import { SAFETY_NOTE } from "./curated.js";
import { curatedFor, suggest, usageToday } from "./service.js";

export const aiRouter = Router();
aiRouter.use(requireActive, apiLimiter);

const INTENTION_TEXT = { SINGLE: "exploring connections", SITUATIONSHIP: "something casual or undefined", MARRIAGE: "a long-term commitment" } as const;

/** Minimal, consented public context about one person: never messages, answers or exact data. */
async function publicContext(userId: string) {
  const u = await prisma.user.findFirst({
    where: { id: userId, status: "ACTIVE", profile: { isPublished: true } },
    include: { profile: true, interests: { include: { interest: true } }, preferences: { where: { kind: "OWN" } } },
  });
  if (!u?.profile) return null;
  return {
    name: u.profile.displayName,
    city: u.profile.city,
    interests: u.interests.map((i) => ({ slug: i.interest.slug, name: i.interest.name })),
    intentions: u.preferences.map((p) => INTENTION_TEXT[p.intention]),
  };
}

async function pairContext(me: string, otherId: string) {
  if (me === otherId || (await isBlockedBetween(me, otherId))) throw notFound("This profile is not available.");
  const [mine, theirs] = await Promise.all([publicContext(me), publicContext(otherId)]);
  if (!mine || !theirs) throw notFound("This profile is not available.");
  const theirSlugs = new Set(theirs.interests.map((i) => i.slug));
  const shared = mine.interests.filter((i) => theirSlugs.has(i.slug));
  return { mine, theirs, shared };
}

// How each compared answer reads inside a sentence. Only the topic is named, never anyone's answer.
const EXPLAIN_TOPIC: Record<string, string> = {
  intentions: "the kind of relationship you want",
  interests: "the things you enjoy",
  children: "children",
  pace: "the pace of dating",
  conflict: "handling arguments",
  texting: "staying in touch",
  feelings: "sharing feelings",
  weekends: "weekends",
  smoking: "smoking",
  drinking: "drinking",
  mornings: "mornings and late nights",
  family: "family",
  money: "money",
  space: "personal space",
  ambition: "career",
};
const listOf = (t: string[]) => (t.length > 1 ? `${t.slice(0, -1).join(", ")} and ${t[t.length - 1]}` : (t[0] ?? ""));

const schema = z.discriminatedUnion("feature", [
  z.object({ feature: z.literal("conversation_starter"), matchId: z.string().uuid() }),
  z.object({ feature: z.literal("icebreaker"), userId: z.string().uuid() }),
  z.object({ feature: z.literal("bio_help"), draft: z.string().max(500).default("") }),
  z.object({ feature: z.literal("reflection") }),
  z.object({ feature: z.literal("first_date"), matchId: z.string().uuid() }),
  z.object({ feature: z.literal("explain_compatibility"), userId: z.string().uuid() }),
]);

async function matchPartner(me: string, matchId: string) {
  const m = await prisma.match.findFirst({ where: { id: matchId, status: "ACTIVE", OR: [{ userAId: me }, { userBId: me }] } });
  if (!m) throw notFound("Match not found.");
  return m.userAId === me ? m.userBId : m.userAId;
}

aiRouter.post("/suggest", async (req, res) => {
  const body = parse(schema, req.body);
  const me = req.user!.id;

  switch (body.feature) {
    case "conversation_starter":
    case "icebreaker": {
      const otherId = body.feature === "icebreaker" ? body.userId : await matchPartner(me, body.matchId);
      const { theirs, shared } = await pairContext(me, otherId);
      const topics = (shared.length ? shared : theirs.interests).map((i) => i.name).slice(0, 5);
      return ok(
        res,
        await suggest(me, {
          feature: body.feature,
          prompt: `Suggest friendly opening questions for someone who likes: ${topics.join(", ") || "meeting new people"}. They are looking for ${theirs.intentions.join(" or ") || "a connection"}.`,
          fallback: curatedFor.starters((shared.length ? shared : theirs.interests).map((i) => i.slug)),
        }),
      );
    }
    case "bio_help": {
      const mine = await publicContext(me);
      return ok(
        res,
        await suggest(me, {
          feature: "bio_help",
          prompt: `Rewrite or improve this short dating profile bio, keeping the person's voice. Interests: ${mine?.interests.map((i) => i.name).join(", ") || "not listed"}. Draft: """${body.draft || "(empty)"}"""`,
          fallback: curatedFor.bio(),
        }),
      );
    }
    case "reflection":
      return ok(res, await suggest(me, { feature: "reflection", prompt: "Suggest gentle self-reflection questions about what someone wants from dating.", fallback: curatedFor.reflection() }));
    case "first_date": {
      const otherId = await matchPartner(me, body.matchId);
      const { mine, shared } = await pairContext(me, otherId);
      return ok(
        res,
        await suggest(me, {
          feature: "first_date",
          prompt: `Suggest relaxed, public first-date ideas${mine.city ? ` in ${mine.city}` : ""} for two people who both enjoy: ${shared.map((s) => s.name).join(", ") || "good conversation"}.`,
          fallback: curatedFor.firstDate(),
          note: SAFETY_NOTE,
        }),
      );
    }
    case "explain_compatibility": {
      await pairContext(me, body.userId);
      const result = await compatibilityFor(me, body.userId);
      if (!result) throw badRequest("Not enough information to explain yet.");
      const topic = (i: { key: string; label: string }) => EXPLAIN_TOPIC[i.key] ?? i.label;
      const aligned = result.items.filter((i) => i.status === "aligned").map(topic);
      const different = result.items.filter((i) => i.status === "different").map(topic);
      const missing = result.items.filter((i) => i.status.startsWith("missing")).length;
      const fallback = [
        aligned.length ? `You two are on the same page about ${listOf(aligned.slice(0, 3))}.` : "You're still finding out where you line up.",
        different.length ? `You may see ${listOf(different.slice(0, 3))} a little differently, and that's a lovely thing to talk about.` : "Nothing stands out as a difference so far.",
        missing ? `${missing === 1 ? "One answer is" : `${missing} answers are`} still missing, so there's more to discover.` : "All of this comes from what you've both chosen to share.",
      ];
      // The AI may only rephrase the deterministic result; it cannot change the score or the user's preferences.
      return ok(
        res,
        await suggest(me, {
          feature: "explain_compatibility",
          prompt: `In plain, kind language, explain this compatibility summary in 3 short lines. Do not change or invent anything, do not give a verdict. Aligned: ${aligned.join("; ") || "none"}. Different: ${different.join("; ") || "none"}. Unanswered: ${missing}.`,
          fallback,
          note: "A gentle guide only. It does not predict how a relationship will go.",
        }),
      );
    }
  }
});

aiRouter.get("/status", async (req, res) => {
  const provider = getProvider();
  const usage = await usageToday(req.user!.id);
  const settings = await prisma.userSettings.findUnique({ where: { userId: req.user!.id } });
  ok(res, {
    provider: provider.name,
    available: provider.enabled,
    enabledForYou: settings?.aiEnabled !== false,
    remainingToday: Math.max(0, usage.userLimit - usage.mine),
  });
});
