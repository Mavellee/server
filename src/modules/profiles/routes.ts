import { Router } from "express";
import { z } from "zod";
import { Gender, Intention } from "@prisma/client";
import { prisma } from "../../db.js";
import { ApiError, badRequest, notFound, ok, parse } from "../../lib/http.js";
import { CITIES, findCity } from "../../lib/cities.js";
import { MAX_PROMPT_ANSWER, MAX_PROMPTS, PROMPTS, promptText } from "../../lib/prompts.js";
import { roundCoord } from "../../lib/geo.js";
import { isBlockedBetween } from "../../lib/safety.js";
import { ageFrom } from "../../lib/age.js";
import { requireActive, requireAuth } from "../../middleware/auth.js";
import { publicProfileInclude, toPublicProfile } from "./serialize.js";
import { mediaLimits, ownMediaRouter, ownMediaView } from "./media.js";

export { photosRouter } from "./media.js";
import { viewerFor } from "../discovery/service.js";
import { compatibilityFor } from "../compatibility/service.js";


const intentionList = z.array(z.nativeEnum(Intention)).max(3);
const profileSchema = z
  .object({
    displayName: z.string().trim().min(1, "Add a display name.").max(40),
    gender: z.nativeEnum(Gender),
    interestedIn: z.array(z.nativeEnum(Gender)).min(1, "Choose at least one.").max(7),
    bio: z.string().trim().max(500).nullable(),
    city: z.string().trim().max(80).nullable(),
    // Optional approximate position from the browser; rounded before storage.
    approxLocation: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).nullable(),
    languages: z.array(z.string().trim().min(1).max(30)).max(8),
    interests: z.array(z.string().max(60)).max(12),
    intentions: intentionList.min(1, "Choose at least one intention."),
    soughtIntentions: intentionList,
    ageMin: z.number().int().min(18).max(100),
    ageMax: z.number().int().min(18).max(100),
    maxDistanceKm: z.number().int().min(1).max(20000).nullable(),
  })
  .partial()
  .refine((v) => v.ageMin === undefined || v.ageMax === undefined || v.ageMax >= v.ageMin, {
    message: "Maximum age must be at least the minimum age.",
    path: ["ageMax"],
  });

export const profilesRouter = Router();
profilesRouter.use(requireAuth);
profilesRouter.use("/me", ownMediaRouter);

async function ownProfile(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      profile: true,
      photos: { orderBy: { position: "asc" } },
      prompts: { orderBy: { position: "asc" } },
      preferences: true,
      interests: { include: { interest: true } },
    },
  });
  const p = user.profile;
  return {
    age: user.dateOfBirth ? ageFrom(user.dateOfBirth) : null,
    displayName: p?.displayName ?? "",
    gender: p?.gender ?? null,
    interestedIn: p?.interestedIn ?? [],
    bio: p?.bio ?? "",
    city: p?.city ?? null,
    hasApproxLocation: !!(p?.latitude && p?.longitude),
    languages: p?.languages ?? [],
    interests: user.interests.map((i) => i.interest.slug),
    intentions: user.preferences.filter((x) => x.kind === "OWN").map((x) => x.intention),
    soughtIntentions: user.preferences.filter((x) => x.kind === "SOUGHT").map((x) => x.intention),
    ageMin: p?.ageMin ?? 18,
    ageMax: p?.ageMax ?? 60,
    maxDistanceKm: p?.maxDistanceKm ?? null,
    isPublished: p?.isPublished ?? false,
    isDiscoverable: p?.isDiscoverable ?? true,
    discoveryPaused: !!p?.discoveryPausedAt,
    // `photos` lists images only (primary first); `media` is the whole gallery in the member's chosen order.
    photos: [...user.photos.filter((m) => m.kind === "IMAGE")].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.position - b.position).map(ownMediaView),
    media: user.photos.map(ownMediaView),
    mediaLimits,
    prompts: user.prompts.filter((pr) => promptText(pr.promptKey)).map((pr) => ({ key: pr.promptKey, text: promptText(pr.promptKey)!, answer: pr.answer })),
    dateOfBirth: user.dateOfBirth ? user.dateOfBirth.toISOString().slice(0, 10) : null, // own view only
  };
}

profilesRouter.get("/me", async (req, res) => {
  ok(res, await ownProfile(req.user!.id));
});

profilesRouter.patch("/me", async (req, res) => {
  const body = parse(profileSchema, req.body);
  const userId = req.user!.id;
  const existing = await prisma.profile.findUnique({ where: { userId } });

  if (!existing && (!body.displayName || !body.gender || !body.interestedIn)) {
    throw badRequest("Display name, gender and who you're interested in are needed to create your profile.");
  }
  const ageMin = body.ageMin ?? existing?.ageMin ?? 18;
  const ageMax = body.ageMax ?? existing?.ageMax ?? 60;
  if (ageMax < ageMin) throw new ApiError(422, "VALIDATION_FAILED", "Some fields need attention.", { ageMax: ["Maximum age must be at least the minimum age."] });

  let coords: { latitude: number | null; longitude: number | null } | undefined;
  if (body.approxLocation) {
    coords = { latitude: roundCoord(body.approxLocation.lat), longitude: roundCoord(body.approxLocation.lon) };
  } else if (body.city !== undefined) {
    const city = body.city ? findCity(body.city) : undefined;
    coords = city ? { latitude: city.lat, longitude: city.lon } : { latitude: null, longitude: null };
  }

  let interestIds: string[] | undefined;
  if (body.interests) {
    const found = await prisma.interest.findMany({ where: { slug: { in: body.interests } }, select: { id: true } });
    if (found.length !== new Set(body.interests).size) throw badRequest("One or more interests are not recognised.");
    interestIds = found.map((f) => f.id);
  }

  const fields = {
    displayName: body.displayName,
    gender: body.gender,
    interestedIn: body.interestedIn,
    bio: body.bio === undefined ? undefined : body.bio || null,
    city: body.city === undefined ? undefined : body.city || null,
    languages: body.languages,
    ageMin: body.ageMin,
    ageMax: body.ageMax,
    maxDistanceKm: body.maxDistanceKm,
    ...coords,
  };

  await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.profile.update({ where: { userId }, data: fields });
    } else {
      await tx.profile.create({
        data: { ...fields, userId, displayName: body.displayName!, gender: body.gender!, interestedIn: body.interestedIn! },
      });
    }
    for (const [kind, list] of [
      ["OWN", body.intentions],
      ["SOUGHT", body.soughtIntentions],
    ] as const) {
      if (!list) continue;
      await tx.relationshipPreference.deleteMany({ where: { userId, kind } });
      await tx.relationshipPreference.createMany({ data: [...new Set(list)].map((intention) => ({ userId, kind, intention })) });
    }
    if (interestIds) {
      await tx.userInterest.deleteMany({ where: { userId } });
      await tx.userInterest.createMany({ data: interestIds.map((interestId) => ({ userId, interestId })) });
    }
  });
  ok(res, await ownProfile(userId));
});

/** Publishing makes the profile eligible for Discover. */
profilesRouter.post("/me/publish", async (req, res) => {
  const userId = req.user!.id;
  const me = await ownProfile(userId);
  const missing: string[] = [];
  if (!me.displayName) missing.push("display name");
  if (!me.gender) missing.push("gender");
  if (!me.interestedIn.length) missing.push("who you're interested in");
  if (!me.intentions.length) missing.push("a relationship intention");
  if (!me.photos.length) missing.push("at least one photo");
  if (missing.length) throw badRequest(`Before publishing, add ${missing.join(", ")}.`, { missing });
  await prisma.$transaction([
    prisma.profile.update({ where: { userId }, data: { isPublished: true } }),
    prisma.user.update({ where: { id: userId }, data: { onboardedAt: new Date() } }),
  ]);
  ok(res, await ownProfile(userId));
});

/** Replaces the member's prompt answers (in display order). Unknown prompts are rejected. */
profilesRouter.put("/me/prompts", async (req, res) => {
  const userId = req.user!.id;
  const { prompts } = parse(
    z.object({
      prompts: z
        .array(z.object({ key: z.string().max(40), answer: z.string().trim().min(1, "Write a few words, or remove this prompt.").max(MAX_PROMPT_ANSWER) }))
        .max(MAX_PROMPTS, `Choose up to ${MAX_PROMPTS} prompts.`),
    }),
    req.body,
  );
  const keys = prompts.map((p) => p.key);
  if (new Set(keys).size !== keys.length) throw badRequest("Each prompt can only be answered once.");
  if (keys.some((k) => !promptText(k))) throw badRequest("One or more prompts aren't recognised.");
  await prisma.$transaction([
    prisma.profilePrompt.deleteMany({ where: { userId } }),
    prisma.profilePrompt.createMany({ data: prompts.map((p, position) => ({ userId, promptKey: p.key, answer: cleanPrompt(p.answer), position })) }),
  ]);
  ok(res, await ownProfile(userId));
});

/** Another member's profile. Only published, unblocked, active accounts are visible. */
profilesRouter.get("/:userId", requireActive, async (req, res) => {
  const viewerId = req.user!.id;
  const { userId } = parse(z.object({ userId: z.string().uuid() }), req.params);
  const user = await prisma.user.findFirst({
    where: { id: userId, status: "ACTIVE", profile: { isPublished: true } },
    include: publicProfileInclude,
  });
  if (!user || (userId !== viewerId && (await isBlockedBetween(viewerId, userId)))) throw notFound("This profile is not available.");
  const viewer = await viewerFor(viewerId);
  const settings = await prisma.userSettings.findUnique({ where: { userId } });
  const compatibility = userId === viewerId ? null : await compatibilityFor(viewerId, userId);
  ok(res, { ...toPublicProfile(user, viewer, { showDistance: settings?.showDistance }), compatibility });
});

// eslint-disable-next-line no-control-regex
const cleanPrompt = (t: string) => t.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

export const metaRouter = Router();
metaRouter.get("/prompts", (_req, res) => ok(res, PROMPTS));
metaRouter.get("/interests", async (_req, res) => {
  const interests = await prisma.interest.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
  ok(res, interests.map(({ slug, name, category }) => ({ slug, name, category })));
});
metaRouter.get("/cities", (_req, res) => ok(res, CITIES.map(({ name, region }) => ({ name, region }))));

