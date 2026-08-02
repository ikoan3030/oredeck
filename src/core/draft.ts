import { decideOffer } from "./decision";
import { hasKeyword, isRemoval } from "./evaluation";
import { nextRandom } from "./random";
import { passiveInterventionRate, updateTrust } from "./trust";
import type { AdviceCategory, Card, ChildProfile, DraftOffer, DraftState, PickSource } from "./types";

export function createDraft(seed: number, child: ChildProfile, initialTrust = child.trust.initial): DraftState {
  return {
    seed: seed >>> 0,
    pick: 0,
    deck: [],
    rejectedCardIds: [],
    trust: initialTrust,
    seenAdviceCheckpoints: [],
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

function matchesAdvice(card: Card, category: Exclude<AdviceCategory, "skip">): boolean {
  if (category === "removal") return isRemoval(card);
  if (category === "guard") return hasKeyword(card, "guard");
  return card.cost <= 2;
}

function eligibleCards(state: DraftState, cards: readonly Card[], category?: Exclude<AdviceCategory, "skip">): Card[] {
  const counts = new Map<string, number>();
  state.deck.forEach((item) => counts.set(item.cardId, (counts.get(item.cardId) ?? 0) + 1));
  const underCap = cards.filter((card) => (counts.get(card.id) ?? 0) < 2);
  const filtered = category ? underCap.filter((card) => matchesAdvice(card, category)) : underCap;
  return filtered.length >= 2 ? filtered : underCap;
}

function weightedIndex(seed: number, pool: readonly Card[], child: ChildProfile): { index: number; seed: number } {
  const total = pool.reduce((sum, card) => sum + (child.offerWeightsByCardId?.[card.id] ?? 1), 0);
  const next = nextRandom(seed);
  let cursor = next.value * total;
  for (let index = 0; index < pool.length; index += 1) {
    cursor -= child.offerWeightsByCardId?.[pool[index].id] ?? 1;
    if (cursor <= 0) return { index, seed: next.seed };
  }
  return { index: pool.length - 1, seed: next.seed };
}

export function generateOffer(
  state: DraftState,
  cards: readonly Card[],
  child: ChildProfile,
  adviceCategory?: Exclude<AdviceCategory, "skip">,
): { state: DraftState; offer: DraftOffer } {
  const pool = eligibleCards(state, cards, adviceCategory);
  const first = weightedIndex(state.seed, pool, child);
  const secondPool = pool.filter((_, index) => index !== first.index);
  const second = weightedIndex(first.seed, secondPool, child);
  const offered: [Card, Card] = [pool[first.index], secondPool[second.index]];
  const decision = decideOffer(offered, child);
  let seed = second.seed;
  let wantsIntervention = Boolean(adviceCategory);
  if (!adviceCategory && !decision.love) {
    const chance = nextRandom(seed);
    seed = chance.seed;
    wantsIntervention = chance.value < passiveInterventionRate(state.trust, child);
  }
  return {
    state: { ...state, seed },
    offer: {
      cards: offered,
      decision,
      wantsIntervention,
      source: adviceCategory ? "advice" : "normal",
      adviceCategory,
    },
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
  const source: PickSource = offer.decision.love ? "love" : offer.source === "advice" ? "advice" : isPlayerDecision ? "passive" : "auto";
  const supported = chosenIndex === offer.decision.preferredIndex;
  const trustAfter = source === "passive"
    ? updateTrust(state.trust, supported, offer.decision.scores[offer.decision.preferredIndex], child)
    : state.trust;
  return {
    ...state,
    pick: state.pick + 1,
    deck: [...state.deck, { instanceId: `${chosen.id}-${state.pick}-${state.seed}`, cardId: chosen.id, intervention: source === "passive" || source === "advice", source }],
    rejectedCardIds: [...state.rejectedCardIds, rejected.id],
    trust: trustAfter,
    seenAdviceCheckpoints: offer.source === "advice" && !state.seenAdviceCheckpoints.includes(state.pick) ? [...state.seenAdviceCheckpoints, state.pick] : state.seenAdviceCheckpoints,
    passiveInterventions: state.passiveInterventions + (offer.source === "normal" && offer.wantsIntervention ? 1 : 0),
    lovePicks: state.lovePicks + (offer.decision.love ? 1 : 0),
    history: [...state.history, {
      pick: state.pick + 1,
      offered: [offer.cards[0].id, offer.cards[1].id],
      selected: chosen.id,
      rejected: rejected.id,
      source,
      preferred: offer.cards[offer.decision.preferredIndex].id,
      trustBefore: state.trust,
      trustAfter,
      reason: offer.decision.reason,
    }],
  };
}
