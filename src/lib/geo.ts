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

/** Distance shown to other users: coarse buckets, never exact. */
export function approxDistanceLabel(km: number): string {
  if (km < 2) return "Less than 2 km away";
  if (km < 10) return `About ${Math.round(km)} km away`;
  if (km < 100) return `About ${Math.round(km / 5) * 5} km away`;
  return "More than 100 km away";
}
