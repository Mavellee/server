import type { GameRoundStatus, GameSessionStatus } from "@prisma/client";
import { ApiError } from "../../lib/http.js";

/** Legal session transitions for in-chat games. Anything else is rejected with 409. */
export const SESSION_TRANSITIONS: Partial<Record<GameSessionStatus, GameSessionStatus[]>> = {
  WAITING: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["PAUSED", "COMPLETED", "CANCELLED"],
  PAUSED: ["ACTIVE", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export const ROUND_TRANSITIONS: Record<GameRoundStatus, GameRoundStatus[]> = {
  OPEN: ["REVEALED", "SKIPPED"],
  REVEALED: [],
  SKIPPED: [],
};

export const LIVE_STATUSES: GameSessionStatus[] = ["WAITING", "ACTIVE", "PAUSED"];

export function canTransition(from: GameSessionStatus, to: GameSessionStatus) {
  return SESSION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: GameSessionStatus, to: GameSessionStatus) {
  if (!canTransition(from, to)) throw new ApiError(409, "BAD_STATE", `This game can't go from ${from.toLowerCase()} to ${to.toLowerCase()}.`);
}

export function assertRoundTransition(from: GameRoundStatus, to: GameRoundStatus) {
  if (!ROUND_TRANSITIONS[from].includes(to)) throw new ApiError(409, "BAD_STATE", "This round has already finished.");
}

/** Answers are only accepted while the game is active and the round is open. */
export function assertCanAnswer(status: GameSessionStatus, round: { status: GameRoundStatus } | null) {
  if (status === "PAUSED") throw new ApiError(409, "PAUSED", "The game is paused. Resume it to keep playing.");
  if (status !== "ACTIVE") throw new ApiError(409, "BAD_STATE", "This game isn't accepting answers.");
  if (!round || round.status !== "OPEN") throw new ApiError(409, "BAD_STATE", "This round has already finished.");
}
