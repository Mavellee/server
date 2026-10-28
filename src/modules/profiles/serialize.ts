import type { Prisma } from "@prisma/client";
import { ageFrom } from "../../lib/age.js";
import { approxDistanceLabel, distanceKm } from "../../lib/geo.js";

/** Everything needed to render a profile card. Note: no email, no date of birth, no coordinates leave this module. */
export const publicProfileInclude = {
  profile: true,
  photos: { where: { status: "APPROVED" }, orderBy: { position: "asc" }, select: { id: true } },
  preferences: { where: { kind: "OWN" }, select: { intention: true } },
  interests: { include: { interest: true } },
  expertProfile: { select: { status: true } },
} satisfies Prisma.UserInclude;

export type PublicProfileSource = Prisma.UserGetPayload<{ include: typeof publicProfileInclude }>;

export interface Viewer {
  lat: number | null;
  lon: number | null;
  interestIds: Set<string>;
}

export function toPublicProfile(user: PublicProfileSource, viewer?: Viewer, opts: { showDistance?: boolean } = {}) {
  const p = user.profile!;
  let distance: string | null = null;
  if (viewer?.lat != null && viewer.lon != null && p.latitude && p.longitude && opts.showDistance !== false) {
    distance = approxDistanceLabel(distanceKm(viewer.lat, viewer.lon, Number(p.latitude), Number(p.longitude)));
  }
  const interests = user.interests.map((ui) => ({
    slug: ui.interest.slug,
    name: ui.interest.name,
    shared: viewer ? viewer.interestIds.has(ui.interestId) : false,
  }));
  interests.sort((a, b) => Number(b.shared) - Number(a.shared));
  return {
    id: user.id,
    displayName: p.displayName,
    age: user.dateOfBirth ? ageFrom(user.dateOfBirth) : null,
    gender: p.gender,
    city: p.city,
    distance,
    bio: p.bio,
    languages: p.languages,
    intentions: user.preferences.map((x) => x.intention),
    interests,
    sharedInterestCount: interests.filter((i) => i.shared).length,
    photoIds: user.photos.map((ph) => ph.id),
    isApprovedExpert: user.expertProfile?.status === "APPROVED",
  };
}

export type PublicProfile = ReturnType<typeof toPublicProfile>;
