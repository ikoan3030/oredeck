import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const styles = readFileSync(resolve("src/styles.css"), "utf8");
const app = readFileSync(resolve("src/App.tsx"), "utf8");

/**
 * Classes that ride along with a card for as long as it holds that state. They may only paint;
 * if one of them ever animates, every unrelated re-render would restart that animation and the
 * board-card identity work would be undone from the CSS side.
 */
const PERSISTENT_CARD_CLASSES = ["sync-granted", "ace-granted", "intervened"];

function rulesFor(className: string): string[] {
  const blocks: string[] = [];
  const pattern = new RegExp(`([^{}]*\\.${className}[^{}]*)\\{([^}]*)\\}`, "g");
  let match = pattern.exec(styles);
  while (match) {
    blocks.push(match[2]);
    match = pattern.exec(styles);
  }
  return blocks;
}

test("persistent card state classes paint but never animate", () => {
  for (const className of PERSISTENT_CARD_CLASSES) {
    const blocks = rulesFor(className);
    assert.ok(blocks.length > 0, `${className} should still be styled`);
    for (const body of blocks) {
      assert.ok(!/(^|[;\s])animation(-name)?\s*:/.test(body), `${className} must not declare an animation: ${body.trim()}`);
    }
  }
});

test("the board renders from the identity-stable boards, keyed by instance id", () => {
  assert.ok(app.includes("stableBoards.brother.map"), "the brother board must render the reconciled list");
  assert.ok(app.includes("stableBoards.opponent.map"), "the opponent board must render the reconciled list");
  assert.ok(!/board(Brother|Opponent)\.board\.map/.test(app), "no board may render straight from a snapshot");
  const boardCards = app.match(/<AnimatedBoardCard key=\{[^}]*\}/g) ?? [];
  assert.equal(boardCards.length, 2);
  assert.ok(boardCards.every((usage) => usage.includes("key={item.instanceId}")), "board cards must key on the instance id");
});

test("the battle does not show the held ace card before its draw", () => {
  assert.equal(app.includes("function AceStatus("), false, "the always-on ace holder component must be removed");
  assert.equal(app.includes('className="ace-status"'), false, "the always-on ace holder markup must be removed");
  assert.equal(styles.includes(".ace-status"), false, "the always-on ace holder styles must be removed");
  assert.ok(app.includes('item.type === "ace"'), "the ace event remains available for the draw cut-in and log");
});

test("each side stacks a portrait over its own caption, with life split out", () => {
  assert.ok(app.includes("function BattleActor("), "the speaker block should be one replaceable component");
  assert.ok(app.includes('<BattleActor side="opponent"'), "the opponent needs a speaker block");
  assert.ok(app.includes('<BattleActor side="brother"'), "the brother needs a speaker block");
  assert.ok(app.includes('className="battle-actor-portrait"'), "the portrait is its own element");
  assert.ok(app.includes('className="battle-actor-caption"'), "the caption is its own element under the portrait");
  // 台詞が無い間も枠が残るよう、テキストは条件レンダリングにしない。
  assert.ok(app.includes("{text ?? \"\"}"), "an absent line must leave the caption standing with an empty line");
  // 立ち絵はトリミングせず縦横比を保つ。
  assert.ok(styles.includes("object-fit: contain"), "the portrait must not be cropped");
  assert.equal(app.includes("function BattleMessageWindow("), false, "the one-row message window must be removed");
  assert.equal(styles.includes(".battle-message-face"), false, "the embedded face column must be removed");
  assert.equal(app.includes("function BattlePortrait("), false, "the standalone portrait frame must be removed");
  assert.equal(app.includes("function BattleSpeechSlot("), false, "the standalone speech bubble slot must be removed");
  assert.equal(styles.includes(".battle-dialogue-group"), false, "the split dialogue group must be removed");
  assert.equal(app.includes('className="avatar"'), false, "the old circular leader icons must be removed");
});

test("deck depletion is announced once per player, and never during skip", () => {
  assert.ok(app.includes("function DeckOutBanner("), "the announcement needs its own small banner");
  assert.ok(app.includes("announcedDeckOut"), "the announcement must remember who was already announced");
  assert.ok(app.includes("announcedDeckOut.current.add(deckOutSide)"), "a side must be recorded the first time it runs out");
  assert.ok(app.includes("!announcedDeckOut.current.has(target)"), "an already-announced side must not fire again");
  // スキップは0msなので帯を出さない。
  assert.ok(/DECK_OUT_BANNER_MS[^;]*skip: 0/.test(app), "skip playback must omit the announcement");
  // 切り札カットインより明確に小さい細帯であること。
  assert.ok(styles.includes(".deck-out-banner"), "the banner needs its own thin-band style");
  assert.ok(app.includes("function DeckCaseMeter("), "the deck case meter must expose the current deck count");
  assert.ok(app.includes("deckCountOpponent") && app.includes("deckCountBrother"), "both sides must receive playback-synchronized deck counts");
});

test("the turn number is a field watermark that never covers a card", () => {
  assert.equal(app.includes("battle-turn-center"), false, "the old fixed turn badge must be gone");
  assert.equal(styles.includes(".battle-turn-center"), false, "the old fixed turn badge styles must be gone");
  assert.ok(app.includes('className="board-turn"'), "the turn number lives inside the field");
  const block = rulesFor("board-turn")[0] ?? "";
  assert.ok(/z-index:\s*1/.test(block), "the watermark must sit above the board art and behind the cards");
  assert.ok(!/background(-color)?:/.test(block), "the watermark must not paint a band");
  assert.ok(!/(^|[;\s])border\s*:/.test(block), "the watermark must not draw a border");
  // 盤面の点線枠と同じ淡さ。
  assert.ok(block.includes("#ffffff44"), "the watermark must remain a subdued field label");
  assert.ok(app.includes('className="battle-board-art"'), "the field uses the imported board artwork");
  assert.ok(styles.includes(".battle-board-art"), "the board artwork needs a dedicated background layer");
  assert.equal(styles.includes("border: 3px dashed #ffffff44"), false, "the old dashed board outline must be removed");
});

test("the board art is the back layer and every UI layer sits in front of it", () => {
  // 同じクラスに複数の宣言ブロックがあるので、z-index を宣言している方を拾う。
  const zOf = (className: string) => {
    for (const block of rulesFor(className)) {
      const found = /z-index:\s*(-?\d+)/.exec(block);
      if (found) return Number(found[1]);
    }
    return NaN;
  };
  const arena = zOf("arena");
  assert.equal(zOf("battle-board-art"), 0, "the board art stays at the back of the arena");
  // .arena が重ね合わせ文脈を作るので、arena より大きい z-index の要素は必ずボードより手前になる。
  for (const layer of ["battle-actor", "battle-controls", "battle-log-panel", "deck-out-banner", "turn-transition-banner"]) {
    const z = zOf(layer);
    assert.ok(Number.isFinite(z), `${layer} must declare a z-index`);
    assert.ok(z > arena, `${layer} (z-index ${z}) must sit in front of the board layer (arena z-index ${arena})`);
  }
});

test("a speaker caption reserves two lines so a long line is never cut", () => {
  const line = rulesFor("battle-actor-line")[0] ?? "";
  const clamp = /-webkit-line-clamp:\s*(\d+)/.exec(line);
  const minHeight = /min-height:\s*(\d+)px/.exec(line);
  const lineHeight = /line-height:\s*(\d+)px/.exec(line);
  assert.ok(clamp && Number(clamp[1]) === 2, "the caption shows up to two lines");
  assert.ok(minHeight && lineHeight, "the caption reserves its height explicitly");
  assert.ok(Number(minHeight[1]) >= Number(lineHeight[1]) * 2, "the reserved height must hold both lines");
});
