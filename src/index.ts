import { createServer } from "node:http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { prisma } from "./db.js";
import { createApp } from "./app.js";
import { createSocketServer } from "./realtime/socket.js";

const app = createApp();
const http = createServer(app);
const io = createSocketServer(http);

http.listen(config.port, () => logger.info({ port: config.port, env: config.env, ai: config.ai.provider }, "Mavelle API listening"));

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  io.close();
  http.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
