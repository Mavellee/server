import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { zodiacSign } from "../src/lib/zodiac.js";
import { createUser, loginAs, match, resetDb } from "./helpers.js";

async function pair(intentions: ("SINGLE" | "SITUATIONSHIP" | "MARRIAGE")[] = ["SINGLE"]) {
  const ua = await createUser({ name: "Asha", gender: "WOMAN", interestedIn: ["MAN"], intentions });
  const ub = await createUser({ name: "Vikram", gender: "MAN", interestedIn: ["WOMAN"], intentions });
  const m = await match(ua, ub);
  return { ua, ub, id: m.matchId, A: await loginAs(ua), B: await loginAs(ub) };
}
async function together() {
  const p = await pair();
  await p.A.post(`/api/couple/matches/${p.id}/request`).expect(200);
  await p.B.post(`/api/couple/matches/${p.id}/accept`).expect(200);
  return p;
}
const paused = async (userId: string) => !!(await prisma.profile.findUnique({ where: { userId } }))?.discoveryPausedAt;

beforeEach(resetDb);

describe("zodiac", () => {
  it("works out the sign at every boundary", () => {
    const at = (d: string) => zodiacSign(new Date(d)).name;
    expect(at("1995-01-19")).toBe("Capricorn");
    expect(at("1995-01-20")).toBe("Aquarius");
    expect(at("1995-08-22")).toBe("Leo");
    expect(at("1995-08-23")).toBe("Virgo");
    expect(at("1995-12-21")).toBe("Sagittarius");
    expect(at("1995-12-22")).toBe("Capricorn");
  });

  it("is off by default, opt-in, and never exposes the birth date", async () => {
    const p = await pair();
    let r = await p.B.get(`/api/profiles/${p.ua.id}`).expect(200);
    expect(r.body.data.zodiac).toBeNull();
    await p.A.patch("/api/settings").send({ showZodiacSign: true }).expect(200);
    r = await p.B.get(`/api/profiles/${p.ua.id}`).expect(200);
    expect(r.body.data.zodiac.name).toBeTruthy();
    expect(JSON.stringify(r.body.data)).not.toContain("dateOfBirth");
  });

  it("does not apply to long-term-only members", async () => {
    const p = await pair(["MARRIAGE"]);
    await p.A.patch("/api/settings").send({ showZodiacSign: true }).expect(200);
    expect((await p.B.get(`/api/profiles/${p.ua.id}`)).body.data.zodiac).toBeNull();
    expect((await p.A.get("/api/settings")).body.data.zodiac).toBeNull();
  });

  it("shows the pair card only when both people opted in", async () => {
    const p = await pair();
    await p.A.patch("/api/settings").send({ showZodiacSign: true }).expect(200);
    expect((await p.A.get(`/api/matches/${p.id}/zodiac`)).body.data).toBeNull();
    await p.B.patch("/api/settings").send({ showZodiacSign: true }).expect(200);
    expect((await p.A.get(`/api/matches/${p.id}/zodiac`)).body.data.line).toBeTruthy();
  });
});

describe("we're together", () => {
  it("needs the other person's confirmation; the asker can't accept", async () => {
    const p = await pair(["MARRIAGE"]);
    expect((await p.A.get("/api/couple/me")).body.data).toBeNull();
    await p.A.post(`/api/couple/matches/${p.id}/request`).expect(200);
    await p.A.post(`/api/couple/matches/${p.id}/accept`).expect(409);
    expect((await p.A.get("/api/couple/me")).body.data).toBeNull();
    await p.B.post(`/api/couple/matches/${p.id}/accept`).expect(200);
    expect((await p.A.get("/api/couple/me")).body.data.partner.id).toBe(p.ub.id);
  });

  it("leaves intentions untouched", async () => {
    const p = await together();
    const rows = await prisma.relationshipPreference.findMany({ where: { userId: p.ua.id, kind: "OWN" } });
    expect(rows.map((r) => r.intention)).toEqual(["SINGLE"]);
  });

  it("rejects outsiders", async () => {
    const p = await pair();
    const out = await loginAs(await createUser({ name: "Other" }));
    await out.post(`/api/couple/matches/${p.id}/request`).expect(404);
    await out.get("/api/couple/doodles").expect(404);
  });

  it("stops a repeat ask for a week after a no, without saying why", async () => {
    const p = await pair();
    await p.A.post(`/api/couple/matches/${p.id}/request`).expect(200);
    await p.B.post(`/api/couple/matches/${p.id}/decline`).expect(200);
    const r = await p.A.post(`/api/couple/matches/${p.id}/request`).expect(409);
    expect(r.body.error.message).toBe("This request can't be sent right now.");
    await p.B.post(`/api/couple/matches/${p.id}/request`).expect(200);
  });

  it("allows only one relationship at a time", async () => {
    const p = await together();
    const third = await createUser({ name: "Third", gender: "WOMAN", interestedIn: ["MAN"] });
    const m = await match(third, p.ub);
    await p.B.post(`/api/couple/matches/${m.matchId}/request`).expect(409);
    const T = await loginAs(third);
    await T.post(`/api/couple/matches/${m.matchId}/request`).expect(409);
  });

  it("hides both from Discover while together, whatever their pause setting", async () => {
    const viewer = await createUser({ name: "Viewer", gender: "MAN", interestedIn: ["WOMAN"], intentions: ["SINGLE"] });
    const V = await loginAs(viewer);
    const p = await pair();
    const ids = async () => JSON.stringify((await V.get("/api/discovery")).body.data);
    expect(await ids()).toContain(p.ua.id);
    await p.A.post(`/api/couple/matches/${p.id}/request`).expect(200);
    await p.B.post(`/api/couple/matches/${p.id}/accept`).expect(200);
    await p.A.post("/api/settings/discovery").send({ paused: false }).expect(200);
    expect(await ids()).not.toContain(p.ua.id);
  });

  it("either person can end it alone; both stay hidden until each returns", async () => {
    const p = await together();
    await p.B.post(`/api/couple/matches/${p.id}/end`).expect(200);
    expect((await p.A.get("/api/couple/me")).body.data).toBeNull();
    await p.A.get("/api/couple/doodles").expect(404);
    expect(await paused(p.ua.id)).toBe(true);
    expect(await paused(p.ub.id)).toBe(true);
    // The chat is unaffected.
    expect((await prisma.match.findUnique({ where: { id: p.id } }))?.status).toBe("ACTIVE");
    await p.A.post("/api/settings/discovery").send({ paused: false }).expect(200);
    expect(await paused(p.ua.id)).toBe(false);
    expect(await paused(p.ub.id)).toBe(true);
  });

  it("closes when the match ends through a block", async () => {
    const p = await together();
    await p.A.post("/api/safety/blocks").send({ userId: p.ub.id }).expect((r) => expect(r.status).toBeLessThan(300));
    expect((await prisma.relationship.findUnique({ where: { matchId: p.id } }))?.status).toBe("ENDED");
    await p.B.get("/api/couple/me").expect(200);
    expect((await p.B.get("/api/couple/me")).body.data).toBeNull();
  });
});

describe("couple games", () => {
  it("never appear in the general catalogue and can't be started by a non-couple", async () => {
    const p = await pair();
    const slugs = (await p.A.get("/api/games/catalog")).body.data.map((g: { slug: string }) => g.slug);
    expect(slugs).not.toContain("couple-know-me");
    const conv = await prisma.conversation.findFirstOrThrow({ where: { matchId: p.id } });
    await p.A.post(`/api/conversations/${conv.id}/games`).send({ gameSlug: "couple-know-me" }).expect(404);
  });

  it("scores agreement only on options that mean the same to both players", async () => {
    // "Me" from both players would count as agreeing, when they are actually disagreeing.
    const qs = await prisma.gameQuestion.findMany({ where: { isActive: true, game: { slug: "couple-this-or-that" } } });
    expect(qs.length).toBeGreaterThan(0);
    for (const q of qs) for (const o of q.options as string[]) expect(o).not.toMatch(/\b(me|you)\b/i);
  });

  it("can be played by a couple and are cancelled when it ends", async () => {
    const p = await together();
    const space = (await p.A.get("/api/couple/me")).body.data;
    expect(space.games).toHaveLength(3);
    await p.A.post(`/api/conversations/${space.conversationId}/games`).send({ gameSlug: "couple-this-or-that" }).expect(201);
    await p.A.post(`/api/couple/matches/${p.id}/end`).expect(200);
    const s = await prisma.gameSession.findFirstOrThrow({ where: { conversationId: space.conversationId } });
    expect(s.status).toBe("CANCELLED");
  });
});

describe("doodles", () => {
  it("are shared between the couple and closed after it ends", async () => {
    const p = await together();
    const d = (await p.A.post("/api/couple/doodles").expect(201)).body.data;
    const { addStroke, undoStroke } = await import("../src/modules/couple/service.js");
    const stroke = { id: "stroke-1", c: "#641E32", s: 14, e: false, p: [1, 2, 3, 4] };
    await addStroke(p.ua.id, d.id, stroke);
    await addStroke(p.ub.id, d.id, { ...stroke, id: "stroke-2" });
    expect((await p.B.get(`/api/couple/doodles/${d.id}`)).body.data.strokes).toHaveLength(2);
    // Undo only ever removes your own stroke.
    expect((await undoStroke(p.ua.id, d.id)).strokeId).toBe("stroke-1");
    expect((await undoStroke(p.ua.id, d.id)).strokeId).toBeNull();
    await p.A.post(`/api/couple/matches/${p.id}/end`).expect(200);
    await p.B.get(`/api/couple/doodles/${d.id}`).expect(404);
    await expect(addStroke(p.ua.id, d.id, stroke)).rejects.toThrow();
    expect(await prisma.doodle.count({ where: { id: d.id } })).toBe(1);
  });
});
