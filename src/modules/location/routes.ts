import { Router } from "express";
import { z } from "zod";
import { ok, parse } from "../../lib/http.js";
import { RADIUS_OPTIONS } from "../../lib/geo.js";
import { requireAuth } from "../../middleware/auth.js";
import { limiter } from "../../middleware/security.js";
import * as location from "./service.js";

export const locationRouter = Router();
locationRouter.use(requireAuth);

// Few changes a day: enough for real moves and travel, too few to walk a probe around someone to triangulate them.
const changeLimiter = limiter({ windowMs: 24 * 60 * 60 * 1000, limit: 20 });
const searchLimiter = limiter({ windowMs: 60 * 1000, limit: 60 });

const finite = (min: number, max: number) => z.number().finite().min(min).max(max);
const updateSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("MANUAL"), placeId: z.string().trim().min(2).max(80) }).strict(),
  // Device positions require the member to have agreed to share them, every time.
  z.object({ source: z.literal("DEVICE"), lat: finite(-90, 90), lon: finite(-180, 180), consent: z.literal(true, { errorMap: () => ({ message: "Please agree to share your approximate location." }) }) }).strict(),
]);
const radius = z
  .number()
  .int()
  .refine((v) => (RADIUS_OPTIONS as readonly number[]).includes(v), { message: `Choose ${RADIUS_OPTIONS.join(", ")} km, or anywhere.` })
  .nullable();
const prefsSchema = z.object({ maxDistanceKm: radius.optional(), showDistance: z.boolean().optional() }).strict();
const prefsLimiter = limiter({ windowMs: 60 * 60 * 1000, limit: 60 });

locationRouter.get("/me", async (req, res) => ok(res, await location.locationView(req.user!.id)));

locationRouter.get("/places", searchLimiter, (req, res) => {
  const { q } = parse(z.object({ q: z.string().trim().max(60).default("") }), req.query);
  ok(res, location.searchPlaces(q));
});

locationRouter.put("/me", changeLimiter, async (req, res) => {
  const body = parse(updateSchema, req.body);
  ok(res, body.source === "MANUAL" ? await location.setManualLocation(req.user!.id, body.placeId) : await location.setDeviceLocation(req.user!.id, body.lat, body.lon));
});

locationRouter.delete("/me", async (req, res) => ok(res, await location.clearLocation(req.user!.id)));

locationRouter.patch("/preferences", prefsLimiter, async (req, res) => ok(res, await location.setPreferences(req.user!.id, parse(prefsSchema, req.body))));
