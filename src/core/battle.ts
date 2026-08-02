import { nextRandom, shuffle } from "./random";
import type {
  BattleCardInstance,
  BattleEvent,
  BattlePlayer,
  BattleSide,
  BattleState,
  Card,
  ChildProfile,
  DraftCard,
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
    summonedTurn: -1,
    attacked: false,
    revived: false,
    buffSources: [],
  };
}

function event(state: BattleState, value: Omit<BattleEvent, "id">): BattleState {
  return {
    ...state,
    nextEventId: state.nextEventId + 1,
    events: [...state.events, { ...value, id: `event-${state.nextEventId}` }],
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

function drawOne(player: BattlePlayer): { player: BattlePlayer; drawn?: BattleCardInstance } {
  if (player.deck.length === 0) return { player };
  const [drawn, ...deck] = player.deck;
  return { player: { ...player, deck, hand: [...player.hand, drawn] }, drawn };
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
  let nextState = event(state, { type: "destroyed", side: player.side, text: `${cardById(cards, target.cardId).name}が破壊された`, cardId: target.cardId, instanceId: target.instanceId });
  const hasRevive = cardById(cards, target.cardId).effects.some((effect) => effect.keyword === "revive");
  if (hasRevive && !target.revived) {
    const revived = { ...target, hp: target.maxHp, attacked: false, revived: true, buffSources: [] };
    nextPlayer = { ...nextPlayer, hand: [...nextPlayer.hand, revived] };
    nextState = event(nextState, { type: "effect", side: player.side, text: `${cardById(cards, target.cardId).name}が手札に復活した`, cardId: target.cardId, keyword: "revive", effective: true });
  }
  return { state: nextState, player: nextPlayer, destroyed: target };
}

function conditionMet(card: Card, player: BattlePlayer, cards: readonly Card[]): boolean {
  const condition = card.effects.find((effect) => effect.trigger === "aura")?.condition;
  if (!condition) return true;
  if (condition.kind === "leader_life_at_most") return player.life <= condition.value;
  if (condition.kind === "allied_tribe_at_least" && condition.tribe) {
    return player.board.filter((item) => cardById(cards, item.cardId).tribes.includes(condition.tribe!)).length >= condition.value;
  }
  return true;
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
  let next = event(updatePlayers(state, active, enemy), { type: "play", side, text: `${active.name}は${card.name}を使った`, cardId: card.id, instanceId: instance.instanceId });

  if (card.type === "monster") {
    let summoned = { ...instance, summonedTurn: state.turn, attacked: false };
    active = next[side];
    active = { ...active, board: [...active.board, summoned] };
    next = updatePlayers(next, active, next[other(side)]);
    const aura = card.effects.find((effect) => effect.trigger === "aura" && effect.keyword === "buff");
    if (aura && conditionMet(card, active, cards)) {
      summoned = { ...summoned, atk: summoned.atk + aura.value, buffSources: [...summoned.buffSources, { instanceId: summoned.instanceId, amount: aura.value, intervention: summoned.intervention }] };
      active = { ...active, board: active.board.map((item) => item.instanceId === summoned.instanceId ? summoned : item) };
      next = updatePlayers(next, active, next[other(side)]);
      next = event(next, { type: "effect", side, text: `${card.name}が強化された`, cardId: card.id, keyword: "buff", effective: true });
    }
  }

  for (const effect of card.effects.filter((item) => item.trigger === "on_play")) {
    active = next[side]; enemy = next[other(side)];
    if (effect.condition?.kind === "allied_tribe_at_least" && effect.condition.tribe) {
      const count = active.board.filter((item) => cardById(cards, item.cardId).tribes.includes(effect.condition!.tribe!)).length;
      if (count < effect.condition.value) continue;
    }
    if (effect.keyword === "draw") {
      let drawn = 0;
      for (let count = 0; count < effect.value; count += 1) {
        const result = drawOne(active); active = result.player; drawn += Number(Boolean(result.drawn));
      }
      next = updatePlayers(next, active, enemy);
      if (drawn) next = event(next, { type: "effect", side, text: `${drawn}枚ドローした`, cardId: card.id, keyword: "draw", effective: true });
    }
    if (effect.keyword === "buff" && active.board.length) {
      const targetIndex = active.board.reduce((best, item, index, all) => item.atk > all[best].atk ? index : best, 0);
      const target = active.board[targetIndex];
      const buffed = { ...target, atk: target.atk + effect.value, buffSources: [...target.buffSources, { instanceId: instance.instanceId, amount: effect.value, intervention: instance.intervention }] };
      active = { ...active, board: active.board.map((item, index) => index === targetIndex ? buffed : item) };
      next = updatePlayers(next, active, enemy);
      next = event(next, { type: "effect", side, text: `${cardById(cards, target.cardId).name}を+${effect.value}強化した`, cardId: card.id, keyword: "buff", effective: true });
    }
    if (effect.keyword === "damage") {
      const targets = effect.target === "all_enemies" ? enemy.board.map((_, index) => index).reverse() : [chooseEnemyTarget(enemy)];
      let worked = false;
      if (targets[0] === -1 && effect.target !== "all_enemies") {
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
          }
        }
        if (worked) next = markAttribution(next, instance, "damage", child, false);
      }
      next = event(next, { type: "effect", side, text: `${card.name}のダメージ効果`, cardId: card.id, keyword: "damage", effective: worked });
    }
    if (effect.keyword === "destroy") {
      enemy = next[other(side)];
      const valid = enemy.board.map((target, index) => ({ target, index })).filter(({ target }) => !effect.condition || target.atk <= effect.condition.value);
      if (valid.length) {
        const targetIndex = valid.sort((a, b) => b.target.atk - a.target.atk)[0].index;
        const result = destroyAtIndex(next, enemy, targetIndex, cards); next = updatePlayers(result.state, next[side], result.player);
        next = markAttribution(next, instance, "destroy", child, false);
        next = event(next, { type: "effect", side, text: `${card.name}が敵を破壊した`, cardId: card.id, keyword: "destroy", effective: true });
      }
    }
  }
  return next;
}

function resolveAttack(state: BattleState, side: BattleSide, attackerIndex: number, faceBias: number, cards: readonly Card[], child: ChildProfile): BattleState {
  let active = state[side]; let enemy = state[other(side)];
  const attacker = active.board[attackerIndex];
  if (!attacker || attacker.attacked) return state;
  const guards = enemy.board.map((card, index) => ({ card, index })).filter(({ card }) => cardById(cards, card.cardId).effects.some((effect) => effect.keyword === "guard"));
  const random = nextRandom(state.seed);
  let next = { ...state, seed: random.seed };
  const attackFace = guards.length === 0 && (enemy.board.length === 0 || random.value < faceBias);
  active = { ...active, board: active.board.map((item, index) => index === attackerIndex ? { ...item, attacked: true } : item) };
  if (attackFace) {
    const beforeLife = enemy.life;
    enemy = { ...enemy, life: Math.max(0, enemy.life - attacker.atk) };
    next = updatePlayers(next, active, enemy);
    next = event(next, { type: "attack", side, text: `${cardById(cards, attacker.cardId).name}がリーダーに${attacker.atk}ダメージ`, cardId: attacker.cardId, instanceId: attacker.instanceId, keyword: "damage", effective: attacker.atk > 0 });
    if (attacker.atk > 0) next = markAttribution(next, attacker, "damage", child, enemy.life === 0);
    const baseAttack = attacker.atk - attacker.buffSources.reduce((sum, source) => sum + source.amount, 0);
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
  next = event(next, { type: "attack", side, text: `${cardById(cards, attacker.cardId).name}が${cardById(cards, target.cardId).name}を攻撃`, cardId: attacker.cardId, instanceId: attacker.instanceId, keyword: "damage", effective: damagedTarget.hp <= 0 });
  if (damagedTarget.hp <= 0) {
    const result = destroyAtIndex(next, next[other(side)], targetIndex, cards); next = updatePlayers(result.state, next[side], result.player);
    next = markAttribution(next, attacker, "damage", child, false);
    const baseAttack = attacker.atk - attacker.buffSources.reduce((sum, source) => sum + source.amount, 0);
    const usefulBuff = attacker.buffSources.find((source) => source.intervention && target.hp > baseAttack && target.hp <= attacker.atk);
    if (usefulBuff) next = markAttribution(next, { ...attacker, instanceId: usefulBuff.instanceId, intervention: true }, "buff", child, false);
  }
  const updatedActive = next[side];
  const currentAttackerIndex = updatedActive.board.findIndex((item) => item.instanceId === attacker.instanceId);
  if (currentAttackerIndex >= 0 && updatedActive.board[currentAttackerIndex].hp <= 0) {
    const result = destroyAtIndex(next, updatedActive, currentAttackerIndex, cards); next = updatePlayers(result.state, result.player, next[other(side)]);
  }
  return next;
}

export function createBattle(
  deck: readonly DraftCard[],
  opponent: OpponentDefinition,
  cards: readonly Card[],
  seed: number,
): BattleState {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const brotherInstances = deck.map((item, index) => makeInstance(byId.get(item.cardId)!, `b-${index}-${item.instanceId}`, item));
  const opponentInstances = opponent.deck.map((id, index) => makeInstance(byId.get(id)!, `o-${index}-${id}`));
  const shuffledBrother = shuffle(seed, brotherInstances);
  const shuffledOpponent = shuffle(shuffledBrother.seed, opponentInstances);
  const brotherHand = shuffledBrother.values.slice(0, 3);
  const opponentHand = shuffledOpponent.values.slice(0, 3);
  return {
    seed: shuffledOpponent.seed,
    turn: 0,
    activeSide: "brother",
    brother: { side: "brother", name: "ユウタ", life: 20, maxPp: 0, pp: 0, deck: shuffledBrother.values.slice(3), hand: brotherHand, board: [], graveyard: [] },
    opponent: { side: "opponent", name: opponent.name, life: 20, maxPp: 0, pp: 0, deck: shuffledOpponent.values.slice(3), hand: opponentHand, board: [], graveyard: [] },
    winner: null,
    events: [],
    attributionFired: [],
    nextEventId: 1,
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
  const draw = drawOne(active); active = draw.player;
  let next = updatePlayers({ ...state, turn }, active, enemy);
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
    const card = cardById(cards, attacker.cardId);
    const rush = card.effects.some((effect) => effect.keyword === "rush");
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
