import type { Response } from "express";
import type { z, ZodTypeAny } from "zod";

/** Errors that are safe to show to the client. Anything else becomes a generic 500. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Please log in to continue.") => new ApiError(401, "UNAUTHENTICATED", message);
export const forbidden = (message = "You do not have access to this.") => new ApiError(403, "FORBIDDEN", message);
export const notFound = (message = "Not found.") => new ApiError(404, "NOT_FOUND", message);
export const conflict = (message: string) => new ApiError(409, "CONFLICT", message);

export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ data });
}

/** Parses input with a Zod schema, throwing a 400 with field errors on failure. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(422, "VALIDATION_FAILED", "Some fields need attention.", result.error.flatten().fieldErrors);
  }
  return result.data;
}
