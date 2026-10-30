import { CITIES } from "../../lib/cities.js";

/** Birthplaces with coordinates and IANA time zones. A curated list, so no birthplace leaves the server for geocoding. */
export interface BirthPlace {
  id: string;
  city: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
  tz: string;
}
const WORLD: [string, string, string, number, number, string][] = [
  ["Kathmandu", "", "Nepal", 27.72, 85.32, "Asia/Kathmandu"], ["Dhaka", "", "Bangladesh", 23.81, 90.41, "Asia/Dhaka"], ["Colombo", "", "Sri Lanka", 6.93, 79.86, "Asia/Colombo"], ["Karachi", "", "Pakistan", 24.86, 67.0, "Asia/Karachi"], ["Lahore", "", "Pakistan", 31.55, 74.34, "Asia/Karachi"],
  ["Dubai", "", "United Arab Emirates", 25.2, 55.27, "Asia/Dubai"], ["Abu Dhabi", "", "United Arab Emirates", 24.45, 54.38, "Asia/Dubai"], ["Doha", "", "Qatar", 25.29, 51.53, "Asia/Qatar"], ["Riyadh", "", "Saudi Arabia", 24.71, 46.68, "Asia/Riyadh"], ["Muscat", "", "Oman", 23.59, 58.41, "Asia/Muscat"], ["Kuwait City", "", "Kuwait", 29.38, 47.99, "Asia/Kuwait"],
  ["Singapore", "", "Singapore", 1.35, 103.82, "Asia/Singapore"], ["Kuala Lumpur", "", "Malaysia", 3.14, 101.69, "Asia/Kuala_Lumpur"], ["Bangkok", "", "Thailand", 13.76, 100.5, "Asia/Bangkok"], ["Jakarta", "", "Indonesia", -6.21, 106.85, "Asia/Jakarta"], ["Hong Kong", "", "China", 22.32, 114.17, "Asia/Hong_Kong"], ["Shanghai", "", "China", 31.23, 121.47, "Asia/Shanghai"], ["Tokyo", "", "Japan", 35.68, 139.69, "Asia/Tokyo"], ["Seoul", "", "South Korea", 37.57, 126.98, "Asia/Seoul"],
  ["London", "England", "United Kingdom", 51.51, -0.13, "Europe/London"], ["Manchester", "England", "United Kingdom", 53.48, -2.24, "Europe/London"], ["Birmingham", "England", "United Kingdom", 52.49, -1.89, "Europe/London"], ["Paris", "", "France", 48.86, 2.35, "Europe/Paris"], ["Berlin", "", "Germany", 52.52, 13.41, "Europe/Berlin"], ["Amsterdam", "", "Netherlands", 52.37, 4.9, "Europe/Amsterdam"], ["Dublin", "", "Ireland", 53.35, -6.26, "Europe/Dublin"], ["Rome", "", "Italy", 41.9, 12.5, "Europe/Rome"], ["Madrid", "", "Spain", 40.42, -3.7, "Europe/Madrid"], ["Zurich", "", "Switzerland", 47.38, 8.54, "Europe/Zurich"], ["Moscow", "", "Russia", 55.76, 37.62, "Europe/Moscow"],
  ["New York", "New York", "United States", 40.71, -74.01, "America/New_York"], ["Chicago", "Illinois", "United States", 41.88, -87.63, "America/Chicago"], ["Houston", "Texas", "United States", 29.76, -95.37, "America/Chicago"], ["San Francisco", "California", "United States", 37.77, -122.42, "America/Los_Angeles"], ["Los Angeles", "California", "United States", 34.05, -118.24, "America/Los_Angeles"], ["Seattle", "Washington", "United States", 47.61, -122.33, "America/Los_Angeles"], ["Boston", "Massachusetts", "United States", 42.36, -71.06, "America/New_York"], ["Toronto", "Ontario", "Canada", 43.65, -79.38, "America/Toronto"], ["Vancouver", "British Columbia", "Canada", 49.28, -123.12, "America/Vancouver"],
  ["Sydney", "New South Wales", "Australia", -33.87, 151.21, "Australia/Sydney"], ["Melbourne", "Victoria", "Australia", -37.81, 144.96, "Australia/Melbourne"], ["Auckland", "", "New Zealand", -36.85, 174.76, "Pacific/Auckland"], ["Johannesburg", "", "South Africa", -26.2, 28.05, "Africa/Johannesburg"], ["Nairobi", "", "Kenya", -1.29, 36.82, "Africa/Nairobi"], ["Lagos", "", "Nigeria", 6.52, 3.38, "Africa/Lagos"], ["Sao Paulo", "", "Brazil", -23.55, -46.63, "America/Sao_Paulo"],
];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
export const PLACES: BirthPlace[] = [
  // CITIES also lists a few cities abroad for profile distance; those need their own country and time zone from WORLD.
  ...CITIES.filter((c) => !WORLD.some(([city]) => city === c.name)).map((c) => ({ id: `in-${slug(c.name)}`, city: c.name, region: c.region, country: "India", lat: c.lat, lon: c.lon, tz: "Asia/Kolkata" })),
  ...WORLD.map(([city, region, country, lat, lon, tz]) => ({ id: `${slug(country)}-${slug(city)}`, city, region, country, lat, lon, tz })),
];
export const placeById = (id: string) => PLACES.find((p) => p.id === id) ?? null;
