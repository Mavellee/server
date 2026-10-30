-- CreateEnum
CREATE TYPE "RelationshipStatus" AS ENUM ('PENDING', 'ACTIVE', 'DECLINED', 'ENDED');

-- AlterTable
ALTER TABLE "UserSettings" ADD COLUMN "showZodiacSign" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Relationship" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "status" "RelationshipStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" UUID NOT NULL,
    "startedAt" TIMESTAMP(3),
    "closedById" UUID,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Relationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Doodle" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "createdById" UUID NOT NULL,
    "strokes" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Doodle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Relationship_matchId_key" ON "Relationship"("matchId");
CREATE INDEX "Relationship_status_idx" ON "Relationship"("status");
CREATE INDEX "Doodle_matchId_updatedAt_idx" ON "Doodle"("matchId", "updatedAt");

-- AddForeignKey
ALTER TABLE "Relationship" ADD CONSTRAINT "Relationship_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Doodle" ADD CONSTRAINT "Doodle_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Doodle" ADD CONSTRAINT "Doodle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
