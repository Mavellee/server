-- The sign now shows unless a member hides it. No hidden choice exists to preserve: the setting has not shipped.
ALTER TABLE "UserSettings" ALTER COLUMN "showZodiacSign" SET DEFAULT true;
UPDATE "UserSettings" SET "showZodiacSign" = true;
