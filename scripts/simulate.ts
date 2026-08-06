import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  advanceBattle,
  advanceRun,
  activeSpeciesSynergies,
  createBattle,
  createDraft,
  createLadderRun,
  createRun,
  evaluateDeck,
  generateOffer,
  getOpponentById,
  isAceUnlocked,
  isAdviceDue,
  markAdviceSkipped,
  nextRandom,
  resolveOffer,
  syncStage,
  type AdviceCategory,
  type BattleState,
  type Card,
  type ChildProfile,
  type DraftState,
  type OpponentDefinition,
  type SpeciesSynergyConfig,
  type RunState,
} from "../src/core/index";

const cards = JSON.parse(readFileSync(resolve("data/cards.json"), "utf8")) as Card[];
const child = JSON.parse(readFileSync(resolve("data/children/tanjun.json"), "utf8")) as ChildProfile;
const opponents = JSON.parse(readFileSync(resolve("data/opponents.json"), "utf8")) as OpponentDefinition[];
const synergyConfig = JSON.parse(readFileSync(resolve("data/species.json"), "utf8")) as SpeciesSynergyConfig;

type LadderMode = "six" | "three";
type PolicyKind = "always-match" | "never-match" | "random" | "match-rate";

interface AdjudicationPolicy {
  kind: PolicyKind;
  matchRate?: number;
}

interface BattleAggregate {
  battles: number;
  wins: number;
  buildSync: number[];
  carrySync: number[];
  buildStages: Record<string, number>;
  carryStages: Record<string, number>;
  stage5Builds: number;
  opponentStage: Record<string, { battles: number; wins: number }>;
  aceEligible: number;
  aceActivated: number;
  aceActivatedWins: number;
  aceComebackWins: number;
  aceLifeReached: number;
  withAceWins: number;
  withoutAceWins: number;
  deckExhausted: number;
  boundaryBuild: number;
  boundaryCarry: number;
  passiveInterventions: number;
}

const args = process.argv.slice(2);
const optionValue = (name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index >= 0) return args[index + 1];
  const prefix = `${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const positionalRuns = args.find((arg) => /^\d+$/.test(arg));
const runs = Number(positionalRuns ?? 10000);
const mode = (optionValue("--mode") ?? "six") as LadderMode;
const rawPolicy = optionValue("--policy") ?? "always-match";
const rawMatchRate = optionValue("--match-rate");
const rawAceThreshold = optionValue("--ace-threshold");

if (!Number.isInteger(runs) || runs < 1) throw new Error("runs must be a positive integer");
if (mode !== "six" && mode !== "three") throw new Error("--mode must be six or three");

const aceThreshold = rawAceThreshold === undefined ? child.ace.lifeThreshold : Number(rawAceThreshold);
if (!Number.isInteger(aceThreshold) || aceThreshold < 0) throw new Error("--ace-threshold must be a non-negative integer");
const simulationChild: ChildProfile = {
  ...child,
  ace: { ...child.ace, lifeThreshold: aceThreshold },
};

function parseRate(value: string): number {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error("match rate must be between 0.0 and 1.0");
  return rate;
}

function parsePolicy(): AdjudicationPolicy {
  if (rawMatchRate !== undefined) return { kind: "match-rate", matchRate: parseRate(rawMatchRate) };
  if (rawPolicy === "always-match" || rawPolicy === "never-match" || rawPolicy === "random") return { kind: rawPolicy };
  if (rawPolicy.startsWith("rate:")) return { kind: "match-rate", matchRate: parseRate(rawPolicy.slice(5)) };
  if (/^\d*\.?\d+$/.test(rawPolicy)) return { kind: "match-rate", matchRate: parseRate(rawPolicy) };
  throw new Error("--policy must be always-match, never-match, random, or a 0.0-1.0 match rate");
}

const policy = parsePolicy();

function opponentById(id: string): OpponentDefinition {
  const opponent = getOpponentById(opponents, id);
  if (!opponent) throw new Error(`Missing opponent data: ${id}`);
  return opponent;
}

function chooseAdviceCategory(): Exclude<AdviceCategory, "skip"> | undefined {
  return simulationChild.advice.categories.find((category): category is Exclude<AdviceCategory, "skip"> => category !== "skip");
}

function policyMatches(policyValue: AdjudicationPolicy, seed: number): { matches: boolean; seed: number } {
  if (policyValue.kind === "always-match") return { matches: true, seed };
  if (policyValue.kind === "never-match") return { matches: false, seed };
  const random = nextRandom(seed);
  const rate = policyValue.kind === "random" ? 0.5 : policyValue.matchRate ?? 0;
  return { matches: random.value < rate, seed: random.seed };
}

function simulateDraft(seed: number, initialSync: number, policyValue: AdjudicationPolicy, initialPolicySeed: number): { draft: DraftState; policySeed: number } {
  let state = createDraft(seed, simulationChild, initialSync);
  let policySeed = initialPolicySeed >>> 0;
  while (state.pick < 15) {
    if (isAdviceDue(state, simulationChild)) {
      const category = chooseAdviceCategory();
      if (!category) {
        state = markAdviceSkipped(state);
        continue;
      }
      const generated = generateOffer(state, cards, simulationChild, category);
      state = resolveOffer(generated.state, generated.offer, simulationChild, generated.offer.decision.preferredIndex);
      continue;
    }

    const generated = generateOffer(state, cards, simulationChild);
    let selectedIndex: 0 | 1 | undefined;
    if (generated.offer.wantsIntervention) {
      const result = policyMatches(policyValue, policySeed);
      policySeed = result.seed;
      selectedIndex = result.matches ? generated.offer.decision.preferredIndex : generated.offer.decision.preferredIndex === 0 ? 1 : 0;
    }
    state = resolveOffer(generated.state, generated.offer, simulationChild, selectedIndex);
  }
  return { draft: state, policySeed };
}

function runBattleWithMetrics(initial: BattleState, opponent: OpponentDefinition): { battle: BattleState; lifeThresholdReached: boolean; deckExhausted: boolean; aceActivated: boolean; comebackWin: boolean } {
  let next = initial;
  let lifeThresholdReached = next.brother.life <= simulationChild.ace.lifeThreshold;
  let deckExhausted = next.brother.deck.length === 0 || next.opponent.deck.length === 0;
  let aceActivated = false;
  let wasBehindAtAce = false;
  while (!next.winner) {
    const before = next;
    next = advanceBattle(next, cards, simulationChild, opponent);
    if (!before.brother.aceUsed && next.brother.aceUsed) {
      aceActivated = true;
      wasBehindAtAce = before.brother.life < before.opponent.life;
    }
    lifeThresholdReached ||= next.brother.life <= simulationChild.ace.lifeThreshold;
    deckExhausted ||= next.brother.deck.length === 0 || next.opponent.deck.length === 0;
  }
  return { battle: next, lifeThresholdReached, deckExhausted, aceActivated, comebackWin: aceActivated && wasBehindAtAce && next.winner === "brother" };
}

function createAggregate(): BattleAggregate {
  return {
    battles: 0,
    wins: 0,
    buildSync: [],
    carrySync: [],
    buildStages: {},
    carryStages: {},
    stage5Builds: 0,
    opponentStage: {},
    aceEligible: 0,
    aceActivated: 0,
    aceActivatedWins: 0,
    aceComebackWins: 0,
    aceLifeReached: 0,
    withAceWins: 0,
    withoutAceWins: 0,
    deckExhausted: 0,
    boundaryBuild: 0,
    boundaryCarry: 0,
    passiveInterventions: 0,
  };
}

function addStage(map: Record<string, number>, stage: number): void {
  const key = String(stage);
  map[key] = (map[key] ?? 0) + 1;
}

function nearStageBoundary(value: number): boolean {
  return [20, 40, 60, 80].some((boundary) => Math.abs(value - boundary) <= 0.5);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
}

function distribution(values: number[]): Record<string, number> {
  return Object.fromEntries([1, 2, 3, 4, 5].map((stage) => [String(stage), values.filter((value) => syncStage(value, simulationChild) === stage).length]));
}

function summarize(values: number[]): Record<string, number> {
  if (!values.length) return { mean: 0, p10: 0, median: 0, p90: 0, min: 0, max: 0 };
  return {
    mean: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
    p10: percentile(values, 0.1),
    median: percentile(values, 0.5),
    p90: percentile(values, 0.9),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function ladderFor(modeValue: LadderMode, seed: number): RunState {
  return modeValue === "six" ? createLadderRun(seed, simulationChild.sync.initial) : createRun(["rush", "wall", "boss"], simulationChild.sync.initial);
}

const battleCount = mode === "six" ? 6 : 3;
const aggregates = Array.from({ length: battleCount }, createAggregate);
const interventionHistogram = new Map<number, number>();
const variablePairCounts = new Map<string, number>();
const synergyStats = { builds: 0, stageOneBuilds: 0, stageTwoBuilds: 0, stageOneLines: 0, stageTwoLines: 0, winsWithSynergy: 0, buildsWithSynergy: 0, winsWithout: 0, buildsWithout: 0 };
const synergyBySpecies = new Map<string, number>();
const allBuildValues: number[] = [];
const allCarryValues: number[] = [];
const stage5ByBattle = Array.from({ length: battleCount }, () => 0);
const runWinHistogram = new Map<number, number>();
let totalWins = 0;
let totalBattles = 0;
let totalDeckExhaustions = 0;

for (let runIndex = 0; runIndex < runs; runIndex += 1) {
  const runSeed = Math.imul(runIndex + 1, 0x9e3779b1) >>> 0;
  let run = ladderFor(mode, runSeed);
  let policySeed = (runSeed ^ 0xa5a5a5a5) >>> 0;
  if (mode === "six") {
    const pair = run.opponentIds.slice(1, 3).join("+");
    variablePairCounts.set(pair, (variablePairCounts.get(pair) ?? 0) + 1);
  }

  for (let battleIndex = 0; battleIndex < battleCount; battleIndex += 1) {
    const draftSeed = (runSeed ^ Math.imul(battleIndex + 1, 0x85ebca6b)) >>> 0;
    const drafted = simulateDraft(draftSeed, run.carrySync, policy, policySeed);
    policySeed = drafted.policySeed;
    const draft = drafted.draft;
    const opponent = opponentById(run.opponentIds[battleIndex]);
    const buildStage = syncStage(draft.syncRate, simulationChild);
    const aceEligible = isAceUnlocked(draft.syncRate, simulationChild);
    const aceCardId = aceEligible ? draft.deck[0]?.cardId ?? null : null;
    const battleSeed = (draft.seed ^ 0xa5a5a5a5) >>> 0;
    const withAce = runBattleWithMetrics(createBattle(draft.deck, opponent, cards, battleSeed, draft.syncRate, aceCardId, synergyConfig), opponent);
    let withoutAce: ReturnType<typeof runBattleWithMetrics> | undefined;
    if (aceEligible) withoutAce = runBattleWithMetrics(createBattle(draft.deck, opponent, cards, battleSeed, draft.syncRate, null, synergyConfig), opponent);

    const synergies = activeSpeciesSynergies(draft.deck, cards, synergyConfig);
    synergyStats.builds += 1;
    synergyStats.stageOneLines += synergies.filter((item) => item.stage === 1).length;
    synergyStats.stageTwoLines += synergies.filter((item) => item.stage === 2).length;
    synergyStats.stageOneBuilds += Number(synergies.some((item) => item.stage === 1));
    synergyStats.stageTwoBuilds += Number(synergies.some((item) => item.stage === 2));
    synergies.forEach((item) => synergyBySpecies.set(`${item.species}|${item.stage}`, (synergyBySpecies.get(`${item.species}|${item.stage}`) ?? 0) + 1));

    run = advanceRun(run, draft, withAce.battle.winner!, simulationChild);
    const result = run.battleResults.at(-1)!;
    if (synergies.length) { synergyStats.buildsWithSynergy += 1; synergyStats.winsWithSynergy += Number(result.winner === "brother"); }
    else { synergyStats.buildsWithout += 1; synergyStats.winsWithout += Number(result.winner === "brother"); }
    const aggregate = aggregates[battleIndex];
    aggregate.battles += 1;
    aggregate.wins += Number(result.winner === "brother");
    aggregate.buildSync.push(result.syncAfterBuild);
    aggregate.carrySync.push(result.syncAfterDecay);
    aggregate.passiveInterventions += result.passiveInterventions;
    addStage(aggregate.buildStages, buildStage);
    addStage(aggregate.carryStages, syncStage(result.syncAfterDecay, simulationChild));
    aggregate.opponentStage[`${result.opponentId}|${buildStage}`] ??= { battles: 0, wins: 0 };
    aggregate.opponentStage[`${result.opponentId}|${buildStage}`].battles += 1;
    aggregate.opponentStage[`${result.opponentId}|${buildStage}`].wins += Number(result.winner === "brother");
    aggregate.aceEligible += Number(aceEligible);
    aggregate.aceActivated += Number(withAce.aceActivated);
    aggregate.aceActivatedWins += Number(withAce.aceActivated && result.winner === "brother");
    aggregate.aceComebackWins += Number(withAce.comebackWin);
    aggregate.aceLifeReached += Number(aceEligible && withAce.lifeThresholdReached);
    aggregate.withAceWins += Number(aceEligible && result.winner === "brother");
    aggregate.withoutAceWins += Number(aceEligible && withoutAce?.battle.winner === "brother");
    aggregate.deckExhausted += Number(withAce.deckExhausted);
    aggregate.boundaryBuild += Number(nearStageBoundary(result.syncAfterBuild));
    aggregate.boundaryCarry += Number(nearStageBoundary(result.syncAfterDecay));
    if (aceEligible) {
      aggregate.stage5Builds += 1;
      stage5ByBattle[battleIndex] += 1;
    }
    interventionHistogram.set(result.passiveInterventions, (interventionHistogram.get(result.passiveInterventions) ?? 0) + 1);
    allBuildValues.push(result.syncAfterBuild);
    allCarryValues.push(result.syncAfterDecay);
    totalWins += Number(result.winner === "brother");
    totalBattles += 1;
    totalDeckExhaustions += Number(withAce.deckExhausted);
  }
  runWinHistogram.set(run.summary.wins, (runWinHistogram.get(run.summary.wins) ?? 0) + 1);
}

const formatRate = (value: number, denominator: number) => denominator ? Number((value / denominator * 100).toFixed(3)) : 0;
const formatAggregate = (aggregate: BattleAggregate, battleIndex: number) => ({
  battle: battleIndex + 1,
  battles: aggregate.battles,
  winRate: formatRate(aggregate.wins, aggregate.battles),
  buildSync: summarize(aggregate.buildSync),
  carrySync: summarize(aggregate.carrySync),
  buildStageDistribution: aggregate.buildStages,
  carryStageDistribution: aggregate.carryStages,
  stage5BuildRate: formatRate(aggregate.stage5Builds, aggregate.battles),
  opponentStageWinRate: Object.fromEntries(Object.entries(aggregate.opponentStage).sort().map(([key, value]) => [key, { battles: value.battles, winRate: formatRate(value.wins, value.battles) }])),
  ace: {
    stage5Builds: aggregate.aceEligible,
    lifeThresholdReached: aggregate.aceLifeReached,
    activated: aggregate.aceActivated,
    exposureRate: formatRate(aggregate.aceActivated, aggregate.aceEligible),
    activatedWinRate: formatRate(aggregate.aceActivatedWins, aggregate.aceActivated),
    comebackWins: aggregate.aceComebackWins,
    comebackRateAmongActivated: formatRate(aggregate.aceComebackWins, aggregate.aceActivated),
    comebackRateAmongActivatedWins: formatRate(aggregate.aceComebackWins, aggregate.aceActivatedWins),
    withAceWinRate: formatRate(aggregate.withAceWins, aggregate.aceEligible),
    withoutAceWinRate: formatRate(aggregate.withoutAceWins, aggregate.aceEligible),
    winRateDifferencePoints: Number((formatRate(aggregate.withAceWins, aggregate.aceEligible) - formatRate(aggregate.withoutAceWins, aggregate.aceEligible)).toFixed(3)),
  },
  passiveInterventions: {
    averagePerBattle: Number((aggregate.passiveInterventions / aggregate.battles).toFixed(3)),
  },
  deckExhaustionRate: formatRate(aggregate.deckExhausted, aggregate.battles),
  syncBoundaryWithinHalf: {
    buildEnd: aggregate.boundaryBuild,
    carryEnd: aggregate.boundaryCarry,
  },
});

for (const id of ["rush", "wall", "boss", "sister", "smart-brother", "cousin", "executive"]) opponentById(id);

console.log(JSON.stringify({
  runs,
  mode,
  aceThreshold,
  policy,
  ladderBattles: battleCount,
  overallWinRate: formatRate(totalWins, totalBattles),
  battleStats: aggregates.map(formatAggregate),
  stage5BuildEndByBattle: stage5ByBattle,
  interventionHistogram: Object.fromEntries([...interventionHistogram.entries()].sort((a, b) => a[0] - b[0])),
  syncBoundaryWithinHalfTotal: {
    buildEnd: aggregates.reduce((sum, item) => sum + item.boundaryBuild, 0),
    carryEnd: aggregates.reduce((sum, item) => sum + item.boundaryCarry, 0),
  },
  allBuildSync: summarize(allBuildValues),
  allCarrySync: summarize(allCarryValues),
  deckExhaustionRate: formatRate(totalDeckExhaustions, totalBattles),
  runWinHistogram: Object.fromEntries([...runWinHistogram.entries()].sort((a, b) => a[0] - b[0])),
  speciesSynergy: {
    buildsWithStageOne: `${round(synergyStats.stageOneBuilds / synergyStats.builds * 100)}%`,
    buildsWithStageTwo: `${round(synergyStats.stageTwoBuilds / synergyStats.builds * 100)}%`,
    linesPerBuild: round(synergyStats.stageOneLines / synergyStats.builds),
    winRateWithSynergy: synergyStats.buildsWithSynergy ? round(synergyStats.winsWithSynergy / synergyStats.buildsWithSynergy * 100) : null,
    winRateWithoutSynergy: synergyStats.buildsWithout ? round(synergyStats.winsWithout / synergyStats.buildsWithout * 100) : null,
    bySpecies: Object.fromEntries([...synergyBySpecies.entries()].sort((a, b) => b[1] - a[1])),
  },
  variablePairCounts: Object.fromEntries([...variablePairCounts.entries()].sort()),
}, null, 2));
