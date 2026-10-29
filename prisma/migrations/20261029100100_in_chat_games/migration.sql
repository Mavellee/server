-- CreateEnum
CREATE TYPE "GameRoundStatus" AS ENUM ('OPEN', 'REVEALED', 'SKIPPED');

-- AlterTable
ALTER TABLE "GameSession" ADD COLUMN     "config" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "conversationId" UUID,
ADD COLUMN     "endedById" UUID,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "rulesVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "startedAt" TIMESTAMP(3),
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "gameSessionId" UUID,
ADD COLUMN     "metadata" JSONB;

-- CreateTable
CREATE TABLE "GameParticipant" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "joinedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameRound" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "index" INTEGER NOT NULL,
    "questionId" UUID NOT NULL,
    "status" "GameRoundStatus" NOT NULL DEFAULT 'OPEN',
    "subjectUserId" UUID,
    "revealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameRoundAnswer" (
    "id" UUID NOT NULL,
    "roundId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "choice" TEXT,
    "text" TEXT,
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "correct" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GameRoundAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GameParticipant_userId_idx" ON "GameParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GameParticipant_sessionId_userId_key" ON "GameParticipant"("sessionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "GameRound_sessionId_index_key" ON "GameRound"("sessionId", "index");

-- CreateIndex
CREATE UNIQUE INDEX "GameRoundAnswer_roundId_userId_key" ON "GameRoundAnswer"("roundId", "userId");

-- CreateIndex
CREATE INDEX "GameSession_conversationId_createdAt_idx" ON "GameSession"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_gameSessionId_fkey" FOREIGN KEY ("gameSessionId") REFERENCES "GameSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameSession" ADD CONSTRAINT "GameSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameParticipant" ADD CONSTRAINT "GameParticipant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameParticipant" ADD CONSTRAINT "GameParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GameSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "GameQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRoundAnswer" ADD CONSTRAINT "GameRoundAnswer_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "GameRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRoundAnswer" ADD CONSTRAINT "GameRoundAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one live in-chat game per conversation.
CREATE UNIQUE INDEX "GameSession_one_live_per_conversation" ON "GameSession"("conversationId")
  WHERE "conversationId" IS NOT NULL AND "status" IN ('WAITING', 'ACTIVE', 'PAUSED');
