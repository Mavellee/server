-- Additive: marks reviews written by Mavelle AI so they are never shown as a person's.
ALTER TABLE "ExpertReview" ADD COLUMN "aiWritten" BOOLEAN NOT NULL DEFAULT false;
