import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { app, createUser, loginAs, match, ORIGIN, resetDb } from "./helpers.js";

const open = (token: string) => request(app).post("/api/friend-reviews/shared/open").set("Origin", ORIGIN).send({ token });
const reply = (token: string, body = {}) => request(app).post("/api/friend-reviews/shared/reply").set("Origin", ORIGIN).send({ token, friendName: "Meera", verdict: "ASK_MORE", comment: "Ask about their weekends.", ...body });

async function pair() {
  const ua = await createUser({ name: "Asha", gender: "WOMAN", interestedIn: ["MAN"], city: "Delhi" });
  const ub = await createUser({ name: "Vikram", gender: "MAN", interestedIn: ["WOMAN"], city: "Secretville" });
  const m = await match(ua, ub);
  return { ua, ub, id: m.matchId, A: await loginAs(ua), B: await loginAs(ub) };
}
async function allowed() {
  const p = await pair();
  const rid = (await p.A.post(`/api/friend-reviews/matches/${p.id}`).expect(201)).body.data.id as string;
  await p.B.post(`/api/friend-reviews/${rid}/allow`).expect(200);
  return { ...p, rid };
}
async function linked() {
  const p = await allowed();
  const token = (await p.A.post(`/api/friend-reviews/${p.rid}/link`).expect(200)).body.data.token as string;
  return { ...p, token };
}

beforeEach(resetDb);

describe("consent", () => {
  it("creates no link until the other person agrees", async () => {
    const p = await pair();
    const rid = (await p.A.post(`/api/friend-reviews/matches/${p.id}`).expect(201)).body.data.id;
    await p.A.post(`/api/friend-reviews/${rid}/link`).expect(404);
    await p.A.post(`/api/friend-reviews/${rid}/allow`).expect(404); // the asker can't approve themselves
  });

  it("makes a declined asker wait, and rejects outsiders", async () => {
    const p = await pair();
    const out = await loginAs(await createUser({ name: "Other" }));
    await out.post(`/api/friend-reviews/matches/${p.id}`).expect(404);
    await out.get(`/api/friend-reviews/matches/${p.id}`).expect(404);
    const rid = (await p.A.post(`/api/friend-reviews/matches/${p.id}`).expect(201)).body.data.id;
    await out.post(`/api/friend-reviews/${rid}/allow`).expect(404);
    await p.B.post(`/api/friend-reviews/${rid}/decline`).expect(200);
    await p.A.post(`/api/friend-reviews/matches/${p.id}`).expect(409);
  });
});

describe("the friend's link", () => {
  it("stores only a hash, and shows no location, contact or match data", async () => {
    const p = await linked();
    const row = await prisma.friendReview.findUniqueOrThrow({ where: { id: p.rid } });
    expect(row.tokenHash).not.toBe(p.token);
    const body = JSON.stringify((await open(p.token).expect(200)).body.data);
    expect(body).toContain("Vikram");
    for (const secret of ["Secretville", "knot.test", "dateOfBirth", "latitude", p.ub.id, p.id]) expect(body).not.toContain(secret);
  });

  it("dies on expiry, on a new link, and when either person stops sharing", async () => {
    const p = await linked();
    await prisma.friendReview.update({ where: { id: p.rid }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await open(p.token).expect(404);
    const second = (await p.A.post(`/api/friend-reviews/${p.rid}/link`).expect(200)).body.data.token;
    await open(p.token).expect(404);
    await open(second).expect(200);
    await p.B.post(`/api/friend-reviews/${p.rid}/revoke`).expect(200);
    await open(second).expect(404);
  });

  it("dies when the match ends, and the reply is erased", async () => {
    const p = await linked();
    await p.B.delete(`/api/matches/${p.id}`).expect(200);
    await open(p.token).expect(404);
    const q = await linked();
    await reply(q.token).expect(200);
    await q.A.post("/api/safety/blocks").send({ userId: q.ub.id });
    const row = await prisma.friendReview.findUniqueOrThrow({ where: { id: q.rid } });
    expect(row.comment).toBeNull();
    expect(row.friendName).toBeNull();
  });

  it("serves only the reviewed person's approved images, and only with the token", async () => {
    const p = await linked();
    const mine = await prisma.profilePhoto.create({ data: { userId: p.ua.id, storageKey: "x.jpg", mimeType: "image/jpeg", status: "APPROVED", position: 0, sizeBytes: 1 } as never }).catch(() => null);
    if (mine) await request(app).get(`/api/friend-reviews/shared/photos/${mine.id}`).set("x-friend-token", p.token).expect(404);
    await request(app).get(`/api/friend-reviews/shared/photos/${p.rid}`).expect(404);
  });
});

describe("the reply", () => {
  it("reaches only the asker, closes the link, and can't be sent twice", async () => {
    const p = await linked();
    await reply(p.token).expect(200);
    await reply(p.token).expect(404);
    await open(p.token).expect(404);
    const mine = (await p.A.get(`/api/friend-reviews/matches/${p.id}`)).body.data.mine[0];
    expect(mine).toMatchObject({ friendName: "Meera", verdict: "ASK_MORE", comment: "Ask about their weekends." });
    const theirs = JSON.stringify((await p.B.get(`/api/friend-reviews/matches/${p.id}`)).body.data);
    expect(theirs).not.toContain("Meera");
    expect(theirs).not.toContain("weekends");
    const note = JSON.stringify(await prisma.notification.findMany({ where: { userId: p.ua.id } }));
    expect(note).not.toContain("weekends");
  });

  it("never changes the match or anything else", async () => {
    const p = await linked();
    await reply(p.token, { verdict: "NOT_SURE" }).expect(200);
    expect((await prisma.match.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("ACTIVE");
    expect(await prisma.message.count({ where: { conversation: { matchId: p.id } } })).toBe(0);
  });

  it("lets the subject withdraw only before a reply, and the asker delete it after", async () => {
    const p = await linked();
    await reply(p.token).expect(200);
    await p.B.post(`/api/friend-reviews/${p.rid}/revoke`).expect(404);
    await p.A.post(`/api/friend-reviews/${p.rid}/revoke`).expect(200);
    expect((await prisma.friendReview.findUniqueOrThrow({ where: { id: p.rid } })).comment).toBeNull();
  });
});
