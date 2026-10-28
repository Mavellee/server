import { Router } from "express";
import { z } from "zod";
import { ok, parse } from "../../lib/http.js";
import { requireActive } from "../../middleware/auth.js";
import { discover } from "./service.js";

export const discoveryRouter = Router();
discoveryRouter.use(requireActive);

discoveryRouter.get("/", async (req, res) => {
  const q = parse(
    z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(20).default(10) }),
    req.query,
  );
  ok(res, await discover(req.user!.id, q.cursor, q.limit));
});
