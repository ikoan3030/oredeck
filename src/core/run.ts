import { decaySync } from "./sync";
import type { ChildProfile, DraftState, RunBattleResult, RunOutcome, RunState, RunSummary, RunWinner } from "./types";

function emptySummary(initialSync: number): RunSummary {
  return {
    wins: 0,
    losses: 0,
    draws: 0,
    passiveInterventions: 0,
    passiveSupports: 0,
    passiveRejects: 0,
    loveCardIds: [],
    finalSync: initialSync,
  };
}

export function createRun(opponentIds: readonly string[], initialSync: number): RunState {
  return {
    currentBattle: 0,
    opponentIds: [...opponentIds],
    initialSync,
    carrySync: initialSync,
    battleResults: [],
    summary: emptySummary(initialSync),
  };
}

export function getCurrentOpponentId(run: RunState): string | undefined {
  return run.opponentIds[run.currentBattle];
}

export function isRunComplete(run: RunState): boolean {
  return run.currentBattle >= run.opponentIds.length;
}

function outcomeFor(winner: RunWinner): RunOutcome {
  if (winner === "brother") return "win";
  if (winner === "opponent") return "loss";
  return "draw";
}

function summarizeDraft(draft: DraftState): Pick<RunBattleResult, "passiveInterventions" | "passiveSupports" | "passiveRejects" | "loveCardIds"> {
  const passiveHistory = draft.history.filter((item) => item.source === "passive");
  return {
    passiveInterventions: passiveHistory.length,
    passiveSupports: passiveHistory.filter((item) => item.selected === item.preferred).length,
    passiveRejects: passiveHistory.filter((item) => item.selected !== item.preferred).length,
    loveCardIds: draft.history.filter((item) => item.source === "love").map((item) => item.selected),
  };
}

function addOutcome(summary: RunSummary, outcome: RunOutcome): RunSummary {
  return {
    ...summary,
    wins: summary.wins + (outcome === "win" ? 1 : 0),
    losses: summary.losses + (outcome === "loss" ? 1 : 0),
    draws: summary.draws + (outcome === "draw" ? 1 : 0),
  };
}

export function recordBattleResult(run: RunState, draft: DraftState, winner: RunWinner, child: ChildProfile): RunState {
  const opponentId = getCurrentOpponentId(run);
  if (!opponentId) return run;

  const outcome = outcomeFor(winner);
  const draftSummary = summarizeDraft(draft);
  const syncAfterDecay = decaySync(draft.syncRate, child);
  const battleResult: RunBattleResult = {
    opponentId,
    winner,
    outcome,
    syncBefore: run.carrySync,
    syncAfterBuild: draft.syncRate,
    syncAfterDecay,
    ...draftSummary,
  };
  const summary = addOutcome(run.summary, outcome);
  return {
    ...run,
    currentBattle: run.currentBattle + 1,
    carrySync: syncAfterDecay,
    battleResults: [...run.battleResults, battleResult],
    summary: {
      ...summary,
      passiveInterventions: summary.passiveInterventions + draftSummary.passiveInterventions,
      passiveSupports: summary.passiveSupports + draftSummary.passiveSupports,
      passiveRejects: summary.passiveRejects + draftSummary.passiveRejects,
      loveCardIds: [...summary.loveCardIds, ...draftSummary.loveCardIds],
      finalSync: syncAfterDecay,
    },
  };
}

export function advanceRun(run: RunState, draft: DraftState, winner: RunWinner, child: ChildProfile): RunState {
  return recordBattleResult(run, draft, winner, child);
}

export function resetRun(run: RunState, initialSync = run.initialSync): RunState {
  return createRun(run.opponentIds, initialSync);
}
