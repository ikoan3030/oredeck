export interface RandomResult {
  value: number;
  seed: number;
}

export function nextRandom(seed: number): RandomResult {
  let state = (seed + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: state >>> 0 };
}

export function randomIndex(seed: number, length: number): { index: number; seed: number } {
  if (length <= 0) throw new Error("Cannot sample an empty collection");
  const next = nextRandom(seed);
  return { index: Math.floor(next.value * length), seed: next.seed };
}

export function shuffle<T>(seed: number, values: readonly T[]): { values: T[]; seed: number } {
  const result = [...values];
  let nextSeed = seed;
  for (let index = result.length - 1; index > 0; index -= 1) {
    const next = randomIndex(nextSeed, index + 1);
    nextSeed = next.seed;
    [result[index], result[next.index]] = [result[next.index], result[index]];
  }
  return { values: result, seed: nextSeed };
}

