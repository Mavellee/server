import type { NextFunction, Request, Response } from "express";
import { Prisma } from "@prisma/client";
import multer from "multer";
import { ApiError } from "../lib/http.js";
import { logger } from "../logger.js";

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found." } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "That file is too large." : "Upload failed.";
    return res.status(400).json({ error: { code: "UPLOAD_FAILED", message } });
  }
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON body." } });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } });
  }
  logger.error({ err, path: req.path, method: req.method }, "unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong on our side. Please try again." } });
}
