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

test("the portrait and the speech share one persistent message window per side", () => {
  assert.ok(app.includes("function BattleMessageWindow("), "the window should be one replaceable component");
  assert.ok(app.includes('<BattleMessageWindow side="opponent"'), "the opponent needs a message window");
  assert.ok(app.includes('<BattleMessageWindow side="brother"'), "the brother needs a message window");
  assert.ok(app.includes('className="battle-message-face"'), "the face sits inside the window, not in its own frame");
  assert.ok(app.includes('className="battle-message-line"'), "the line sits inside the window, not in a bubble");
  // 台詞が無い間も枠が残るよう、テキストは条件レンダリングにしない。
  assert.ok(app.includes("{text ?? \"\"}"), "an absent line must leave the window standing with an empty line");
  assert.ok(styles.includes(".battle-message-face"), "the window needs a dedicated face column");
  assert.equal(app.includes("function BattlePortrait("), false, "the standalone portrait frame must be removed");
  assert.equal(app.includes("function BattleSpeechSlot("), false, "the standalone speech bubble slot must be removed");
  assert.equal(styles.includes(".battle-portrait"), false, "the standalone portrait styles must be removed");
  assert.equal(styles.includes(".battle-dialogue-group"), false, "the split dialogue group must be removed");
  assert.equal(app.includes('className="avatar"'), false, "the old circular leader icons must be removed");
});
