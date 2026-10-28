import type { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { ageFrom, birthDateForAge } from "../../lib/age.js";
import { boundingBox, distanceKm } from "../../lib/geo.js";
import { blockedUserIds } from "../../lib/safety.js";
import { badRequest } from "../../lib/http.js";
import { publicProfileInclude, toPublicProfile, type Viewer } from "../profiles/serialize.js";
import { compatibilitySummaries } from "../compatibility/service.js";

export async function viewerFor(userId: string): Promise<Viewer> {
  const [profile, interests] = await Promise.all([
    prisma.profile.findUnique({ where: { userId }, select: { latitude: true, longitude: true } }),
    prisma.userInterest.findMany({ where: { userId }, select: { interestId: true } }),
  ]);
  return {
    lat: profile?.latitude ? Number(profile.latitude) : null,
    lon: profile?.longitude ? Number(profile.longitude) : null,
    interestIds: new Set(interests.map((i) => i.interestId)),
  };
}

/**
 * Builds the candidate filter for a viewer. Preferences are applied in both directions:
 * I only see people who match what I asked for AND who would want to see someone like me.
 */
export async function candidateWhere(userId: string): Promise<{ where: Prisma.UserWhereInput; me: NonNullable<Awaited<ReturnType<typeof loadMe>>> }> {
  const me = await loadMe(userId);
  if (!me?.profile?.isPublished) throw badRequest("Publish your profile to start discovering people.");
  if (!me.dateOfBirth) throw badRequest("Your date of birth is missing.");
  const p = me.profile;
  const myAge = ageFrom(me.dateOfBirth);

  const [blocked, acted] = await Promise.all([
    blockedUserIds(userId),
    Promise.all([
      prisma.like.findMany({ where: { fromUserId: userId }, select: { toUserId: true } }),
      prisma.pass.findMany({ where: { fromUserId: userId }, select: { toUserId: true } }),
    ]),
  ]);
  const exclude = new Set<string>([userId, ...blocked, ...acted.flat().map((a) => a.toUserId)]);
  const sought = me.preferences.filter((x) => x.kind === "SOUGHT").map((x) => x.intention);

  const where: Prisma.UserWhereInput = {
    id: { notIn: [...exclude] },
    status: "ACTIVE",
    // Age is filtered on date of birth so the exact date is never exposed.
    dateOfBirth: { lte: birthDateForAge(p.ageMin), gt: birthDateForAge(p.ageMax + 1) },
    profile: {
      isPublished: true,
      isDiscoverable: true,
      discoveryPausedAt: null,
      gender: { in: p.interestedIn },
      interestedIn: { has: p.gender },
      ageMin: { lte: myAge },
      ageMax: { gte: myAge },
    },
    ...(sought.length ? { preferences: { some: { kind: "OWN", intention: { in: sought } } } } : {}),
  };

  if (p.maxDistanceKm && p.latitude && p.longitude) {
    const box = boundingBox(Number(p.latitude), Number(p.longitude), p.maxDistanceKm);
    where.profile = {
      ...(where.profile as Prisma.ProfileWhereInput),
      latitude: { gte: box.minLat, lte: box.maxLat },
      longitude: { gte: box.minLon, lte: box.maxLon },
    };
  }
  return { where, me };
}

function loadMe(userId: string) {
  return prisma.user.findUnique({ where: { id: userId }, include: { profile: true, preferences: true } });
}

export async function discover(userId: string, cursor: string | undefined, limit: number) {
  const { where, me } = await candidateWhere(userId);
  const p = me.profile!;
  const viewer = await viewerFor(userId);
  const out: Awaited<ReturnType<typeof prisma.user.findMany<{ include: typeof publicProfileInclude }>>> = [];
  let after = cursor;
  let exhausted = false;

  // Distance is checked exactly after the bounding-box pre-filter, so scan in batches.
  while (out.length < limit) {
    const batch = await prisma.user.findMany({
      where: after ? { AND: [where, { id: { gt: after } }] } : where,
      include: publicProfileInclude,
      orderBy: { id: "asc" },
      take: limit * 2,
    });
    if (!batch.length) {
      exhausted = true;
      break;
    }
    for (const u of batch) {
      after = u.id;
      const lat = u.profile?.latitude;
      const lon = u.profile?.longitude;
      if (p.maxDistanceKm && viewer.lat != null && viewer.lon != null && lat && lon) {
        if (distanceKm(viewer.lat, viewer.lon, Number(lat), Number(lon)) > p.maxDistanceKm) continue;
      }
      out.push(u);
      if (out.length === limit) break;
    }
    if (batch.length < limit * 2 && out.length < limit) {
      exhausted = true;
      break;
    }
  }

  const settings = await prisma.userSettings.findMany({
    where: { userId: { in: out.map((u) => u.id) } },
    select: { userId: true, showDistance: true },
  });
  const showDistance = new Map(settings.map((s) => [s.userId, s.showDistance]));
  const compat = await compatibilitySummaries(userId, out.map((u) => u.id));

  return {
    items: out.map((u) => ({
      ...toPublicProfile(u, viewer, { showDistance: showDistance.get(u.id) }),
      compatibility: compat.get(u.id) ?? null,
    })),
    nextCursor: exhausted ? null : (after ?? null),
  };
}
