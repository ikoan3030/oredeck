import type {
  ActiveSpeciesSynergy,
  Card,
  DraftCard,
  Species,
  SpeciesGrant,
  SpeciesSynergyConfig,
} from "./types";

export const SPECIES_ORDER: readonly Species[] = ["ドラゴン", "メカ", "けもの", "天使", "悪魔", "精霊"];

export function emptySpeciesCounts(): Record<Species, number> {
  return { "ドラゴン": 0, "メカ": 0, "けもの": 0, "天使": 0, "悪魔": 0, "精霊": 0 };
}

/**
 * Counts distinct card types per species, not copies: two copies of the same card are one type.
 * Spells carry no species and are never counted.
 */
export function countSpeciesTypes(deck: readonly DraftCard[], cards: readonly Card[]): Record<Species, number> {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const seen = new Map<Species, Set<string>>();
  for (const item of deck) {
    const card = byId.get(item.cardId);
    if (!card || card.type !== "monster" || !card.species) continue;
    const bucket = seen.get(card.species) ?? new Set<string>();
    bucket.add(card.id);
    seen.set(card.species, bucket);
  }
  const counts = emptySpeciesCounts();
  seen.forEach((ids, species) => { counts[species] = ids.size; });
  return counts;
}

export function synergyStageFor(types: number, config: SpeciesSynergyConfig): 0 | 1 | 2 {
  if (types >= config.thresholds.stageTwo) return 2;
  if (types >= config.thresholds.stageOne) return 1;
  return 0;
}

/**
 * Stage two keeps the stage-one stat unless it moves the same stat, in which case it replaces it.
 * Only the dragon shares a stat across both stages (attack), so it reads +2 rather than +3;
 * the other five carry their stage-one stat under the stage-two grant.
 */
export function speciesGrant(species: Species, stage: 1 | 2, config: SpeciesSynergyConfig): SpeciesGrant | undefined {
  const definition = config.species.find((item) => item.id === species);
  if (!definition) return undefined;
  if (stage === 1) return definition.stageOne;
  const one = definition.stageOne;
  const two = definition.stageTwo;
  return {
    keywords: [...one.keywords, ...two.keywords],
    effects: [...one.effects, ...two.effects],
    attack: two.attack || one.attack,
    hp: two.hp || one.hp,
  };
}

export function synergyLabel(species: Species, stage: 1 | 2, config: SpeciesSynergyConfig): string {
  return `${species}${config.bondSuffix}・${config.stageLabels[stage - 1] ?? String(stage)}`;
}

/** Resolved once when the build is finished; the result stays active for the whole battle. */
export function activeSpeciesSynergies(
  deck: readonly DraftCard[],
  cards: readonly Card[],
  config: SpeciesSynergyConfig,
): ActiveSpeciesSynergy[] {
  const counts = countSpeciesTypes(deck, cards);
  return SPECIES_ORDER.flatMap((species) => {
    const types = counts[species];
    const stage = synergyStageFor(types, config);
    if (stage === 0) return [];
    return [{ species, stage, types, label: synergyLabel(species, stage, config) }];
  });
}
