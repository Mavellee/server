-- DropIndex
DROP INDEX "CompatibilityResult_userAId_userBId_version_key";

-- AlterTable
ALTER TABLE "CompatibilityResult" ADD COLUMN     "inputsHash" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "CompatibilityResult_userAId_userBId_version_inputsHash_key" ON "CompatibilityResult"("userAId", "userBId", "version", "inputsHash");

