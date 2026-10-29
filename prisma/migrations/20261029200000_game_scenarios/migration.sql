-- AlterTable
ALTER TABLE "GameQuestion" ADD COLUMN     "discussion" TEXT,
ADD COLUMN     "key" TEXT,
ADD COLUMN     "theme" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "GameQuestion_gameId_key_key" ON "GameQuestion"("gameId", "key");

