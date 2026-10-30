import { Router } from "express";
import { z } from "zod";
import { ok, parse } from "../../lib/http.js";
import { requireActive } from "../../middleware/auth.js";
import { messageLimiter } from "../../middleware/security.js";
import * as couple from "./service.js";

export const coupleRouter = Router();
coupleRouter.use(requireActive);

const id = (p: unknown) => parse(z.object({ id: z.string().uuid() }), p).id;

coupleRouter.get("/me", async (req, res) => ok(res, await couple.mySpace(req.user!.id)));
coupleRouter.get("/matches/:id", async (req, res) => ok(res, await couple.stateFor(req.user!.id, id(req.params))));
for (const action of ["request", "accept", "decline", "end"] as const) {
  coupleRouter.post(`/matches/:id/${action}`, messageLimiter, async (req, res) => ok(res, await couple[action](req.user!.id, id(req.params))));
}

coupleRouter.get("/doodles", async (req, res) => ok(res, await couple.listDoodles(req.user!.id)));
coupleRouter.post("/doodles", messageLimiter, async (req, res) => ok(res, await couple.createDoodle(req.user!.id), 201));
coupleRouter.get("/doodles/:id", async (req, res) => ok(res, await couple.getDoodle(req.user!.id, id(req.params))));
coupleRouter.delete("/doodles/:id", messageLimiter, async (req, res) => ok(res, await couple.deleteDoodle(req.user!.id, id(req.params))));
