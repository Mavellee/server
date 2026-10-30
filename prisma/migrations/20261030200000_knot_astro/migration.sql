-- CreateEnum
CREATE TYPE "AstroStatus" AS ENUM ('AWAITING_CONSENT', 'COLLECTING', 'CALCULATING', 'INTERPRETING', 'READY', 'PARTIAL', 'FAILED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AstroConsentState" AS ENUM ('INTERESTED', 'CONSENTED', 'DECLINED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AstroTimeAccuracy" AS ENUM ('EXACT', 'APPROXIMATE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "AstroProfile" (
    "userId" UUID NOT NULL,
    "birthCipher" TEXT NOT NULL,
    "accuracy" "AstroTimeAccuracy" NOT NULL,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AstroProfile_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AstroChart" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AstroChart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AstroSession" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "status" "AstroStatus" NOT NULL DEFAULT 'AWAITING_CONSENT',
    "failure" TEXT,
    "aiAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AstroSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AstroConsent" (
    "sessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "state" "AstroConsentState" NOT NULL,
    "shareSummary" BOOLEAN NOT NULL DEFAULT false,
    "externalAi" BOOLEAN NOT NULL DEFAULT false,
    "useInterests" BOOLEAN NOT NULL DEFAULT false,
    "consentedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),

    CONSTRAINT "AstroConsent_pkey" PRIMARY KEY ("sessionId","userId")
);

-- CreateTable
CREATE TABLE "AstroReport" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "version" TEXT NOT NULL,
    "calculation" JSONB NOT NULL,
    "interpretation" JSONB,
    "model" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AstroReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AstroProfile_lastUsedAt_idx" ON "AstroProfile"("lastUsedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AstroChart_userId_version_key" ON "AstroChart"("userId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "AstroSession_matchId_key" ON "AstroSession"("matchId");

-- CreateIndex
CREATE INDEX "AstroConsent_userId_idx" ON "AstroConsent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AstroReport_sessionId_key" ON "AstroReport"("sessionId");

-- AddForeignKey
ALTER TABLE "AstroProfile" ADD CONSTRAINT "AstroProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AstroChart" ADD CONSTRAINT "AstroChart_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AstroSession" ADD CONSTRAINT "AstroSession_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AstroConsent" ADD CONSTRAINT "AstroConsent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AstroSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AstroConsent" ADD CONSTRAINT "AstroConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AstroReport" ADD CONSTRAINT "AstroReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AstroSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

