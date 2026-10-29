-- AlterTable
ALTER TABLE "Like" ADD COLUMN     "comment" TEXT,
ADD COLUMN     "detailKind" TEXT,
ADD COLUMN     "detailRef" TEXT;

-- AlterTable
ALTER TABLE "ProfilePhoto" ADD COLUMN     "focusX" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "focusY" INTEGER NOT NULL DEFAULT 50;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "isDemo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ProfilePrompt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "promptKey" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfilePrompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfilePrompt_userId_position_idx" ON "ProfilePrompt"("userId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ProfilePrompt_userId_promptKey_key" ON "ProfilePrompt"("userId", "promptKey");

-- AddForeignKey
ALTER TABLE "ProfilePrompt" ADD CONSTRAINT "ProfilePrompt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "ProfilePhoto" ADD CONSTRAINT "ProfilePhoto_focus_range" CHECK ("focusX" BETWEEN 0 AND 100 AND "focusY" BETWEEN 0 AND 100);
ALTER TABLE "ProfilePrompt" ADD CONSTRAINT "ProfilePrompt_answer_len" CHECK (char_length("answer") BETWEEN 1 AND 250);
ALTER TABLE "Like" ADD CONSTRAINT "Like_comment_len" CHECK ("comment" IS NULL OR char_length("comment") <= 300);
