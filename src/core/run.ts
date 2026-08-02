import type { DraftState, RunBattleResult, RunOutcome, RunState, RunSummary, RunWinner } from "./types";

function emptySummary(initialTrust: number): RunSummary {
  return {
    wins: 0,
    losses: 0,
    draws: 0,
    passiveInterventions: 0,
    passiveSupports: 0,
    passiveRejects: 0,
    loveCardIds: [],
    finalTrust: initialTrust,
  };
}

export function createRun(opponentIds: readonly string[], initialTrust: number): RunState {
  return {
    currentBattle: 0,
    opponentIds: [...opponentIds],
    initialTrust,
    carryTrust: initialTrust,
    battleResults: [],
    summary: emptySummary(initialTrust),
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

export function recordBattleResult(run: RunState, draft: DraftState, winner: RunWinner): RunState {
  const opponentId = getCurrentOpponentId(run);
  if (!opponentId) return run;

  const outcome = outcomeFor(winner);
  const draftSummary = summarizeDraft(draft);
  const battleResult: RunBattleResult = {
    opponentId,
    winner,
    outcome,
    trustBefore: run.carryTrust,
    trustAfter: draft.trust,
    ...draftSummary,
  };
  const summary = addOutcome(run.summary, outcome);
  return {
    ...run,
    currentBattle: run.currentBattle + 1,
    carryTrust: draft.trust,
    battleResults: [...run.battleResults, battleResult],
    summary: {
      ...summary,
      passiveInterventions: summary.passiveInterventions + draftSummary.passiveInterventions,
      passiveSupports: summary.passiveSupports + draftSummary.passiveSupports,
      passiveRejects: summary.passiveRejects + draftSummary.passiveRejects,
      loveCardIds: [...summary.loveCardIds, ...draftSummary.loveCardIds],
      finalTrust: draft.trust,
    },
  };
}

export function advanceRun(run: RunState, draft: DraftState, winner: RunWinner): RunState {
  return recordBattleResult(run, draft, winner);
}

export function resetRun(run: RunState, initialTrust = run.initialTrust): RunState {
  return createRun(run.opponentIds, initialTrust);
}
