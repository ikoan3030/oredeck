import type { Card, ChildProfile, PickDecision } from "./types";

export function aestheticScore(card: Card, child: ChildProfile): number {
  return (Object.keys(card.aesthetic) as Array<keyof Card["aesthetic"]>).reduce(
    (total, key) => total + card.aesthetic[key] * child.aestheticWeights[key],
    0,
  );
}

export function decideOffer(cards: [Card, Card], child: ChildProfile): PickDecision {
  const scores: [number, number] = [aestheticScore(cards[0], child), aestheticScore(cards[1], child)];
  const loveIndexes = ([0, 1] as const).filter((index) => scores[index] >= child.loveThreshold);
  if (loveIndexes.length > 0) {
    const preferredIndex: 0 | 1 = loveIndexes.length === 2 && scores[1] > scores[0] ? 1 : 0;
    return { preferredIndex, reason: "love", love: true, scores };
  }

  if (cards[0].type !== cards[1].type) {
    return { preferredIndex: cards[0].type === "monster" ? 0 : 1, reason: "monster", love: false, scores };
  }
  if (cards[0].cost !== cards[1].cost) {
    return { preferredIndex: cards[0].cost < cards[1].cost ? 0 : 1, reason: "lower_cost", love: false, scores };
  }
  if (cards[0].atk !== cards[1].atk) {
    return { preferredIndex: cards[0].atk > cards[1].atk ? 0 : 1, reason: "higher_attack", love: false, scores };
  }
  if (scores[0] !== scores[1]) {
    return { preferredIndex: scores[0] > scores[1] ? 0 : 1, reason: "aesthetic", love: false, scores };
  }
  return { preferredIndex: 0, reason: "first", love: false, scores };
}

