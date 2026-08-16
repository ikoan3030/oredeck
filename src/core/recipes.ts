import type { BattleCardInstance, Recipe, RecipeMemory } from "./types";

/** 習得済みのレシピを priority 昇順で返す。同値は定義順のまま。 */
export function learnedRecipes(recipes: readonly Recipe[], memory: RecipeMemory): Recipe[] {
  return recipes
    .filter((recipe) => memory.learnedRecipeIds.includes(recipe.id))
    .sort((a, b) => a.priority - b.priority);
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
