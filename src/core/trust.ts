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

