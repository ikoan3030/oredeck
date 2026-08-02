import type { OpponentDefinition } from "./types";

export function getOpponentById(opponents: readonly OpponentDefinition[], id: string): OpponentDefinition | undefined {
  return opponents.find((opponent) => opponent.id === id);
}
