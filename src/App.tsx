import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  advanceBattle,
  advanceRun,
  createBattle,
  createDraft,
  createRun,
  evaluateDeck,
  getOpponentById,
  getCurrentOpponentId,
  generateOffer,
  isAdviceDue,
  isAceUnlocked,
  isRunComplete,
  markAdviceSkipped,
  resolveOffer,
  syncStage,
  type AdviceCategory,
  type BattleState,
  type Card,
  type ChildProfile,
  type DraftOffer,
  type DraftState,
  type OpponentDefinition,
  type RunState,
} from "@/src/core";

type Phase = "title" | "mode" | "character" | "opponent" | "draft" | "deck" | "ace" | "battle" | "clear";

interface SavedGame {
  version: 3;
  phase: Phase;
  draft: DraftState | null;
  offer: DraftOffer | null;
  adviceOpen: boolean;
  battle: BattleState | null;
  run: RunState;
  aceCardId?: string | null;
}

/** Transient answer-check line shown after the player rules on a passive intervention. Not persisted. */
interface KidReaction {
  tone: "support" | "reject";
  text: string;
}

interface SyncStageLabel {
  minimum: number;
  label: string;
}

interface SyncNotice {
  stage: number;
  label: string;
}

const SAVE_KEY = "oredeck-prototype-v2";
const LADDER_OPPONENT_IDS = ["rush", "wall", "boss"];

function createDefaultSave(initialSync = 0): SavedGame {
  return { version: 3, phase: "title", draft: null, offer: null, adviceOpen: false, battle: null, run: createRun(LADDER_OPPONENT_IDS, initialSync), aceCardId: null };
}

const defaultSave = createDefaultSave();

function isSavedGame(value: unknown): value is SavedGame {
  if (!value || typeof value !== "object") return false;
  const saved = value as Partial<SavedGame>;
  return saved.version === 3 && typeof saved.phase === "string" && Boolean(saved.run && Array.isArray(saved.run.opponentIds));
}

function loadSavedGame(raw: string | null): SavedGame | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSavedGame(parsed) ? { ...parsed, aceCardId: parsed.aceCardId ?? null } : null;
  } catch {
    return null;
  }
}

const categoryCopy: Record<AdviceCategory, { label: string; detail: string; icon: string }> = {
  removal: { label: "除去がほしい", detail: "相手の切り札をどかすカード", icon: "破" },
  guard: { label: "守護がほしい", detail: "攻撃を受け止めるモンスター", icon: "守" },
  low_cost: { label: "軽いカードがほしい", detail: "2コスト以下で早く動けるカード", icon: "軽" },
  skip: { label: "今は見送る", detail: "弟の選び方をそのまま続ける", icon: "続" },
};

const reasonCopy: Record<DraftOffer["decision"]["reason"], string> = {
  love: "見た瞬間に心を奪われた",
  monster: "モンスターだから",
  lower_cost: "先に出せるから",
  higher_attack: "攻撃力が高いから",
  aesthetic: "よりカッコいいから",
  first: "最初に見た方だから",
};

function effectText(card: Card): string {
  if (!card.effects.length) return "効果なし";
  return card.effects.map((effect) => {
    const words: Record<string, string> = { rush: "速攻", guard: "守護", damage: `ダメージ${effect.value}`, destroy: "破壊", buff: `強化+${effect.value}`, draw: `ドロー${effect.value}`, revive: "復活" };
    const triggers: Record<string, string> = { on_play: "登場時", on_destroyed: "破壊時", passive: "", aura: "常時" };
    return [triggers[effect.trigger], words[effect.keyword]].filter(Boolean).join("：");
  }).join(" / ");
}

function CardFace({ card, selected, intervention, compact = false }: { card: Card; selected?: boolean; intervention?: boolean; compact?: boolean }) {
  const aesthetic = card.aesthetic.C >= 3 ? "love" : card.aesthetic.C >= 2 ? "cool" : card.aesthetic.K >= 2 ? "cute" : "plain";
  return (
    <article className={`card-face ${aesthetic} ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}>
      {intervention && <span className="intervention-mark" title="兄ちゃんが選んだカード">兄</span>}
      <div className="card-topline"><span className="cost-gem">{card.cost}</span><span className="card-kind">{card.type === "monster" ? "MONSTER" : "SPELL"}</span></div>
      <div className="card-art" aria-hidden="true"><span>{card.name.slice(0, 1)}</span><i /></div>
      <h3>{card.name}</h3>
      <p className="effect-line">{effectText(card)}</p>
      {card.type === "monster" ? <div className="stats"><b>ATK {card.atk}</b><b>HP {card.hp}</b></div> : <div className="spell-stamp">ACTION</div>}
    </article>
  );
}

function syncStageLabel(sync: number, child: ChildProfile): string {
  const labels = (child.sync as ChildProfile["sync"] & { stageLabels?: SyncStageLabel[] }).stageLabels ?? [];
  return [...labels].filter((item) => sync >= item.minimum).sort((a, b) => a.minimum - b.minimum).at(-1)?.label ?? "シンクロ";
}

function SyncMeter({ sync, child }: { sync: number; child: ChildProfile }) {
  const stage = syncStage(sync, child);
  const stages = child.sync.stageMinimums.length;
  const label = syncStageLabel(sync, child);
  return (
    <div className={`sync-box stage-${stage}`} aria-label={`シンクロ状態：${label}`}>
      <span>ユウタとカードのシンクロ</span>
      <div className="sync-meter" aria-hidden="true">{Array.from({ length: stages }, (_, index) => index + 1).map((item) => <i key={item} className={item <= stage ? "on" : ""} />)}</div>
      <strong>{label}</strong>
    </div>
  );
}

function SyncStageBanner({ notice }: { notice: SyncNotice | null }) {
  if (!notice) return null;
  return <div className={`sync-stage-banner ${notice.stage === 5 ? "unlock" : ""}`} role="status"><span>SYNC UP!</span><strong>{notice.label}</strong>{notice.stage === 5 && <b>切り札解禁！！</b>}</div>;
}

function DeckMaterials({ draft, cards, small = false }: { draft: DraftState; cards: Card[]; small?: boolean }) {
  const data = evaluateDeck(draft.deck, cards);
  const maxCurve = Math.max(1, ...data.curve);
  return (
    <section className={`materials-panel ${small ? "small" : ""}`}>
      <div className="panel-heading"><span>DECK DATA</span><b>{data.size}/15</b></div>
      <div className="material-grid">
        <div><span>除去</span><strong>{data.removal}</strong><small>目安 2</small></div>
        <div><span>守護</span><strong>{data.guards}</strong><small>目安 2</small></div>
        <div><span>6コスト〜</span><strong>{data.heavy}</strong><small>目安 2以下</small></div>
        <div><span>〜2コスト</span><strong>{data.lowCost}</strong><small>目安 4</small></div>
      </div>
      {!small && <>
        <div className="substats"><span>平均コスト <b>{data.averageCost.toFixed(1)}</b></span><span>モンスター <b>{data.monsters}</b></span><span>スペル <b>{data.spells}</b></span></div>
        <div className="curve" aria-label="コスト分布">
          {data.curve.slice(1).map((value, index) => <div key={index}><i style={{ height: `${Math.max(4, value / maxCurve * 54)}px` }} /><span>{index === 7 ? "8+" : index + 1}</span></div>)}
        </div>
      </>}
    </section>
  );
}

function Speech({ speaker, text, tone = "kid" }: { speaker: string; text: string; tone?: "kid" | "rival" | "system" }) {
  return <div className={`speech ${tone}`}><span>{speaker}</span><p>{text}</p></div>;
}

function ReactionBanner({ reaction, speaker }: { reaction: KidReaction; speaker: string }) {
  return <div className={`kid-reaction ${reaction.tone}`} role="status">
    <b aria-hidden="true">{reaction.tone === "support" ? "！" : "…"}</b>
    <span>{speaker}</span>
    <p>{reaction.text}</p>
  </div>;
}

function ModeSelectScreen({ onSelect }: { onSelect: () => void }) {
  return <main className="mode-select-screen"><section className="mode-select-panel"><span className="section-kicker">SELECT MODE</span><h1>遊び方を選べ！</h1><button className="mode-card active" onClick={onSelect}><strong>アーケードモード</strong><span>3人の相手と連続バトル</span><b>START ▶</b></button></section></main>;
}

function CharacterSelectScreen({ onSelect }: { onSelect: () => void }) {
  return <main className="character-select-screen"><section className="character-select-panel"><span className="section-kicker">SELECT CHARACTER</span><h1>キャラクターを選べ！</h1><div className="character-grid">
    <button className="character-slot active" onClick={onSelect}><span className="character-portrait">ユ</span><strong>単純弟</strong><small>かっこいいカードが大好き。アグロ気質。</small><b>SELECT ▶</b></button>
    {[1, 2, 3].map((slot) => <div className="character-slot locked" key={slot}><span className="character-portrait">？</span><strong>？？？</strong><small>LOCKED</small></div>)}
  </div></section></main>;
}

function OpponentPreviewScreen({ opponent, battleNumber, onStart }: { opponent: OpponentDefinition; battleNumber: number; onStart: () => void }) {
  return <main className="opponent-preview-screen"><section className="opponent-preview-panel"><span className="section-kicker">BATTLE {battleNumber} / 3</span><h1>つぎの相手</h1><div className="opponent-preview-card" style={{ "--rival-color": opponent.color } as CSSProperties}><span className="opponent-mark">{opponent.title.slice(0, 1)}</span><small>{opponent.title}</small><strong>{opponent.name}</strong><p>{opponent.trait}</p></div><button className="primary-action" onClick={onStart}>デッキを組む！<span>▶</span></button></section></main>;
}

function DraftScreen({ draft, offer, cards, child, adviceOpen, reaction, syncNotice, onPick, onAuto, onAdvice }: {
  draft: DraftState;
  offer: DraftOffer | null;
  cards: Card[];
  child: ChildProfile;
  adviceOpen: boolean;
  reaction: KidReaction | null;
  syncNotice: SyncNotice | null;
  onPick: (index: 0 | 1) => void;
  onAuto: () => void;
  onAdvice: (category: AdviceCategory) => void;
}) {
  const dialogue = !offer ? "次のカード、どんなのかな！" : offer.decision.love ? child.dialogue.love[draft.pick % child.dialogue.love.length] : offer.wantsIntervention ? child.dialogue.ask[draft.pick % child.dialogue.ask.length] : `${offer.cards[offer.decision.preferredIndex].name}にする！ ${reasonCopy[offer.decision.reason]}！`;
  return (
    <main className="game-shell draft-screen">
      <header className="game-header"><div className="mini-logo">兄ちゃん！<b>俺のデッキ作って！</b></div><div className="pick-counter"><span>PICK</span><b>{String(draft.pick + 1).padStart(2, "0")}</b><em>/15</em></div><SyncMeter sync={draft.syncRate} child={child} /></header>
      {reaction && <ReactionBanner reaction={reaction} speaker={child.displayName} />}
      <SyncStageBanner notice={syncNotice} />
      <div className="draft-layout">
        <section className="choice-zone">
          <div className="versus-label"><span>どっちを入れる？</span>{offer?.source === "advice" && <b>兄ちゃんの注文ピック</b>}</div>
          {offer ? <div className="card-choice">
            {offer.cards.map((card, index) => (
              <button
                className={`card-choice-button ${offer.decision.love && index === offer.decision.preferredIndex ? "love-lock" : ""}`}
                key={`${card.id}-${index}`}
                disabled={!offer.wantsIntervention || offer.decision.love}
                onClick={() => onPick(index as 0 | 1)}
                aria-label={`${card.name}を選ぶ`}
              >
                {offer.decision.love && index === offer.decision.preferredIndex && <span className="love-ribbon">一目惚れ！変更不可</span>}
                <CardFace card={card} />
                {offer.wantsIntervention && !offer.decision.love && <span className="choose-label">こっちにする</span>}
              </button>
            ))}
            <div className="vs-burst">VS</div>
          </div> : <div className="loading-card">カードをシャッフル中…</div>}
          {offer && (!offer.wantsIntervention || offer.decision.love) && <button className="primary-action slam" onClick={onAuto}>{offer.decision.love ? "このカードで決定！" : "弟のピックを見届ける"}<span>▶</span></button>}
          <Speech speaker={child.displayName} text={dialogue} />
        </section>
        <aside><DeckMaterials draft={draft} cards={cards} /></aside>
      </div>
      {adviceOpen && <div className="modal-backdrop"><section className="advice-modal">
        <div className="advice-title"><span>兄ちゃん会議！</span><h2>デッキを見て、ひとこと注文しよう</h2><p>注文したカードも、このまま通常の1枠として入る。</p></div>
        <DeckMaterials draft={draft} cards={cards} small />
        <div className="advice-options">{child.advice.categories.map((category) => {
          const copy = categoryCopy[category];
          return <button key={category} onClick={() => onAdvice(category)} className={category === "skip" ? "skip" : ""}><b>{copy.icon}</b><span><strong>{copy.label}</strong><small>{copy.detail}</small></span></button>;
        })}</div>
      </section></div>}
    </main>
  );
}

function AceSelectionScreen({ draft, cards, selectedCardId, onSelect, onConfirm, onSkip }: { draft: DraftState; cards: Card[]; selectedCardId: string | null; onSelect: (cardId: string) => void; onConfirm: () => void; onSkip: () => void }) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return <main className="ace-selection-screen"><section className="ace-selection-panel"><span className="section-kicker">DESTINY DRAW / UNLOCKED</span><h1>切り札を選べ！！</h1><p className="ace-flavor">ここぞの一枚を、運命のドローに指定しろ！</p><div className="ace-deck-grid">{draft.deck.map((item) => { const card = byId.get(item.cardId)!; const selected = selectedCardId === item.cardId; return <button key={item.instanceId} className={`ace-card-option ${selected ? "selected" : ""}`} onClick={() => onSelect(item.cardId)} aria-pressed={selected}><CardFace card={card} selected={selected} /><span>{selected ? "切り札に指定中" : "この札を選ぶ"}</span></button>; })}</div><div className="ace-selection-actions"><button className="secondary-action" onClick={onSkip}>切り札なしで開始</button><button className="primary-action" onClick={onConfirm} disabled={!selectedCardId}>このカードで決定<span>▶</span></button></div></section></main>;
}

function DeckScreen({ draft, cards, child, reaction, onBattle }: { draft: DraftState; cards: Card[]; child: ChildProfile; reaction: KidReaction | null; onBattle: () => void }) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return <main className="game-shell deck-screen">
    <header className="game-header"><div className="mini-logo">デッキ完成！<b>答え合わせへ</b></div><div className="completion-stamp">15 CARDS</div></header>
    {reaction && <ReactionBanner reaction={reaction} speaker={child.displayName} />}
    <div className="deck-review-grid">
      <section className="deck-list-panel"><div className="section-kicker">YOUR DECK</div><h1>ユウタのデッキ</h1><div className="deck-list">{draft.deck.map((item, index) => { const card = byId.get(item.cardId)!; return <div key={item.instanceId} className="deck-row"><span className="deck-number">{String(index + 1).padStart(2, "0")}</span><span className="mini-cost">{card.cost}</span><strong>{card.name}</strong><small>{effectText(card)}</small>{item.intervention && <b className="brother-tag">兄ちゃん</b>}</div>; })}</div></section>
      <aside><DeckMaterials draft={draft} cards={cards} /><div className="no-verdict"><b>勝てそう？</b><span>数字は材料。答えは対戦で確かめよう。</span></div></aside>
    </div>
    <section className="deck-action"><button className="primary-action battle-start" onClick={onBattle}>この相手とバトル！<span>▶</span></button></section>
  </main>;
}

function BoardCard({ instance, cards, ace = false }: { instance: BattleState["brother"]["board"][number]; cards: Card[]; ace?: boolean }) {
  const card = cards.find((item) => item.id === instance.cardId)!;
  const syncBonus = instance.grantedKeywords.length > 0 || instance.grantedAtk > 0;
  return <div className={`board-card ${instance.intervention ? "intervened" : ""} ${syncBonus && !ace ? "sync-granted" : ""} ${ace ? "ace-granted" : ""}`} title={card.name}>{instance.intervention && <span className="intervention-mark">兄</span>}{syncBonus && !ace && <span className="sync-mark">SYNC</span>}{ace && <span className="ace-mark">ACE</span>}<b>{card.name.slice(0, 1)}</b><small>{card.name}</small><div><span>{instance.atk}</span><span>{instance.hp}</span></div></div>;
}

function BattleHandCard({ instance, cards, ace }: { instance: BattleState["brother"]["hand"][number]; cards: Card[]; ace?: boolean }) {
  const card = cards.find((item) => item.id === instance.cardId)!;
  const syncBonus = instance.grantedKeywords.length > 0 || instance.grantedAtk > 0;
  return <div className={`hand-card ${syncBonus && !ace ? "sync-granted" : ""} ${ace ? "ace-granted" : ""}`}><CardFace compact card={card} intervention={instance.intervention} />{syncBonus && !ace && <span className="sync-mark">SYNC</span>}{ace && <span className="ace-mark">ACE</span>}</div>;
}

function AceStatus({ battle, cards }: { battle: BattleState; cards: Card[] }) {
  if (!battle.brother.aceUsed && !battle.brother.aceCard) return null;
  const aceEvent = [...battle.events].reverse().find((item) => item.type === "ace");
  const cardId = battle.brother.aceCard?.cardId ?? aceEvent?.cardId;
  const card = cardId ? cards.find((item) => item.id === cardId) : undefined;
  return <div className={`ace-status ${battle.brother.aceUsed ? "used" : "ready"}`}><span>切り札</span>{battle.brother.aceUsed ? <strong>発動済み</strong> : <><strong>{card?.name ?? "指定札"}</strong><small>待機中</small></>}</div>;
}

function BattleScreen({ battle, cards, opponent, onNext, onAuto, auto, onFinish, finalBattle }: { battle: BattleState; cards: Card[]; opponent: OpponentDefinition; onNext: () => void; onAuto: () => void; auto: boolean; onFinish: () => void; finalBattle: boolean }) {
  const dialogueEvent = [...battle.events].reverse().find((item) => item.dialogue);
  const aceEvent = [...battle.events].reverse().find((item) => item.type === "ace");
  const syncEvent = [...battle.events].reverse().find((item) => item.type === "sync_bonus");
  const recent = battle.events.slice(-9);
  for (const importantEvent of [syncEvent, aceEvent]) {
    if (importantEvent && !recent.some((item) => item.id === importantEvent.id)) recent.push(importantEvent);
  }
  recent.reverse();
  const aceInstanceId = aceEvent?.instanceId;
  const [shownAceEventId, setShownAceEventId] = useState<string | null>(null);
  const [showAceBanner, setShowAceBanner] = useState(false);
  useEffect(() => {
    if (!aceEvent || aceEvent.id === shownAceEventId) return;
    setShownAceEventId(aceEvent.id);
    setShowAceBanner(true);
    const timer = window.setTimeout(() => setShowAceBanner(false), 1900);
    return () => window.clearTimeout(timer);
  }, [aceEvent, shownAceEventId]);
  return <main className="battle-screen">
    <header className="battle-header"><div><span>{opponent.title}</span><strong>{opponent.name}</strong></div><div className="battle-turn">TURN <b>{battle.turn}</b></div><div className="brother-name"><span>単純弟</span><strong>ユウタ</strong></div></header>
    <AceStatus battle={battle} cards={cards} />
    {showAceBanner && <div className="ace-reaction-banner" role="status"><span>DESTINY DRAW</span><strong>ディスティニードロー！！</strong><small>{aceEvent?.text}</small></div>}
    <section className="arena">
      <div className="fighter opponent-fighter"><div className="avatar" style={{ "--rival-color": opponent.color } as CSSProperties}>{opponent.name.slice(0, 1)}</div><div className="life"><span>LIFE</span><b>{battle.opponent.life}</b></div><div className="pp">PP {battle.opponent.pp}/{battle.opponent.maxPp}</div></div>
      <div className="board-zone opponent-board">{battle.opponent.board.map((item) => <BoardCard key={item.instanceId} instance={item} cards={cards} />)}{!battle.opponent.board.length && <span className="empty-board">相手の場は空</span>}</div>
      <div className="board-line"><b>AUTO CARD BATTLE</b></div>
      <div className="board-zone brother-board">{battle.brother.board.map((item) => <BoardCard key={item.instanceId} instance={item} cards={cards} ace={item.instanceId === aceInstanceId} />)}{!battle.brother.board.length && <span className="empty-board">ユウタの場は空</span>}</div>
      <div className="fighter brother-fighter"><div className="avatar kid">ユ</div><div className="life"><span>LIFE</span><b>{battle.brother.life}</b></div><div className="pp">PP {battle.brother.pp}/{battle.brother.maxPp}</div></div>
      <div className="hand-zone">{battle.brother.hand.map((item) => <BattleHandCard key={item.instanceId} instance={item} cards={cards} ace={item.instanceId === aceInstanceId} />)}</div>
    </section>
    <aside className="battle-log"><div className="panel-heading"><span>BATTLE LOG</span><b>LIVE</b></div>{recent.map((item) => <p key={item.id} className={item.type === "attribution" ? "highlight" : item.type === "sync_bonus" ? "sync-event" : item.type === "ace" ? "ace-event" : ""}><span>{item.side === "brother" ? "ユウタ" : opponent.name}</span>{item.text}</p>)}</aside>
    {dialogueEvent && !battle.winner && <div className="battle-speech"><Speech speaker={dialogueEvent.side === "brother" ? "ユウタ" : opponent.name} text={dialogueEvent.dialogue!} tone={dialogueEvent.side === "brother" ? "kid" : "rival"} /></div>}
    {!battle.winner && <div className="battle-controls"><button onClick={onNext} disabled={auto}>1ターン進める</button><button className="primary-action" onClick={onAuto}>{auto ? "自動再生中…" : "最後まで見る"}<span>▶</span></button></div>}
    {battle.winner && <div className="result-overlay"><div className={`result-burst ${battle.winner === "brother" ? "win" : "lose"}`}><span>{battle.winner === "brother" ? "VICTORY!" : battle.winner === "draw" ? "DRAW" : "DEFEAT"}</span><h1>{battle.winner === "brother" ? "ユウタの勝利！" : battle.winner === "draw" ? "引き分け！" : `${opponent.name}の勝利！`}</h1><p>{battle.winner === "brother" ? "デッキは狙い通りに仕事をしただろうか？" : "次の相手とのバトルへ進もう。"}</p><button className="primary-action" onClick={onFinish}>{finalBattle ? "結果を見る" : "次の相手へ"}<span>▶</span></button></div></div>}
  </main>;
}

function ClearScreen({ run, cards, child, opponents, onTitle }: { run: RunState; cards: Card[]; child: ChildProfile; opponents: OpponentDefinition[]; onTitle: () => void }) {
  const opponentById = new Map(opponents.map((opponent) => [opponent.id, opponent]));
  return <main className="clear-screen"><section className="clear-panel"><span className="section-kicker">ARCADE CLEAR</span><h1>3戦完走！</h1><section className="run-results"><h2>バトルの記録</h2>{run.battleResults.map((result, index) => <div className="run-result-row" key={`${result.opponentId}-${index}`}><span>{index + 1}戦目</span><strong className={result.outcome}>{result.outcome === "win" ? "○" : result.outcome === "loss" ? "×" : "△"}</strong><b>{opponentById.get(result.opponentId)?.name ?? result.opponentId}</b></div>)}</section><section className="run-facts"><div className="run-fact"><span>受動介入</span><strong>{run.summary.passiveInterventions}回</strong><small>支持 {run.summary.passiveSupports} / 却下 {run.summary.passiveRejects}</small></div><div className="run-fact"><span>一目惚れで入った札</span>{run.summary.loveCardIds.length ? <ul>{run.summary.loveCardIds.map((cardId, index) => <li key={`${cardId}-${index}`}>{cards.find((card) => card.id === cardId)?.name ?? cardId}</li>)}</ul> : <strong>なし</strong>}</div><div className="run-fact"><span>最後のシンクロ状態</span><strong>{syncStageLabel(run.summary.finalSync, child)}</strong></div></section><button className="primary-action" onClick={onTitle}>タイトルへ<span>↻</span></button></section></main>;
}

export default function Home() {
  const [cards, setCards] = useState<Card[]>([]);
  const [child, setChild] = useState<ChildProfile | null>(null);
  const [opponents, setOpponents] = useState<OpponentDefinition[]>([]);
  const [game, setGame] = useState<SavedGame>(defaultSave);
  const [hydrated, setHydrated] = useState(false);
  const [autoBattle, setAutoBattle] = useState(false);
  const [reaction, setReaction] = useState<KidReaction | null>(null);
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null);

  useEffect(() => {
    Promise.all([fetch("./data/cards.json").then((response) => response.json()), fetch("./data/children/tanjun.json").then((response) => response.json()), fetch("./data/opponents.json").then((response) => response.json())])
      .then(([cardData, childData, opponentData]) => { setCards(cardData); setChild(childData); setOpponents(opponentData); setGame(loadSavedGame(localStorage.getItem(SAVE_KEY)) ?? createDefaultSave(childData.sync.initial)); setHydrated(true); });
  }, []);

  useEffect(() => { if (hydrated) localStorage.setItem(SAVE_KEY, JSON.stringify(game)); }, [game, hydrated]);

  useEffect(() => {
    if (!autoBattle || !game.battle || game.battle.winner || !child) { if (game.battle?.winner) setAutoBattle(false); return; }
    const timer = window.setTimeout(() => setGame((current) => {
      if (!current.battle) return current;
      const opponentId = getCurrentOpponentId(current.run);
      const opponent = opponentId ? getOpponentById(opponents, opponentId) : undefined;
      return opponent ? { ...current, battle: advanceBattle(current.battle, cards, child, opponent) } : current;
    }), 520);
    return () => window.clearTimeout(timer);
  }, [autoBattle, game.battle, game.run, cards, child, opponents]);

  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);

  function nextNormalOffer(draft: DraftState): SavedGame {
    if (!child) return game;
    if (draft.pick >= 15) return { ...game, phase: "deck", draft, offer: null, adviceOpen: false };
    if (isAdviceDue(draft, child)) return { ...game, phase: "draft", draft, offer: null, adviceOpen: true };
    const generated = generateOffer(draft, cards, child);
    return { ...game, phase: "draft", draft: generated.state, offer: generated.offer, adviceOpen: false, battle: null };
  }

  function beginArcade() {
    if (!child) return;
    setAutoBattle(false);
    setReaction(null);
    setSyncNotice(null);
    setGame({ ...createDefaultSave(child.sync.initial), phase: "mode" });
  }

  function selectMode() {
    setGame((current) => ({ ...current, phase: "character" }));
  }

  function selectCharacter() {
    setGame((current) => ({ ...current, phase: "opponent" }));
  }

  function startDraft() {
    if (!child || !getCurrentOpponentId(game.run)) return;
    setReaction(null);
    setSyncNotice(null);
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const draft = createDraft(seed, child, game.run.carrySync);
    const generated = generateOffer(draft, cards, child);
    setGame({ ...game, phase: "draft", draft: generated.state, offer: generated.offer, adviceOpen: false, battle: null });
  }

  function takePick(index?: 0 | 1) {
    if (!game.draft || !game.offer || !child) return;
    const offer = game.offer;
    const ruled = offer.source === "normal" && offer.wantsIntervention && !offer.decision.love && index !== undefined;
    if (ruled) {
      const supported = index === offer.decision.preferredIndex;
      const lines = supported ? child.dialogue.support : child.dialogue.reject;
      setReaction({ tone: supported ? "support" : "reject", text: lines[game.draft.pick % lines.length] });
    } else {
      setReaction(null);
    }
    const beforeStage = syncStage(game.draft.syncRate, child);
    const next = resolveOffer(game.draft, game.offer, child, index);
    const nextStage = syncStage(next.syncRate, child);
    setSyncNotice(nextStage > beforeStage ? { stage: nextStage, label: syncStageLabel(next.syncRate, child) } : null);
    setGame(nextNormalOffer(next));
  }

  function chooseAdvice(category: AdviceCategory) {
    if (!game.draft || !child) return;
    setReaction(null);
    if (category === "skip") { const next = markAdviceSkipped(game.draft); const generated = generateOffer(next, cards, child); setGame({ ...game, draft: generated.state, offer: generated.offer, adviceOpen: false }); return; }
    const generated = generateOffer(game.draft, cards, child, category);
    setGame({ ...game, draft: generated.state, offer: generated.offer, adviceOpen: false });
  }

  function prepareBattle() {
    if (!game.draft || !child) return;
    if (isAceUnlocked(game.draft.syncRate, child)) {
      setGame({ ...game, phase: "ace", aceCardId: null });
      return;
    }
    startBattle(null);
  }

  function selectAceCard(cardId: string) {
    setGame((current) => ({ ...current, aceCardId: cardId }));
  }

  function startBattle(aceCardId: string | null = game.aceCardId ?? null) {
    if (!game.draft || !child) return;
    setReaction(null);
    setSyncNotice(null);
    const opponentId = getCurrentOpponentId(game.run);
    const opponent = opponentId ? getOpponentById(opponents, opponentId) : undefined;
    if (!opponent) return;
    const battle = createBattle(game.draft.deck, opponent, cards, game.draft.seed ^ 0xa5a5a5a5, game.draft.syncRate, aceCardId);
    setGame({ ...game, phase: "battle", battle, aceCardId });
  }

  function finishBattle() {
    if (!game.draft || !game.battle?.winner || !child) return;
    const nextRun = advanceRun(game.run, game.draft, game.battle.winner, child);
    setAutoBattle(false);
    setGame({ ...game, phase: isRunComplete(nextRun) ? "clear" : "opponent", draft: null, offer: null, adviceOpen: false, battle: null, run: nextRun, aceCardId: null });
  }

  function returnToTitle() {
    if (!child) return;
    setAutoBattle(false);
    setReaction(null);
    setSyncNotice(null);
    setGame(createDefaultSave(child.sync.initial));
  }

  if (!hydrated || !child || cards.length !== 40 || opponents.length === 0) return <main className="boot-screen"><div className="logo-burst"><span>NOW LOADING</span><b>カードをまぜてるぞ！</b></div></main>;
  if (game.phase === "title") return <main className="title-screen"><div className="halftone" /><section className="title-copy"><span className="prototype-label">DECK BUILD SUPPORT GAME / PROTOTYPE</span><h1><small>兄ちゃん！</small>俺のデッキ<br />作って！</h1><p>好きなカードは、変えたくない。<br /><b>だから兄ちゃん、勝てる形にしてくれよ！</b></p><button className="primary-action title-start" onClick={beginArcade}>ゲームを始める！<span>▶</span></button><div className="save-note">途中経過はこのブラウザに自動保存</div></section><section className="title-cards"><div className="tilted-card one"><CardFace card={byId.get("zexvain")!} /></div><div className="tilted-card two"><CardFace card={byId.get("dolguard")!} intervention /></div><div className="title-shout">「カッコいい」で<br />勝ちたいんだ！</div></section><footer>15 PICKS · 2 ADVICES · 1 AUTO BATTLE</footer></main>;
  if (game.phase === "mode") return <ModeSelectScreen onSelect={selectMode} />;
  if (game.phase === "character") return <CharacterSelectScreen onSelect={selectCharacter} />;
  const currentOpponentId = getCurrentOpponentId(game.run);
  const currentOpponent = currentOpponentId ? getOpponentById(opponents, currentOpponentId) : undefined;
  if (game.phase === "opponent" && currentOpponent) return <OpponentPreviewScreen opponent={currentOpponent} battleNumber={game.run.currentBattle + 1} onStart={startDraft} />;
  if (game.phase === "draft" && game.draft) return <DraftScreen draft={game.draft} offer={game.offer} cards={cards} child={child} adviceOpen={game.adviceOpen} reaction={reaction} syncNotice={syncNotice} onPick={takePick} onAuto={() => takePick()} onAdvice={chooseAdvice} />;
  if (game.phase === "deck" && game.draft) return <DeckScreen draft={game.draft} cards={cards} child={child} reaction={reaction} onBattle={prepareBattle} />;
  if (game.phase === "ace" && game.draft) return <AceSelectionScreen draft={game.draft} cards={cards} selectedCardId={game.aceCardId ?? null} onSelect={selectAceCard} onConfirm={() => startBattle()} onSkip={() => startBattle(null)} />;
  if (game.phase === "battle" && game.battle && currentOpponent) return <BattleScreen battle={game.battle} cards={cards} opponent={currentOpponent} onNext={() => setGame({ ...game, battle: advanceBattle(game.battle!, cards, child, currentOpponent) })} onAuto={() => setAutoBattle(true)} auto={autoBattle} onFinish={finishBattle} finalBattle={game.run.currentBattle === game.run.opponentIds.length - 1} />;
  if (game.phase === "clear") return <ClearScreen run={game.run} cards={cards} child={child} opponents={opponents} onTitle={returnToTitle} />;
  return <main className="boot-screen"><button className="primary-action" onClick={returnToTitle}>タイトルへ</button></main>;
}
