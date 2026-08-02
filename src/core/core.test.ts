import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { advanceRun, aestheticScore, advanceBattle, createBattle, createDraft, createRun, decideOffer, evaluateDeck, generateOffer, getCurrentOpponentId, getOpponentById, isAdviceDue, isRunComplete, passiveInterventionRate, recordBattleResult, resetRun, resolveOffer, runBattle, updateTrust, type Card, type ChildProfile, type DraftCard, type DraftOffer, type OpponentDefinition } from "./index";

const cards = JSON.parse(readFileSync(resolve("data/cards.json"), "utf8")) as Card[];
const child = JSON.parse(readFileSync(resolve("data/children/tanjun.json"), "utf8")) as ChildProfile;
const opponents = JSON.parse(readFileSync(resolve("data/opponents.json"), "utf8")) as OpponentDefinition[];
const get = (id: string) => cards.find((card) => card.id === id)!;
const getOpponent = (id: string) => getOpponentById(opponents, id)!;

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

test("passive intervention rate follows the five trust levels", () => {
  assert.deepEqual(child.passiveInterventionRatesByTrustLevel, [0.25, 0.4, 0.5, 0.6, 0.7]);
  assert.deepEqual([20, 30, 50, 70, 90].map((trust) => passiveInterventionRate(trust, child)), [0.25, 0.4, 0.5, 0.6, 0.7]);
});

test("offer generation asks more often at high trust than at low trust", () => {
  const sample = (trust: number) => {
    let asked = 0;
    let normal = 0;
    for (let seed = 1; seed <= 600; seed += 1) {
      const generated = generateOffer({ ...createDraft(seed * 7919, child, trust) }, cards, child);
      if (generated.offer.decision.love) continue;
      normal += 1;
      if (generated.offer.wantsIntervention) asked += 1;
    }
    return asked / normal;
  };
  const low = sample(child.trust.minimum);
  const high = sample(child.trust.maximum);
  assert.ok(Math.abs(low - 0.25) < 0.06, `low trust rate ${low}`);
  assert.ok(Math.abs(high - 0.7) < 0.06, `high trust rate ${high}`);
});

test("love suppresses passive intervention and advice picks always ask, whatever the trust", () => {
  for (let seed = 1; seed <= 600; seed += 1) {
    const generated = generateOffer(createDraft(seed * 7919, child, child.trust.maximum), cards, child);
    if (generated.offer.decision.love) assert.equal(generated.offer.wantsIntervention, false);
  }
  const lowTrustDraft = createDraft(13579, child, child.trust.minimum);
  assert.equal(generateOffer(lowTrustDraft, cards, child, "removal").offer.wantsIntervention, true);
  assert.equal(generateOffer(lowTrustDraft, cards, child, "guard").offer.wantsIntervention, true);
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
  const initial = createBattle(deck, getOpponent("wall"), cards, 12345);
  const snapshot = JSON.stringify(initial);
  const oneTurn = advanceBattle(initial, cards, child, getOpponent("wall"));
  assert.equal(JSON.stringify(initial), snapshot);
  assert.notEqual(oneTurn, initial);
  const result = runBattle(initial, cards, child, getOpponent("wall"));
  assert.ok(result.winner);
  assert.ok(result.turn <= 30);
});

test("attribution only appears on effective work and never on card play", () => {
  const ids = ["judgment","judgment","followarrow","followarrow","steel-blessing","steel-blessing","balga","dolguard","grim","alvine","gaiorg","volganid","phoenixeed","valzeid","dolga"];
  const deck: DraftCard[] = ids.map((cardId, index) => ({ instanceId: `i-${index}`, cardId, intervention: index < 6, source: index < 6 ? "advice" : "auto" }));
  const result = runBattle(createBattle(deck, getOpponent("rush"), cards, 98765), cards, child, getOpponent("rush"));
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

test("run trust carries from the first battle into the second draft", () => {
  const initialDraft = createDraft(1, child, 50);
  const decision = decideOffer([get("grim"), get("zahhak")], child);
  const offer: DraftOffer = { cards: [get("grim"), get("zahhak")], decision, wantsIntervention: true, source: "normal" };
  const rejectedIndex = decision.preferredIndex === 0 ? 1 : 0;
  const firstDraft = resolveOffer(initialDraft, offer, child, rejectedIndex);
  const afterFirstBattle = recordBattleResult(createRun(["rush", "wall", "boss"], 50), firstDraft, "opponent");
  const secondDraft = createDraft(2, child, afterFirstBattle.carryTrust);

  assert.equal(afterFirstBattle.battleResults[0].trustBefore, 50);
  assert.equal(afterFirstBattle.carryTrust, firstDraft.trust);
  assert.equal(secondDraft.trust, firstDraft.trust);
});

test("resetting a run clears battle progress and restores the initial trust", () => {
  const run = recordBattleResult(createRun(["rush", "wall", "boss"], 50), { ...createDraft(3, child, 50), trust: 37 }, "brother");
  const reset = resetRun(run);

  assert.equal(reset.currentBattle, 0);
  assert.deepEqual(reset.battleResults, []);
  assert.equal(reset.carryTrust, 50);
  assert.equal(reset.summary.finalTrust, 50);
});

test("run advances through rush, wall, and boss and completes after three battles", () => {
  let run = createRun(["rush", "wall", "boss"], 50);
  const winners = ["brother", "opponent", "draw"] as const;

  winners.forEach((winner, index) => {
    run = advanceRun(run, createDraft(index + 10, child, run.carryTrust), winner);
    assert.equal(run.currentBattle, index + 1);
  });

  assert.equal(isRunComplete(run), true);
  assert.equal(getCurrentOpponentId(run), undefined);
  assert.deepEqual(run.battleResults.map((result) => result.opponentId), ["rush", "wall", "boss"]);
  assert.deepEqual(run.battleResults.map((result) => result.outcome), ["win", "loss", "draw"]);
  assert.deepEqual({ wins: run.summary.wins, losses: run.summary.losses, draws: run.summary.draws }, { wins: 1, losses: 1, draws: 1 });
});

test("run summary aggregates passive support, rejection, love cards, outcomes, and final trust", () => {
  let draft = createDraft(20, child, 50);
  const loveOffer: DraftOffer = { cards: [get("zexvain"), get("noelka")], decision: decideOffer([get("zexvain"), get("noelka")], child), wantsIntervention: false, source: "normal" };
  draft = resolveOffer(draft, loveOffer, child);

  const supportDecision = decideOffer([get("grim"), get("zahhak")], child);
  const supportOffer: DraftOffer = { cards: [get("grim"), get("zahhak")], decision: supportDecision, wantsIntervention: true, source: "normal" };
  draft = resolveOffer(draft, supportOffer, child, supportDecision.preferredIndex);

  const rejectDecision = decideOffer([get("dolguard"), get("gaiorg")], child);
  const rejectOffer: DraftOffer = { cards: [get("dolguard"), get("gaiorg")], decision: rejectDecision, wantsIntervention: true, source: "normal" };
  const rejectedIndex = rejectDecision.preferredIndex === 0 ? 1 : 0;
  draft = resolveOffer(draft, rejectOffer, child, rejectedIndex);

  const run = recordBattleResult(createRun(["rush", "wall", "boss"], 50), draft, "brother");
  const result = run.battleResults[0];

  assert.equal(result.passiveInterventions, 2);
  assert.equal(result.passiveSupports, 1);
  assert.equal(result.passiveRejects, 1);
  assert.deepEqual(result.loveCardIds, ["zexvain"]);
  assert.equal(run.summary.wins, 1);
  assert.equal(run.summary.passiveInterventions, 2);
  assert.equal(run.summary.passiveSupports, 1);
  assert.equal(run.summary.passiveRejects, 1);
  assert.deepEqual(run.summary.loveCardIds, ["zexvain"]);
  assert.equal(run.summary.finalTrust, draft.trust);
});
