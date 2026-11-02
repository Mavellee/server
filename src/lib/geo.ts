/** Rounds to 2 decimals (~1.1 km) so exact positions are never stored. */
export const roundCoord = (v: number) => Math.round(v * 100) / 100;

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Bounding box used to pre-filter candidates in SQL before the exact distance check. */
export function boundingBox(lat: number, lon: number, km: number) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

/** Discover radius choices, in km. */
export const RADIUS_OPTIONS = [5, 10, 25, 50, 100] as const;

/**
 * Distance shown to other users: the same coarse bands as the radius choices, never a number of its own.
 * Combined with ~1 km rounding and limited location changes, this keeps anyone's position from being worked out.
 */
export function approxDistanceLabel(km: number): string {
  if (km < 5) return "Within 5 km";
  if (km < 10) return "Around 10 km away";
  if (km < 25) return "Around 25 km away";
  if (km < 50) return "Around 50 km away";
  if (km < 100) return "Around 100 km away";
  return "More than 100 km away";
}
