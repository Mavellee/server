import { Router } from "express";
import { z } from "zod";
import { Intention } from "@prisma/client";
import { ok, parse } from "../../lib/http.js";
import { requireActive } from "../../middleware/auth.js";
import { discover } from "./service.js";

export const discoveryRouter = Router();
discoveryRouter.use(requireActive);

const list = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .pipe(z.array(item).max(12).optional());

discoveryRouter.get("/", async (req, res) => {
  const q = parse(
    z.object({
      cursor: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(24).default(12),
      intentions: list(z.nativeEnum(Intention)),
      interests: list(z.string().max(60)),
      ageMin: z.coerce.number().int().min(18).max(100).optional(),
      ageMax: z.coerce.number().int().min(18).max(100).optional(),
      maxDistanceKm: z.coerce.number().int().min(1).max(20000).optional(),
    }),
    req.query,
  );
  const { cursor, limit, ...filters } = q;
  ok(res, await discover(req.user!.id, cursor, limit, filters));
});
