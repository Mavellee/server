-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'VIDEO');

-- AlterTable
ALTER TABLE "ProfilePhoto" ADD COLUMN     "caption" TEXT,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "isPrimary" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "kind" "MediaKind" NOT NULL DEFAULT 'IMAGE',
ADD COLUMN     "posterKey" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePhoto_posterKey_key" ON "ProfilePhoto"("posterKey");


-- Every existing member's first photo becomes their primary photo (non-destructive backfill).
UPDATE "ProfilePhoto" p SET "isPrimary" = true
FROM (SELECT DISTINCT ON ("userId") id FROM "ProfilePhoto" ORDER BY "userId", "position" ASC, "createdAt" ASC) first
WHERE p.id = first.id;

-- At most one primary item per member, and only images can be primary.
CREATE UNIQUE INDEX "ProfilePhoto_one_primary_per_user" ON "ProfilePhoto"("userId") WHERE "isPrimary";
ALTER TABLE "ProfilePhoto" ADD CONSTRAINT "ProfilePhoto_primary_is_image" CHECK (NOT "isPrimary" OR "kind" = 'IMAGE');
ALTER TABLE "ProfilePhoto" ADD CONSTRAINT "ProfilePhoto_caption_length" CHECK ("caption" IS NULL OR char_length("caption") <= 200);
ALTER TABLE "ProfilePhoto" ADD CONSTRAINT "ProfilePhoto_video_fields" CHECK ("kind" = 'VIDEO' OR ("posterKey" IS NULL AND "durationMs" IS NULL));
