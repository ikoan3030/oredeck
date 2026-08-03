import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { advanceRun, aestheticScore, advanceBattle, createBattle, createDraft, createLadderRun, createRun, decaySync, decideOffer, evaluateDeck, gainSync, generateOffer, getCurrentOpponentId, getOpponentById, instanceHasKeyword, isAceUnlocked, isAdviceDue, isRunComplete, recordBattleResult, resetRun, resolveOffer, runBattle, syncStage, type Card, type ChildProfile, type DraftCard, type DraftOffer, type OpponentDefinition } from "./index";

const cards = JSON.parse(readFileSync(resolve("data/cards.json"), "utf8")) as Card[];
const child = JSON.parse(readFileSync(resolve("data/children/tanjun.json"), "utf8")) as ChildProfile;
const opponents = JSON.parse(readFileSync(resolve("data/opponents.json"), "utf8")) as OpponentDefinition[];
const get = (id: string) => cards.find((card) => card.id === id)!;
const getOpponent = (id: string) => getOpponentById(opponents, id)!;
const battleDeck = (cardId: string): DraftCard[] => Array.from({ length: 15 }, (_, index) => ({ instanceId: `battle-${index}`, cardId, intervention: false, source: "auto" }));

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

test("sync only rises on a supported ruling and never falls during a build", () => {
  assert.equal(gainSync(0, true, child), 8);
  assert.equal(gainSync(40, false, child), 40);
  assert.equal(gainSync(96, true, child), 100);
});

test("the post-battle cooldown keeps values under the floor untouched", () => {
  assert.equal(Number(decaySync(48, child).toFixed(4)), 33.6);
  assert.equal(decaySync(25, child), 20);
  assert.equal(decaySync(16, child), 16);
  assert.equal(decaySync(20, child), 20);
});

test("stages are twenty wide and the ace unlocks only at the top one", () => {
  assert.deepEqual([0, 19, 20, 59, 60, 80, 100].map((value) => syncStage(value, child)), [1, 1, 2, 3, 4, 5, 5]);
  assert.equal(isAceUnlocked(79, child), false);
  assert.equal(isAceUnlocked(80, child), true);
});

test("passive intervention stays at the fixed character rate, independent of sync", () => {
  assert.equal(child.passiveInterventionRate, 0.5);
  const sample = (sync: number) => {
    let asked = 0;
    let normal = 0;
    for (let seed = 1; seed <= 600; seed += 1) {
      const generated = generateOffer(createDraft(seed * 7919, child, sync), cards, child);
      if (generated.offer.decision.love) continue;
      normal += 1;
      if (generated.offer.wantsIntervention) asked += 1;
    }
    return asked / normal;
  };
  const low = sample(child.sync.initial);
  const high = sample(child.sync.maximum);
  assert.ok(Math.abs(low - 0.5) < 0.06, `low sync rate ${low}`);
  assert.ok(Math.abs(high - 0.5) < 0.06, `high sync rate ${high}`);
  assert.ok(Math.abs(low - high) < 0.05, `sync must not shift the rate: ${low} vs ${high}`);
});

test("love suppresses passive intervention and advice picks always ask, whatever the sync", () => {
  for (let seed = 1; seed <= 600; seed += 1) {
    const generated = generateOffer(createDraft(seed * 7919, child, child.sync.maximum), cards, child);
    if (generated.offer.decision.love) assert.equal(generated.offer.wantsIntervention, false);
  }
  const lowSyncDraft = createDraft(13579, child, child.sync.initial);
  assert.equal(generateOffer(lowSyncDraft, cards, child, "removal").offer.wantsIntervention, true);
  assert.equal(generateOffer(lowSyncDraft, cards, child, "guard").offer.wantsIntervention, true);
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

test("sync bonuses use the stage data and affect instance keyword checks", () => {
  const opponent = getOpponent("wall");
  const before = createBattle(battleDeck("noelka"), opponent, cards, 5, 20, null);
  assert.equal(instanceHasKeyword(before.brother.hand[0], cards, "rush"), false);

  const activated = advanceBattle(before, cards, child, opponent);
  const activatedCard = activated.brother.board[0];
  assert.ok(activatedCard);
  assert.deepEqual(activatedCard.grantedKeywords, ["rush"]);
  assert.equal(instanceHasKeyword(activatedCard, cards, "rush"), true);
  assert.equal(activated.events.filter((item) => item.type === "sync_bonus").length, 1);
  assert.equal(activated.opponent.life, 19);

  const missed = advanceBattle(createBattle(battleDeck("noelka"), opponent, cards, 1, 20, null), cards, child, opponent);
  assert.equal(missed.events.filter((item) => item.type === "sync_bonus").length, 0);
  assert.equal(missed.opponent.life, 20);

  const stageOne = advanceBattle(createBattle(battleDeck("noelka"), opponent, cards, 5, 0, null), cards, child, opponent);
  assert.equal(stageOne.events.filter((item) => item.type === "sync_bonus").length, 0);
  assert.equal(stageOne.opponent.life, 20);

  const tooExpensive = createBattle(battleDeck("dolga"), opponent, cards, 5, 20, null);
  const enoughPp = { ...tooExpensive, brother: { ...tooExpensive.brother, maxPp: 1, pp: 1 } };
  const costMiss = advanceBattle(enoughPp, cards, child, opponent);
  assert.equal(costMiss.events.filter((item) => item.type === "sync_bonus").length, 0);

  const stageFive = createBattle(battleDeck("dolga"), opponent, cards, 1, 80, null);
  const stageFiveNext = advanceBattle({ ...stageFive, brother: { ...stageFive.brother, maxPp: 1, pp: 1 } }, cards, child, opponent);
  assert.equal(stageFiveNext.events.filter((item) => item.type === "sync_bonus").length, 1);
  assert.equal(stageFiveNext.brother.board[0].grantedAtk, 1);
  assert.equal(instanceHasKeyword(stageFiveNext.brother.board[0], cards, "rush"), true);

  const guardGranted = { ...before.brother.hand[0], grantedKeywords: ["guard"] as ["guard"] };
  assert.equal(instanceHasKeyword(guardGranted, cards, "guard"), true);
});

test("the ace card uses the 14-card deck, life threshold, and one-use turn-start draw", () => {
  const opponent = getOpponent("wall");
  const battle = createBattle(battleDeck("grim"), opponent, cards, 123, 80, "grim");
  const aceId = battle.brother.aceCard?.instanceId;
  assert.ok(aceId);
  assert.equal(battle.brother.deck.length + battle.brother.hand.length, 14);
  assert.equal(battle.brother.deck.length, 11);

  const primed = { ...battle, brother: { ...battle.brother, life: 7 } };
  const first = advanceBattle(primed, cards, child, opponent);
  const drawnAce = first.brother.hand.find((item) => item.instanceId === aceId);
  assert.ok(drawnAce);
  assert.equal(drawnAce.grantedAtk, 2);
  assert.deepEqual(drawnAce.grantedKeywords, ["rush"]);
  assert.equal(first.brother.aceCard, null);
  assert.equal(first.brother.aceUsed, true);
  assert.equal(first.brother.deck.length, battle.brother.deck.length);
  assert.equal(first.events.filter((item) => item.type === "ace").length, 1);
  assert.equal(first.events.filter((item) => item.type === "draw").length, 0);

  const second = advanceBattle(first, cards, child, opponent);
  const third = advanceBattle(second, cards, child, opponent);
  assert.equal(third.events.filter((item) => item.type === "ace").length, 1);

  const drawDeck: DraftCard[] = [
    { instanceId: "ace", cardId: "grim", intervention: false, source: "auto" },
    ...Array.from({ length: 14 }, (_, index) => ({ instanceId: `draw-${index}`, cardId: "wisdom", intervention: false, source: "auto" as const })),
  ];
  const drawBattle = createBattle(drawDeck, opponent, cards, 1, 80, "grim");
  const drawEffect = advanceBattle({ ...drawBattle, brother: { ...drawBattle.brother, maxPp: 1, pp: 1 } }, cards, child, opponent);
  assert.ok(drawEffect.events.some((item) => item.type === "effect" && item.keyword === "draw"));
  assert.equal(drawEffect.events.filter((item) => item.type === "ace").length, 0);
  assert.ok(drawEffect.brother.aceCard);

  const noAce = createBattle(battleDeck("grim"), opponent, cards, 123, 80, null);
  assert.equal(noAce.brother.aceCard, null);
  assert.equal(noAce.brother.aceUsed, false);
  assert.equal(noAce.brother.deck.length, 12);
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

test("sync carries into the next draft through the post-battle cooldown", () => {
  const decision = decideOffer([get("grim"), get("zahhak")], child);
  const offer: DraftOffer = { cards: [get("grim"), get("zahhak")], decision, wantsIntervention: true, source: "normal" };
  const supportedDraft = resolveOffer(createDraft(1, child, 40), offer, child, decision.preferredIndex);
  assert.equal(supportedDraft.syncRate, 48);

  const afterFirstBattle = recordBattleResult(createRun(["rush", "wall", "boss"], 0), supportedDraft, "opponent", child);
  const secondDraft = createDraft(2, child, afterFirstBattle.carrySync);

  assert.equal(afterFirstBattle.battleResults[0].syncBefore, 0);
  assert.equal(afterFirstBattle.battleResults[0].syncAfterBuild, 48);
  assert.equal(Number(afterFirstBattle.battleResults[0].syncAfterDecay.toFixed(4)), 33.6);
  assert.equal(afterFirstBattle.carrySync, afterFirstBattle.battleResults[0].syncAfterDecay);
  assert.equal(secondDraft.syncRate, afterFirstBattle.carrySync);
});

test("the sync curve matches the target gradient in the spec for 6/6, 5/6 and 4/6 reads", () => {
  const round = (value: number) => Number(value.toFixed(1));
  const build = (sync: number, hits: number) => {
    let value = sync;
    for (let index = 0; index < 6; index += 1) value = gainSync(value, index < hits, child);
    return value;
  };
  const ladder = (hits: number) => {
    const first = build(child.sync.initial, hits);
    const second = build(decaySync(first, child), hits);
    const third = build(decaySync(second, child), hits);
    return { first, second, third, unlockedAt: [first, second, third].findIndex((value) => isAceUnlocked(value, child)) + 1 };
  };

  const all = ladder(6);
  assert.deepEqual([round(all.first), round(all.second), round(all.third)], [48, 81.6, 100]);
  assert.equal(all.unlockedAt, 2);

  const five = ladder(5);
  assert.deepEqual([round(five.first), round(five.second), round(five.third)], [40, 68, 87.6]);
  assert.equal(five.unlockedAt, 3);

  const four = ladder(4);
  assert.deepEqual([round(four.first), round(four.second), round(four.third)], [32, 54.4, 70.1]);
  assert.equal(four.unlockedAt, 0);
});

test("a rejected ruling leaves sync untouched", () => {
  const decision = decideOffer([get("dolguard"), get("gaiorg")], child);
  const offer: DraftOffer = { cards: [get("dolguard"), get("gaiorg")], decision, wantsIntervention: true, source: "normal" };
  const rejectedIndex = decision.preferredIndex === 0 ? 1 : 0;
  const draft = resolveOffer(createDraft(1, child, 24), offer, child, rejectedIndex);
  assert.equal(draft.syncRate, 24);
  assert.equal(draft.history.at(-1)?.syncBefore, 24);
  assert.equal(draft.history.at(-1)?.syncAfter, 24);
});

test("resetting a run clears battle progress and restores the initial sync", () => {
  const run = recordBattleResult(createRun(["rush", "wall", "boss"], 0), { ...createDraft(3, child, 0), syncRate: 37 }, "brother", child);
  const reset = resetRun(run);

  assert.equal(reset.currentBattle, 0);
  assert.deepEqual(reset.battleResults, []);
  assert.equal(reset.carrySync, 0);
  assert.equal(reset.summary.finalSync, 0);
});

test("run advances through rush, wall, and boss and completes after three battles", () => {
  let run = createRun(["rush", "wall", "boss"], 0);
  const winners = ["brother", "opponent", "draw"] as const;

  winners.forEach((winner, index) => {
    run = advanceRun(run, createDraft(index + 10, child, run.carrySync), winner, child);
    assert.equal(run.currentBattle, index + 1);
  });

  assert.equal(isRunComplete(run), true);
  assert.equal(getCurrentOpponentId(run), undefined);
  assert.deepEqual(run.battleResults.map((result) => result.opponentId), ["rush", "wall", "boss"]);
  assert.deepEqual(run.battleResults.map((result) => result.outcome), ["win", "loss", "draw"]);
  assert.deepEqual({ wins: run.summary.wins, losses: run.summary.losses, draws: run.summary.draws }, { wins: 1, losses: 1, draws: 1 });
});

test("the ladder builds six deterministic battles with two distinct variable opponents", () => {
  const first = createLadderRun(123456, 0);
  const second = createLadderRun(123456, 0);
  assert.deepEqual(first, second);
  assert.deepEqual(first.opponentIds.slice(0, 1), ["rush"]);
  assert.deepEqual(first.opponentIds.slice(3), ["wall", "executive", "boss"]);
  assert.equal(first.opponentIds.length, 6);
  assert.equal(new Set(first.opponentIds.slice(1, 3)).size, 2);
  assert.ok(first.opponentIds.slice(1, 3).every((id) => ["sister", "smart-brother", "cousin"].includes(id)));
});

test("run summary aggregates passive support, rejection, love cards, outcomes, and final sync", () => {
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

  const run = recordBattleResult(createRun(["rush", "wall", "boss"], 50), draft, "brother", child);
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
  assert.equal(run.summary.finalSync, decaySync(draft.syncRate, child));
});
