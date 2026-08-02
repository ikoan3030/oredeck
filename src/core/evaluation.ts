import type { Card, DeckEvaluation, DraftCard } from "./types";

export function isRemoval(card: Card): boolean {
  return card.type === "spell" && card.effects.some((effect) =>
    effect.keyword === "destroy" || (effect.keyword === "damage" && effect.value >= 3),
  );
}

export function hasKeyword(card: Card, keyword: string): boolean {
  return card.effects.some((effect) => effect.keyword === keyword);
}

export function evaluateDeck(deck: readonly DraftCard[], cards: readonly Card[]): DeckEvaluation {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const resolved = deck.map((item) => byId.get(item.cardId)).filter((card): card is Card => Boolean(card));
  const monsters = resolved.filter((card) => card.type === "monster").length;
  const removal = resolved.filter(isRemoval).length;
  const guards = resolved.filter((card) => hasKeyword(card, "guard")).length;
  const lowCost = resolved.filter((card) => card.cost <= 2).length;
  const heavy = resolved.filter((card) => card.cost >= 6).length;
  const tribeCounts = new Map<string, number>();
  resolved.forEach((card) => card.tribes.forEach((tribe) => tribeCounts.set(tribe, (tribeCounts.get(tribe) ?? 0) + 1)));
  const synergyActive = resolved.filter((card) =>
    card.effects.some((effect) => {
      const condition = effect.condition;
      return condition?.kind === "allied_tribe_at_least" && Boolean(condition.tribe) && (tribeCounts.get(condition.tribe!) ?? 0) >= condition.value;
    }),
  ).length;
  const metrics = {
    removalMissing: removal < 2,
    durabilityMissing: guards < 2,
    heavyCongestion: heavy >= 3,
    lowCostMissing: lowCost < 4,
  };
  const curve = Array.from({ length: 9 }, () => 0);
  resolved.forEach((card) => { curve[Math.min(8, card.cost)] += 1; });
  return {
    size: resolved.length,
    monsters,
    spells: resolved.length - monsters,
    averageCost: resolved.length ? resolved.reduce((sum, card) => sum + card.cost, 0) / resolved.length : 0,
    removal,
    guards,
    lowCost,
    heavy,
    synergyActive,
    metrics,
    missingCount: Object.values(metrics).filter(Boolean).length,
    curve,
  };
}
