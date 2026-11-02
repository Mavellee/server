-- Additive: records where a member's location came from and when, plus consent for device location.
-- Existing rows are untouched (all new columns are nullable).
CREATE TYPE "LocationSource" AS ENUM ('DEVICE', 'MANUAL');

ALTER TABLE "Profile"
  ADD COLUMN "locationSource" "LocationSource",
  ADD COLUMN "placeId" TEXT,
  ADD COLUMN "locationUpdatedAt" TIMESTAMP(3),
  ADD COLUMN "locationConsentAt" TIMESTAMP(3);
