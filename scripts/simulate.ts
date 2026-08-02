import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDraft,
  evaluateDeck,
  generateOffer,
  isAdviceDue,
  markAdviceSkipped,
  resolveOffer,
  getOpponentById,
  type Card,
  type ChildProfile,
  type OpponentDefinition,
} from "../src/core/index";

const cards = JSON.parse(readFileSync(resolve("data/cards.json"), "utf8")) as Card[];
const child = JSON.parse(readFileSync(resolve("data/children/tanjun.json"), "utf8")) as ChildProfile;
const opponents = JSON.parse(readFileSync(resolve("data/opponents.json"), "utf8")) as OpponentDefinition[];
if (!getOpponentById(opponents, "wall") || !getOpponentById(opponents, "rush")) throw new Error("Missing baseline opponent data");
const runs = Number(process.argv[2] ?? 2000);

const totals = {
  love: 0,
  passive: 0,
  monsters: 0,
  spells: 0,
  cost: 0,
  guard: 0,
  removal: 0,
  low: 0,
  heavy: 0,
  missing: 0,
  removalMissing: 0,
  durabilityMissing: 0,
  heavyCongestion: 0,
  lowCostMissing: 0,
};
const cardCounts = new Map<string, number>();

for (let run = 0; run < runs; run += 1) {
  let state = createDraft((run + 1) * 0x9e3779b1, child);
  while (state.pick < 15) {
    if (isAdviceDue(state, child)) state = markAdviceSkipped(state);
    const generated = generateOffer(state, cards, child);
    state = resolveOffer(generated.state, generated.offer, child, generated.offer.wantsIntervention ? generated.offer.decision.preferredIndex : undefined);
  }
  const evaluation = evaluateDeck(state.deck, cards);
  state.deck.forEach((item) => cardCounts.set(item.cardId, (cardCounts.get(item.cardId) ?? 0) + 1));
  totals.love += state.lovePicks;
  totals.passive += state.passiveInterventions;
  totals.monsters += evaluation.monsters;
  totals.spells += evaluation.spells;
  totals.cost += evaluation.averageCost;
  totals.guard += evaluation.guards;
  totals.removal += evaluation.removal;
  totals.low += evaluation.lowCost;
  totals.heavy += evaluation.heavy;
  totals.missing += evaluation.missingCount;
  totals.removalMissing += Number(evaluation.metrics.removalMissing);
  totals.durabilityMissing += Number(evaluation.metrics.durabilityMissing);
  totals.heavyCongestion += Number(evaluation.metrics.heavyCongestion);
  totals.lowCostMissing += Number(evaluation.metrics.lowCostMissing);
}

const average = (value: number) => Number((value / runs).toFixed(3));
const percent = (value: number) => `${(value / runs * 100).toFixed(1)}%`;
console.log(JSON.stringify({
  runs,
  averages: {
    love: average(totals.love),
    passiveInterventions: average(totals.passive),
    monsters: average(totals.monsters),
    spells: average(totals.spells),
    averageCost: average(totals.cost),
    guard: average(totals.guard),
    removal: average(totals.removal),
    lowCost: average(totals.low),
    heavy: average(totals.heavy),
    missing: average(totals.missing),
  },
  rates: {
    removalMissing: percent(totals.removalMissing),
    durabilityMissing: percent(totals.durabilityMissing),
    heavyCongestion: percent(totals.heavyCongestion),
    lowCostMissing: percent(totals.lowCostMissing),
  },
  averageCopies: Object.fromEntries([...cardCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => [id, average(count)])),
}, null, 2));
