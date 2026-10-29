import type { GameCategory } from "@prisma/client";

/**
 * How each deck plays inside a conversation. Content (questions/options) lives in PostgreSQL;
 * these rules describe the mechanics. Bump RULES_VERSION when mechanics change.
 */
export const RULES_VERSION = 2; // 2: skipping is round-level only (no per-player passes)

export type Mode = "simultaneous" | "guess";
export type AnswerType = "choice" | "text";

export interface GameRules {
  mode: Mode; // simultaneous: both answer privately; guess: one answers about themself, the other guesses
  answer: AnswerType;
  agreement: boolean; // count matching choices
  notes: boolean; // allow a short explanation after the reveal
  rounds: number;
  minutes: number;
  players: 2;
}

export const GAME_RULES: Record<GameCategory, GameRules> = {
  RED_FLAG_GREEN_FLAG: { mode: "simultaneous", answer: "choice", agreement: true, notes: true, rounds: 5, minutes: 10, players: 2 },
  KNOW_EACH_OTHER: { mode: "guess", answer: "text", agreement: false, notes: false, rounds: 6, minutes: 10, players: 2 },
  DEEP_QUESTIONS: { mode: "simultaneous", answer: "text", agreement: false, notes: false, rounds: 4, minutes: 15, players: 2 },
  WOULD_YOU_RATHER: { mode: "simultaneous", answer: "choice", agreement: true, notes: true, rounds: 6, minutes: 5, players: 2 },
  LOYALTY_BOUNDARIES: { mode: "simultaneous", answer: "choice", agreement: true, notes: true, rounds: 5, minutes: 10, players: 2 },
  LOVE_LANGUAGES: { mode: "simultaneous", answer: "choice", agreement: true, notes: true, rounds: 5, minutes: 8, players: 2 },
  FUN_CHALLENGES: { mode: "simultaneous", answer: "text", agreement: false, notes: false, rounds: 5, minutes: 10, players: 2 },
};

export const MAX_TEXT = 500;
export const MAX_NOTE = 280;
