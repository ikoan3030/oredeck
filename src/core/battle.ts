import { nextRandom, randomIndex, shuffle } from "./random";
import { activeSpeciesSynergies, speciesGrant } from "./species";
import { syncStage } from "./sync";
import type {
  BattleCardInstance,
  CardEffect,
  SpeciesSynergyConfig,
  BattleEvent,
  BattleEventSnapshot,
  BattleEventSnapshotPlayer,
  BattlePlayer,
  BattleSide,
  BattleState,
  Card,
  ChildProfile,
  DraftCard,
  ActiveSpeciesSynergy,
  Keyword,
  OpponentDefinition,
} from "./types";

const MAX_BOARD = 5;
const MAX_TURNS = 30;

function other(side: BattleSide): BattleSide {
  return side === "brother" ? "opponent" : "brother";
}

function makeInstance(card: Card, instanceId: string, draft?: DraftCard): BattleCardInstance {
  return {
    instanceId,
    cardId: card.id,
    intervention: draft?.intervention ?? false,
    source: draft?.source ?? "auto",
    atk: card.atk,
    hp: card.hp,
    maxHp: card.hp,
    grantedKeywords: [],
    grantedEffects: [],
    grantedAtk: 0,
    grantedHp: 0,
    summonedTurn: -1,
    attacked: false,
    revived: false,
    buffSources: [],
  };
}

function snapshotPlayer(player: BattlePlayer): BattleEventSnapshotPlayer {
  return {
    side: player.side,
    name: player.name,
    life: player.life,
    maxPp: player.maxPp,
    pp: player.pp,
    deckCount: player.deck.length,
    hand: [...player.hand],
    board: [...player.board],
    graveyard: [...player.graveyard],
    aceCard: player.aceCard,
    aceUsed: player.aceUsed,
  };
}

function snapshot(state: BattleState): BattleEventSnapshot {
  return {
    brother: snapshotPlayer(state.brother),
    opponent: snapshotPlayer(state.opponent),
  };
}

function event(state: BattleState, value: Omit<BattleEvent, "id">): BattleState {
  const id = `event-${state.nextEventId}`;
  const next = {
    ...state,
    nextEventId: state.nextEventId + 1,
  };
  return {
    ...next,
    events: [...state.events, { ...value, id, beforeSnapshot: value.beforeSnapshot ?? snapshot(state), snapshot: value.snapshot ?? snapshot(next) }],
  };
}

function updatePlayers(state: BattleState, active: BattlePlayer, enemy: BattlePlayer): BattleState {
  return active.side === "brother" ? { ...state, brother: active, opponent: enemy } : { ...state, opponent: active, brother: enemy };
}

function cardById(cards: readonly Card[], id: string): Card {
  const card = cards.find((item) => item.id === id);
  if (!card) throw new Error(`Unknown card: ${id}`);
  return card;
}

function applySpeciesGrants(
  instances: BattleCardInstance[],
  synergies: readonly ActiveSpeciesSynergy[],
  cards: readonly Card[],
  config: SpeciesSynergyConfig,
): BattleCardInstance[] {
  return instances.map((instance) => {
    const species = cardById(cards, instance.cardId).species;
    const synergy = species ? synergies.find((item) => item.species === species) : undefined;
    if (!synergy) return instance;
    const grant = speciesGrant(synergy.species, synergy.stage, config);
    return grant ? grantToInstance(instance, cards, grant) : instance;
  });
}

export function instanceHasKeyword(instance: BattleCardInstance, cards: readonly Card[], keyword: Keyword): boolean {
  return instance.grantedKeywords.includes(keyword)
    || instance.grantedEffects.some((effect) => effect.keyword === keyword)
    || cardById(cards, instance.cardId).effects.some((effect) => effect.keyword === keyword);
}

function instanceEffects(instance: BattleCardInstance, cards: readonly Card[]): CardEffect[] {
  return [...cardById(cards, instance.cardId).effects, ...instance.grantedEffects];
}

/**
 * The shared duplicate ruling for every grant (species synergy, sync stage bonus, ace card):
 * a different keyword stacks, the same keyword becomes 強化+1 instead so nothing whiffs.
 */
function grantToInstance(
  instance: BattleCardInstance,
  cards: readonly Card[],
  grant: { keywords?: readonly Keyword[]; effects?: readonly CardEffect[]; attack?: number; hp?: number },
): BattleCardInstance {
  let attack = grant.attack ?? 0;
  const hp = grant.hp ?? 0;
  const keywords: Keyword[] = [];
  const effects: CardEffect[] = [];
  for (const keyword of grant.keywords ?? []) {
    if (instanceHasKeyword(instance, cards, keyword)) attack += 1;
    else keywords.push(keyword);
  }
  for (const effect of grant.effects ?? []) {
    if (instanceHasKeyword(instance, cards, effect.keyword)) attack += 1;
    else effects.push(effect);
  }
  return {
    ...instance,
    grantedKeywords: [...instance.grantedKeywords, ...keywords],
    grantedEffects: [...instance.grantedEffects, ...effects],
    grantedAtk: instance.grantedAtk + attack,
    atk: instance.atk + attack,
    // Folding the hp grant into hp and maxHp keeps every combat, destruction and display
    // path working unchanged, and makes maxHp the healing ceiling the spec asks for.
    grantedHp: instance.grantedHp + hp,
    hp: instance.hp + hp,
    maxHp: instance.maxHp + hp,
  };
}

function drawOne(player: BattlePlayer): { player: BattlePlayer; drawn?: BattleCardInstance } {
  if (player.deck.length === 0) return { player };
  const [drawn, ...deck] = player.deck;
  return { player: { ...player, deck, hand: [...player.hand, drawn] }, drawn };
}

function drawAtTurnStart(
  state: BattleState,
  player: BattlePlayer,
  child: ChildProfile,
  cards: readonly Card[],
): { player: BattlePlayer; drawn?: BattleCardInstance; ace: boolean; aceCard?: BattleCardInstance } {
  const ace = child.ace;
  const stage = syncStage(state.syncRate, child);
  if (player.side !== "brother" || !player.aceCard || stage < ace.unlockStage || player.life > ace.lifeThreshold) {
    const drawn = drawOne(player);
    return { ...drawn, ace: false };
  }
  const drawn = grantToInstance(player.aceCard, cards, { keywords: ace.grant.keywords, attack: ace.grant.statModifiers.attack });
  return {
    player: { ...player, aceCard: null, aceUsed: true, hand: [...player.hand, drawn] },
    ace: true,
    aceCard: drawn,
  };
}

function canPlay(instance: BattleCardInstance, player: BattlePlayer, enemy: BattlePlayer, cards: readonly Card[]): boolean {
  const card = cardById(cards, instance.cardId);
  if (card.cost > player.pp) return false;
  if (card.type === "monster") return player.board.length < MAX_BOARD;
  const effect = card.effects[0];
  if (!effect) return false;
  if (effect.keyword === "buff") return player.board.length > 0;
  if (effect.keyword === "destroy") return enemy.board.some((target) => !effect.condition || target.atk <= effect.condition.value);
  return true;
}

function chooseEnemyTarget(enemy: BattlePlayer, preferKillableAtk = Number.POSITIVE_INFINITY): number {
  const killable = enemy.board
    .map((card, index) => ({ card, index }))
    .filter(({ card }) => card.hp <= preferKillableAtk)
    .sort((a, b) => b.card.atk - a.card.atk || a.card.hp - b.card.hp);
  if (killable.length) return killable[0].index;
  return enemy.board
    .map((card, index) => ({ card, index }))
    .sort((a, b) => a.card.hp - b.card.hp || b.card.atk - a.card.atk)[0]?.index ?? -1;
}

function markAttribution(
  state: BattleState,
  instance: BattleCardInstance,
  keyword: Keyword,
  child: ChildProfile,
  finisher: boolean,
): BattleState {
  if (!instance.intervention || state.attributionFired.includes(instance.instanceId)) return state;
  if (!finisher && !child.battle.attributionKeywords.includes(keyword)) return state;
  const dialogueList = finisher ? child.dialogue.finisher : child.dialogue.work;
  const dialogue = dialogueList[state.nextEventId % dialogueList.length];
  const next = event(state, {
    type: "attribution",
    side: "brother",
    text: finisher ? "介入カードが最後の一撃を決めた" : "介入カードが実効的な仕事をした",
    cardId: instance.cardId,
    instanceId: instance.instanceId,
    keyword,
    dialogue,
    effective: true,
  });
  return { ...next, attributionFired: [...next.attributionFired, instance.instanceId] };
}

function destroyAtIndex(
  state: BattleState,
  player: BattlePlayer,
  index: number,
  cards: readonly Card[],
): { state: BattleState; player: BattlePlayer; destroyed?: BattleCardInstance } {
  const target = player.board[index];
  if (!target) return { state, player };
  const board = player.board.filter((_, itemIndex) => itemIndex !== index);
  let nextPlayer = { ...player, board, graveyard: [...player.graveyard, target] };
  let nextState = event(state, {
    type: "destroyed",
    side: player.side,
    text: `${cardById(cards, target.cardId).name}が破壊された`,
    cardId: target.cardId,
    instanceId: target.instanceId,
    targetInstanceId: target.instanceId,
    targetInstances: [target],
    destroyed: true,
  });
  const hasRevive = instanceHasKeyword(target, cards, "revive");
  if (hasRevive && !target.revived) {
    const revived = { ...target, hp: target.maxHp, attacked: false, revived: true, buffSources: [] };
    nextPlayer = { ...nextPlayer, hand: [...nextPlayer.hand, revived] };
    nextState = event(nextState, {
      type: "effect",
      side: player.side,
      text: `${cardById(cards, target.cardId).name}が手札に復活した`,
      cardId: target.cardId,
      keyword: "revive",
      sourceInstanceId: target.instanceId,
      targetInstanceIds: [revived.instanceId],
      sourceInstance: target,
      targetInstances: [revived],
      effective: true,
    });
  }
  return { state: nextState, player: nextPlayer, destroyed: target };
}

/**
 * Resolves granted "destroyed" triggers, currently only the mech stage-two damage.
 * Read the state fresh at the call site so the owner and enemy are both current.
 * No chaining: only the player's own cards ever carry a trigger, so a kill made here
 * cannot fire another one.
 */
function applyDestroyTriggers(
  state: BattleState,
  destroyed: BattleCardInstance,
  ownerSide: BattleSide,
  cards: readonly Card[],
): BattleState {
  const triggers = destroyed.grantedEffects.filter((effect) => effect.trigger === "on_destroyed" && effect.keyword === "damage");
  if (!triggers.length) return state;
  const sourceCard = cardById(cards, destroyed.cardId);
  let next = state;
  for (const trigger of triggers) {
    const enemySide = other(ownerSide);
    let enemy = next[enemySide];
    if (enemy.board.length) {
      const pick = randomIndex(next.seed, enemy.board.length);
      next = { ...next, seed: pick.seed };
      const target = enemy.board[pick.index];
      const damaged = { ...target, hp: target.hp - trigger.value };
      enemy = { ...enemy, board: enemy.board.map((item, index) => index === pick.index ? damaged : item) };
      next = updatePlayers(next, enemy, next[ownerSide]);
      next = event(next, {
        type: "effect",
        side: ownerSide,
        text: `${sourceCard.name}の破壊時ダメージ`,
        cardId: destroyed.cardId,
        keyword: "damage",
        sourceInstanceId: destroyed.instanceId,
        targetInstanceId: target.instanceId,
        targetInstanceIds: [target.instanceId],
        sourceInstance: destroyed,
        targetInstances: [damaged],
        damage: trigger.value,
        effective: true,
      });
      if (damaged.hp <= 0) {
        const result = destroyAtIndex(next, next[enemySide], pick.index, cards);
        next = updatePlayers(result.state, result.player, next[ownerSide]);
      }
      continue;
    }
    enemy = { ...enemy, life: Math.max(0, enemy.life - trigger.value) };
    next = updatePlayers(next, enemy, next[ownerSide]);
    next = event(next, {
      type: "effect",
      side: ownerSide,
      text: `${sourceCard.name}の破壊時ダメージがリーダーへ`,
      cardId: destroyed.cardId,
      keyword: "damage",
      sourceInstanceId: destroyed.instanceId,
      targetLeader: true,
      sourceInstance: destroyed,
      damage: trigger.value,
      effective: true,
    });
  }
  return next;
}

function conditionMet(card: Card, player: BattlePlayer, cards: readonly Card[]): boolean {
  const condition = card.effects.find((effect) => effect.trigger === "aura")?.condition;
  if (!condition) return true;
  if (condition.kind === "leader_life_at_most") return player.life <= condition.value;
  if (condition.kind === "allied_species_at_least" && condition.species) {
    return player.board.filter((item) => cardById(cards, item.cardId).species === condition.species).length >= condition.value;
  }
  return true;
}

function applySyncBonus(
  state: BattleState,
  side: BattleSide,
  summoned: BattleCardInstance,
  card: Card,
  child: ChildProfile,
  cards: readonly Card[],
): { state: BattleState; instance: BattleCardInstance } {
  if (side !== "brother") return { state, instance: summoned };

  const stage = syncStage(state.syncRate, child);
  const bonus = child.sync.stageBonuses.find((item) => item.stage === stage);
  const maxCost = bonus?.condition.maxCost;
  if (!bonus || maxCost === null || maxCost === undefined || card.cost > maxCost) {
    return { state, instance: summoned };
  }

  const random = nextRandom(state.seed);
  let next = { ...state, seed: random.seed };
  if (random.value >= bonus.activationRate) return { state: next, instance: summoned };

  const granted = grantToInstance(summoned, cards, { keywords: bonus.keywords, attack: bonus.statModifiers.attack });
  const active = next[side];
  next = updatePlayers(next, {
    ...active,
    board: active.board.map((item) => item.instanceId === granted.instanceId ? granted : item),
  }, next[other(side)]);
  const grants = [
    ...bonus.keywords,
    ...(bonus.statModifiers.attack ? [`強化+${bonus.statModifiers.attack}`] : []),
  ].join("・");
  next = event(next, {
    type: "sync_bonus",
    side,
    text: `シンクロ発動！ ${card.name}に${grants}`,
    cardId: card.id,
    instanceId: granted.instanceId,
    sourceInstanceId: granted.instanceId,
    targetInstanceIds: [granted.instanceId],
    keyword: bonus.keywords[0],
    value: bonus.statModifiers.attack,
    sourceInstance: granted,
    targetInstances: [granted],
    effective: true,
  });
  return { state: next, instance: granted };
}

function resolvePlay(
  state: BattleState,
  side: BattleSide,
  handIndex: number,
  cards: readonly Card[],
  child: ChildProfile,
): BattleState {
  let active = state[side];
  let enemy = state[other(side)];
  const instance = active.hand[handIndex];
  const card = cardById(cards, instance.cardId);
  active = { ...active, pp: active.pp - card.cost, hand: active.hand.filter((_, index) => index !== handIndex) };
  let next = updatePlayers(state, active, enemy);

  if (card.type === "monster") {
    let summoned = { ...instance, summonedTurn: state.turn, attacked: false };
    active = next[side];
    active = { ...active, board: [...active.board, summoned] };
    next = updatePlayers(next, active, next[other(side)]);
    next = event(next, { type: "play", side, text: `${active.name}は${card.name}を使った`, cardId: card.id, instanceId: instance.instanceId });
    const syncBonus = applySyncBonus(next, side, summoned, card, child, cards);
    next = syncBonus.state;
    summoned = syncBonus.instance;
    const aura = card.effects.find((effect) => effect.trigger === "aura" && effect.keyword === "buff");
    if (aura && conditionMet(card, active, cards)) {
      summoned = { ...summoned, atk: summoned.atk + aura.value, buffSources: [...summoned.buffSources, { instanceId: summoned.instanceId, amount: aura.value, intervention: summoned.intervention }] };
      active = { ...active, board: active.board.map((item) => item.instanceId === summoned.instanceId ? summoned : item) };
      next = updatePlayers(next, active, next[other(side)]);
      next = event(next, {
        type: "effect",
        side,
        text: `${card.name}が強化された`,
        cardId: card.id,
        keyword: "buff",
        sourceInstanceId: instance.instanceId,
        targetInstanceIds: [summoned.instanceId],
        value: aura.value,
        effective: true,
      });
    }
  } else {
    next = event(next, { type: "play", side, text: `${active.name}は${card.name}を使った`, cardId: card.id, instanceId: instance.instanceId });
  }

  for (const effect of instanceEffects(instance, cards).filter((item) => item.trigger === "on_play")) {
    active = next[side]; enemy = next[other(side)];
    if (effect.condition?.kind === "allied_species_at_least" && effect.condition.species) {
      const count = active.board.filter((item) => cardById(cards, item.cardId).species === effect.condition!.species).length;
      if (count < effect.condition.value) continue;
    }
    if (effect.keyword === "heal") {
      // Stage-two spirit grant: top every friendly monster back up, never past its ceiling.
      const healed: BattleCardInstance[] = [];
      const board = active.board.map((item) => {
        const restored = Math.min(item.maxHp, item.hp + effect.value);
        if (restored === item.hp) return item;
        const next = { ...item, hp: restored };
        healed.push(next);
        return next;
      });
      if (healed.length) {
        active = { ...active, board };
        next = updatePlayers(next, active, enemy);
        next = event(next, {
          type: "heal",
          side,
          text: `${card.name}の登場で味方が${effect.value}回復`,
          cardId: card.id,
          keyword: "heal",
          sourceInstanceId: instance.instanceId,
          targetInstanceIds: healed.map((item) => item.instanceId),
          sourceInstance: instance,
          targetInstances: healed,
          value: effect.value,
          effective: true,
        });
      }
      continue;
    }
    if (effect.keyword === "damage" && effect.target === "enemy_leader") {
      // Stage-two demon grant: straight to the enemy leader, never at the board.
      const before = enemy.life;
      enemy = { ...enemy, life: Math.max(0, enemy.life - effect.value) };
      next = updatePlayers(next, active, enemy);
      next = event(next, {
        type: "effect",
        side,
        text: `${card.name}の登場で相手リーダーに${effect.value}ダメージ`,
        cardId: card.id,
        keyword: "damage",
        sourceInstanceId: instance.instanceId,
        targetLeader: true,
        sourceInstance: instance,
        damage: effect.value,
        effective: enemy.life < before,
      });
      if (enemy.life < before) next = markAttribution(next, instance, "damage", child, enemy.life === 0);
      continue;
    }
    if (effect.keyword === "draw") {
      let drawn = 0;
      const drawnInstanceIds: string[] = [];
      const drawnInstances: BattleCardInstance[] = [];
      for (let count = 0; count < effect.value; count += 1) {
        const result = drawOne(active); active = result.player; drawn += Number(Boolean(result.drawn));
        if (result.drawn) {
          drawnInstanceIds.push(result.drawn.instanceId);
          drawnInstances.push(result.drawn);
        }
      }
      next = updatePlayers(next, active, enemy);
      if (drawn) next = event(next, {
        type: "effect",
        side,
        text: `${drawn}枚ドローした`,
        cardId: card.id,
        keyword: "draw",
        sourceInstanceId: instance.instanceId,
        targetInstanceIds: drawnInstanceIds,
        value: drawn,
        sourceInstance: instance,
        targetInstances: drawnInstances,
        effective: true,
      });
    }
    if (effect.keyword === "buff" && active.board.length) {
      const targetIndex = active.board.reduce((best, item, index, all) => item.atk > all[best].atk ? index : best, 0);
      const target = active.board[targetIndex];
      const buffed = { ...target, atk: target.atk + effect.value, buffSources: [...target.buffSources, { instanceId: instance.instanceId, amount: effect.value, intervention: instance.intervention }] };
      active = { ...active, board: active.board.map((item, index) => index === targetIndex ? buffed : item) };
      next = updatePlayers(next, active, enemy);
      next = event(next, {
        type: "effect",
        side,
        text: `${cardById(cards, target.cardId).name}を+${effect.value}強化した`,
        cardId: card.id,
        keyword: "buff",
        sourceInstanceId: instance.instanceId,
        targetInstanceIds: [target.instanceId],
        value: effect.value,
        sourceInstance: instance,
        targetInstances: [target],
        effective: true,
      });
    }
    if (effect.keyword === "damage") {
      const targets = effect.target === "all_enemies" ? enemy.board.map((_, index) => index).reverse() : [chooseEnemyTarget(enemy)];
      const targetInstanceIds = targets.map((targetIndex) => enemy.board[targetIndex]?.instanceId).filter((instanceId): instanceId is string => Boolean(instanceId));
      const targetInstances = targets.map((targetIndex) => enemy.board[targetIndex]).filter((target): target is BattleCardInstance => Boolean(target));
      const targetLeader = targets[0] === -1 && effect.target !== "all_enemies";
      let worked = false;
      let destroyed = false;
      if (targetLeader) {
        const before = enemy.life; enemy = { ...enemy, life: Math.max(0, enemy.life - effect.value) }; worked = enemy.life < before;
        next = updatePlayers(next, active, enemy);
        if (worked) next = markAttribution(next, instance, "damage", child, enemy.life === 0);
      } else {
        for (const targetIndex of targets) {
          enemy = next[other(side)];
          const target = enemy.board[targetIndex];
          if (!target) continue;
          const damaged = { ...target, hp: target.hp - effect.value };
          enemy = { ...enemy, board: enemy.board.map((item, index) => index === targetIndex ? damaged : item) };
          next = updatePlayers(next, next[side], enemy);
          if (damaged.hp <= 0) {
            const result = destroyAtIndex(next, enemy, targetIndex, cards); next = updatePlayers(result.state, next[side], result.player); worked = true;
            if (result.destroyed) next = applyDestroyTriggers(next, result.destroyed, other(side), cards);
            destroyed = true;
          }
        }
        if (worked) next = markAttribution(next, instance, "damage", child, false);
      }
      next = event(next, {
        type: "effect",
        side,
        text: `${card.name}のダメージ効果`,
        cardId: card.id,
        keyword: "damage",
        sourceInstanceId: instance.instanceId,
        targetInstanceIds: targetInstanceIds.length ? targetInstanceIds : undefined,
        targetLeader: targetLeader || undefined,
        damage: effect.value,
        destroyed: destroyed || undefined,
        sourceInstance: instance,
        targetInstances: targetInstances.length ? targetInstances : undefined,
        effective: worked,
      });
    }
    if (effect.keyword === "destroy") {
      enemy = next[other(side)];
      const valid = enemy.board.map((target, index) => ({ target, index })).filter(({ target }) => !effect.condition || target.atk <= effect.condition.value);
      if (valid.length) {
        const selected = valid.sort((a, b) => b.target.atk - a.target.atk)[0];
        const targetIndex = selected.index;
        const result = destroyAtIndex(next, enemy, targetIndex, cards); next = updatePlayers(result.state, next[side], result.player);
        if (result.destroyed) next = applyDestroyTriggers(next, result.destroyed, other(side), cards);
        next = markAttribution(next, instance, "destroy", child, false);
        next = event(next, {
          type: "effect",
          side,
          text: `${card.name}が敵を破壊した`,
          cardId: card.id,
          keyword: "destroy",
          sourceInstanceId: instance.instanceId,
          targetInstanceIds: [selected.target.instanceId],
          destroyed: true,
          sourceInstance: instance,
          targetInstances: [selected.target],
          effective: true,
        });
      }
    }
  }
  return next;
}

function resolveAttack(state: BattleState, side: BattleSide, attackerIndex: number, faceBias: number, cards: readonly Card[], child: ChildProfile): BattleState {
  let active = state[side]; let enemy = state[other(side)];
  const attacker = active.board[attackerIndex];
  if (!attacker || attacker.attacked) return state;
  const guards = enemy.board.map((card, index) => ({ card, index })).filter(({ card }) => instanceHasKeyword(card, cards, "guard"));
  const random = nextRandom(state.seed);
  let next = { ...state, seed: random.seed };
  const attackFace = guards.length === 0 && (enemy.board.length === 0 || random.value < faceBias);
  active = { ...active, board: active.board.map((item, index) => index === attackerIndex ? { ...item, attacked: true } : item) };
  if (attackFace) {
    const beforeLife = enemy.life;
    enemy = { ...enemy, life: Math.max(0, enemy.life - attacker.atk) };
    next = updatePlayers(next, active, enemy);
    next = event(next, {
      type: "attack",
      side,
      text: `${cardById(cards, attacker.cardId).name}がリーダーに${attacker.atk}ダメージ`,
      cardId: attacker.cardId,
      instanceId: attacker.instanceId,
      targetLeader: true,
      damage: attacker.atk,
      sourceInstance: attacker,
      keyword: "damage",
      effective: attacker.atk > 0,
    });
    if (attacker.atk > 0) next = markAttribution(next, attacker, "damage", child, enemy.life === 0);
    const baseAttack = attacker.atk - attacker.grantedAtk - attacker.buffSources.reduce((sum, source) => sum + source.amount, 0);
    const usefulBuff = attacker.buffSources.find((source) => source.intervention && beforeLife > baseAttack && beforeLife <= attacker.atk);
    if (usefulBuff) next = markAttribution(next, { ...attacker, instanceId: usefulBuff.instanceId, intervention: true }, "buff", child, enemy.life === 0);
    return next;
  }
  const targetIndex = guards.length ? guards.sort((a, b) => a.card.hp - b.card.hp)[0].index : chooseEnemyTarget(enemy, attacker.atk);
  const target = enemy.board[targetIndex];
  if (!target) return updatePlayers(next, active, enemy);
  const damagedTarget = { ...target, hp: target.hp - attacker.atk };
  const damagedAttacker = { ...active.board[attackerIndex], hp: attacker.hp - target.atk };
  active = { ...active, board: active.board.map((item, index) => index === attackerIndex ? damagedAttacker : item) };
  enemy = { ...enemy, board: enemy.board.map((item, index) => index === targetIndex ? damagedTarget : item) };
  next = updatePlayers(next, active, enemy);
  next = event(next, {
    type: "attack",
    side,
    text: `${cardById(cards, attacker.cardId).name}が${cardById(cards, target.cardId).name}を攻撃`,
    cardId: attacker.cardId,
    instanceId: attacker.instanceId,
    targetInstanceId: target.instanceId,
    damage: attacker.atk,
    retaliationDamage: target.atk,
    sourceInstance: attacker,
    targetInstances: [target],
    keyword: "damage",
    destroyed: damagedTarget.hp <= 0,
    effective: damagedTarget.hp <= 0,
  });
  if (damagedTarget.hp <= 0) {
    const result = destroyAtIndex(next, next[other(side)], targetIndex, cards); next = updatePlayers(result.state, next[side], result.player);
    if (result.destroyed) next = applyDestroyTriggers(next, result.destroyed, other(side), cards);
    next = markAttribution(next, attacker, "damage", child, false);
    const baseAttack = attacker.atk - attacker.grantedAtk - attacker.buffSources.reduce((sum, source) => sum + source.amount, 0);
    const usefulBuff = attacker.buffSources.find((source) => source.intervention && target.hp > baseAttack && target.hp <= attacker.atk);
    if (usefulBuff) next = markAttribution(next, { ...attacker, instanceId: usefulBuff.instanceId, intervention: true }, "buff", child, false);
  }
  const updatedActive = next[side];
  const currentAttackerIndex = updatedActive.board.findIndex((item) => item.instanceId === attacker.instanceId);
  if (currentAttackerIndex >= 0 && updatedActive.board[currentAttackerIndex].hp <= 0) {
    const result = destroyAtIndex(next, updatedActive, currentAttackerIndex, cards); next = updatePlayers(result.state, result.player, next[other(side)]);
    if (result.destroyed) next = applyDestroyTriggers(next, result.destroyed, side, cards);
  }
  return next;
}

export function createBattle(
  deck: readonly DraftCard[],
  opponent: OpponentDefinition,
  cards: readonly Card[],
  seed: number,
  syncRate: number = 0,
  aceCardId: string | null = null,
  synergyConfig: SpeciesSynergyConfig | null = null,
): BattleState {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const synergies = synergyConfig ? activeSpeciesSynergies(deck, cards, synergyConfig) : [];
  let brotherInstances = deck.map((item, index) => makeInstance(byId.get(item.cardId)!, `b-${index}-${item.instanceId}`, item));
  if (synergyConfig) {
    brotherInstances = applySpeciesGrants(brotherInstances, synergies, cards, synergyConfig);
  }
  let aceCard: BattleCardInstance | null = null;
  if (aceCardId !== null) {
    const aceIndex = brotherInstances.findIndex((item) => item.cardId === aceCardId);
    if (aceIndex < 0) throw new Error(`Ace card is not in the deck: ${aceCardId}`);
    aceCard = brotherInstances[aceIndex];
    brotherInstances = brotherInstances.filter((_, index) => index !== aceIndex);
  }
  let opponentInstances = opponent.deck.map((id, index) => makeInstance(byId.get(id)!, `o-${index}-${id}`));
  if (opponent.speciesSynergy && synergyConfig) {
    const opponentDeck: DraftCard[] = opponent.deck.map((cardId, index) => ({ instanceId: `opponent-${index}-${cardId}`, cardId, intervention: false, source: "auto" }));
    const opponentSynergies = activeSpeciesSynergies(opponentDeck, cards, synergyConfig);
    opponentInstances = applySpeciesGrants(opponentInstances, opponentSynergies, cards, synergyConfig);
  }
  const shuffledBrother = shuffle(seed, brotherInstances);
  const shuffledOpponent = shuffle(shuffledBrother.seed, opponentInstances);
  const brotherHand = shuffledBrother.values.slice(0, 3);
  const opponentHand = shuffledOpponent.values.slice(0, 3);
  const result = {
    seed: shuffledOpponent.seed,
    syncRate,
    synergies,
    turn: 0,
    activeSide: "brother" as const,
    brother: { side: "brother", name: "ユウタ", life: 20, maxPp: 0, pp: 0, deck: shuffledBrother.values.slice(3), hand: brotherHand, board: [], graveyard: [] },
    opponent: { side: "opponent", name: opponent.name, life: opponent.leaderLife ?? 20, maxPp: 0, pp: 0, deck: shuffledOpponent.values.slice(3), hand: opponentHand, board: [], graveyard: [] },
    winner: null,
    events: [],
    attributionFired: [],
    nextEventId: 1,
  };
  return {
    ...result,
    brother: { ...result.brother, aceCard, aceUsed: false } as BattlePlayer,
    opponent: { ...result.opponent, aceCard: null, aceUsed: false } as BattlePlayer,
  };
}

export function advanceBattle(
  state: BattleState,
  cards: readonly Card[],
  child: ChildProfile,
  opponent: OpponentDefinition,
): BattleState {
  if (state.winner) return state;
  const side = state.activeSide;
  let active = state[side]; let enemy = state[other(side)];
  const turn = state.turn + 1;
  active = { ...active, maxPp: Math.min(10, active.maxPp + 1), pp: Math.min(10, active.maxPp + 1), board: active.board.map((item) => ({ ...item, attacked: false })) };
  const draw = drawAtTurnStart(state, active, child, cards); active = draw.player;
  let next = updatePlayers({ ...state, turn }, active, enemy);
  if (draw.aceCard) {
    next = event(next, { type: "ace", side, text: `ディスティニードロー！ ${cardById(cards, draw.aceCard.cardId).name}に切り札効果`, cardId: draw.aceCard.cardId, instanceId: draw.aceCard.instanceId, keyword: "buff", effective: true });
  }
  next = event(next, { type: "turn", side, text: `${turn}ターン目・${active.name}のターン` });
  if (draw.drawn) next = event(next, { type: "draw", side, text: `${active.name}が1枚ドロー`, cardId: draw.drawn.cardId });

  while (true) {
    active = next[side]; enemy = next[other(side)];
    const playable = active.hand
      .map((instance, index) => ({ instance, index, card: cardById(cards, instance.cardId) }))
      .filter(({ instance }) => canPlay(instance, active, enemy, cards))
      .sort((a, b) => b.card.cost - a.card.cost || b.card.atk - a.card.atk);
    if (!playable.length) break;
    next = resolvePlay(next, side, playable[0].index, cards, child);
    if (next.brother.life <= 0 || next.opponent.life <= 0) break;
  }

  const faceBias = side === "brother" ? child.battle.faceBias : opponent.faceBias;
  let attackerCursor = 0;
  while (attackerCursor < next[side].board.length) {
    const attacker = next[side].board[attackerCursor];
    const rush = instanceHasKeyword(attacker, cards, "rush");
    if (!attacker.attacked && (attacker.summonedTurn < turn || rush)) next = resolveAttack(next, side, attackerCursor, faceBias, cards, child);
    if (next.brother.life <= 0 || next.opponent.life <= 0) break;
    const stillAtCursor = next[side].board[attackerCursor]?.instanceId === attacker.instanceId;
    attackerCursor += stillAtCursor ? 1 : 0;
  }

  if (side === "opponent" && turn % 4 === 0 && !next.winner) {
    const line = opponent.taunts[(turn / 4 - 1) % opponent.taunts.length];
    next = event(next, { type: "taunt", side: "opponent", text: line, dialogue: line });
  }
  const winner = next.opponent.life <= 0 ? "brother" : next.brother.life <= 0 ? "opponent" : turn >= MAX_TURNS ? (next.brother.life === next.opponent.life ? "draw" : next.brother.life > next.opponent.life ? "brother" : "opponent") : null;
  if (winner) {
    next = { ...next, winner };
    next = event(next, { type: "result", side: winner === "opponent" ? "opponent" : "brother", text: winner === "draw" ? "時間切れで引き分け" : winner === "brother" ? "ユウタの勝利！" : `${opponent.name}の勝利！` });
  }
  return { ...next, activeSide: other(side) };
}

export function runBattle(
  state: BattleState,
  cards: readonly Card[],
  child: ChildProfile,
  opponent: OpponentDefinition,
): BattleState {
  let next = state;
  while (!next.winner) next = advanceBattle(next, cards, child, opponent);
  return next;
}
