import { Body, Ecliptic, GeoVector, MakeTime, SiderealTime } from "astronomy-engine";

/**
 * Mavelle Astro calculation engine: real astronomy, never an LLM.
 * Positions come from astronomy-engine (MIT; VSOP87 planets, NOVAS-derived Moon), geocentric, apparent, ecliptic of date.
 * Sidereal conversion: Lahiri ayanamsa, 23.245524743° at JD 2435553.5 advanced by IAU 2006 general precession.
 * Rahu/Ketu: mean lunar node (Meeus). Houses: whole sign from the Lagna.
 * Results were cross-checked against Swiss Ephemeris 2.10 in Lahiri mode (see tests/astro.engine.test.ts).
 * Change CALCULATION_VERSION whenever a convention changes, so old reports stay reproducible and new ones recalculate.
 */
export const CALCULATION_VERSION = "knot-vedic-1";
export const CONVENTIONS = { zodiac: "sidereal", ayanamsa: "Lahiri", node: "mean", houses: "whole sign", positions: "geocentric apparent" };

export const RASHIS = ["Mesha", "Vrishabha", "Mithuna", "Karka", "Simha", "Kanya", "Tula", "Vrishchika", "Dhanu", "Makara", "Kumbha", "Meena"];
export const NAKSHATRAS = ["Ashwini", "Bharani", "Krittika", "Rohini", "Mrigashira", "Ardra", "Punarvasu", "Pushya", "Ashlesha", "Magha", "Purva Phalguni", "Uttara Phalguni", "Hasta", "Chitra", "Swati", "Vishakha", "Anuradha", "Jyeshtha", "Mula", "Purva Ashadha", "Uttara Ashadha", "Shravana", "Dhanishta", "Shatabhisha", "Purva Bhadrapada", "Uttara Bhadrapada", "Revati"];
const NAK_SPAN = 360 / 27;

export type TimeAccuracy = "EXACT" | "APPROXIMATE" | "UNKNOWN";
export interface BirthInput {
  date: string; // YYYY-MM-DD, local to the birthplace
  time: string | null; // HH:mm, local to the birthplace
  accuracy: TimeAccuracy;
  lat: number;
  lon: number;
  tz: string; // IANA zone
}

export interface MoonPlacement {
  rashi: number;
  nakshatra: number;
  pada: number;
}
export interface ChartData {
  version: string;
  conventions: typeof CONVENTIONS;
  accuracy: TimeAccuracy;
  sunRashi: number | null;
  moon: MoonPlacement | null;
  lagnaRashi: number | null;
  planets: { name: string; rashi: number | null; house: number | null }[];
  unavailable: { field: string; reason: string }[];
}

const norm = (d: number) => ((d % 360) + 360) % 360;
const rad = Math.PI / 180;

/** Offset of `tz` at a UTC instant, in minutes, from the runtime's IANA data (handles DST and historic changes). */
function offsetMinutes(utc: Date, tz: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(utc.getTime() / 1000) * 1000) / 60000;
}

/** Converts local wall-clock time at the birthplace to UTC. Two passes settle DST boundaries. */
export function localToUtc(date: string, time: string, tz: string) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let utc = wall - offsetMinutes(new Date(wall), tz) * 60000;
  utc = wall - offsetMinutes(new Date(utc), tz) * 60000;
  return new Date(utc);
}

const julianDay = (d: Date) => d.getTime() / 86400000 + 2440587.5;

/** General precession in longitude, IAU 2006, arcseconds (T in Julian centuries from J2000). */
const precession = (T: number) => 5028.796195 * T + 1.1054348 * T * T + 0.00007964 * T ** 3 - 0.000023857 * T ** 4;
const LAHIRI_EPOCH_T = (2435553.5 - 2451545) / 36525;
export function lahiriAyanamsa(utc: Date) {
  const T = (julianDay(utc) - 2451545) / 36525;
  return 23.245524743 + (precession(T) - precession(LAHIRI_EPOCH_T)) / 3600;
}

const BODIES: [string, Body][] = [
  ["Sun", Body.Sun],
  ["Moon", Body.Moon],
  ["Mars", Body.Mars],
  ["Mercury", Body.Mercury],
  ["Jupiter", Body.Jupiter],
  ["Venus", Body.Venus],
  ["Saturn", Body.Saturn],
];

/** Sidereal longitudes of the seven classical bodies plus the mean nodes. */
export function siderealLongitudes(utc: Date): Record<string, number> {
  const time = MakeTime(utc);
  const ayan = lahiriAyanamsa(utc);
  const out: Record<string, number> = {};
  for (const [name, body] of BODIES) out[name] = norm(Ecliptic(GeoVector(body, time, true)).elon - ayan);
  const T = (julianDay(utc) - 2451545) / 36525;
  const node = 125.0445479 - 1934.1362891 * T + 0.0020754 * T * T + (T * T * T) / 467441 - (T * T * T * T) / 60616000;
  out.Rahu = norm(node - ayan);
  out.Ketu = norm(node + 180 - ayan);
  return out;
}

/** Sidereal ascendant from Greenwich apparent sidereal time, latitude and longitude. */
export function siderealLagna(utc: Date, lat: number, lon: number) {
  const T = (julianDay(utc) - 2451545) / 36525;
  const eps = (23.4392911 - 0.0130042 * T) * rad;
  const ramc = norm(SiderealTime(MakeTime(utc)) * 15 + lon) * rad;
  const asc = Math.atan2(Math.cos(ramc), -(Math.sin(ramc) * Math.cos(eps) + Math.tan(lat * rad) * Math.sin(eps))) / rad;
  return norm(asc - lahiriAyanamsa(utc));
}

export const rashiOf = (lon: number) => Math.floor(lon / 30);
export function moonPlacement(lon: number): MoonPlacement {
  const nakshatra = Math.floor(lon / NAK_SPAN);
  return { rashi: rashiOf(lon), nakshatra, pada: Math.floor((lon - nakshatra * NAK_SPAN) / (NAK_SPAN / 4)) + 1 };
}

const same = <T>(values: T[]) => values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]));

/**
 * Calculates a chart, and states what can't be known. A placement is only reported if it holds across the whole
 * uncertainty window of the birth time: ±60 min when approximate, the entire local day when unknown.
 * Nothing is ever guessed: a birth time is never assumed.
 */
export function computeChart(b: BirthInput): ChartData {
  const unavailable: ChartData["unavailable"] = [];
  const windowed = b.accuracy === "UNKNOWN" || !b.time;
  const instants = windowed
    ? [localToUtc(b.date, "00:00", b.tz), localToUtc(b.date, "12:00", b.tz), localToUtc(b.date, "23:59", b.tz)]
    : b.accuracy === "APPROXIMATE"
      ? [-60, 0, 60].map((m) => new Date(localToUtc(b.date, b.time!, b.tz).getTime() + m * 60000))
      : [localToUtc(b.date, b.time!, b.tz)];
  const positions = instants.map(siderealLongitudes);
  const hedged = !same(instants.map((i) => i.getTime())) ? " across the possible birth times" : "";

  const moons = positions.map((p) => moonPlacement(p.Moon));
  let moon: MoonPlacement | null = same(moons) ? moons[0] : null;
  if (!moon) {
    const nak = moons.map((m) => m.nakshatra);
    const rashi = moons.map((m) => m.rashi);
    // Pada can move while the sign and star hold; those are what matter, but pada drives some traditional tables.
    if (same(nak) && same(rashi)) moon = { rashi: rashi[0], nakshatra: nak[0], pada: 0 };
    unavailable.push({ field: moon ? "Moon pada" : "Moon sign and nakshatra", reason: `The Moon changes position${hedged}; an exact birth time would settle this.` });
  }

  const suns = positions.map((p) => rashiOf(p.Sun));
  const sunRashi = same(suns) ? suns[0] : null;
  if (sunRashi === null) unavailable.push({ field: "Sun sign", reason: `The Sun changes sign${hedged}.` });

  let lagnaRashi: number | null = null;
  if (windowed) unavailable.push({ field: "Lagna and houses", reason: "These need a birth time." });
  else {
    const lagnas = instants.map((i) => rashiOf(siderealLagna(i, b.lat, b.lon)));
    if (same(lagnas)) lagnaRashi = lagnas[0];
    else unavailable.push({ field: "Lagna and houses", reason: "The rising sign changes within an hour either side of an approximate birth time." });
  }

  const planets = [...BODIES.map(([n]) => n), "Rahu", "Ketu"].map((name) => {
    const r = positions.map((p) => rashiOf(p[name]));
    const rashi = same(r) ? r[0] : null;
    return { name, rashi, house: rashi !== null && lagnaRashi !== null ? ((rashi - lagnaRashi + 12) % 12) + 1 : null };
  });
  return { version: CALCULATION_VERSION, conventions: CONVENTIONS, accuracy: b.accuracy, sunRashi, moon, lagnaRashi, planets, unavailable };
}
