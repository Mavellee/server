import pino from "pino";
import { config } from "./config.js";

// Structured JSON logs. Never log request bodies, cookies or message content.
export const logger = pino({
  level: config.isTest ? "silent" : config.logLevel,
  redact: ["req.headers.cookie", "req.headers.authorization", "res.headers['set-cookie']"],
});
