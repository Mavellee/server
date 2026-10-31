import type { Prisma } from "@prisma/client";
import { ageFrom } from "../../lib/age.js";
import { approxDistanceLabel, distanceKm } from "../../lib/geo.js";
import { promptText } from "../../lib/prompts.js";
import { zodiacApplies, zodiacSign } from "../../lib/zodiac.js";

/** Everything needed to render a profile card. Note: no email, no date of birth, no coordinates leave this module. */
export const publicProfileInclude = {
  profile: true,
  photos: {
    where: { status: "APPROVED" },
    orderBy: { position: "asc" },
    select: { id: true, kind: true, focusX: true, focusY: true, caption: true, isPrimary: true, durationMs: true, posterKey: true },
  },
  prompts: { orderBy: { position: "asc" }, select: { promptKey: true, answer: true } },
  preferences: { where: { kind: "OWN" }, select: { intention: true } },
  interests: { include: { interest: true } },
  expertProfile: { select: { status: true } },
  settings: { select: { showZodiacSign: true } },
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
  const images = user.photos.filter((m) => m.kind === "IMAGE");
  const primary = images.find((m) => m.isPrimary) ?? images[0];
  if (primary) images.sort((a, b) => Number(b.id === primary.id) - Number(a.id === primary.id));
  return {
    id: user.id,
    displayName: p.displayName,
    age: user.dateOfBirth ? ageFrom(user.dateOfBirth) : null,
    // Only the sign, and members can hide it: the date of birth itself is never exposed.
    zodiac: user.dateOfBirth && user.settings?.showZodiacSign !== false && zodiacApplies(user.preferences.map((x) => x.intention)) ? zodiacSign(user.dateOfBirth) : null,
    gender: p.gender,
    city: p.city,
    distance,
    bio: p.bio,
    languages: p.languages,
    intentions: user.preferences.map((x) => x.intention),
    interests,
    sharedInterestCount: interests.filter((i) => i.shared).length,
    // Images only, primary first: used for avatars and cards.
    photoIds: images.map((ph) => ph.id),
    photos: images.map((ph) => ({ id: ph.id, focusX: ph.focusX, focusY: ph.focusY, caption: ph.caption })),
    // The whole approved gallery in the owner's order, photos and videos together, each with its own caption.
    media: user.photos.map((m) => ({
      id: m.id,
      kind: m.kind,
      caption: m.caption,
      isPrimary: m.isPrimary,
      focusX: m.focusX,
      focusY: m.focusY,
      durationMs: m.durationMs,
      hasPoster: !!m.posterKey,
    })),
    prompts: user.prompts.filter((pr) => promptText(pr.promptKey)).map((pr) => ({ key: pr.promptKey, text: promptText(pr.promptKey)!, answer: pr.answer })),
    isDemo: user.isDemo,
    isApprovedExpert: user.expertProfile?.status === "APPROVED",
  };
}

export type PublicProfile = ReturnType<typeof toPublicProfile>;
