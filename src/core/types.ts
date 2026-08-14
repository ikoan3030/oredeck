export type AestheticKey = "C" | "K" | "cool" | "H";
export type Species = "ドラゴン" | "メカ" | "けもの" | "天使" | "悪魔" | "精霊";
export type CardType = "monster" | "spell";
/** "heal" is a stage-two synergy word only: plain cards and spells never carry it. */
export type Keyword = "rush" | "guard" | "damage" | "destroy" | "buff" | "draw" | "revive" | "heal";
export type Trigger = "on_play" | "on_destroyed" | "passive" | "aura";
export type Target = "self" | "ally" | "all_allies" | "enemy" | "enemy_leader" | "all_enemies" | "enemy_low_atk";

export interface EffectCondition {
  kind: "leader_life_at_most" | "allied_species_at_least" | "target_attack_at_most";
  value: number;
  species?: Species;
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
  /** Monsters carry one species; spells are null and never counted by synergy. */
  species: Species | null;
  effects: CardEffect[];
  rarity: "common" | "rare" | "legend";
}

export type AdviceCategory = "species" | "spell" | "low_cost" | "high_cost" | "skip";
export type AttackStyle = "face" | "board" | "balanced";

/**
 * One grant applied to a card. The same shape backs species synergy, the sync stage bonus
 * and the ace card, so the duplicate ruling below is shared by all three.
 */
export interface SpeciesGrant {
  keywords: Keyword[];
  effects: CardEffect[];
  attack: number;
  hp: number;
}

export interface SpeciesDefinition {
  id: Species;
  stageOne: SpeciesGrant;
  stageTwo: SpeciesGrant;
}

export interface SpeciesSynergyConfig {
  thresholds: { stageOne: number; stageTwo: number };
  bondSuffix: string;
  stageLabels: string[];
  species: SpeciesDefinition[];
}

export interface ActiveSpeciesSynergy {
  species: Species;
  stage: 1 | 2;
  types: number;
  label: string;
}

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

export interface SyncStageLabel {
  minimum: number;
  label: string;
}

export interface BuildMoodTier {
  minimumAutoPicks: number;
  text: string;
}

/** Presentation copy for the post-build recap. Read by the UI only. */
export interface BuildSummaryCopy {
  moodTiers: BuildMoodTier[];
  stageUpText: string;
  stageKeptText: string;
}

export type BattleCommentaryKind = "largeSummon" | "ace" | "ownDestroyed" | "leaderDamage" | "lowLife";

export interface BattleCommentaryDefinition {
  frequency: Record<BattleCommentaryKind, number>;
  lines: Record<BattleCommentaryKind, string[]>;
}

export interface PostBattleDialogue {
  gratitude: string[];
  aceWin: string[];
  victory: string[];
  defeat: string[];
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

export interface PassiveInterventionSegment {
  startPick: number;
  endPick: number;
  count: number;
}

export interface PassiveInterventionPlan {
  total: number;
  segments: PassiveInterventionSegment[];
  freeCount: number;
}

export interface ChildProfile {
  id: string;
  name: string;
  displayName: string;
  aestheticWeights: Record<AestheticKey, number>;
  loveThreshold: number;
  decisionOrder: string[];
  /** Fixed per character. Positions are drawn once at build start and are independent of advice weights. */
  passiveInterventions: PassiveInterventionPlan;
  /**
   * Presentation switch only: the crush decision always runs in core.
   * When false the UI shows a crush pick exactly like an ordinary auto pick.
   * Defaults to shown when the field is absent.
   */
  showCrush?: boolean;
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
    stageLabels?: SyncStageLabel[];
    stageBonuses: SyncStageBonus[];
  };
  ace: AceDefinition;
  buildSummary?: BuildSummaryCopy;
  advice: {
    checkpoints: number[];
    categories: AdviceCategory[];
    alwaysIntervene: boolean;
    consumesPick: boolean;
    /** Offer weight applied to the ordered category while the order is live. */
    focusMultiplier: number;
    /** How many picks the order stays live for, counted from the checkpoint. */
    focusPicks: number;
  };
  battle: {
    faceBias: number;
    /** Attack target preference. Missing data falls back to balanced in core. */
    attackStyle?: AttackStyle;
    attributionKeywords: Keyword[];
  };
  /** "pick" lines may carry a {name} placeholder for the chosen card. */
  dialogue: Record<"pick" | "ask" | "support" | "reject" | "love" | "advice" | "mulling", string[]>;
  battleCommentary: BattleCommentaryDefinition;
  postBattle: PostBattleDialogue;
}

export type PickSource = "auto" | "passive" | "advice" | "love";

export interface DraftCard {
  instanceId: string;
  cardId: string;
  intervention: boolean;
  interventionSupported?: boolean;
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
  source: "normal";
}

/** A live advice order: it only tilts the offer weights, never the pick itself. */
export interface AdviceFocus {
  category: Exclude<AdviceCategory, "skip">;
  /** Required when category is species; absent for the other order types. */
  targetSpecies?: Species;
  /** The order stops applying once the draft reaches this pick number. */
  expiresAtPick: number;
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
  adviceFocus: AdviceFocus | null;
  /** One-based future/current pick positions scheduled for passive intervention. */
  passiveInterventionPicks: number[];
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
  speciesTypes: Record<Species, number>;
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
  /** Attack target preference. Missing data falls back to balanced in core. */
  attackStyle?: AttackStyle;
  color: string;
  /** Battle backdrop key. Resolves to an image in src/assets/backgrounds/ on the UI side. */
  background?: string;
  leaderLife?: number;
  /** Organization opponents may resolve their deck's species grants at battle start. */
  speciesSynergy?: boolean;
  intro: string;
  taunts: string[];
}

export type BattleSide = "brother" | "opponent";

export interface BattleCardInstance {
  instanceId: string;
  cardId: string;
  intervention: boolean;
  interventionSupported?: boolean;
  source: PickSource;
  atk: number;
  hp: number;
  maxHp: number;
  grantedKeywords: Keyword[];
  /** Triggered effects handed out by a synergy, resolved alongside the card's own effects. */
  grantedEffects: CardEffect[];
  grantedAtk: number;
  grantedHp: number;
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

export type BattleEventType = "turn" | "draw" | "play" | "effect" | "attack" | "destroyed" | "attribution" | "taunt" | "result" | "sync_bonus" | "ace" | "heal";

export interface BattleEventSnapshotPlayer {
  side: BattleSide;
  name: string;
  life: number;
  maxPp: number;
  pp: number;
  deckCount: number;
  hand: BattleCardInstance[];
  board: BattleCardInstance[];
  graveyard: BattleCardInstance[];
  aceCard: BattleCardInstance | null;
  aceUsed: boolean;
}

export interface BattleEventSnapshot {
  brother: BattleEventSnapshotPlayer;
  opponent: BattleEventSnapshotPlayer;
}

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
  targetInstanceId?: string;
  targetInstanceIds?: string[];
  targetLeader?: boolean;
  sourceInstanceId?: string;
  damage?: number;
  retaliationDamage?: number;
  value?: number;
  destroyed?: boolean;
  sourceInstance?: BattleCardInstance;
  targetInstances?: BattleCardInstance[];
  beforeSnapshot?: BattleEventSnapshot;
  snapshot?: BattleEventSnapshot;
}

export interface BattleState {
  seed: number;
  /** Species synergies resolved at build completion. Constant for the whole battle. */
  synergies: ActiveSpeciesSynergy[];
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
