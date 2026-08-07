import { decideOffer } from "./decision";
import { hasKeyword, isRemoval } from "./evaluation";
import { nextRandom, randomIndex } from "./random";
import { gainSync } from "./sync";
import type { AdviceCategory, Card, ChildProfile, DraftOffer, DraftState, PickSource } from "./types";

export function createDraft(seed: number, child: ChildProfile, initialSync = child.sync.initial): DraftState {
  return {
    seed: seed >>> 0,
    pick: 0,
    deck: [],
    rejectedCardIds: [],
    syncRate: initialSync,
    seenAdviceCheckpoints: [],
    adviceFocus: null,
    passiveInterventions: 0,
    lovePicks: 0,
    history: [],
  };
}

export function isAdviceDue(state: DraftState, child: ChildProfile): boolean {
  return child.advice.checkpoints.includes(state.pick) && !state.seenAdviceCheckpoints.includes(state.pick);
}

export function markAdviceSkipped(state: DraftState): DraftState {
  return state.seenAdviceCheckpoints.includes(state.pick)
    ? state
    : { ...state, seenAdviceCheckpoints: [...state.seenAdviceCheckpoints, state.pick] };
}

/** The single definition of what each advice category asks for. */
export function matchesAdviceCategory(card: Card, category: Exclude<AdviceCategory, "skip">): boolean {
  if (category === "removal") return isRemoval(card);
  if (category === "guard") return hasKeyword(card, "guard");
  return card.cost <= 2;
}

/**
 * An order does not hand the kid a pick: it leans the offer pool toward the category
 * until the next checkpoint (or the end of the build). Skipping leaves the pool alone.
 */
export function applyAdvice(state: DraftState, category: AdviceCategory, child: ChildProfile): DraftState {
  const seen = markAdviceSkipped(state);
  if (category === "skip") return seen;
  return { ...seen, adviceFocus: { category, expiresAtPick: state.pick + child.advice.focusPicks } };
}

export function activeAdviceFocus(state: DraftState): DraftState["adviceFocus"] {
  return state.adviceFocus && state.pick < state.adviceFocus.expiresAtPick ? state.adviceFocus : null;
}

/**
 * Weighted draw over the pool. Consumes exactly one random value, the same as the flat
 * draw, so a live order never shifts how many values a pick takes from the stream.
 */
function weightedIndex(seed: number, weights: readonly number[]): { index: number; seed: number } {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const next = nextRandom(seed);
  let cursor = next.value * total;
  for (let index = 0; index < weights.length; index += 1) {
    cursor -= weights[index];
    if (cursor <= 0) return { index, seed: next.seed };
  }
  return { index: weights.length - 1, seed: next.seed };
}

function eligibleCards(state: DraftState, cards: readonly Card[]): Card[] {
  const counts = new Map<string, number>();
  state.deck.forEach((item) => counts.set(item.cardId, (counts.get(item.cardId) ?? 0) + 1));
  return cards.filter((card) => (counts.get(card.id) ?? 0) < 2);
}

export function generateOffer(
  state: DraftState,
  cards: readonly Card[],
  child: ChildProfile,
): { state: DraftState; offer: DraftOffer } {
  const pool = eligibleCards(state, cards);
  const focus = activeAdviceFocus(state);
  // Without a live order every card is offered at the same rate, and the flat draw is kept
  // as-is so unordered builds reproduce exactly.
  const draw = (seed: number, from: readonly Card[]) => focus
    ? weightedIndex(seed, from.map((card) => matchesAdviceCategory(card, focus.category) ? child.advice.focusMultiplier : 1))
    : randomIndex(seed, from.length);
  const first = draw(state.seed, pool);
  const secondPool = pool.filter((_, index) => index !== first.index);
  const second = draw(first.seed, secondPool);
  const offered: [Card, Card] = [pool[first.index], secondPool[second.index]];
  const decision = decideOffer(offered, child);
  let seed = second.seed;
  let wantsIntervention = false;
  if (!decision.love) {
    const chance = nextRandom(seed);
    seed = chance.seed;
    wantsIntervention = chance.value < child.passiveInterventionRate;
  }
  return {
    state: { ...state, seed },
    offer: { cards: offered, decision, wantsIntervention, source: "normal" },
  };
}

export function resolveOffer(
  state: DraftState,
  offer: DraftOffer,
  child: ChildProfile,
  selectedIndex?: 0 | 1,
): DraftState {
  const isPlayerDecision = offer.wantsIntervention && selectedIndex !== undefined;
  const chosenIndex = isPlayerDecision ? selectedIndex : offer.decision.preferredIndex;
  const rejectedIndex: 0 | 1 = chosenIndex === 0 ? 1 : 0;
  const chosen = offer.cards[chosenIndex];
  const rejected = offer.cards[rejectedIndex];
  const source: PickSource = offer.decision.love ? "love" : isPlayerDecision ? "passive" : "auto";
  const supported = chosenIndex === offer.decision.preferredIndex;
  const syncAfter = source === "passive" ? gainSync(state.syncRate, supported, child) : state.syncRate;
  return {
    ...state,
    pick: state.pick + 1,
    deck: [...state.deck, { instanceId: `${chosen.id}-${state.pick}-${state.seed}`, cardId: chosen.id, intervention: source === "passive", source }],
    rejectedCardIds: [...state.rejectedCardIds, rejected.id],
    syncRate: syncAfter,
    passiveInterventions: state.passiveInterventions + (offer.wantsIntervention ? 1 : 0),
    lovePicks: state.lovePicks + (offer.decision.love ? 1 : 0),
    history: [...state.history, {
      pick: state.pick + 1,
      offered: [offer.cards[0].id, offer.cards[1].id],
      selected: chosen.id,
      rejected: rejected.id,
      source,
      preferred: offer.cards[offer.decision.preferredIndex].id,
      syncBefore: state.syncRate,
      syncAfter,
      reason: offer.decision.reason,
    }],
  };
}
