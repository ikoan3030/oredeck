import type { BattleCardInstance, BattleSide, Recipe, RecipeMemory } from "./types";

/** 実行型（手札の2枚を順に出す）だけを priority 昇順で返す。 */
export function playRecipes(recipes: readonly Recipe[]): Recipe[] {
  return [...recipes].filter((recipe) => recipe.kind === "play").sort((a, b) => a.priority - b.priority);
}

/** 状態型（場に2枚が並んだら発動する）だけを priority 昇順で返す。 */
export function stateRecipes(recipes: readonly Recipe[]): Recipe[] {
  return [...recipes].filter((recipe) => recipe.kind !== "play").sort((a, b) => a.priority - b.priority);
}

/** 習得済みのレシピを priority 昇順で返す。同値は定義順のまま。 */
export function learnedRecipes(recipes: readonly Recipe[], memory: RecipeMemory): Recipe[] {
  return recipes
    .filter((recipe) => memory.learnedRecipeIds.includes(recipe.id))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * そのレシピを発動できる側か。
 * 敵は習得の概念を持たず、デッキにペアが積まれていれば常に発動する（HANDOFFの裁定）。
 */
export function isRecipeLearned(recipe: Recipe, memory: RecipeMemory, side: BattleSide): boolean {
  return side === "opponent" || memory.learnedRecipeIds.includes(recipe.id);
}

/**
 * レシピの2枚が手札に別々の札として揃っているかを見る。
 * 揃っていれば手札の添字を返す。同じカードIDを2枚要求するレシピでも別の札を割り当てる。
 */
export function recipeHandIndexes(recipe: Recipe, hand: readonly BattleCardInstance[]): { first: number; second: number } | null {
  const first = hand.findIndex((item) => item.cardId === recipe.cards[0]);
  if (first < 0) return null;
  const second = hand.findIndex((item, index) => index !== first && item.cardId === recipe.cards[1]);
  if (second < 0) return null;
  return { first, second };
}

/**
 * レシピの2枚が場に並んでいるかを見る。状態型は順不同なので、盤面の並び順は問わない。
 * first は cards[0]、second は cards[1] の添字（transform はこの second だけが置き換わる）。
 */
export function recipeBoardIndexes(recipe: Recipe, board: readonly BattleCardInstance[]): { first: number; second: number } | null {
  const first = board.findIndex((item) => item.cardId === recipe.cards[0]);
  if (first < 0) return null;
  const second = board.findIndex((item, index) => index !== first && item.cardId === recipe.cards[1]);
  if (second < 0) return null;
  return { first, second };
}
