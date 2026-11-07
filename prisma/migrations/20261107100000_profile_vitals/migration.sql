-- Additive only: optional profile vitals and saved dealbreakers. Existing rows keep every value; new columns start empty.
ALTER TABLE "Profile" ADD COLUMN "heightCm" INTEGER;
ALTER TABLE "Profile" ADD COLUMN "jobTitle" TEXT;
ALTER TABLE "Profile" ADD COLUMN "education" TEXT;
ALTER TABLE "Profile" ADD COLUMN "religion" TEXT;
ALTER TABLE "Profile" ADD COLUMN "motherTongue" TEXT;
ALTER TABLE "Profile" ADD COLUMN "diet" TEXT;
ALTER TABLE "Profile" ADD COLUMN "drinking" TEXT;
ALTER TABLE "Profile" ADD COLUMN "smoking" TEXT;
ALTER TABLE "Profile" ADD COLUMN "children" TEXT;
ALTER TABLE "Profile" ADD COLUMN "familyPlans" TEXT;
ALTER TABLE "Profile" ADD COLUMN "hiddenVitals" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Profile" ADD COLUMN "dealbreakers" JSONB;
ALTER TABLE "Profile" ADD CONSTRAINT "Profile_heightCm_range" CHECK ("heightCm" IS NULL OR ("heightCm" BETWEEN 120 AND 230));
