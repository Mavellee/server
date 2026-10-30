-- New enum values live in their own migration, as in 20261029100000_game_enum_values.
ALTER TYPE "GameCategory" ADD VALUE IF NOT EXISTS 'COUPLE_KNOW_ME';
ALTER TYPE "GameCategory" ADD VALUE IF NOT EXISTS 'COUPLE_THIS_OR_THAT';
ALTER TYPE "GameCategory" ADD VALUE IF NOT EXISTS 'COUPLE_OUR_FIRSTS';
