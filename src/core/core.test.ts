import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { OPPONENTS, aestheticScore, advanceBattle, createBattle, createDraft, decideOffer, evaluateDeck, generateOffer, isAdviceDue, resolveOffer, runBattle, updateTrust, type Card, type ChildProfile, type DraftCard } from "./index";

const cards = JSON.parse(readFileSync(resolve("data/cards.json"), "utf8")) as Card[];
const child = JSON.parse(readFileSync(resolve("data/children/tanjun.json"), "utf8")) as ChildProfile;
const get = (id: string) => cards.find((card) => card.id === id)!;

test("aesthetic score follows the fixed C/H/B/K weights", () => {
  assert.equal(aestheticScore(get("gravewald"), child), 2.7);
  assert.equal(aestheticScore(get("phoenixeed"), child), 2.3);
});

test("love is processed before the normal decision table", () => {
  const result = decideOffer([get("zexvain"), get("noelka")], child);
  assert.equal(result.preferredIndex, 0);
  assert.equal(result.reason, "love");
});

test("monster, cost, attack, aesthetic, first stay in the specified order", () => {
  assert.equal(decideOffer([get("prophecy"), get("inferdos")], child).reason, "monster");
  assert.equal(decideOffer([get("grim"), get("drakevine")], child).reason, "lower_cost");
  assert.equal(decideOffer([get("grim"), get("zahhak")], child).reason, "higher_attack");
});

test("trust uses the confirmed asymmetric formula and floor", () => {
  assert.equal(updateTrust(50, true, 2, child), 53);
  assert.equal(updateTrust(50, false, 2, child), 45);
  assert.equal(updateTrust(21, false, 0, child), 20);
});

test("deck evaluation returns materials, not a win recommendation", () => {
  const deck: DraftCard[] = ["dolguard", "gaiorg", "judgment", "thunder"].map((cardId, index) => ({ instanceId: String(index), cardId, intervention: false, source: "auto" }));
  const evaluation = evaluateDeck(deck, cards);
  assert.equal(evaluation.guards, 2);
  assert.equal(evaluation.removal, 2);
  assert.equal("rating" in evaluation, false);
});

test("battle resolves within the turn limit without mutating the input state", () => {
  const ids = ["balga","dolguard","grim","alvine","gaiorg","volganid","phoenixeed","valzeid","dolga","zahhak","shadowkite","judgment","followarrow","thunder","steel-blessing"];
  const deck: DraftCard[] = ids.map((cardId, index) => ({ instanceId: `d-${index}`, cardId, intervention: index >= 11, source: index >= 11 ? "advice" : "auto" }));
  const initial = createBattle(deck, OPPONENTS[0], cards, 12345);
  const snapshot = JSON.stringify(initial);
  const oneTurn = advanceBattle(initial, cards, child, OPPONENTS[0]);
  assert.equal(JSON.stringify(initial), snapshot);
  assert.notEqual(oneTurn, initial);
  const result = runBattle(initial, cards, child, OPPONENTS[0]);
  assert.ok(result.winner);
  assert.ok(result.turn <= 30);
});

test("attribution only appears on effective work and never on card play", () => {
  const ids = ["judgment","judgment","followarrow","followarrow","steel-blessing","steel-blessing","balga","dolguard","grim","alvine","gaiorg","volganid","phoenixeed","valzeid","dolga"];
  const deck: DraftCard[] = ids.map((cardId, index) => ({ instanceId: `i-${index}`, cardId, intervention: index < 6, source: index < 6 ? "advice" : "auto" }));
  const result = runBattle(createBattle(deck, OPPONENTS[0], cards, 98765), cards, child, OPPONENTS[0]);
  assert.ok(result.events.filter((item) => item.type === "attribution").every((item) => item.effective));
  assert.ok(result.events.filter((item) => item.type === "play").every((item) => !item.dialogue));
});

test("the full draft reaches advice checkpoints, forces advice intervention, and respects the two-copy cap", () => {
  let state = createDraft(24680, child);
  while (state.pick < 5) {
    const generated = generateOffer(state, cards, child);
    state = resolveOffer(generated.state, generated.offer, child, generated.offer.wantsIntervention ? generated.offer.decision.preferredIndex : undefined);
  }
  assert.equal(isAdviceDue(state, child), true);
  const advice = generateOffer(state, cards, child, "removal");
  assert.equal(advice.offer.wantsIntervention, true);
  assert.ok(advice.offer.cards.every((card) => card.type === "spell" && card.effects.some((effect) => effect.keyword === "destroy" || (effect.keyword === "damage" && effect.value >= 3))));
  state = resolveOffer(advice.state, advice.offer, child, 0);
  assert.equal(state.deck.at(-1)?.intervention, true);
  while (state.pick < 15) {
    const generated = generateOffer(state, cards, child);
    state = resolveOffer(generated.state, generated.offer, child, generated.offer.wantsIntervention ? generated.offer.decision.preferredIndex : undefined);
  }
  const counts = state.deck.reduce((map, item) => map.set(item.cardId, (map.get(item.cardId) ?? 0) + 1), new Map<string, number>());
  assert.ok([...counts.values()].every((count) => count <= 2));
});
