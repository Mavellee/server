// Runs before every test file: point the app at the isolated test database and a temp upload dir.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.NODE_ENV = "test";
process.env.APP_ORIGIN = "http://localhost:5180";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://knot:knot_dev_password@localhost:5433/knot_test";
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "knot-test-uploads-"));
process.env.AI_PROVIDER = "none";
process.env.AI_DAILY_USER_LIMIT = "3";
process.env.AI_TIMEOUT_MS = "300";
process.env.VIDEO_MAX_MB = "1"; // keeps the size-limit test fast; fixtures are a few KB
