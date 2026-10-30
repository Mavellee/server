import { Router } from "express";
import { z } from "zod";
import { ok, parse } from "../../lib/http.js";
import { requireActive } from "../../middleware/auth.js";
import { limiter } from "../../middleware/security.js";
import { PLACES } from "./places.js";
import * as astro from "./service.js";

export const astroRouter = Router();
astroRouter.use(requireActive);

const writeLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 30 });
const retryLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 6 });

const consent = z.object({
  birth: z
    .object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d)) && d >= "1900-01-01", "Enter a valid date of birth."),
      time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a valid time.").nullable(),
      accuracy: z.enum(["EXACT", "APPROXIMATE", "UNKNOWN"]),
      placeId: z.string().max(80),
    })
    .optional(),
  shareSummary: z.literal(true, { errorMap: () => ({ message: "Your sign-level summary is shown in the joint report, so this is needed to continue." }) }),
  externalAi: z.boolean(),
  useInterests: z.boolean(),
});

const matchId = (v: unknown) => parse(z.string().uuid(), v);

astroRouter.get("/places", (_req, res) => ok(res, PLACES.map(({ id, city, region, country }) => ({ id, city, region, country }))));
astroRouter.get("/me", async (req, res) => ok(res, await astro.myDataSummary(req.user!.id)));
astroRouter.delete("/me", writeLimiter, async (req, res) => {
  await astro.deleteMyData(req.user!.id);
  ok(res, { deleted: true });
});

astroRouter.get("/matches/:id", async (req, res) => ok(res, await astro.stateFor(req.user!.id, matchId(req.params.id))));
astroRouter.get("/matches/:id/report", async (req, res) => ok(res, await astro.reportFor(req.user!.id, matchId(req.params.id))));
astroRouter.post("/matches/:id/opt-in", writeLimiter, async (req, res) => ok(res, await astro.optIn(req.user!.id, matchId(req.params.id))));
astroRouter.post("/matches/:id/decline", writeLimiter, async (req, res) => ok(res, await astro.decline(req.user!.id, matchId(req.params.id))));
astroRouter.post("/matches/:id/consent", writeLimiter, async (req, res) => ok(res, await astro.giveConsent(req.user!.id, matchId(req.params.id), parse(consent, req.body))));
astroRouter.post("/matches/:id/retry", retryLimiter, async (req, res) => ok(res, await astro.retry(req.user!.id, matchId(req.params.id))));
astroRouter.post("/matches/:id/withdraw", writeLimiter, async (req, res) => ok(res, await astro.withdraw(req.user!.id, matchId(req.params.id))));
