import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createUser, loginAs, match, resetDb } from "./helpers.js";

beforeEach(resetDb);

describe("couple games", () => {
  it("lists all seven curated categories from the database", async () => {
    const s = await loginAs(await createUser());
    const games = (await s.get("/api/games")).body.data;
    expect(games).toHaveLength(7);
    expect(games.every((g: { questionCount: number }) => g.questionCount >= 8)).toBe(true);
  });

  it("runs a solo game with answers, option validation, skips and a recap", async () => {
    const s = await loginAs(await createUser());
    let state = (await s.post("/api/games/sessions", { gameSlug: "red-flag-green-flag", questionCount: 3 })).body.data;
    expect(state.progress).toEqual({ index: 0, total: 3 });
    expect((await s.post(`/api/games/sessions/${state.id}/answer`, { answer: "Maybe?" })).status).toBe(400);
    state = (await s.post(`/api/games/sessions/${state.id}/answer`, { answer: "Green flag" })).body.data;
    expect(state.progress.index).toBe(1);
    state = (await s.post(`/api/games/sessions/${state.id}/skip`)).body.data;
    state = (await s.post(`/api/games/sessions/${state.id}/answer`, { answer: "Depends" })).body.data;
    expect(state.status).toBe("COMPLETED");
    expect(state.recap).toHaveLength(3);
    expect(state.recap[1].skipped).toBe(true);
  });

  it("shared sessions reveal a partner's answer only after you answer, and alternate turns", async () => {
    const a = await createUser();
    const b = await createUser();
    const { sa, sb, matchId } = await match(a, b);
    const created = await sa.post("/api/games/sessions", { gameSlug: "deep-questions", matchId, questionCount: 3 });
    const id = created.body.data.id;
    expect(created.body.data.turnUserId).toBe(a.id);
    expect(await prisma.notification.count({ where: { userId: b.id, type: "GAME_INVITE" } })).toBe(1);

    await sa.post(`/api/games/sessions/${id}/answer`, { answer: "When I'm outdoors." });
    let bView = (await sb.get(`/api/games/sessions/${id}`)).body.data;
    expect(bView.partnerAnswered).toBe(true);
    expect(bView.partnerAnswer).toBeNull(); // not revealed yet
    expect((await sb.post(`/api/games/sessions/${id}/next`)).status).toBe(400);

    bView = (await sb.post(`/api/games/sessions/${id}/answer`, { answer: "Cooking for friends." })).body.data;
    expect(bView.partnerAnswer.answer).toBe("When I'm outdoors.");
    const next = (await sb.post(`/api/games/sessions/${id}/next`)).body.data;
    expect(next.progress.index).toBe(1);
    expect(next.turnUserId).toBe(b.id);

    expect((await sa.post(`/api/games/sessions/${id}/end`)).status).toBe(200);
    expect((await sb.get(`/api/games/sessions/${id}`)).body.data.status).toBe("ENDED");
  });

  it("keeps game sessions private to their players", async () => {
    const s = await loginAs(await createUser());
    const id = (await s.post("/api/games/sessions", { gameSlug: "would-you-rather" })).body.data.id;
    const other = await loginAs(await createUser());
    expect((await other.get(`/api/games/sessions/${id}`)).status).toBe(404);
    expect((await other.post(`/api/games/sessions/${id}/answer`, { answer: "Option A" })).status).toBe(404);
  });

  it("closes shared games when the match ends", async () => {
    const a = await createUser();
    const b = await createUser();
    const { sa, sb, matchId } = await match(a, b);
    const id = (await sa.post("/api/games/sessions", { gameSlug: "fun-challenges", matchId })).body.data.id;
    await sb.delete(`/api/matches/${matchId}`);
    expect((await sa.get(`/api/games/sessions/${id}`)).status).toBe(404);
  });
});
