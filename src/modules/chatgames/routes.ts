import { Router } from "express";
import { z } from "zod";
import { ok, parse } from "../../lib/http.js";
import { requireActive } from "../../middleware/auth.js";
import { messageLimiter } from "../../middleware/security.js";
import * as games from "./service.js";

/** Mounted at /api/conversations/:id/games — every route re-checks conversation membership. */
export const chatGamesRouter = Router({ mergeParams: true });
chatGamesRouter.use(requireActive);

const convo = (p: unknown) => parse(z.object({ id: z.string().uuid() }), p).id;
const ids = (p: unknown) => parse(z.object({ id: z.string().uuid(), sessionId: z.string().uuid() }), p);
const roundBody = z.object({ roundIndex: z.number().int().min(0).max(50) });

chatGamesRouter.get("/", async (req, res) => {
  ok(res, await games.listForConversation(req.user!.id, convo(req.params)));
});

chatGamesRouter.post("/", messageLimiter, async (req, res) => {
  const { gameSlug } = parse(z.object({ gameSlug: z.string().min(1).max(60) }), req.body);
  ok(res, await games.startGame(req.user!.id, convo(req.params), gameSlug), 201);
});

chatGamesRouter.get("/:sessionId", async (req, res) => {
  const { id, sessionId } = ids(req.params);
  ok(res, await games.getView(req.user!.id, id, sessionId));
});

chatGamesRouter.post("/:sessionId/join", async (req, res) => {
  const { id, sessionId } = ids(req.params);
  ok(res, await games.join(req.user!.id, id, sessionId));
});

chatGamesRouter.post("/:sessionId/answer", messageLimiter, async (req, res) => {
  const { id, sessionId } = ids(req.params);
  // Strict: a "skip" here is rejected; skipping is the round-level /skip action.
  const body = parse(roundBody.extend({ choice: z.string().max(120).optional(), text: z.string().max(600).optional() }).strict(), req.body);
  ok(res, await games.answer(req.user!.id, id, sessionId, body));
});

chatGamesRouter.post("/:sessionId/skip", async (req, res) => {
  const { id, sessionId } = ids(req.params);
  ok(res, await games.skipRound(req.user!.id, id, sessionId, parse(roundBody, req.body).roundIndex));
});

chatGamesRouter.post("/:sessionId/next", async (req, res) => {
  const { id, sessionId } = ids(req.params);
  ok(res, await games.next(req.user!.id, id, sessionId, parse(roundBody, req.body).roundIndex));
});

chatGamesRouter.post("/:sessionId/note", messageLimiter, async (req, res) => {
  const { id, sessionId } = ids(req.params);
  const body = parse(roundBody.extend({ note: z.string().max(400) }), req.body);
  ok(res, await games.addNote(req.user!.id, id, sessionId, body.roundIndex, body.note));
});

chatGamesRouter.post("/:sessionId/verdict", async (req, res) => {
  const { id, sessionId } = ids(req.params);
  const body = parse(roundBody.extend({ correct: z.boolean() }), req.body);
  ok(res, await games.verdict(req.user!.id, id, sessionId, body.roundIndex, body.correct));
});

for (const action of ["pause", "resume", "end"] as const) {
  chatGamesRouter.post(`/:sessionId/${action}`, async (req, res) => {
    const { id, sessionId } = ids(req.params);
    ok(res, await games[action](req.user!.id, id, sessionId));
  });
}
