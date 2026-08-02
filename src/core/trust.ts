import type { ChildProfile } from "./types";

export function updateTrust(
  trust: number,
  supported: boolean,
  rejectedAestheticScore: number,
  child: ChildProfile,
): number {
  const delta = supported
    ? child.trust.supportGain
    : -child.trust.rejectBaseLoss * Math.max(
        child.trust.aestheticMinimumMultiplier,
        rejectedAestheticScore / child.trust.aestheticDivisor,
      );
  return Math.max(child.trust.minimum, Math.min(child.trust.maximum, trust + delta));
}

export function trustLabel(trust: number, child: ChildProfile): string {
  const sorted = [...child.trust.labels].sort((a, b) => b.minimum - a.minimum);
  return sorted.find((item) => trust >= item.minimum)?.label ?? sorted.at(-1)?.label ?? "いつもの調子";
}

/** 1-based trust level, counted from the lowest label band upward. */
export function trustLevel(trust: number, child: ChildProfile): number {
  const ascending = [...child.trust.labels].sort((a, b) => a.minimum - b.minimum);
  const reachable = ascending.filter((item) => trust >= item.minimum).length;
  return Math.max(1, reachable);
}

export function passiveInterventionRate(trust: number, child: ChildProfile): number {
  const rates = child.passiveInterventionRatesByTrustLevel;
  if (!rates.length) return 0;
  const index = Math.min(rates.length, trustLevel(trust, child)) - 1;
  return rates[index];
}

