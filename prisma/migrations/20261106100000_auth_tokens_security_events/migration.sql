-- Additive: rotating refresh tokens on the existing Session table, and a security event log.
-- Existing sessions keep working: their cookie token is swapped for new tokens on first use.
CREATE TYPE "SessionClient" AS ENUM ('WEB', 'MOBILE');

ALTER TABLE "Session"
  ALTER COLUMN "tokenHash" DROP NOT NULL,
  ADD COLUMN "refreshHash" TEXT,
  ADD COLUMN "previousRefreshHash" TEXT,
  ADD COLUMN "rotatedAt" TIMESTAMP(3),
  ADD COLUMN "idleExpiresAt" TIMESTAMP(3),
  ADD COLUMN "client" "SessionClient" NOT NULL DEFAULT 'WEB',
  ADD COLUMN "revokedReason" TEXT;

CREATE UNIQUE INDEX "Session_refreshHash_key" ON "Session"("refreshHash");
CREATE UNIQUE INDEX "Session_previousRefreshHash_key" ON "Session"("previousRefreshHash");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

CREATE TABLE "SecurityEvent" (
    "id" UUID NOT NULL,
    "userId" UUID,
    "type" TEXT NOT NULL,
    "sessionId" UUID,
    "emailHash" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId", "createdAt");
CREATE INDEX "SecurityEvent_type_createdAt_idx" ON "SecurityEvent"("type", "createdAt");
CREATE INDEX "SecurityEvent_createdAt_idx" ON "SecurityEvent"("createdAt");
