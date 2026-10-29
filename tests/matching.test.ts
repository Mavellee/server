import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { likeUser } from "../src/modules/matches/service.js";
import { createUser, loginAs, resetDb } from "./helpers.js";

beforeEach(resetDb);

describe("likes and matches", () => {
  it("creates a match only when the like is mutual", async () => {
    const a = await createUser();
    const b = await createUser();
    const sa = await loginAs(a);
    const sb = await loginAs(b);
    const first = await sa.post("/api/likes", { userId: b.id });
    expect(first.status).toBe(201);
    expect(first.body.data.matched).toBe(false);
    expect(await prisma.match.count()).toBe(0);

    const second = await sb.post("/api/likes", { userId: a.id });
    expect(second.body.data.matched).toBe(true);
    expect(await prisma.match.count()).toBe(1);
    expect(await prisma.conversation.count()).toBe(1);
    expect(await prisma.notification.count({ where: { type: "MATCH" } })).toBe(2);
    expect((await sa.get("/api/matches")).body.data).toHaveLength(1);
  });

  it("does not duplicate likes or matches", async () => {
    const a = await createUser();
    const b = await createUser();
    const sa = await loginAs(a);
    const sb = await loginAs(b);
    await sa.post("/api/likes", { userId: b.id });
    const again = await sa.post("/api/likes", { userId: b.id });
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyLiked).toBe(true);
    await sb.post("/api/likes", { userId: a.id });
    await sb.post("/api/likes", { userId: a.id });
    expect(await prisma.like.count()).toBe(2);
    expect(await prisma.match.count()).toBe(1);
  });

  it("creates exactly one match when both like at the same time", async () => {
    for (let i = 0; i < 5; i++) {
      const a = await createUser();
      const b = await createUser();
      const results = await Promise.all([likeUser(a.id, b.id), likeUser(b.id, a.id)]);
      expect(results.some((r) => r.matched)).toBe(true);
    }
    expect(await prisma.match.count()).toBe(5);
    expect(await prisma.conversation.count()).toBe(5);
  });

  it("refuses self-likes and unavailable profiles", async () => {
    const a = await createUser();
    const hidden = await createUser({ published: false });
    const sa = await loginAs(a);
    expect((await sa.post("/api/likes", { userId: a.id })).status).toBe(400);
    expect((await sa.post("/api/likes", { userId: hidden.id })).status).toBe(404);
  });

  it("shows only genuine received likes", async () => {
    const me = await createUser();
    const fan = await createUser({ name: "Fan" });
    await createUser({ name: "Stranger" });
    await (await loginAs(fan)).post("/api/likes", { userId: me.id });
    const res = await (await loginAs(me)).get("/api/likes/received");
    expect(res.body.data.map((l: { profile: { displayName: string } }) => l.profile.displayName)).toEqual(["Fan"]);
  });

  it("unmatching ends the match and closes the conversation for both", async () => {
    const a = await createUser();
    const b = await createUser();
    const sa = await loginAs(a);
    const sb = await loginAs(b);
    await sa.post("/api/likes", { userId: b.id });
    const { matchId } = (await sb.post("/api/likes", { userId: a.id })).body.data;
    const convo = await prisma.conversation.findFirstOrThrow({ where: { matchId } });
    expect((await sa.delete(`/api/matches/${matchId}`)).status).toBe(200);
    expect((await sb.get("/api/matches")).body.data).toHaveLength(0);
    expect((await sb.get(`/api/conversations/${convo.id}/messages`)).status).toBe(404);
    // Liking again cannot resurrect an ended match.
    expect((await sa.post("/api/likes", { userId: b.id })).body.data.matched).toBe(false);
  });

  it("only participants can unmatch", async () => {
    const a = await createUser();
    const b = await createUser();
    const c = await createUser();
    await likeUser(a.id, b.id);
    const { matchId } = await likeUser(b.id, a.id);
    expect((await (await loginAs(c)).delete(`/api/matches/${matchId}`)).status).toBe(404);
  });
});

describe("who can like", () => {
  it("requires the liker to have a published profile (no likes from half-created accounts)", async () => {
    const target = await createUser({ name: "Target" });
    const draft = await createUser({ name: "Draft", published: false });
    const s = await loginAs(draft);
    const res = await s.post("/api/likes", { userId: target.id });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Publish your profile/);
    expect((await s.post("/api/likes/pass", { userId: target.id })).status).toBe(400);
    expect(await prisma.like.count({ where: { fromUserId: draft.id } })).toBe(0);
  });
});
