import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import multer from "multer";
import { z } from "zod";
import { Gender, Intention } from "@prisma/client";
import { prisma } from "../../db.js";
import { config } from "../../config.js";
import { ApiError, badRequest, notFound, ok, parse } from "../../lib/http.js";
import { randomToken } from "../../lib/crypto.js";
import { detectImageType, extensionFor, stripMetadata } from "../../lib/images.js";
import { CITIES, findCity } from "../../lib/cities.js";
import { roundCoord } from "../../lib/geo.js";
import { isBlockedBetween } from "../../lib/safety.js";
import { ageFrom } from "../../lib/age.js";
import { requireActive, requireAuth } from "../../middleware/auth.js";
import { publicProfileInclude, toPublicProfile } from "./serialize.js";
import { viewerFor } from "../discovery/service.js";
import { compatibilityFor } from "../compatibility/service.js";

export const MAX_PHOTOS = 6;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 1 } });

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

async function ownProfile(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      profile: true,
      photos: { orderBy: { position: "asc" } },
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
    photos: user.photos.map((ph) => ({ id: ph.id, position: ph.position, status: ph.status })),
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

profilesRouter.post("/me/photos", upload.single("photo"), async (req, res) => {
  const userId = req.user!.id;
  if (!req.file) throw badRequest("Choose a photo to upload.");
  const type = detectImageType(req.file.buffer);
  if (!type) throw badRequest("Photos must be JPEG, PNG or WebP images.");
  const count = await prisma.profilePhoto.count({ where: { userId } });
  if (count >= MAX_PHOTOS) throw badRequest(`You can add up to ${MAX_PHOTOS} photos.`);

  let clean: Buffer;
  try {
    clean = stripMetadata(req.file.buffer, type);
  } catch {
    throw badRequest("That image could not be read. Try a different file.");
  }
  const storageKey = `${randomToken(18)}.${extensionFor(type)}`;
  await fs.mkdir(config.uploadDir, { recursive: true });
  await fs.writeFile(path.join(config.uploadDir, storageKey), clean, { mode: 0o640 });
  const photo = await prisma.profilePhoto.create({
    data: { userId, storageKey, mimeType: type, sizeBytes: clean.length, position: count },
  });
  ok(res, { id: photo.id, position: photo.position, status: photo.status }, 201);
});

profilesRouter.delete("/me/photos/:id", async (req, res) => {
  const userId = req.user!.id;
  const photo = await prisma.profilePhoto.findFirst({ where: { id: req.params.id, userId } });
  if (!photo) throw notFound("Photo not found.");
  await prisma.$transaction(async (tx) => {
    await tx.profilePhoto.delete({ where: { id: photo.id } });
    const rest = await tx.profilePhoto.findMany({ where: { userId }, orderBy: { position: "asc" } });
    for (const [i, p] of rest.entries()) await tx.profilePhoto.update({ where: { id: p.id }, data: { position: i } });
  });
  await fs.rm(path.join(config.uploadDir, photo.storageKey), { force: true });
  ok(res, { deleted: true });
});

profilesRouter.put("/me/photos/order", async (req, res) => {
  const userId = req.user!.id;
  const { ids } = parse(z.object({ ids: z.array(z.string().uuid()).max(MAX_PHOTOS) }), req.body);
  const owned = await prisma.profilePhoto.findMany({ where: { userId }, select: { id: true } });
  const ownedIds = new Set(owned.map((o) => o.id));
  if (ids.length !== owned.length || !ids.every((id) => ownedIds.has(id))) throw badRequest("Photo list does not match your photos.");
  await prisma.$transaction(ids.map((id, position) => prisma.profilePhoto.update({ where: { id }, data: { position } })));
  ok(res, { ordered: true });
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

export const metaRouter = Router();
metaRouter.get("/interests", async (_req, res) => {
  const interests = await prisma.interest.findMany({ orderBy: [{ category: "asc" }, { name: "asc" }] });
  ok(res, interests.map(({ slug, name, category }) => ({ slug, name, category })));
});
metaRouter.get("/cities", (_req, res) => ok(res, CITIES.map(({ name, region }) => ({ name, region }))));

/** Serves a profile photo to signed-in members, except between blocked users. */
export const photosRouter = Router();
photosRouter.get("/:id", requireAuth, async (req, res) => {
  const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
  const photo = await prisma.profilePhoto.findUnique({ where: { id }, include: { user: { select: { status: true } } } });
  if (!photo) throw notFound();
  const viewerId = req.user!.id;
  if (photo.userId !== viewerId) {
    // Other people's photos are for verified, unrestricted members only.
    if (req.user!.status !== "ACTIVE") throw notFound();
    if (photo.status !== "APPROVED" || photo.user.status !== "ACTIVE") throw notFound();
    if (await isBlockedBetween(viewerId, photo.userId)) throw notFound();
  }
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.type(photo.mimeType);
  res.sendFile(path.resolve(config.uploadDir, photo.storageKey));
});
