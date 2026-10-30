import type { Intention } from "@prisma/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { setProvider, getProvider, type AIProvider } from "../src/modules/ai/provider.js";
import { purgeExpired } from "../src/modules/astro/service.js";
import { setIo } from "../src/realtime/bus.js";
import { anon, createUser, loginAs, match, resetDb } from "./helpers.js";

const BIRTH = { date: "1995-06-15", time: "09:30", accuracy: "EXACT", placeId: "in-new-delhi" };
const CONSENT = { shareSummary: true, externalAi: true, useInterests: false };
const GOOD = { overview: "A warm start worth exploring.", chartInsights: { personA: "Person A may value calm.", personB: "Person B may value clarity." }, emotionalConnection: "Tradition suggests some shared ground.", communication: "It may help to talk it through.", attraction: "Worth exploring together.", harmony: ["Both Moons share an element."], differences: ["Your Sun signs differ."], reflectionPrompts: ["What feels like home to you?"], narrative: "A story still being written.", starters: ["What makes you feel understood?", "What does home mean to you?", "Where would you go next?"] };

const original = getProvider();
function fake(reply: () => string): AIProvider & { calls: string[] } {
  const calls: string[] = [];
  return { name: "fake", enabled: true, calls, async generate({ prompt }) { calls.push(prompt); return { text: reply(), model: "fake-model" }; } };
}
async function waitFor(agent: Awaited<ReturnType<typeof loginAs>>, id: string, statuses: string[]) {
  for (let i = 0; i < 100; i++) {
    const r = await agent.get(`/api/astro/matches/${id}`);
    if (statuses.includes(r.body.data.status)) return r.body.data;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("timed out waiting for astro status");
}
async function pair(a: Intention[] = ["MARRIAGE"], b: Intention[] = ["MARRIAGE"]) {
  const ua = await createUser({ name: "Asha", gender: "WOMAN", intentions: a });
  const ub = await createUser({ name: "Vikram", gender: "MAN", intentions: b });
  const m = await match(ua, ub);
  return { ua, ub, id: m.matchId, A: await loginAs(ua), B: await loginAs(ub) };
}
async function bothConsent(p: Awaited<ReturnType<typeof pair>>, birthB = { ...BIRTH, date: "1993-11-02", time: "18:10" }) {
  await p.A.post(`/api/astro/matches/${p.id}/opt-in`).expect(200);
  await p.B.post(`/api/astro/matches/${p.id}/opt-in`).expect(200);
  await p.A.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth: BIRTH }).expect(200);
  await p.B.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth: birthB }).expect(200);
}

beforeAll(resetDb);
beforeEach(resetDb);
afterEach(() => setProvider(original));

describe("eligibility", () => {
  const cases: [Intention[], Intention[], boolean][] = [
    [["MARRIAGE"], ["MARRIAGE"], true],
    [["MARRIAGE"], ["SITUATIONSHIP"], false],
    [["SITUATIONSHIP"], ["MARRIAGE"], false],
    [["MARRIAGE"], ["SINGLE"], false],
    [["SINGLE"], ["MARRIAGE"], false],
    [["SINGLE"], ["SINGLE"], false],
    [["SITUATIONSHIP"], ["SITUATIONSHIP"], false],
    [["SINGLE"], ["SITUATIONSHIP"], false],
  ];
  it.each(cases)("%j + %j → %s", async (a, b, expected) => {
    const p = await pair(a, b);
    const state = (await p.A.get(`/api/astro/matches/${p.id}`).expect(200)).body.data;
    expect(state.available).toBe(expected);
    const opt = await p.A.post(`/api/astro/matches/${p.id}/opt-in`);
    const consent = await p.A.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth: BIRTH });
    if (expected) {
      expect(opt.status).toBe(200);
    } else {
      // A direct API call can't get past the server, nothing is stored, and chat is unaffected.
      expect(opt.status).toBe(403);
      expect(consent.status).toBe(403);
      expect(await prisma.astroProfile.count()).toBe(0);
      expect(await prisma.astroSession.count()).toBe(0);
    }
    const convos = await p.A.get("/api/conversations").expect(200);
    expect(convos.body.data.length).toBe(1);
  });

  it("the like response reports availability from saved intentions", async () => {
    const ua = await createUser({ intentions: ["MARRIAGE"], gender: "WOMAN", interestedIn: ["MAN"] });
    const ub = await createUser({ intentions: ["MARRIAGE"], gender: "MAN", interestedIn: ["WOMAN"] });
    const A = await loginAs(ua);
    const B = await loginAs(ub);
    await A.post("/api/likes").send({ userId: ub.id }).expect(201);
    const r = await B.post("/api/likes").send({ userId: ua.id }).expect(201);
    expect(r.body.data).toMatchObject({ matched: true, astroAvailable: true });
  });

  it("never changes a saved intention, and later changes stop new sessions", async () => {
    const p = await pair();
    await p.B.patch("/api/profiles/me").send({ intentions: ["SINGLE"] }).expect(200);
    await p.A.post(`/api/astro/matches/${p.id}/opt-in`).expect(403);
    expect((await p.A.get(`/api/astro/matches/${p.id}`)).body.data.available).toBe(false);
    expect((await p.A.get("/api/profiles/me")).body.data.intentions).toEqual(["MARRIAGE"]);
  });
});

describe("flow", () => {
  it("generates one report from real calculations, visible to both, without exposing birth details", async () => {
    const provider = fake(() => JSON.stringify(GOOD));
    setProvider(provider);
    const p = await pair();
    await p.A.post(`/api/astro/matches/${p.id}/opt-in`);
    const after = (await p.B.get(`/api/astro/matches/${p.id}`)).body.data;
    expect(after.theirState).toBe("INTERESTED");
    await p.B.post(`/api/astro/matches/${p.id}/opt-in`);
    await p.A.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth: BIRTH }).expect(200);
    expect((await p.A.get(`/api/astro/matches/${p.id}`)).body.data.status).toBe("COLLECTING");
    await p.B.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth: { ...BIRTH, date: "1993-11-02", time: "18:10" } }).expect(200);
    await waitFor(p.A, p.id, ["READY"]);

    const ra = (await p.A.get(`/api/astro/matches/${p.id}/report`).expect(200)).body.data;
    const rb = (await p.B.get(`/api/astro/matches/${p.id}/report`).expect(200)).body.data;
    expect(ra.me.name).toBe("Asha");
    expect(ra.them.name).toBe("Vikram");
    expect(ra.guna.max).toBe(36);
    expect(ra.guna.kootas).toHaveLength(8);
    expect(ra.guna.total).toBe(ra.guna.kootas.reduce((s: number, k: { score: number }) => s + k.score, 0));
    expect(ra.guna.total).toBe(rb.guna.total);
    expect(ra.me.moon).toBe(rb.them.moon);
    expect(JSON.stringify(ra.interpretation)).not.toContain("Person A");
    expect(JSON.stringify(ra.interpretation)).toMatch(/Asha may value|Vikram may value/);

    const leak = JSON.stringify(rb);
    expect(leak).not.toMatch(/1995|09:30|New Delhi|in-new-delhi|cipher/);
    const raw = await prisma.astroProfile.findUniqueOrThrow({ where: { userId: p.ua.id } });
    expect(raw.birthCipher).not.toContain("1995");
    expect(provider.calls[0]).not.toMatch(/1995|1993|09:30|18:10|\bAsha\b|Vikram|Delhi/);
    expect(JSON.stringify((await p.B.get(`/api/profiles/${p.ua.id}`)).body)).not.toMatch(/cipher|09:30/);
    expect(await prisma.astroReport.count()).toBe(1);
  });

  it("repeated and concurrent requests don't create duplicates or extra AI calls", async () => {
    const provider = fake(() => JSON.stringify(GOOD));
    setProvider(provider);
    const p = await pair();
    await bothConsent(p);
    await Promise.all([p.A.post(`/api/astro/matches/${p.id}/consent`).send(CONSENT), p.B.post(`/api/astro/matches/${p.id}/consent`).send(CONSENT)]);
    await waitFor(p.A, p.id, ["READY"]);
    await p.A.post(`/api/astro/matches/${p.id}/consent`).send(CONSENT).expect(200);
    await p.A.get(`/api/astro/matches/${p.id}/report`);
    expect(provider.calls).toHaveLength(1);
    expect(await prisma.astroReport.count()).toBe(1);
    await p.A.post(`/api/astro/matches/${p.id}/retry`).expect(400);
  });

  it("handles a missing birth time with a partial reading that says what's missing", async () => {
    setProvider(fake(() => JSON.stringify(GOOD)));
    const p = await pair();
    await bothConsent(p, { date: "1993-11-02", time: null, accuracy: "UNKNOWN", placeId: "in-mumbai" } as never);
    await waitFor(p.A, p.id, ["READY"]);
    const r = (await p.A.get(`/api/astro/matches/${p.id}/report`)).body.data;
    expect(r.them.lagna).toBeNull();
    expect(r.them.unavailable.map((u: { field: string }) => u.field)).toContain("Lagna and houses");
    expect(r.me.lagna).not.toBeNull();
  });

  it("declines to score Guna Milan for pairings the tradition doesn't define, and explains why", async () => {
    setProvider(fake(() => JSON.stringify(GOOD)));
    const ua = await createUser({ name: "Asha", gender: "WOMAN", intentions: ["MARRIAGE"] });
    const ub = await createUser({ name: "Meera", gender: "WOMAN", intentions: ["MARRIAGE"] });
    const m = await match(ua, ub);
    const p = { ua, ub, id: m.matchId, A: await loginAs(ua), B: await loginAs(ub) };
    await bothConsent(p);
    await waitFor(p.A, p.id, ["READY"]);
    const r = (await p.A.get(`/api/astro/matches/${p.id}/report`)).body.data;
    expect(r.guna).toBeNull();
    expect(r.gunaUnavailableReason).toMatch(/bride and groom/);
  });

  it("a declined invitation stops astrology and chat stays open", async () => {
    const p = await pair();
    await p.A.post(`/api/astro/matches/${p.id}/decline`).expect(200);
    expect((await p.B.get(`/api/astro/matches/${p.id}`)).body.data.theirState).toBe("NOT_PARTICIPATING");
    const c = (await p.A.get("/api/conversations")).body.data[0];
    await p.A.post(`/api/conversations/${c.id}/messages`).send({ body: "Hello" }).expect(201);
  });
});

describe("failures", () => {
  it.each([
    ["no provider configured", () => { /* default provider is off */ }, "NOT_CONFIGURED"],
    ["provider error", () => setProvider(fake(() => { throw new Error("down"); })), "FAILED"],
    ["invalid JSON", () => setProvider(fake(() => "not json")), "FAILED"],
    ["unsafe content", () => setProvider(fake(() => JSON.stringify({ ...GOOD, narrative: "You are destined to be together." }))), "FAILED"],
  ])("%s keeps the match, chat and calculated report", async (_n, arrange, failure) => {
    arrange();
    const p = await pair();
    await bothConsent(p);
    const s = await waitFor(p.A, p.id, ["PARTIAL"]);
    expect(s.failure).toBe(failure);
    const r = (await p.A.get(`/api/astro/matches/${p.id}/report`).expect(200)).body.data;
    expect(r.interpretation).toBeNull();
    expect(r.me.moon).toBeTruthy();
    const c = (await p.B.get("/api/conversations")).body.data[0];
    await p.B.post(`/api/conversations/${c.id}/messages`).send({ body: "Hi" }).expect(201);
  });

  it("retry fills in the interpretation, with a limit", async () => {
    let bad = true;
    const provider = fake(() => { if (bad) throw new Error("down"); return JSON.stringify(GOOD); });
    setProvider(provider);
    const p = await pair();
    await bothConsent(p);
    await waitFor(p.A, p.id, ["PARTIAL"]);
    await p.A.post(`/api/astro/matches/${p.id}/retry`).expect(200);
    await waitFor(p.A, p.id, ["PARTIAL"]);
    bad = false;
    await p.A.post(`/api/astro/matches/${p.id}/retry`).expect(200);
    await waitFor(p.A, p.id, ["READY"]);
    expect((await p.A.get(`/api/astro/matches/${p.id}/report`)).body.data.interpretation.overview).toBeTruthy();
    expect(await prisma.astroReport.count()).toBe(1);
  });

  it("a withdrawal during generation wins: nothing is kept", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    setProvider({ name: "slow", enabled: true, generate: async () => { await gate; return { text: JSON.stringify(GOOD), model: "m" }; } });
    const p = await pair();
    await bothConsent(p);
    await waitFor(p.A, p.id, ["INTERPRETING"]);
    await p.A.post(`/api/astro/matches/${p.id}/withdraw`).expect(200);
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect((await p.B.get(`/api/astro/matches/${p.id}`)).body.data.status).toBe("WITHDRAWN");
    expect(await prisma.astroReport.count()).toBe(0);
  });

  it("skips the provider when someone didn't consent to external AI", async () => {
    const provider = fake(() => JSON.stringify(GOOD));
    setProvider(provider);
    const p = await pair();
    await p.A.post(`/api/astro/matches/${p.id}/opt-in`);
    await p.B.post(`/api/astro/matches/${p.id}/opt-in`);
    await p.A.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, externalAi: false, birth: BIRTH });
    await p.B.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth: BIRTH });
    const s = await waitFor(p.A, p.id, ["PARTIAL"]);
    expect(s.failure).toBe("NO_CONSENT");
    expect(s.canRetry).toBe(false);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("access and privacy", () => {
  it("outsiders and logged-out visitors can't see state or reports", async () => {
    setProvider(fake(() => JSON.stringify(GOOD)));
    const p = await pair();
    await bothConsent(p);
    await waitFor(p.A, p.id, ["READY"]);
    const stranger = await loginAs(await createUser({ intentions: ["MARRIAGE"] }));
    await stranger.get(`/api/astro/matches/${p.id}`).expect(404);
    await stranger.get(`/api/astro/matches/${p.id}/report`).expect(404);
    await stranger.post(`/api/astro/matches/${p.id}/opt-in`).expect(404);
    await anon().get(`/api/astro/matches/${p.id}`).expect(401);
  });

  it("the report is gone before both people have consented", async () => {
    const p = await pair();
    await p.A.post(`/api/astro/matches/${p.id}/opt-in`);
    await p.A.get(`/api/astro/matches/${p.id}/report`).expect(404);
  });

  it("withdrawing removes the joint report for both", async () => {
    setProvider(fake(() => JSON.stringify(GOOD)));
    const p = await pair();
    await bothConsent(p);
    await waitFor(p.A, p.id, ["READY"]);
    await p.A.post(`/api/astro/matches/${p.id}/withdraw`).expect(200);
    await p.B.get(`/api/astro/matches/${p.id}/report`).expect(404);
    expect(await prisma.astroReport.count()).toBe(0);
    expect((await p.B.get(`/api/astro/matches/${p.id}`)).body.data.status).toBe("WITHDRAWN");
  });

  it("deleting astrology data erases birth details, charts and reports", async () => {
    setProvider(fake(() => JSON.stringify(GOOD)));
    const p = await pair();
    await bothConsent(p);
    await waitFor(p.A, p.id, ["READY"]);
    await p.A.delete("/api/astro/me").expect(200);
    expect(await prisma.astroProfile.count({ where: { userId: p.ua.id } })).toBe(0);
    expect(await prisma.astroChart.count({ where: { userId: p.ua.id } })).toBe(0);
    expect(await prisma.astroReport.count()).toBe(0);
    await p.B.get(`/api/astro/matches/${p.id}/report`).expect(404);
    expect(await prisma.astroProfile.count({ where: { userId: p.ub.id } })).toBe(1);
  });

  it("unmatching removes the joint report", async () => {
    setProvider(fake(() => JSON.stringify(GOOD)));
    const p = await pair();
    await bothConsent(p);
    await waitFor(p.A, p.id, ["READY"]);
    await p.A.delete(`/api/matches/${p.id}`).expect(200);
    expect(await prisma.astroSession.count()).toBe(0);
    await p.A.get(`/api/astro/matches/${p.id}/report`).expect(404);
  });

  it("birth details can't be silently replaced", async () => {
    const p = await pair();
    await p.A.post(`/api/astro/matches/${p.id}/opt-in`);
    await p.A.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth: BIRTH }).expect(200);
    await p.A.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth: { ...BIRTH, time: "10:00" } }).expect(409);
  });

  it("validates input", async () => {
    const p = await pair();
    const post = (birth: object) => p.A.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth });
    await post({ ...BIRTH, placeId: "nowhere" }).expect(400);
    await post({ ...BIRTH, date: "2999-01-01" }).expect(400);
    await post({ ...BIRTH, time: "25:00" }).expect(422);
    await post({ ...BIRTH, time: null }).expect(400);
    await p.A.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, shareSummary: false, birth: BIRTH }).expect(422);
  });

  it("retention removes details unused past the limit", async () => {
    const p = await pair();
    await p.A.post(`/api/astro/matches/${p.id}/consent`).send({ ...CONSENT, birth: BIRTH });
    await prisma.astroProfile.update({ where: { userId: p.ua.id }, data: { lastUsedAt: new Date(Date.now() - 400 * 86400000) } });
    expect(await purgeExpired()).toBe(1);
    expect(await prisma.astroProfile.count()).toBe(0);
  });

  it("realtime says what changed, and carries no birth details", async () => {
    const events: [string, unknown][] = [];
    setIo({ to: () => ({ emit: (e: string, payload: unknown) => events.push([e, payload]) }) } as never);
    setProvider(fake(() => JSON.stringify(GOOD)));
    const p = await pair();
    await bothConsent(p);
    await waitFor(p.A, p.id, ["READY"]);
    setIo(null);
    const astro = events.filter(([e]) => e === "astro:update").map(([, x]) => x as { status: string });
    expect(astro.map((x) => x.status)).toEqual(expect.arrayContaining(["AWAITING_CONSENT", "COLLECTING", "CALCULATING", "INTERPRETING", "READY"]));
    expect(events.some(([e, x]) => e === "notification" && JSON.stringify(x).includes("Cosmic Connection"))).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/1995|1993|09:30|18:10|in-new-delhi|Rashi|nakshatra/i);
  });
});
