import type { ChildProfile } from "./types";

/** Passive interventions that match the kid's first choice are the only source of growth. */
export function gainSync(sync: number, supported: boolean, child: ChildProfile): number {
  if (!supported) return sync;
  return Math.min(child.sync.maximum, sync + child.sync.supportGain);
}

/**
 * Cooldown applied after every battle. Values below the floor are carried over untouched,
 * so the floor never pulls a value upward.
 */
export function decaySync(sync: number, child: ChildProfile): number {
  if (sync < child.sync.decayFloor) return sync;
  return Math.max(child.sync.decayFloor, sync * child.sync.decayMultiplier);
}

/** 1-based stage, counted from the lowest band upward. */
export function syncStage(sync: number, child: ChildProfile): number {
  const ascending = [...child.sync.stageMinimums].sort((a, b) => a - b);
  const reached = ascending.filter((minimum) => sync >= minimum).length;
  return Math.max(1, reached);
}

export function maxSyncStage(child: ChildProfile): number {
  return Math.max(1, child.sync.stageMinimums.length);
}

/** The ace card may be nominated only while the kid sits at the top stage. */
export function isAceUnlocked(sync: number, child: ChildProfile): boolean {
  return syncStage(sync, child) >= maxSyncStage(child);
}
