-- New enum values live in their own migration: PostgreSQL cannot use a value
-- in the same transaction that adds it (the next migration's index needs them).
ALTER TYPE "MessageKind" ADD VALUE IF NOT EXISTS 'GAME';
ALTER TYPE "GameSessionStatus" ADD VALUE IF NOT EXISTS 'WAITING';
ALTER TYPE "GameSessionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
ALTER TYPE "GameSessionStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
