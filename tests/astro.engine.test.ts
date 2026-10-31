import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider } from "../src/modules/ai/provider.js";
import { computeChart, lahiriAyanamsa, localToUtc, moonPlacement, siderealLagna, siderealLongitudes } from "../src/modules/astro/engine.js";
import { gunaMilan } from "../src/modules/astro/gunaMilan.js";
import { PLACES } from "../src/modules/astro/places.js";
import { interpretationSchema, violatesPolicy, buildPrompt } from "../src/modules/astro/interpret.js";

const load = (f: string) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8"));
const diff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe("calculation engine", () => {
  // Reference values generated with Swiss Ephemeris 2.10 (Moshier, Lahiri), a tool not shipped with Mavelle.
  const rows: { utc: string; lat: number; lon: number; pos: Record<string, number>; asc: number; ayan: number }[] = load("astro-swiss-reference.json");
  it("matches Swiss Ephemeris to within 0.01° for every body, the ascendant and the ayanamsa", () => {
    for (const r of rows) {
      const u = new Date(r.utc);
      const p = siderealLongitudes(u);
      for (const k of Object.keys(r.pos)) expect(diff(p[k], r.pos[k])).toBeLessThan(0.01);
      expect(diff(siderealLagna(u, r.lat, r.lon), r.asc)).toBeLessThan(0.01);
      expect(Math.abs(lahiriAyanamsa(u) - r.ayan)).toBeLessThan(0.001);
    }
  });

  it("converts local time with the birthplace's offset, including daylight saving", () => {
    expect(localToUtc("1995-06-15", "12:00", "Asia/Kolkata").toISOString()).toBe("1995-06-15T06:30:00.000Z");
    expect(localToUtc("1995-01-15", "12:00", "America/New_York").toISOString()).toBe("1995-01-15T17:00:00.000Z");
    expect(localToUtc("1995-07-15", "12:00", "America/New_York").toISOString()).toBe("1995-07-15T16:00:00.000Z");
  });

  it("derives nakshatra and pada at the boundaries", () => {
    expect(moonPlacement(0)).toEqual({ rashi: 0, nakshatra: 0, pada: 1 });
    expect(moonPlacement(13.34)).toEqual({ rashi: 0, nakshatra: 1, pada: 1 });
    expect(moonPlacement(359.9)).toEqual({ rashi: 11, nakshatra: 26, pada: 4 });
  });

  const base = { date: "1995-06-15", lat: 28.61, lon: 77.21, tz: "Asia/Kolkata" };
  it("gives a Lagna only with a birth time, and never assumes one", () => {
    const exact = computeChart({ ...base, time: "09:30", accuracy: "EXACT" });
    expect(exact.lagnaRashi).not.toBeNull();
    expect(exact.planets.find((p) => p.name === "Sun")?.house).not.toBeNull();
    const unknown = computeChart({ ...base, time: null, accuracy: "UNKNOWN" });
    expect(unknown.lagnaRashi).toBeNull();
    expect(unknown.planets.every((p) => p.house === null)).toBe(true);
    expect(unknown.unavailable.map((u) => u.field)).toContain("Lagna and houses");
  });

  it("withholds the Moon rather than guessing when it changes during an unknown birth day", () => {
    // Across thousands of days, an unknown time must never yield a Moon that disagrees with some time that day.
    for (let d = 1; d <= 28; d++) {
      const date = `2000-03-${String(d).padStart(2, "0")}`;
      const c = computeChart({ ...base, date, time: null, accuracy: "UNKNOWN" });
      const early = computeChart({ ...base, date, time: "00:05", accuracy: "EXACT" });
      if (c.moon) expect(c.moon.nakshatra).toBe(early.moon!.nakshatra);
      else expect(c.unavailable.some((u) => u.field.includes("Moon"))).toBe(true);
    }
  });

  it("is reproducible and versioned", () => {
    const b = { ...base, time: "09:30", accuracy: "EXACT" as const };
    expect(computeChart(b)).toEqual(computeChart(b));
    expect(computeChart(b).version).toBe("knot-vedic-1");
  });
});

describe("Guna Milan", () => {
  const place = (n: number, p: number) => ({ nakshatra: n - 1, pada: p, rashi: Math.floor((((n - 1) * 360) / 27 + ((p - 0.5) * 90) / 27) / 30) });
  // Reference values from the published PyJHora dataset, for the five kootas where it follows the tradition as written.
  const refs: { boy: [number, number]; girl: [number, number]; vashya: number; gana: number; yoni: number; maitri: number; nadi: number }[] = load("astro-guna-reference.json");
  it("agrees with reference data on Vashya, Gana, Yoni, Maitri and Nadi", () => {
    for (const r of refs) {
      const g = gunaMilan(place(...r.boy), place(...r.girl));
      const score = (k: string) => g.kootas.find((x) => x.key === k)!.score;
      expect([score("vashya"), score("gana"), score("yoni"), score("maitri"), score("nadi")]).toEqual([r.vashya, r.gana, r.yoni, r.maitri, r.nadi]);
    }
  });
  const of = (a: ReturnType<typeof place>, b: ReturnType<typeof place>, k: string) => gunaMilan(a, b).kootas.find((x) => x.key === k)!.score;
  it("applies the classical rules", () => {
    expect(of(place(1, 1), place(1, 1), "nadi")).toBe(0); // same nadi
    expect(of(place(1, 1), place(1, 1), "tara")).toBe(3); // Janma both ways
    expect(of(place(1, 1), place(3, 2), "tara")).toBeLessThan(3); // 3rd star is Vipat one way
    expect(of(place(1, 1), place(4, 1), "bhakoot")).toBe(0); // Mesha / Vrishabha sit 2/12
    expect(of(place(1, 1), place(1, 1), "bhakoot")).toBe(7);
    expect(of(place(9, 1), place(1, 1), "varna")).toBe(1); // Brahmin groom, Kshatriya bride
    expect(of(place(1, 1), place(9, 1), "varna")).toBe(0); // the reverse
  });
  it("never exceeds the traditional maximums", () => {
    for (const r of refs) {
      const g = gunaMilan(place(...r.boy), place(...r.girl));
      expect(g.total).toBeLessThanOrEqual(36);
      for (const k of g.kootas) expect(k.score).toBeLessThanOrEqual(k.max);
    }
  });
});

describe("interpretation guards", () => {
  const good = { overview: "A warm start worth exploring.", chartInsights: { personA: "Person A may value calm.", personB: "Person B may value clarity." }, emotionalConnection: "Tradition suggests some shared ground.", communication: "It may help to talk it through.", attraction: "Worth exploring together.", harmony: ["Both Moons share an element."], differences: ["Your Sun signs differ."], reflectionPrompts: ["What feels like home to you?"], narrative: "A story still being written.", starters: ["What makes you feel understood?", "What does home mean to you?", "Where would you go next?"] };
  it("accepts a valid reply and rejects a malformed one", () => {
    expect(interpretationSchema.safeParse(good).success).toBe(true);
    expect(interpretationSchema.safeParse({ ...good, starters: ["one question only here"] }).success).toBe(false);
  });
  it.each(["You are destined to be together.", "Person A will cheat.", "This pairing is unsuitable for marriage.", "You are 82% compatible.", "A guarantee of happiness.", "The traditional total is low.", "A low Guna Milan total.", "Three kootas score zero.", "Astrologers might urge careful attention."])("rejects %s", (bad) => {
    expect(violatesPolicy({ ...good, narrative: bad })).toBe(true);
  });
  it("keeps the overview short", () => {
    expect(interpretationSchema.safeParse({ ...good, overview: "word ".repeat(120) }).success).toBe(false);
  });
  it("sends the provider sign-level data only", () => {
    const c = computeChart({ date: "1995-06-15", time: "09:30", accuracy: "EXACT", lat: 28.61, lon: 77.21, tz: "Asia/Kolkata" });
    const prompt = buildPrompt(c, c, null, []);
    expect(prompt).not.toMatch(/1995|09:30|28\.61|Delhi|Kolkata/);
  });
});

describe("birthplaces", () => {
  it("gives every place a valid time zone, its right country and a unique id", () => {
    expect(new Set(PLACES.map((p) => p.id)).size).toBe(PLACES.length);
    for (const p of PLACES) expect(() => new Intl.DateTimeFormat("en", { timeZone: p.tz })).not.toThrow();
    expect(PLACES.filter((p) => p.city === "London").map((p) => [p.country, p.tz])).toEqual([["United Kingdom", "Europe/London"]]);
    expect(PLACES.filter((p) => p.country === "India").every((p) => p.tz === "Asia/Kolkata" && p.lon > 68 && p.lon < 98)).toBe(true);
  });
});

describe("provider requests", () => {
  const send = async (tuning: boolean) => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] })));
    vi.stubGlobal("fetch", fetchMock);
    await new OpenAICompatibleProvider("https://example.test/v1", "k", "m", tuning).generate({ system: "s", prompt: "p", maxChars: 100, signal: new AbortController().signal, json: true });
    vi.unstubAllGlobals();
    return JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
  };
  it("sends JSON mode and temperature only where the API accepts them", async () => {
    expect(await send(true)).toMatchObject({ temperature: 0.7, response_format: { type: "json_object" } });
    const anthropic = await send(false);
    expect(anthropic).not.toHaveProperty("temperature");
    expect(anthropic).not.toHaveProperty("response_format");
  });
});
