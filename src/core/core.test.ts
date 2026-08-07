import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { activeAdviceFocus, applyAdvice, matchesAdviceCategory, activeSpeciesSynergies, advanceRun, aestheticScore, advanceBattle, createBattle, createDraft, createLadderRun, createRun, decaySync, decideOffer, evaluateDeck, gainSync, generateOffer, getCurrentOpponentId, getOpponentById, countSpeciesTypes, instanceHasKeyword, speciesGrant, isAceUnlocked, isAdviceDue, isRunComplete, recordBattleResult, resetRun, resolveOffer, runBattle, syncStage, type Card, type ChildProfile, type DraftCard, type DraftOffer, type OpponentDefinition, type SpeciesSynergyConfig } from "./index";

const cards = JSON.parse(readFileSync(resolve("data/cards.json"), "utf8")) as Card[];
const child = JSON.parse(readFileSync(resolve("data/children/tanjun.json"), "utf8")) as ChildProfile;
const opponents = JSON.parse(readFileSync(resolve("data/opponents.json"), "utf8")) as OpponentDefinition[];
const synergy = JSON.parse(readFileSync(resolve("data/species.json"), "utf8")) as SpeciesSynergyConfig;
const get = (id: string) => cards.find((card) => card.id === id)!;
const getOpponent = (id: string) => getOpponentById(opponents, id)!;
const battleDeck = (cardId: string): DraftCard[] => Array.from({ length: 15 }, (_, index) => ({ instanceId: `battle-${index}`, cardId, intervention: false, source: "auto" }));

test("aesthetic score follows the fixed C/H/cool/K weights", () => {
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

test("love suppresses passive intervention, and an order does not force one", () => {
  for (let seed = 1; seed <= 600; seed += 1) {
    const generated = generateOffer(createDraft(seed * 7919, child, child.sync.maximum), cards, child);
    if (generated.offer.decision.love) assert.equal(generated.offer.wantsIntervention, false);
  }
  let asked = 0;
  let offers = 0;
  for (let seed = 1; seed <= 600; seed += 1) {
    const ordered = applyAdvice({ ...createDraft(seed * 7919, child, child.sync.initial), pick: 5 }, "removal", child);
    const generated = generateOffer(ordered, cards, child);
    if (generated.offer.decision.love) continue;
    offers += 1;
    asked += Number(generated.offer.wantsIntervention);
  }
  const rate = asked / offers;
  assert.ok(Math.abs(rate - child.passiveInterventionRate) < 0.06, `an order must not change the ask rate: ${rate}`);
});

test("an order raises how often the ordered category is offered, and stops at expiry", () => {
  const sample = (build: (state: ReturnType<typeof createDraft>) => ReturnType<typeof createDraft>) => {
    let matched = 0;
    let offered = 0;
    for (let seed = 1; seed <= 3000; seed += 1) {
      const state = build({ ...createDraft(seed * 7919, child, child.sync.initial), pick: 5 });
      const generated = generateOffer(state, cards, child);
      offered += 2;
      matched += generated.offer.cards.filter((card) => matchesAdviceCategory(card, "removal")).length;
    }
    return matched / offered;
  };
  const flat = sample((state) => state);
  const ordered = sample((state) => applyAdvice(state, "removal", child));
  const skipped = sample((state) => applyAdvice(state, "skip", child));
  const expired = sample((state) => ({ ...applyAdvice(state, "removal", child), pick: 10 }));

  assert.ok(ordered > flat * 1.5, `an order should lift the category: ${flat} -> ${ordered}`);
  assert.ok(Math.abs(skipped - flat) < 0.02, `skipping must change nothing: ${flat} vs ${skipped}`);
  assert.ok(Math.abs(expired - flat) < 0.02, `the order must lapse at its expiry: ${flat} vs ${expired}`);
});

test("skipping the checkpoint leaves no order behind", () => {
  const state = applyAdvice({ ...createDraft(4242, child, child.sync.initial), pick: 5 }, "skip", child);
  assert.equal(state.adviceFocus, null);
  assert.equal(activeAdviceFocus(state), null);
  assert.equal(isAdviceDue(state, child), false, "the checkpoint is still consumed");
});

test("the advice categories keep one shared definition", () => {
  assert.equal(matchesAdviceCategory(get("judgment"), "removal"), true);
  assert.equal(matchesAdviceCategory(get("thunder"), "removal"), true, "damage of three or more counts as removal");
  assert.equal(matchesAdviceCategory(get("flamebullet"), "removal"), false, "damage of two does not");
  assert.equal(matchesAdviceCategory(get("grim"), "removal"), false, "monsters never count");
  assert.equal(matchesAdviceCategory(get("dolguard"), "guard"), true);
  assert.equal(matchesAdviceCategory(get("grim"), "guard"), false);
  assert.equal(matchesAdviceCategory(get("balga"), "low_cost"), true);
  assert.equal(matchesAdviceCategory(get("gorganos"), "low_cost"), false);
});

const speciesDeck = (cardIds: readonly string[]): DraftCard[] =>
  cardIds.map((cardId, index) => ({ instanceId: `sp-${index}`, cardId, intervention: false, source: "auto" as const }));

test("species types count distinct cards, so a second copy adds nothing", () => {
  const counts = countSpeciesTypes(speciesDeck(["grim", "grim", "gorganos", "balga"]), cards);
  assert.equal(counts["けもの"], 3);
  const doubled = countSpeciesTypes(speciesDeck(["grim", "grim", "grim", "grim"]), cards);
  assert.equal(doubled["けもの"], 1);
});

test("spells never count toward a species", () => {
  const counts = countSpeciesTypes(speciesDeck(["judgment", "thunder", "wisdom", "prophecy", "holyblade", "blastwave"]), cards);
  assert.deepEqual(Object.values(counts), [0, 0, 0, 0, 0, 0]);
  assert.equal(cards.filter((card) => card.type === "spell").every((card) => card.species === null), true);
});

test("four types reach stage one and six types reach stage two", () => {
  assert.deepEqual(synergy.thresholds, { stageOne: 4, stageTwo: 6 });
  const four = activeSpeciesSynergies(speciesDeck(["grim", "gorganos", "balga", "dolga", "grim"]), cards, synergy);
  assert.deepEqual(four.map((item) => [item.species, item.stage]), [["けもの", 1]]);
  assert.equal(four[0].label, "けもの結束・小");

  const three = activeSpeciesSynergies(speciesDeck(["grim", "gorganos", "balga", "grim"]), cards, synergy);
  assert.equal(three.length, 0, "three types no longer reach stage one");

  const six = activeSpeciesSynergies(speciesDeck(["grim", "gorganos", "balga", "dolga", "zahhak", "mewrin"]), cards, synergy);
  assert.deepEqual(six.map((item) => [item.species, item.stage]), [["けもの", 2]]);
  assert.equal(six[0].label, "けもの結束・大");
});

test("stage one grants +1 attack to that species only", () => {
  const deck = speciesDeck(["grim", "gorganos", "balga", "dolga", "judgment"]);
  const battle = createBattle(deck, getOpponent("wall"), cards, 7, 0, null, synergy);
  const all = [...battle.brother.deck, ...battle.brother.hand];
  const grim = all.find((item) => item.cardId === "grim")!;
  assert.equal(grim.atk, get("grim").atk + 1);
  assert.equal(grim.grantedAtk, 1);
  assert.equal(all.filter((item) => item.cardId === "judgment").every((item) => item.grantedAtk === 0), true);
});

test("organization opponents opt into their deck species synergy at battle setup", () => {
  const opponent = getOpponent("wall");
  assert.equal(opponent.speciesSynergy, true);
  const battle = createBattle([], opponent, cards, 7, 0, null, synergy);
  const all = [...battle.opponent.deck, ...battle.opponent.hand];
  const noelka = all.find((item) => item.cardId === "noelka")!;
  assert.deepEqual(noelka.grantedKeywords, ["guard"]);
  assert.equal(all.filter((item) => get(item.cardId).species === "天使").every((item) => instanceHasKeyword(item, cards, "guard")), true);
});

test("stage two hands the beast keyword out and converts the same keyword to +1", () => {
  const deck = speciesDeck(["grim", "gorganos", "balga", "dolga", "zahhak", "mewrin"]);
  const battle = createBattle(deck, getOpponent("wall"), cards, 7, 0, null, synergy);
  const all = [...battle.brother.deck, ...battle.brother.hand];
  const grim = all.find((item) => item.cardId === "grim")!;
  assert.deepEqual(grim.grantedKeywords, ["rush"]);
  assert.equal(grim.grantedAtk, 1, "the stage-one attack carries under the stage-two grant");

  // balga already has rush natively: the duplicate becomes 強化+1 on top of the stage-one +1
  const balga = all.find((item) => item.cardId === "balga")!;
  assert.deepEqual(balga.grantedKeywords, []);
  assert.equal(balga.grantedAtk, 2);
  assert.equal(balga.atk, get("balga").atk + 2);
});

test("a different keyword stacks on top of the card's own", () => {
  // phoenixeed revives natively; the beast stage two adds rush without dropping revive
  const deck = speciesDeck(["grim", "gorganos", "balga", "dolga", "zahhak", "phoenixeed"]);
  const battle = createBattle(deck, getOpponent("wall"), cards, 3, 0, null, synergy);
  const phoenix = [...battle.brother.deck, ...battle.brother.hand].find((item) => item.cardId === "phoenixeed")!;
  assert.equal(instanceHasKeyword(phoenix, cards, "revive"), true);
  assert.equal(instanceHasKeyword(phoenix, cards, "rush"), true);
  assert.deepEqual(phoenix.grantedKeywords, ["rush"]);
  assert.equal(phoenix.grantedAtk, 1);
});

test("the mech stage two adds a destroy trigger that damages an enemy", () => {
  const deck = speciesDeck(["gaiorg", "zamud", "gearload", "metalgain", "dolguard", "drakevine"]);
  const opponent = getOpponent("wall");
  const battle = createBattle(deck, opponent, cards, 11, 0, null, synergy);
  const mech = [...battle.brother.deck, ...battle.brother.hand].find((item) => item.cardId === "zamud")!;
  assert.deepEqual(mech.grantedEffects.map((effect) => [effect.trigger, effect.keyword, effect.value]), [["on_destroyed", "damage", 2]]);

  const enemyCard = { ...battle.opponent.hand[0], cardId: "gaiorg", atk: 3, hp: 5, maxHp: 5, summonedTurn: 0, attacked: false };
  const staged = {
    ...battle,
    turn: 2,
    activeSide: "opponent" as const,
    brother: { ...battle.brother, maxPp: 0, pp: 0, hand: [], deck: [], board: [{ ...mech, atk: 0, hp: 1, maxHp: 1, summonedTurn: 0 }] },
    opponent: { ...battle.opponent, maxPp: 0, pp: 0, hand: [], deck: [], board: [enemyCard] },
  };
  const result = advanceBattle(staged, cards, child, opponent);
  const triggered = result.events.find((item) => item.type === "effect" && item.sourceInstanceId === mech.instanceId && item.keyword === "damage");
  assert.ok(triggered, "the destroyed mech should damage the enemy");
  assert.equal(triggered.damage, 2);
  assert.equal(result.opponent.board[0]?.hp ?? 0, enemyCard.hp - 2);
});

test("stage one splits into attack species and health species", () => {
  const beasts = createBattle(speciesDeck(["grim", "gorganos", "balga", "dolga"]), getOpponent("wall"), cards, 7, 0, null, synergy);
  const grim = [...beasts.brother.deck, ...beasts.brother.hand].find((item) => item.cardId === "grim")!;
  assert.equal(grim.grantedAtk, 1);
  assert.equal(grim.grantedHp, 0);
  assert.equal(grim.atk, get("grim").atk + 1);
  assert.equal(grim.hp, get("grim").hp);

  const mechs = createBattle(speciesDeck(["gaiorg", "zamud", "gearload", "mentena"]), getOpponent("wall"), cards, 7, 0, null, synergy);
  const gaiorg = [...mechs.brother.deck, ...mechs.brother.hand].find((item) => item.cardId === "gaiorg")!;
  assert.equal(gaiorg.grantedAtk, 0);
  assert.equal(gaiorg.grantedHp, 1);
  assert.equal(gaiorg.hp, get("gaiorg").hp + 1);
  assert.equal(gaiorg.maxHp, get("gaiorg").hp + 1, "the ceiling rises with the grant so healing can reach it");
  assert.equal(gaiorg.atk, get("gaiorg").atk);
});

test("granted health survives combat that would otherwise kill the card", () => {
  const opponent = getOpponent("wall");
  const battle = createBattle(speciesDeck(["gaiorg", "zamud", "gearload", "mentena"]), opponent, cards, 7, 0, null, synergy);
  const mech = [...battle.brother.deck, ...battle.brother.hand].find((item) => item.cardId === "gaiorg")!;
  const attacker = { ...battle.opponent.hand[0], cardId: "gorganos", atk: 5, hp: 6, maxHp: 6, summonedTurn: 0, attacked: false };
  const staged = {
    ...battle,
    turn: 2,
    activeSide: "opponent" as const,
    brother: { ...battle.brother, maxPp: 0, pp: 0, hand: [], deck: [], board: [{ ...mech, summonedTurn: 0 }] },
    opponent: { ...battle.opponent, maxPp: 0, pp: 0, hand: [], deck: [], board: [attacker] },
  };
  const result = advanceBattle(staged, cards, child, opponent);
  // gaiorg is 3/5 natively: 5 damage kills it, 5 damage against 5+1 leaves it standing on 1
  assert.equal(result.brother.board.length, 1);
  assert.equal(result.brother.board[0].hp, 1);
});

test("the dragon replaces its own stat at stage two while the others accumulate", () => {
  const dragons = speciesDeck(["baldrogia", "volganid", "valgu", "dragbalt", "baldrogia", "volganid"]);
  assert.deepEqual(activeSpeciesSynergies(dragons, cards, synergy).map((item) => item.stage), [1], "only four dragon types exist in the current pool");
  const four = createBattle(speciesDeck(["baldrogia", "volganid", "valgu", "dragbalt"]), getOpponent("wall"), cards, 7, 0, null, synergy);
  const valgu = [...four.brother.deck, ...four.brother.hand].find((item) => item.cardId === "valgu")!;
  assert.equal(valgu.grantedAtk, 1);

  // the stage-two grant is read straight from the table so the rule holds without six dragon types
  const dragonGrant = speciesGrant("ドラゴン", 2, synergy)!;
  assert.equal(dragonGrant.attack, 2, "same stat: replaced, not +3");
  assert.equal(dragonGrant.hp, 0);

  const angelGrant = speciesGrant("天使", 2, synergy)!;
  assert.equal(angelGrant.hp, 1, "different words: the stage-one health carries");
  assert.deepEqual(angelGrant.keywords, ["guard"]);

  const beastGrant = speciesGrant("けもの", 2, synergy)!;
  assert.equal(beastGrant.attack, 1);
  assert.deepEqual(beastGrant.keywords, ["rush"]);
});

test("the demon stage two hits the enemy leader when a demon lands", () => {
  const demonGrant = speciesGrant("悪魔", 2, synergy)!;
  assert.equal(demonGrant.attack, 1, "the stage-one attack carries under the leader chip");
  assert.deepEqual(demonGrant.effects.map((effect) => [effect.trigger, effect.keyword, effect.value, effect.target]), [["on_play", "damage", 1, "enemy_leader"]]);

  // only five demon types exist in the current pool, so stage two is staged by hand
  const deck = speciesDeck(["valzeid", "nemesion", "zexvain", "inferdos", "shadowkite"]);
  const opponent = getOpponent("wall");
  const battle = createBattle(deck, opponent, cards, 5, 0, null, synergy);
  const demon = { ...[...battle.brother.deck, ...battle.brother.hand].find((item) => item.cardId === "shadowkite")!, grantedEffects: demonGrant.effects };
  const staged = {
    ...battle,
    turn: 2,
    activeSide: "brother" as const,
    brother: { ...battle.brother, maxPp: 9, pp: 9, hand: [demon], deck: [], board: [] },
    opponent: { ...battle.opponent, maxPp: 0, pp: 0, hand: [], deck: [], board: [] },
  };
  const lifeBefore = staged.opponent.life;
  const result = advanceBattle(staged, cards, child, opponent);
  const hit = result.events.find((item) => item.type === "effect" && item.targetLeader && item.sourceInstanceId === demon.instanceId);
  assert.ok(hit, "landing a demon should chip the enemy leader");
  assert.equal(hit.damage, 1);
  // one point from the grant plus the attack itself
  assert.ok(result.opponent.life < lifeBefore);
});

test("the spirit stage two heals allies without passing their ceiling", () => {
  const deck = speciesDeck(["fiorina", "gravewald", "kagerou", "sylphy", "fiorina", "gravewald"]);
  assert.deepEqual(activeSpeciesSynergies(deck, cards, synergy).map((item) => item.stage), [1], "four types stop at stage one; copies do not count");

  const spiritGrant = speciesGrant("精霊", 2, synergy)!;
  assert.equal(spiritGrant.hp, 1, "the stage-one health carries under the heal");
  assert.deepEqual(spiritGrant.effects.map((effect) => [effect.trigger, effect.keyword, effect.value, effect.target]), [["on_play", "heal", 1, "all_allies"]]);

  const opponent = getOpponent("wall");
  const battle = createBattle(speciesDeck(["gravewald", "kagerou", "fiorina", "sylphy"]), opponent, cards, 5, 0, null, synergy);
  const all = [...battle.brother.deck, ...battle.brother.hand];
  const played = { ...all.find((item) => item.cardId === "kagerou")!, grantedEffects: [{ trigger: "on_play" as const, keyword: "heal" as const, value: 1, target: "all_allies" as const }] };
  const hurt = { ...all.find((item) => item.cardId === "gravewald")!, summonedTurn: 0, attacked: true };
  const full = { ...all.find((item) => item.cardId === "fiorina")!, summonedTurn: 0, attacked: true };
  const staged = {
    ...battle,
    turn: 3,
    activeSide: "brother" as const,
    brother: {
      ...battle.brother,
      maxPp: 9,
      pp: 9,
      hand: [played],
      deck: [],
      board: [{ ...hurt, hp: 1 }, full],
    },
    opponent: { ...battle.opponent, maxPp: 0, pp: 0, hand: [], deck: [], board: [] },
  };
  const result = advanceBattle(staged, cards, child, opponent);
  const heal = result.events.find((item) => item.type === "heal");
  assert.ok(heal, "playing the spirit should heal the board");
  assert.equal(heal.keyword, "heal");
  assert.ok((heal.targetInstanceIds ?? []).includes(hurt.instanceId));
  assert.equal((heal.targetInstanceIds ?? []).includes(full.instanceId), false, "a card already at its ceiling is not a heal target");
  const healed = result.brother.board.find((item) => item.instanceId === hurt.instanceId)!;
  assert.equal(healed.hp, 2);
  const untouched = result.brother.board.find((item) => item.instanceId === full.instanceId)!;
  assert.equal(untouched.hp, untouched.maxHp, "healing never passes the ceiling");
});

test("without a synergy config no grant is handed out", () => {
  const deck = speciesDeck(["grim", "gorganos", "balga", "dolga", "zahhak", "mewrin"]);
  const battle = createBattle(deck, getOpponent("wall"), cards, 7);
  assert.deepEqual(battle.synergies, []);
  assert.equal([...battle.brother.deck, ...battle.brother.hand].every((item) => item.grantedAtk === 0 && item.grantedKeywords.length === 0), true);
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

test("opponent leader life uses the data override and defaults to twenty", () => {
  assert.equal(createBattle(battleDeck("grim"), getOpponent("wall"), cards, 1).opponent.life, 20);
  assert.equal(createBattle(battleDeck("grim"), getOpponent("boss"), cards, 1).opponent.life, 28);
});

test("monster play events snapshot the summoned card on the board", () => {
  const initial = createBattle(battleDeck("grim"), getOpponent("wall"), cards, 1);
  const primed = { ...initial, brother: { ...initial.brother, maxPp: 3, pp: 3 } };
  const result = advanceBattle(primed, cards, child, getOpponent("wall"));
  const play = result.events.find((item) => item.type === "play" && item.side === "brother" && item.cardId === "grim");
  assert.ok(play);
  assert.ok(play.snapshot?.brother.board.some((item) => item.instanceId === play.instanceId));
});

test("attack events carry structured card and leader targets", () => {
  const base = createBattle(battleDeck("grim"), getOpponent("wall"), cards, 1);
  const attacker = { ...base.brother.hand[0], summonedTurn: 0, attacked: false };
  const target = { ...base.opponent.hand[0], cardId: "gaiorg", atk: 3, hp: 5, maxHp: 5, summonedTurn: 0 };
  const cardTargetState = {
    ...base,
    turn: 1,
    activeSide: "brother" as const,
    brother: { ...base.brother, maxPp: 0, pp: 0, hand: [], deck: [], board: [attacker] },
    opponent: { ...base.opponent, maxPp: 0, pp: 0, hand: [], deck: [], board: [target] },
  };
  const cardTargetResult = advanceBattle(cardTargetState, cards, child, getOpponent("wall"));
  const cardAttack = cardTargetResult.events.find((item) => item.type === "attack" && item.targetInstanceId);
  assert.ok(cardAttack);
  assert.equal(cardAttack.instanceId, attacker.instanceId);
  assert.equal(cardAttack.targetInstanceId, target.instanceId);
  assert.equal(cardAttack.damage, attacker.atk);
  assert.equal(cardAttack.retaliationDamage, target.atk);
  assert.deepEqual(cardAttack.targetInstances?.map((item) => item.instanceId), [target.instanceId]);
  assert.ok(cardAttack.beforeSnapshot?.opponent.board.some((item) => item.instanceId === target.instanceId));
  assert.ok(cardAttack.snapshot?.brother.board.some((item) => item.instanceId === attacker.instanceId));

  const leaderTargetState = { ...cardTargetState, opponent: { ...cardTargetState.opponent, board: [] } };
  const leaderTargetResult = advanceBattle(leaderTargetState, cards, child, getOpponent("wall"));
  const leaderAttack = leaderTargetResult.events.find((item) => item.type === "attack" && item.targetLeader);
  assert.ok(leaderAttack);
  assert.equal(leaderAttack.instanceId, attacker.instanceId);
  assert.equal(leaderAttack.targetLeader, true);
  assert.equal(leaderAttack.damage, attacker.atk);
  assert.equal(leaderAttack.targetInstanceId, undefined);
});

test("effect events carry their source, target collection, damage, and destruction data", () => {
  const base = createBattle(battleDeck("thunder"), getOpponent("wall"), cards, 1);
  const source = base.brother.hand[0];
  const target = { ...base.opponent.hand[0], cardId: "gaiorg", atk: 3, hp: 5, maxHp: 5, summonedTurn: 0 };
  const state = {
    ...base,
    turn: 1,
    activeSide: "brother" as const,
    brother: { ...base.brother, maxPp: 3, pp: 3, hand: [source], deck: [], board: [] },
    opponent: { ...base.opponent, maxPp: 0, pp: 0, hand: [], deck: [], board: [target] },
  };
  const result = advanceBattle(state, cards, child, getOpponent("wall"));
  const damage = result.events.find((item) => item.type === "effect" && item.keyword === "damage");
  assert.ok(damage);
  assert.equal(damage.sourceInstanceId, source.instanceId);
  assert.deepEqual(damage.targetInstanceIds, [target.instanceId]);
  assert.equal(damage.damage, 4);
  assert.equal(damage.targetLeader, undefined);
  assert.equal(damage.destroyed, undefined);
  assert.equal(damage.sourceInstance?.instanceId, source.instanceId);
  assert.equal(damage.targetInstances?.[0].instanceId, target.instanceId);
  assert.equal(damage.snapshot?.opponent.board[0].hp, 1);

  const leaderState = { ...state, opponent: { ...state.opponent, board: [] } };
  const leaderResult = advanceBattle(leaderState, cards, child, getOpponent("wall"));
  const leaderDamage = leaderResult.events.find((item) => item.type === "effect" && item.keyword === "damage");
  assert.ok(leaderDamage);
  assert.equal(leaderDamage.targetLeader, true);
  assert.deepEqual(leaderDamage.targetInstanceIds, undefined);

  const destroyBase = createBattle(battleDeck("judgment"), getOpponent("wall"), cards, 1);
  const destroySource = destroyBase.brother.hand[0];
  const destroyTarget = { ...destroyBase.opponent.hand[0], cardId: "dolga", atk: 3, hp: 1, maxHp: 1, summonedTurn: 0 };
  const destroyState = {
    ...destroyBase,
    turn: 1,
    activeSide: "brother" as const,
    brother: { ...destroyBase.brother, maxPp: 3, pp: 3, hand: [destroySource], deck: [], board: [] },
    opponent: { ...destroyBase.opponent, maxPp: 0, pp: 0, hand: [], deck: [], board: [destroyTarget] },
  };
  const destroyResult = advanceBattle(destroyState, cards, child, getOpponent("wall"));
  const destroy = destroyResult.events.find((item) => item.type === "effect" && item.keyword === "destroy");
  assert.ok(destroy);
  assert.equal(destroy.sourceInstanceId, destroySource.instanceId);
  assert.deepEqual(destroy.targetInstanceIds, [destroyTarget.instanceId]);
  assert.equal(destroy.destroyed, true);
  assert.equal(destroy.targetInstances?.[0].instanceId, destroyTarget.instanceId);
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

test("the full draft reaches advice checkpoints, keeps the order live, and respects the two-copy cap", () => {
  let state = createDraft(24680, child);
  while (state.pick < 5) {
    const generated = generateOffer(state, cards, child);
    state = resolveOffer(generated.state, generated.offer, child, generated.offer.wantsIntervention ? generated.offer.decision.preferredIndex : undefined);
  }
  assert.equal(isAdviceDue(state, child), true);
  state = applyAdvice(state, "removal", child);
  assert.equal(isAdviceDue(state, child), false, "the checkpoint is consumed by ordering");
  assert.deepEqual(state.adviceFocus, { category: "removal", expiresAtPick: 10 });
  assert.equal(activeAdviceFocus(state)?.category, "removal");
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
