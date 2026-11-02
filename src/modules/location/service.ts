import { prisma } from "../../db.js";
import { badRequest, notFound } from "../../lib/http.js";
import { distanceKm, roundCoord } from "../../lib/geo.js";
import { PLACES, placeById, type BirthPlace } from "../astro/places.js";

/**
 * A member's own location. Coordinates are rounded to ~1 km before they are stored, are never returned to other
 * members or by the location API, and are used only on the server to measure distance in coarse bands.
 * (The member's own data export includes them, as it does all of their data.)
 */

// Device positions are labelled with the nearest listed place, if one is this close; otherwise no city is shown.
const NEAREST_PLACE_KM = 30;

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
const searchable = PLACES.map((p) => ({ p, city: fold(p.city), all: fold(`${p.city} ${p.region} ${p.country}`) }));
const publicPlace = (p: BirthPlace) => ({ id: p.id, name: p.city, region: p.region, country: p.country });

/** Places whose name starts with the query come first, then any place that mentions it. */
export function searchPlaces(query: string, limit = 8) {
  const q = fold(query);
  if (q.length < 2) return [];
  const starts = searchable.filter((x) => x.city.startsWith(q));
  const contains = searchable.filter((x) => !x.city.startsWith(q) && x.all.includes(q));
  return [...starts, ...contains].slice(0, limit).map((x) => publicPlace(x.p));
}

export function nearestPlace(lat: number, lon: number, withinKm = NEAREST_PLACE_KM) {
  let best: { p: BirthPlace; km: number } | null = null;
  for (const p of PLACES) {
    const km = distanceKm(lat, lon, p.lat, p.lon);
    if (km <= withinKm && (!best || km < best.km)) best = { p, km };
  }
  return best?.p ?? null;
}

async function requireProfile(userId: string) {
  const profile = await prisma.profile.findUnique({ where: { userId } });
  if (!profile) throw badRequest("Add your name first, then set your location.");
  return profile;
}

/** What a member sees about their own location: the place and how it was set, never the coordinates. */
export async function locationView(userId: string) {
  const [p, settings] = await Promise.all([prisma.profile.findUnique({ where: { userId } }), prisma.userSettings.findUnique({ where: { userId } })]);
  // Places saved before placeId existed are found by name.
  const place = p?.placeId ? placeById(p.placeId) : p?.city ? (PLACES.find((x) => x.city === p.city) ?? null) : null;
  return {
    city: p?.city ?? null,
    region: place?.region ?? null,
    country: place?.country ?? null,
    source: p?.locationSource ?? (p?.latitude != null ? "MANUAL" : null),
    hasLocation: p?.latitude != null && p?.longitude != null,
    updatedAt: p?.locationUpdatedAt ?? null,
    deviceConsent: !!p?.locationConsentAt,
    maxDistanceKm: p?.maxDistanceKm ?? null,
    showDistance: settings?.showDistance !== false,
  };
}

export async function setManualLocation(userId: string, placeId: string) {
  await requireProfile(userId);
  const place = placeById(placeId);
  if (!place) throw notFound("That place isn't on our list. Try searching again.");
  await prisma.profile.update({
    where: { userId },
    // Choosing a place by hand replaces any device position and withdraws device consent.
    data: { city: place.city, placeId: place.id, latitude: place.lat, longitude: place.lon, locationSource: "MANUAL", locationUpdatedAt: new Date(), locationConsentAt: null },
  });
  return locationView(userId);
}

export async function setDeviceLocation(userId: string, lat: number, lon: number) {
  await requireProfile(userId);
  const rLat = roundCoord(lat);
  const rLon = roundCoord(lon);
  const near = nearestPlace(rLat, rLon);
  const now = new Date();
  await prisma.profile.update({
    where: { userId },
    data: { city: near?.city ?? null, placeId: near?.id ?? null, latitude: rLat, longitude: rLon, locationSource: "DEVICE", locationUpdatedAt: now, locationConsentAt: now },
  });
  return locationView(userId);
}

/** Withdraws consent and deletes the stored place and coordinates straight away. Distance simply stops applying. */
export async function clearLocation(userId: string) {
  await prisma.profile.updateMany({
    where: { userId },
    data: { city: null, placeId: null, latitude: null, longitude: null, locationSource: null, locationUpdatedAt: null, locationConsentAt: null },
  });
  return locationView(userId);
}

export async function setPreferences(userId: string, prefs: { maxDistanceKm?: number | null; showDistance?: boolean }) {
  if (prefs.maxDistanceKm !== undefined) {
    await requireProfile(userId);
    await prisma.profile.update({ where: { userId }, data: { maxDistanceKm: prefs.maxDistanceKm } });
  }
  if (prefs.showDistance !== undefined) {
    await prisma.userSettings.upsert({ where: { userId }, create: { userId, showDistance: prefs.showDistance }, update: { showDistance: prefs.showDistance } });
  }
  return locationView(userId);
}
