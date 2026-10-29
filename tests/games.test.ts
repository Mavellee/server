import { beforeEach, describe, expect, it } from "vitest";
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
    state = (await s.post(`/api/games/sessions/${state.id}/answer`, { answer: "Green Flag" })).body.data;
    expect(state.progress.index).toBe(1);
    state = (await s.post(`/api/games/sessions/${state.id}/skip`)).body.data;
    state = (await s.post(`/api/games/sessions/${state.id}/answer`, { answer: "It Depends" })).body.data;
    expect(state.status).toBe("COMPLETED");
    expect(state.recap).toHaveLength(3);
    expect(state.recap[1].skipped).toBe(true);
  });

  it("no longer runs shared games outside the conversation", async () => {
    const a = await createUser();
    const b = await createUser();
    const { sa, matchId } = await match(a, b);
    const res = await sa.post("/api/games/sessions", { gameSlug: "deep-questions", matchId });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/inside your conversation/);
  });

  it("keeps game sessions private to their players", async () => {
    const s = await loginAs(await createUser());
    const id = (await s.post("/api/games/sessions", { gameSlug: "would-you-rather" })).body.data.id;
    const other = await loginAs(await createUser());
    expect((await other.get(`/api/games/sessions/${id}`)).status).toBe(404);
    expect((await other.post(`/api/games/sessions/${id}/answer`, { answer: "Option A" })).status).toBe(404);
  });

});
