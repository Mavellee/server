import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { loadSession } from "./middleware/auth.js";
import { apiLimiter, originCheck } from "./middleware/security.js";
import { errorHandler, notFoundHandler } from "./middleware/errors.js";
import { authRouter } from "./modules/auth/routes.js";
import { metaRouter, photosRouter, profilesRouter } from "./modules/profiles/routes.js";
import { discoveryRouter } from "./modules/discovery/routes.js";
import { likesRouter, matchesRouter } from "./modules/matches/routes.js";
import { conversationsRouter } from "./modules/chat/routes.js";
import { compatibilityRouter } from "./modules/compatibility/routes.js";
import { expertsRouter } from "./modules/experts/routes.js";
import { gamesRouter } from "./modules/games/routes.js";
import { aiRouter } from "./modules/ai/routes.js";
import { notificationsRouter } from "./modules/notifications/routes.js";
import { safetyRouter } from "./modules/safety/routes.js";
import { settingsRouter } from "./modules/settings/routes.js";
import { adminRouter } from "./modules/admin/routes.js";
import { astroRouter } from "./modules/astro/routes.js";
import { coupleRouter } from "./modules/couple/routes.js";
import { friendReviewRouter } from "./modules/friendreview/routes.js";
import { locationRouter } from "./modules/location/routes.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
      // Log method, path and status only; never bodies or query strings.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, path: req.url?.split("?")[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: "same-origin" },
      // Default "same-origin" breaks the Google sign-in popup: it can no longer tell the opener it has
      // finished, so the sign-in call never resolves. "same-origin-allow-popups" keeps the isolation but lets a
      // popup we opened report back to us.
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          // Firebase's client SDK calls these from the page itself (sign-in and token refresh).
          "connect-src": ["'self'", "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com"],
          // A brief handshake frame Firebase opens against the project's own authDomain during sign-in.
          "frame-src": ["'self'", "https://*.firebaseapp.com"],
          // Google account profile photos.
          "img-src": ["'self'", "data:", "https://*.googleusercontent.com"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // Liveness and readiness for Docker / the reverse proxy.
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/readyz", async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  const api = express.Router();
  api.use(originCheck, loadSession, apiLimiter);
  api.use("/auth", authRouter);
  api.use("/meta", metaRouter);
  api.use("/profiles", profilesRouter);
  api.use("/photos", photosRouter);
  api.use("/discovery", discoveryRouter);
  api.use("/likes", likesRouter);
  api.use("/matches", matchesRouter);
  api.use("/conversations", conversationsRouter);
  api.use("/compatibility", compatibilityRouter);
  api.use("/experts", expertsRouter);
  api.use("/games", gamesRouter);
  api.use("/ai", aiRouter);
  api.use("/notifications", notificationsRouter);
  api.use("/safety", safetyRouter);
  api.use("/settings", settingsRouter);
  api.use("/admin", adminRouter);
  api.use("/astro", astroRouter);
  api.use("/couple", coupleRouter);
  api.use("/friend-reviews", friendReviewRouter);
  api.use("/location", locationRouter);
  api.use(notFoundHandler);

  app.use("/api", api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
