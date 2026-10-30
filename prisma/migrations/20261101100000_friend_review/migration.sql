-- CreateEnum
CREATE TYPE "FriendReviewStatus" AS ENUM ('PENDING', 'ALLOWED', 'DECLINED', 'REVIEWED', 'REVOKED');

-- CreateEnum
CREATE TYPE "FriendVerdict" AS ENUM ('GOOD_FEELING', 'ASK_MORE', 'NOT_SURE');

-- CreateTable
CREATE TABLE "FriendReview" (
    "id" UUID NOT NULL,
    "matchId" UUID NOT NULL,
    "requesterId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "status" "FriendReviewStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "friendName" TEXT,
    "verdict" "FriendVerdict",
    "comment" TEXT,
    "closedById" UUID,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FriendReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FriendReview_tokenHash_key" ON "FriendReview"("tokenHash");
CREATE INDEX "FriendReview_matchId_requesterId_idx" ON "FriendReview"("matchId", "requesterId");

-- AddForeignKey
ALTER TABLE "FriendReview" ADD CONSTRAINT "FriendReview_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
