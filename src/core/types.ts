export type AestheticKey = "C" | "K" | "B" | "H";
export type CardType = "monster" | "spell";
export type Keyword = "rush" | "guard" | "damage" | "destroy" | "buff" | "draw" | "revive";
export type Trigger = "on_play" | "on_destroyed" | "passive" | "aura";
export type Target = "self" | "ally" | "enemy" | "all_enemies" | "enemy_low_atk";

export interface EffectCondition {
  kind: "leader_life_at_most" | "allied_tribe_at_least" | "target_attack_at_most";
  value: number;
  tribe?: string;
}

export interface CardEffect {
  trigger: Trigger;
  keyword: Keyword;
  value: number;
  target: Target;
  condition?: EffectCondition;
}

export interface Card {
  id: string;
  name: string;
  type: CardType;
  cost: number;
  atk: number;
  hp: number;
  aesthetic: Record<AestheticKey, number>;
  tribes: string[];
  effects: CardEffect[];
  rarity: "common" | "rare" | "legend";
}

export type AdviceCategory = "removal" | "guard" | "low_cost" | "skip";

export interface SyncStageBonus {
  stage: number;
  condition: {
    maxCost: number | null;
  };
  keywords: Keyword[];
  statModifiers: {
    attack: number;
  };
  activationRate: number;
}

export interface AceDefinition {
  unlockStage: number;
  lifeThreshold: number;
  grant: {
    keywords: Keyword[];
    statModifiers: {
      attack: number;
    };
  };
}

export interface ChildProfile {
  id: string;
  name: string;
  displayName: string;
  aestheticWeights: Record<AestheticKey, number>;
  loveThreshold: number;
  decisionOrder: string[];
  /** Fixed per character. Deliberately not tied to the sync rate. */
  passiveInterventionRate: number;
  offerWeightsByCardId?: Record<string, number>;
  sync: {
    initial: number;
    maximum: number;
    /** Added when the player rules in favour of the kid's first choice. */
    supportGain: number;
    /** Applied after every battle. */
    decayMultiplier: number;
    /** Values below this are carried over undecayed; the floor never raises a value. */
    decayFloor: number;
    /** Lower bound of each stage, lowest first. */
    stageMinimums: number[];
    stageBonuses: SyncStageBonus[];
  };
  ace: AceDefinition;
  advice: {
    checkpoints: number[];
    categories: AdviceCategory[];
    alwaysIntervene: boolean;
    consumesPick: boolean;
  };
  battle: {
    faceBias: number;
    attributionKeywords: Keyword[];
  };
  dialogue: Record<"ask" | "support" | "reject" | "love" | "work" | "finisher", string[]>;
}

export type PickSource = "auto" | "passive" | "advice" | "love";

export interface DraftCard {
  instanceId: string;
  cardId: string;
  intervention: boolean;
  source: PickSource;
}

export interface PickDecision {
  preferredIndex: 0 | 1;
  reason: "love" | "monster" | "lower_cost" | "higher_attack" | "aesthetic" | "first";
  love: boolean;
  scores: [number, number];
}

export interface DraftOffer {
  cards: [Card, Card];
  decision: PickDecision;
  wantsIntervention: boolean;
  source: "normal" | "advice";
  adviceCategory?: Exclude<AdviceCategory, "skip">;
}

export interface DraftHistoryItem {
  pick: number;
  offered: [string, string];
  selected: string;
  rejected: string;
  source: PickSource;
  preferred: string;
  syncBefore: number;
  syncAfter: number;
  reason: PickDecision["reason"];
}

export interface DraftState {
  seed: number;
  pick: number;
  deck: DraftCard[];
  rejectedCardIds: string[];
  syncRate: number;
  seenAdviceCheckpoints: number[];
  passiveInterventions: number;
  lovePicks: number;
  history: DraftHistoryItem[];
}

export type RunWinner = BattleSide | "draw";
export type RunOutcome = "win" | "loss" | "draw";

export interface RunBattleResult {
  opponentId: string;
  winner: RunWinner;
  outcome: RunOutcome;
  syncBefore: number;
  /** Sync rate at the end of the deck build, before the post-battle cooldown. */
  syncAfterBuild: number;
  /** Sync rate carried into the next battle, after the cooldown. */
  syncAfterDecay: number;
  passiveInterventions: number;
  passiveSupports: number;
  passiveRejects: number;
  loveCardIds: string[];
}

export interface RunSummary {
  wins: number;
  losses: number;
  draws: number;
  passiveInterventions: number;
  passiveSupports: number;
  passiveRejects: number;
  loveCardIds: string[];
  finalSync: number;
}

export interface RunState {
  /** Zero-based index of the next battle to start. Equals opponentIds.length when complete. */
  currentBattle: number;
  opponentIds: string[];
  initialSync: number;
  carrySync: number;
  battleResults: RunBattleResult[];
  summary: RunSummary;
}

export interface DeckEvaluation {
  size: number;
  monsters: number;
  spells: number;
  averageCost: number;
  removal: number;
  guards: number;
  lowCost: number;
  heavy: number;
  synergyActive: number;
  metrics: {
    removalMissing: boolean;
    durabilityMissing: boolean;
    heavyCongestion: boolean;
    lowCostMissing: boolean;
  };
  missingCount: number;
  curve: number[];
}

export interface OpponentDefinition {
  id: string;
  name: string;
  title: string;
  trait: string;
  deck: string[];
  faceBias: number;
  color: string;
  intro: string;
  taunts: string[];
}

export type BattleSide = "brother" | "opponent";

export interface BattleCardInstance {
  instanceId: string;
  cardId: string;
  intervention: boolean;
  source: PickSource;
  atk: number;
  hp: number;
  maxHp: number;
  grantedKeywords: Keyword[];
  grantedAtk: number;
  summonedTurn: number;
  attacked: boolean;
  revived: boolean;
  buffSources: Array<{ instanceId: string; amount: number; intervention: boolean }>;
}

export interface BattlePlayer {
  side: BattleSide;
  name: string;
  life: number;
  maxPp: number;
  pp: number;
  deck: BattleCardInstance[];
  hand: BattleCardInstance[];
  board: BattleCardInstance[];
  graveyard: BattleCardInstance[];
  aceCard: BattleCardInstance | null;
  aceUsed: boolean;
}

export type BattleEventType = "turn" | "draw" | "play" | "effect" | "attack" | "destroyed" | "attribution" | "taunt" | "result" | "sync_bonus" | "ace";

export interface BattleEvent {
  id: string;
  type: BattleEventType;
  side: BattleSide;
  text: string;
  cardId?: string;
  instanceId?: string;
  keyword?: Keyword;
  dialogue?: string;
  effective?: boolean;
}

export interface BattleState {
  seed: number;
  syncRate: number;
  turn: number;
  activeSide: BattleSide;
  brother: BattlePlayer;
  opponent: BattlePlayer;
  winner: BattleSide | "draw" | null;
  events: BattleEvent[];
  attributionFired: string[];
  nextEventId: number;
}
