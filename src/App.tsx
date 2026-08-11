import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import handImage from "./assets/characters/tanjun-hand-open.png";
import tanjunBustSmile from "./assets/characters/tanjun-bust-smile.png";
import {
  advanceBattle,
  advanceRun,
  createBattle,
  createDraft,
  createLadderRun,
  evaluateDeck,
  getOpponentById,
  getCurrentOpponentId,
  instanceHasKeyword,
  generateOffer,
  isAdviceDue,
  isAceUnlocked,
  isRunComplete,
  activeAdviceFocus,
  applyAdvice,
  resolveOffer,
  syncStage,
  SPECIES_ORDER,
  countSpeciesTypes,
  synergyStageFor,
  type ActiveSpeciesSynergy,
  type AdviceCategory,
  type BattleEvent,
  type BattleEventType,
  type BattleCardInstance,
  type BattleState,
  type Card,
  type ChildProfile,
  type DraftOffer,
  type DraftState,
  type OpponentDefinition,
  type RunState,
  type Species,
  type SpeciesSynergyConfig,
} from "@/src/core";

type Phase = "title" | "mode" | "character" | "opponent" | "draft" | "deck" | "ace" | "battle" | "clear";

interface SavedGame {
  version: 5;
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

/**
 * Transient glow shown on the card the kid just took and on the sync meter.
 * "soft" is the kid picking on his own, "burst" is the player reading him correctly.
 * Deliberately independent of the battle playback speed setting.
 */
interface PickFlash {
  strength: "soft" | "burst";
  index: 0 | 1;
  duration?: number;
  /** Set only for picks the kid made himself; rulings stay hand-free. */
  hand?: { style: HandStyle; timing: HandTiming };
}

const PICK_FLASH_MS: Record<PickFlash["strength"], number> = { soft: 420, burst: 700 };

/**
 * The kid's hand snatching a card he picked himself, karuta style.
 * "carry" takes the card off the bottom of the screen; "cut" drops hand and card together.
 */
type HandStyle = "carry" | "cut";

interface HandTiming {
  reach: number;
  hold: number;
  exit: number;
}

const HAND_TIMING: Record<PlaybackSpeed, Record<HandStyle, HandTiming>> = {
  // 判定済み・再調整: じっくりは伸び350ms / 止め550ms / 抜け550ms。さくさくは全時間を半減。
  normal: { carry: { reach: 350, hold: 550, exit: 550 }, cut: { reach: 350, hold: 550, exit: 150 } },
  fast: { carry: { reach: 175, hold: 275, exit: 275 }, cut: { reach: 175, hold: 275, exit: 75 } },
  skip: { carry: { reach: 0, hold: 0, exit: 0 }, cut: { reach: 0, hold: 0, exit: 0 } },
};

// carry is the finalized default. The cut renderer remains available for a later presentation pass.
const DEFAULT_HAND_STYLE: HandStyle = "carry";

function handTotal(timing: HandTiming): number {
  return timing.reach + timing.hold + timing.exit;
}

// 横長専用。設計原寸は 1280x720 で、これを下回る横長ビューポートでは
// 舞台の大きさを保ったまま縮小する。レイアウトが組み替わらないので、
// 画面ごとの縦積みフォールバックを持たなくてよい。
const STAGE_WIDTH = 1280;
const STAGE_HEIGHT = 720;

function useLandscapeStage() {
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      // 縦長のときはCSS側が案内へ差し替えるので、寸法計算はしない。
      if (viewportHeight > viewportWidth) return;
      const scale = Math.min(viewportWidth / STAGE_WIDTH, viewportHeight / STAGE_HEIGHT, 1);
      const width = scale < 1 ? STAGE_WIDTH : viewportWidth;
      const height = scale < 1 ? STAGE_HEIGHT : viewportHeight;
      root.style.setProperty("--stage-w", `${width}px`);
      root.style.setProperty("--stage-h", `${height}px`);
      root.style.setProperty("--stage-scale", `${scale}`);
      root.style.setProperty("--stage-vw", `${width / 100}px`);
      root.style.setProperty("--stage-vh", `${height / 100}px`);
    };
    apply();
    window.addEventListener("resize", apply);
    window.addEventListener("orientationchange", apply);
    return () => {
      window.removeEventListener("resize", apply);
      window.removeEventListener("orientationchange", apply);
    };
  }, []);
}

function RotateNotice() {
  return (
    <div className="rotate-notice">
      <div className="rotate-icon"><i /><b>↻</b></div>
      <strong>このゲームは横画面専用です。<br />端末を横にしてください</strong>
      <small>横向きにすると、そのまま続きから始まります</small>
    </div>
  );
}

interface SyncNotice {
  stage: number;
  label: string;
}

type PlaybackSpeed = "normal" | "fast" | "skip";
type CutInKind = "ace" | "finisher";
type AutoPickPhase = "mulling" | "deciding" | "confirming";

interface BuildPickTiming {
  mulling: number;
  mullingPause: number;
  decision: number;
  confirm: number;
}

const BUILD_PICK_TIMING: Record<PlaybackSpeed, BuildPickTiming> = {
  normal: { mulling: 1100, mullingPause: 450, decision: 900, confirm: 550 },
  fast: { mulling: 500, mullingPause: 250, decision: 500, confirm: 250 },
  skip: { mulling: 0, mullingPause: 0, decision: 0, confirm: 0 },
};

interface EventPlaybackTiming {
  normal: number;
  fast: number;
  skip: number;
  attackPrelude?: Record<PlaybackSpeed, number>;
  attackAfterglow?: Record<PlaybackSpeed, number>;
  attackReach?: Record<PlaybackSpeed, string>;
  attackLeaderReach?: Record<PlaybackSpeed, string>;
  attackOverlap?: Record<PlaybackSpeed, string>;
  attackKnockback?: Record<PlaybackSpeed, string>;
  attackShake?: Record<PlaybackSpeed, string>;
  summonPrelude?: Record<PlaybackSpeed, number>;
  guardIntercept?: Record<PlaybackSpeed, number>;
  guardInterceptDistance?: Record<PlaybackSpeed, string>;
  leaderShake?: Record<PlaybackSpeed, string>;
  attackImpactSize?: Record<PlaybackSpeed, string>;
  turnBanner?: Record<PlaybackSpeed, number>;
  visual?: Record<PlaybackSpeed, number>;
  cutIn?: Record<PlaybackSpeed, { before: number; hold: number; after: number }>;
}

const PLAYBACK_SPEED_KEY = "oredeck-battle-playback-speed";
const PLAYBACK_SPEED_LABELS: Record<PlaybackSpeed, string> = { normal: "じっくり", fast: "さくさく", skip: "スキップ" };
// Keep the internal keys stable for localStorage compatibility: normal is rich pacing, fast is quick pacing.
const EVENT_PLAYBACK_TIMING: Record<BattleEventType, EventPlaybackTiming> = {
  turn: { normal: 200, fast: 130, skip: 70, turnBanner: { normal: 700, fast: 0, skip: 0 } },
  draw: { normal: 340, fast: 210, skip: 70 },
  play: { normal: 480, fast: 290, skip: 80, summonPrelude: { normal: 300, fast: 0, skip: 0 }, visual: { normal: 480, fast: 290, skip: 120 } },
  effect: { normal: 420, fast: 260, skip: 80, visual: { normal: 420, fast: 260, skip: 100 } },
  attack: {
    normal: 600,
    fast: 380,
    skip: 90,
    attackPrelude: { normal: 150, fast: 0, skip: 0 },
    attackAfterglow: { normal: 180, fast: 0, skip: 0 },
    attackReach: { normal: "clamp(270px, 38vh, 380px)", fast: "clamp(180px, 26vh, 260px)", skip: "0px" },
    attackLeaderReach: { normal: "clamp(360px, 48vh, 500px)", fast: "clamp(180px, 26vh, 260px)", skip: "0px" },
    attackOverlap: { normal: "28px", fast: "0px", skip: "0px" },
    attackKnockback: { normal: "34px", fast: "20px", skip: "0px" },
    attackShake: { normal: "10px", fast: "5px", skip: "0px" },
    guardIntercept: { normal: 220, fast: 110, skip: 0 },
    guardInterceptDistance: { normal: "36px", fast: "15px", skip: "0px" },
    leaderShake: { normal: "12px", fast: "5px", skip: "0px" },
    attackImpactSize: { normal: "clamp(150px, 20vw, 240px)", fast: "clamp(115px, 16vw, 190px)", skip: "100px" },
    visual: { normal: 600, fast: 380, skip: 140 },
  },
  destroyed: { normal: 450, fast: 260, skip: 80, visual: { normal: 450, fast: 260, skip: 100 } },
  attribution: { normal: 1400, fast: 550, skip: 100 },
  taunt: { normal: 1100, fast: 450, skip: 100 },
  result: {
    normal: 900,
    fast: 500,
    skip: 500,
    cutIn: {
      normal: { before: 100, hold: 1000, after: 300 },
      fast: { before: 100, hold: 650, after: 300 },
      skip: { before: 50, hold: 400, after: 50 },
    },
  },
  sync_bonus: { normal: 900, fast: 450, skip: 100, visual: { normal: 800, fast: 400, skip: 140 } },
  heal: { normal: 480, fast: 260, skip: 80, visual: { normal: 480, fast: 260, skip: 100 } },
  ace: {
    normal: 1200,
    fast: 700,
    skip: 500,
    visual: { normal: 900, fast: 600, skip: 260 },
    cutIn: {
      normal: { before: 100, hold: 1000, after: 300 },
      fast: { before: 100, hold: 650, after: 300 },
      skip: { before: 50, hold: 400, after: 50 },
    },
  },
};

function loadPlaybackSpeed(): PlaybackSpeed {
  if (typeof window === "undefined") return "normal";
  const saved = window.localStorage.getItem(PLAYBACK_SPEED_KEY);
  return saved === "normal" || saved === "fast" || saved === "skip" ? saved : "normal";
}

const SAVE_KEY = "oredeck-prototype-v2";

function createDefaultSave(initialSync = 0, seed = 0): SavedGame {
  return { version: 5, phase: "title", draft: null, offer: null, adviceOpen: false, battle: null, run: createLadderRun(seed, initialSync), aceCardId: null };
}

const defaultSave = createDefaultSave();

function isSavedGame(value: unknown): value is SavedGame {
  if (!value || typeof value !== "object") return false;
  const saved = value as Partial<SavedGame>;
  return saved.version === 5 && typeof saved.phase === "string" && Boolean(saved.run && Array.isArray(saved.run.opponentIds) && saved.run.opponentIds.length === 6);
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

const categoryCopy: Record<Exclude<AdviceCategory, "skip">, { label: string; detail: string; icon: string }> = {
  species: { label: "種族を狙う", detail: "狙う種族のカードを集める", icon: "種" },
  spell: { label: "呪文をとったら？", detail: "スペル全般を集める", icon: "呪" },
  low_cost: { label: "出しやすいのをとったら？", detail: "コスト2以下を集める", icon: "軽" },
  high_cost: { label: "強いのをとったら？", detail: "コスト5以上を集める", icon: "強" },
};

/** Kept as data for future screens. The kid's own picks deliberately state no reason. */
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
    const words: Record<string, string> = { rush: "速攻", guard: "守護", damage: `ダメージ${effect.value}`, destroy: "破壊", buff: `強化+${effect.value}`, draw: `ドロー${effect.value}`, revive: "復活", heal: `回復${effect.value}` };
    const triggers: Record<string, string> = { on_play: "登場時", on_destroyed: "破壊時", passive: "", aura: "常時" };
    return [triggers[effect.trigger], words[effect.keyword]].filter(Boolean).join("：");
  }).join(" / ");
}

type VisibleKeyword = "guard" | "rush" | "revive";

const VISIBLE_KEYWORD_META: Record<VisibleKeyword, { label: string; symbol: string }> = {
  guard: { label: "守護", symbol: "盾" },
  rush: { label: "速攻", symbol: "↯" },
  revive: { label: "復活", symbol: "↻" },
};

const VISIBLE_KEYWORD_ORDER: VisibleKeyword[] = ["guard", "rush", "revive"];

function cardVisibleKeywords(card: Card): VisibleKeyword[] {
  return VISIBLE_KEYWORD_ORDER.filter((keyword) => card.effects.some((effect) => effect.keyword === keyword));
}

function instanceVisibleKeywords(instance: BattleCardInstance, cards: Card[]): VisibleKeyword[] {
  return VISIBLE_KEYWORD_ORDER.filter((keyword) => instanceHasKeyword(instance, cards, keyword));
}

function KeywordBadges({ keywords, compact = false }: { keywords: VisibleKeyword[]; compact?: boolean }) {
  const visible = [...new Set(keywords)].slice(0, 3);
  if (!visible.length) return null;
  return <div className={`keyword-badges ${compact ? "compact" : ""}`} aria-label={`キーワード: ${visible.map((keyword) => VISIBLE_KEYWORD_META[keyword].label).join("・")}`}>{visible.map((keyword) => { const meta = VISIBLE_KEYWORD_META[keyword]; return <span key={keyword} className={`keyword-badge keyword-${keyword}`} title={meta.label} aria-label={meta.label}><i aria-hidden="true">{meta.symbol}</i><b>{meta.label}</b></span>; })}</div>;
}

function CardFace({ card, selected, intervention, compact = false, keywords }: { card: Card; selected?: boolean; intervention?: boolean; compact?: boolean; keywords?: VisibleKeyword[] }) {
  const aesthetic = card.aesthetic.C >= 3 ? "rare-aura" : card.aesthetic.C >= 2 ? "cool" : card.aesthetic.K >= 2 ? "cute" : "plain";
  const visibleKeywords = keywords ?? cardVisibleKeywords(card);
  return (
    <article className={`card-face ${aesthetic} ${selected ? "selected" : ""} ${compact ? "compact" : ""} ${visibleKeywords.length ? "has-keywords" : ""}`}>
      {intervention && <span className="intervention-mark" title="兄ちゃんが選んだカード">兄</span>}
      {card.species && <span className="species-tag" title={`種族：${card.species}`}>{card.species}</span>}
      <div className="card-topline"><span className="cost-gem">{card.cost}</span><span className="card-kind">{card.type === "monster" ? "MONSTER" : "SPELL"}</span></div>
      <div className="card-art" aria-hidden="true"><span>{card.name.slice(0, 1)}</span><i /></div>
      <h3>{card.name}</h3>
      <p className="effect-line">{effectText(card)}</p>
      {card.type === "monster" ? <div className="stats"><b>ATK {card.atk}</b><b>HP {card.hp}</b></div> : <div className="spell-stamp">ACTION</div>}
      <KeywordBadges keywords={visibleKeywords} compact={compact} />
    </article>
  );
}

function syncStageLabel(sync: number, child: ChildProfile): string {
  const labels = child.sync.stageLabels ?? [];
  return [...labels].filter((item) => sync >= item.minimum).sort((a, b) => a.minimum - b.minimum).at(-1)?.label ?? "シンクロ";
}

function SyncMeter({ sync, child, flash = null }: { sync: number; child: ChildProfile; flash?: PickFlash | null }) {
  const stage = syncStage(sync, child);
  const stages = child.sync.stageMinimums.length;
  const label = syncStageLabel(sync, child);
  return (
    <div className={`sync-box stage-${stage} ${flash ? `sync-flash-${flash.strength}` : ""}`} aria-label={`シンクロ状態：${label}`}>
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

function handStyleVars(timing: HandTiming): Record<string, string> {
  return {
    "--hand-reach": `${timing.reach}ms`,
    "--hand-exit": `${timing.exit}ms`,
    "--hand-exit-delay": `${timing.reach + timing.hold}ms`,
  };
}

/**
 * The hand art is a Vite-managed image. If it cannot load, KidHand reveals the
 * CSS silhouette so the pick remains visible instead of silently disappearing.
 */
function KidHand({ hand }: { hand: { style: HandStyle; timing: HandTiming } }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <span className={`kid-hand hand-${hand.style}`} style={handStyleVars(hand.timing) as CSSProperties} aria-hidden="true">
      <span className={`kid-hand-art ${imageFailed ? "hand-art-fallback" : ""}`}>
        {!imageFailed && <img className="kid-hand-image" src={handImage} alt="" onError={() => setImageFailed(true)} />}
        <i className="kid-hand-finger one" /><i className="kid-hand-finger two" /><i className="kid-hand-finger three" /><i className="kid-hand-finger four" />
        <b className="kid-hand-palm" />
        <em className="kid-hand-sleeve" />
      </span>
    </span>
  );
}

function DeckMaterials({ draft, cards, small = false }: { draft: DraftState; cards: Card[]; small?: boolean }) {
  const data = evaluateDeck(draft.deck, cards);
  const byId = new Map(cards.map((card) => [card.id, card]));
  const curve = Array.from({ length: 8 }, () => ({ monsters: 0, spells: 0 }));
  draft.deck.forEach((item) => {
    const card = byId.get(item.cardId);
    if (!card) return;
    const bucket = Math.min(7, Math.max(0, card.cost - 1));
    curve[bucket][card.type === "monster" ? "monsters" : "spells"] += 1;
  });
  const maxCurve = Math.max(1, ...curve.map((item) => item.monsters + item.spells));
  return (
    <section className={`materials-panel ${small ? "small" : ""}`}>
      <div className="panel-heading"><span>DECK DATA</span><b>{data.size}/15</b></div>
      <div className="curve-legend" aria-label="マナカーブ凡例"><span className="monster">■ モンスター</span><span className="spell">■ 呪文</span></div>
      <div className="curve" aria-label="マナカーブ">
        {curve.map((item, index) => {
          const total = item.monsters + item.spells;
          return <div key={index}><span className="curve-stack" style={{ height: `${total ? Math.max(4, total / maxCurve * 54) : 0}px` }}><i className="curve-spells" style={{ height: `${total ? item.spells / total * 100 : 0}%` }} /><i className="curve-monsters" style={{ height: `${total ? item.monsters / total * 100 : 0}%` }} /></span><b>{index === 7 ? "7+" : index + 1}</b></div>;
        })}
      </div>
    </section>
  );
}

function SpeciesCounter({ draft, cards, config }: { draft: DraftState; cards: Card[]; config: SpeciesSynergyConfig }) {
  const counts = countSpeciesTypes(draft.deck, cards);
  return (
    <section className="species-counter" aria-label="種族の種類数">
      <div className="panel-heading"><span>SPECIES</span><b>{config.thresholds.stageOne} / {config.thresholds.stageTwo}</b></div>
      <div className="species-grid">
        {SPECIES_ORDER.map((species) => {
          const stage = synergyStageFor(counts[species], config);
          return <div key={species} className={`species-cell stage-${stage}`}><span>{species}</span><strong>{counts[species]}</strong></div>;
        })}
      </div>
    </section>
  );
}

function SynergyDeclaration({ synergies }: { synergies: ActiveSpeciesSynergy[] }) {
  if (!synergies.length) return null;
  return <div className="synergy-declaration" role="status"><span>SYNERGY</span>{synergies.map((item) => <b key={item.species} className={`stage-${item.stage}`}>{item.label} 発動中</b>)}</div>;
}

function Speech({ speaker, text, tone = "kid" }: { speaker: string; text: string; tone?: "kid" | "rival" | "system" }) {
  return <div className={`speech ${tone}`}><span>{speaker}</span><p>{text}</p></div>;
}

/**
 * 顔グラと台詞を一体にした横長のメッセージウィンドウ。左端が顔グラ（正方形・枠の高さいっぱい、
 * 現状はプレースホルダ）、右が上段に話者名・下段に台詞。台詞が無い間も枠は残り、台詞欄だけが空になる。
 */
function BattleMessageWindow({ side, name, marker, text, leader, hit, portraitSrc }: {
  side: "brother" | "opponent";
  name: string;
  marker: string;
  text?: string;
  leader: { life: number; pp: number; maxPp: number };
  hit: boolean;
  portraitSrc?: string;
}) {
  return <div className={`battle-message battle-message-${side}`}>
    <div className="battle-message-face" role="img" aria-label={`${name}の顔グラフィック${portraitSrc ? "" : "（プレースホルダ）"}`}>
      {portraitSrc ? <img className="battle-message-portrait-image" src={portraitSrc} alt="" /> : <><span aria-hidden="true">{marker}</span><small>PORTRAIT</small></>}
    </div>
    <div className="battle-message-body">
      <span className="battle-message-name">{name}</span>
      <p className="battle-message-line" aria-live="polite">{text ?? ""}</p>
    </div>
    <div className={`battle-leader-info ${side}-leader-info ` + (hit ? "life-target" : "")}>
      <div className="life"><span>LIFE</span><b>{leader.life}</b></div>
      <div className="pp">PP {leader.pp}/{leader.maxPp}</div>
    </div>
  </div>;
}

function ReactionBanner({ reaction, speaker }: { reaction: KidReaction; speaker: string }) {
  return <div className={`kid-reaction ${reaction.tone}`} role="status">
    <b aria-hidden="true">！</b>
    <span>{speaker}</span>
    <p>{reaction.text}</p>
  </div>;
}

interface HowToPage {
  title: string;
  lead?: string;
  items?: Array<{ term?: string; text: string }>;
  note?: string;
}

/** Static reference pages, reachable from mode select at any time. Not a guided tutorial. */
const HOW_TO_PAGES: HowToPage[] = [
  {
    title: "このゲームについて",
    lead: "デッキを組むのは、あなたではなく弟です。",
    items: [
      { text: "弟は自分の好みでカードを選びます。あなた（兄ちゃん）が口を出せるのは、弟が意見を求めてきたときと、区切りごとのアドバイスだけ。" },
      { text: "完成したデッキで、弟は対戦相手に挑みます。バトルは自動で進行し、あなたは観戦します。" },
    ],
    note: "勝たせてやるために、弟の好みを読み、足りないものを補うのがあなたの役目です。",
  },
  {
    title: "カードの見かた",
    lead: "カードには次の情報があります。",
    items: [
      { term: "コスト", text: "場に出すために必要なPP" },
      { term: "攻撃力／体力", text: "戦闘の数値。体力が0になると破壊される" },
      { term: "種族", text: "カード右上に表示。ドラゴン／メカ／けもの／天使／悪魔／精霊の6種" },
      { term: "効果", text: "一部のカードが持つ能力（次ページ）" },
    ],
    note: "スペルは使い切りのカードで、モンスターと違い場に残りません。種族も持ちません。",
  },
  {
    title: "効果の説明",
    lead: "効果は7種類だけです。",
    items: [
      { term: "速攻", text: "場に出たターンから攻撃できる（通常は次のターンから）" },
      { term: "守護", text: "このカードがいる間、相手は先にこのカードを攻撃しなければならない" },
      { term: "ダメージ", text: "指定の相手に直接ダメージを与える" },
      { term: "破壊", text: "対象のモンスターを体力に関係なく破壊する" },
      { term: "強化", text: "味方の攻撃力を上げる" },
      { term: "ドロー", text: "カードを引く" },
      { term: "復活", text: "破壊されたとき、一度だけ場に戻ってくる" },
    ],
  },
  {
    title: "バトルのルール",
    items: [
      { text: "お互いのリーダーはライフ20から始まる（一部の強敵はもっと多い）。相手のライフを0にすれば勝ち" },
      { text: "PPは毎ターン1ずつ増え、上限は10。コストの分だけPPを使ってカードを出す" },
      { text: "場に出せるモンスターは5体まで" },
      { text: "モンスター同士が戦闘すると、互いの攻撃力分のダメージを与え合う" },
      { text: "相手の場に守護がいなければ、モンスターを無視してリーダーを直接攻撃できます" },
    ],
    note: "バトル中の判断はすべて弟が行います。あなたの仕事はビルドで終わっています。",
  },
  {
    title: "シンクロと種族結束",
    items: [
      { term: "シンクロ率", text: "弟が意見を求めてきたとき、弟が本当に欲しがっているカードを選んであげると上がります。段階が上がると弟のカードに力が宿り、最大まで達すると、ビルド後に切り札を1枚指定できます。切り札はピンチのとき、必ず手札にやってきます" },
      { term: "種族結束", text: "同じ種族のカードが4種類そろうと、その種族全体が少し強くなります。6種類そろえば、種族ごとの大きな力が発動します。同じカード2枚は1種類と数えます" },
    ],
    note: "シンクロ率は試合をまたいで持ち越されますが、試合が終わるごとに少し下がります。",
  },
];

function HowToPlayOverlay({ onClose }: { onClose: () => void }) {
  const [page, setPage] = useState(0);
  const current = HOW_TO_PAGES[page];
  const last = HOW_TO_PAGES.length - 1;
  return (
    <div className="modal-backdrop how-to-backdrop">
      <section className="how-to-panel" role="dialog" aria-modal="true" aria-label="あそびかた">
        <header className="how-to-head">
          <span className="section-kicker">HOW TO PLAY</span>
          <h2>{current.title}</h2>
          <button type="button" className="how-to-close" onClick={onClose} aria-label="あそびかたを閉じる">×</button>
        </header>
        <div className="how-to-body">
          {current.lead && <p className="how-to-lead">{current.lead}</p>}
          {current.items && <ul className="how-to-list">
            {current.items.map((item, index) => (
              <li key={index}>{item.term && <b>{item.term}</b>}<span>{item.text}</span></li>
            ))}
          </ul>}
          {current.note && <p className="how-to-note">{current.note}</p>}
        </div>
        <footer className="how-to-foot">
          <button type="button" className="secondary-action" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0}>◀ 前へ</button>
          <div className="how-to-dots" aria-label={`${page + 1} / ${HOW_TO_PAGES.length}ページ`}>
            {HOW_TO_PAGES.map((item, index) => <i key={item.title} className={index === page ? "on" : ""} />)}
          </div>
          {page === last
            ? <button type="button" className="primary-action" onClick={onClose}>閉じる</button>
            : <button type="button" className="primary-action" onClick={() => setPage((value) => Math.min(last, value + 1))}>次へ ▶</button>}
        </footer>
      </section>
    </div>
  );
}

function ModeSelectScreen({ onSelect }: { onSelect: () => void }) {
  const [howToOpen, setHowToOpen] = useState(false);
  return <main className="mode-select-screen"><section className="mode-select-panel"><span className="section-kicker">SELECT MODE</span><h1>遊び方を選べ！</h1>
    <button className="mode-card active" onClick={onSelect}><strong>アーケードモード</strong><span>6戦の連続バトル</span><b>START ▶</b></button>
    <button className="mode-card how-to-card" onClick={() => setHowToOpen(true)}><strong>あそびかた</strong><span>ルールの説明を読む</span><b>OPEN ▶</b></button>
  </section>{howToOpen && <HowToPlayOverlay onClose={() => setHowToOpen(false)} />}</main>;
}

function CharacterSelectScreen({ onSelect }: { onSelect: () => void }) {
  return <main className="character-select-screen"><section className="character-select-panel"><span className="section-kicker">SELECT CHARACTER</span><h1>キャラクターを選べ！</h1><div className="character-grid">
    <button className="character-slot active" onClick={onSelect}><span className="character-portrait">ユ</span><strong>単純弟</strong><small>かっこいいカードが大好き。アグロ気質。</small><b>SELECT ▶</b></button>
    {[1, 2, 3].map((slot) => <div className="character-slot locked" key={slot}><span className="character-portrait">？</span><strong>？？？</strong><small>LOCKED</small></div>)}
  </div></section></main>;
}

function OpponentPreviewScreen({ opponent, battleNumber, onStart }: { opponent: OpponentDefinition; battleNumber: number; onStart: () => void }) {
  return <main className="opponent-preview-screen"><section className="opponent-preview-panel"><span className="section-kicker">BATTLE {battleNumber} / 6</span><h1>つぎの相手</h1><div className="opponent-preview-card" style={{ "--rival-color": opponent.color } as CSSProperties}><span className="opponent-mark">{opponent.title.slice(0, 1)}</span><small>{opponent.title}</small><strong>{opponent.name}</strong><p>{opponent.trait}</p></div><button className="primary-action" onClick={onStart}>デッキを組む！<span>▶</span></button></section></main>;
}

function DraftScreen({ draft, offer, cards, child, adviceOpen, reaction, syncNotice, pickFlash, autoPickPhase, synergyConfig, speed, onSpeedChange, onPick, onAdvice }: {
  draft: DraftState;
  offer: DraftOffer | null;
  cards: Card[];
  child: ChildProfile;
  adviceOpen: boolean;
  reaction: KidReaction | null;
  syncNotice: SyncNotice | null;
  pickFlash: PickFlash | null;
  autoPickPhase: AutoPickPhase | null;
  synergyConfig: SpeciesSynergyConfig;
  speed: PlaybackSpeed;
  onSpeedChange: (speed: PlaybackSpeed) => void;
  onPick: (index: 0 | 1) => void;
  onAdvice: (category: Exclude<AdviceCategory, "skip">, targetSpecies?: Species) => void;
}) {
  const focus = activeAdviceFocus(draft);
  const adviceFocusLabel = focus
    ? focus.category === "species" && focus.targetSpecies
      ? `${focus.targetSpecies}を探し中`
      : `${categoryCopy[focus.category].label}を探し中`
    : null;
  const [speciesMenuOpen, setSpeciesMenuOpen] = useState(false);
  const speciesCounts = countSpeciesTypes(draft.deck, cards);
  const adviceCategories = child.advice.categories.filter((category): category is Exclude<AdviceCategory, "skip"> => category !== "skip");

  useEffect(() => {
    if (!adviceOpen) setSpeciesMenuOpen(false);
  }, [adviceOpen]);
  // The crush decision always runs in core; showCrush only decides whether the UI marks it.
  const crush = Boolean(offer?.decision.love) && child.showCrush !== false;
  // The kid never explains himself on his own picks: one line of feeling, no reasoning.
  const autoLine = offer
    ? child.dialogue.pick[draft.pick % child.dialogue.pick.length].replace("{name}", offer.cards[offer.decision.preferredIndex].name)
    : "";
  const autoPick = Boolean(offer && (!offer.wantsIntervention || offer.decision.love));
  const dialogue = !offer
    ? "次のカード、どんなのかな！"
    : autoPick && autoPickPhase === "mulling"
      ? child.dialogue.mulling[draft.pick % child.dialogue.mulling.length]
      : crush
      ? child.dialogue.love[draft.pick % child.dialogue.love.length]
      : offer.wantsIntervention
        ? child.dialogue.ask[draft.pick % child.dialogue.ask.length]
        : autoLine;
  return (
    <main className="game-shell draft-screen">
      <div className="draft-speed-slot">
        <div className="draft-evaluation-controls">
          <BattleSpeedControls speed={speed} onChange={onSpeedChange} />
        </div>
      </div>
      <header className="game-header"><div className="mini-logo">兄ちゃん！<b>俺のデッキ作って！</b></div><div className="pick-counter"><span>PICK</span><b>{String(draft.pick + 1).padStart(2, "0")}</b><em>/15</em></div><SyncMeter sync={draft.syncRate} child={child} flash={pickFlash} /></header>
      {reaction && <ReactionBanner reaction={reaction} speaker={child.displayName} />}
      <SyncStageBanner notice={syncNotice} />
      <div className="draft-layout">
        <section className="choice-zone">
          <div className="versus-label"><span>どっちを入れる？</span>{adviceFocusLabel && <b>{adviceFocusLabel}</b>}</div>
          {offer ? <div className="card-choice">
            {offer.cards.map((card, index) => (
              <button
                className={`card-choice-button ${crush && index === offer.decision.preferredIndex ? "love-lock" : ""} ${pickFlash?.index === index ? `pick-flash-${pickFlash.strength}` : ""} ${pickFlash?.hand && pickFlash.index === index ? `card-taken-${pickFlash.hand.style}` : ""}`}
                style={{
                  ...(pickFlash?.hand && pickFlash.index === index ? handStyleVars(pickFlash.hand.timing) : {}),
                } as CSSProperties}
                key={`${card.id}-${index}`}
                disabled={!offer.wantsIntervention || offer.decision.love || Boolean(pickFlash)}
                onClick={() => onPick(index as 0 | 1)}
                aria-label={`${card.name}を選ぶ`}
              >
                {crush && index === offer.decision.preferredIndex && <span className="love-ribbon">一目惚れ！変更不可</span>}
                <div className="pick-card-layer">
                  <CardFace card={card} />
                  {pickFlash?.hand && pickFlash.index === index && <KidHand hand={pickFlash.hand} />}
                </div>
                {offer.wantsIntervention && !offer.decision.love && <span className="choose-label">こっちにする</span>}
              </button>
            ))}
            <div className="vs-burst">VS</div>
          </div> : <div className="loading-card">カードをシャッフル中…</div>}
          <Speech speaker={child.displayName} text={dialogue} />
        </section>
        <aside><DeckMaterials draft={draft} cards={cards} /><SpeciesCounter draft={draft} cards={cards} config={synergyConfig} /></aside>
      </div>
      {adviceOpen && <div className="modal-backdrop"><section className="advice-modal">
        <div className="advice-title"><span>兄ちゃん会議！</span><h2>デッキを見て、ひとこと注文しよう</h2><p>注文したカードも、このまま通常の1枠として入る。</p></div>
        <DeckMaterials draft={draft} cards={cards} small />
        <SpeciesCounter draft={draft} cards={cards} config={synergyConfig} />
        {!speciesMenuOpen ? <div className="advice-options">{adviceCategories.map((category) => {
          const copy = categoryCopy[category];
          return <button key={category} disabled={Boolean(pickFlash)} onClick={() => category === "species" ? setSpeciesMenuOpen(true) : onAdvice(category)}><b>{copy.icon}</b><span><strong>{copy.label}</strong><small>{copy.detail}</small></span></button>;
        })}</div> : <div className="species-advice-menu">
          <button type="button" className="advice-back" onClick={() => setSpeciesMenuOpen(false)}>← 4系統の注文に戻る</button>
          <div className="species-advice-options">{SPECIES_ORDER.map((species) => <button key={species} type="button" disabled={Boolean(pickFlash)} onClick={() => onAdvice("species", species)}><b>{species.slice(0, 1)}</b><span><strong>{species}</strong><small>デッキ内 {speciesCounts[species]}種類</small></span></button>)}</div>
        </div>}
      </section></div>}
    </main>
  );
}

function AceSelectionScreen({ draft, cards, selectedCardId, onSelect, onConfirm, onSkip }: { draft: DraftState; cards: Card[]; selectedCardId: string | null; onSelect: (cardId: string) => void; onConfirm: () => void; onSkip: () => void }) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return <main className="ace-selection-screen"><section className="ace-selection-panel"><span className="section-kicker">DESTINY DRAW / UNLOCKED</span><h1>切り札を選べ！！</h1><p className="ace-flavor">ここぞの一枚を、運命のドローに指定しろ！</p><div className="ace-deck-grid">{draft.deck.map((item) => { const card = byId.get(item.cardId)!; const selected = selectedCardId === item.cardId; return <button key={item.instanceId} className={`ace-card-option ${selected ? "selected" : ""}`} onClick={() => onSelect(item.cardId)} aria-pressed={selected}><CardFace card={card} selected={selected} /><span>{selected ? "切り札に指定中" : "この札を選ぶ"}</span></button>; })}</div><div className="ace-selection-actions"><button className="secondary-action" onClick={onSkip}>切り札なしで開始</button><button className="primary-action" onClick={onConfirm} disabled={!selectedCardId}>このカードで決定<span>▶</span></button></div></section></main>;
}

/** Picks the kid made on his own: no ruling was asked for, or love locked the card in. */
function autoPickCount(draft: DraftState): number {
  return draft.deck.filter((item) => item.source === "auto" || item.source === "love").length;
}

function BuildSummary({ draft, child }: { draft: DraftState; child: ChildProfile }) {
  const copy = child.buildSummary;
  if (!copy) return null;
  const autoPicks = autoPickCount(draft);
  const mood = [...copy.moodTiers].sort((a, b) => b.minimumAutoPicks - a.minimumAutoPicks).find((tier) => autoPicks >= tier.minimumAutoPicks);
  const startedAt = draft.history[0]?.syncBefore ?? draft.syncRate;
  const gained = syncStage(draft.syncRate, child) - syncStage(startedAt, child);
  const stageNote = gained > 0 ? copy.stageUpText.replace("{count}", String(gained)) : copy.stageKeptText;
  return (
    <section className="build-summary">
      <p className="build-mood">{mood?.text}</p>
      <p className="build-stage"><span>シンクロ</span><strong>{syncStageLabel(draft.syncRate, child)}</strong><small>（{stageNote}）</small></p>
    </section>
  );
}

function DeckScreen({ draft, cards, child, reaction, synergyConfig, onBattle }: { draft: DraftState; cards: Card[]; child: ChildProfile; reaction: KidReaction | null; synergyConfig: SpeciesSynergyConfig; onBattle: () => void }) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return <main className="game-shell deck-screen">
    <header className="game-header"><div className="mini-logo">デッキ完成！<b>答え合わせへ</b></div><div className="completion-stamp">15 CARDS</div></header>
    {reaction && <ReactionBanner reaction={reaction} speaker={child.displayName} />}
    <BuildSummary draft={draft} child={child} />
    <div className="deck-review-grid">
      <section className="deck-list-panel"><div className="section-kicker">YOUR DECK</div><h1>ユウタのデッキ</h1><div className="deck-list">{draft.deck.map((item, index) => { const card = byId.get(item.cardId)!; return <div key={item.instanceId} className="deck-row"><span className="deck-number">{String(index + 1).padStart(2, "0")}</span><span className="mini-cost">{card.cost}</span><strong>{card.name}</strong><small>{effectText(card)}</small>{item.intervention && <b className="brother-tag">兄ちゃん</b>}</div>; })}</div></section>
      <aside><DeckMaterials draft={draft} cards={cards} /><SpeciesCounter draft={draft} cards={cards} config={synergyConfig} /><div className="no-verdict"><b>勝てそう？</b><span>数字は材料。答えは対戦で確かめよう。</span></div></aside>
    </div>
    <section className="deck-action"><button className="primary-action battle-start" onClick={onBattle}>この相手とバトル！<span>▶</span></button></section>
  </main>;
}

function eventDamageAmount(event: BattleEvent | null): number | null {
  if (!event || (event.type !== "attack" && !(event.type === "effect" && event.keyword === "damage"))) return null;
  return event.damage ?? null;
}

function isDamageEvent(event: BattleEvent | null): boolean {
  return Boolean(event && (event.type === "attack" || (event.type === "effect" && event.keyword === "damage")));
}

function isGuardInterceptAttack(event: BattleEvent | null, cards: Card[]): boolean {
  if (!event || event.type !== "attack" || !event.targetInstanceId || !event.beforeSnapshot) return false;
  const defendingPlayer = event.side === "brother" ? event.beforeSnapshot.opponent : event.beforeSnapshot.brother;
  const target = defendingPlayer.board.find((instance) => instance.instanceId === event.targetInstanceId);
  return Boolean(target && instanceHasKeyword(target, cards, "guard"));
}

function isLargeSummon(event: BattleEvent | null, cards: Card[]): boolean {
  if (!event || event.type !== "play" || !event.cardId) return false;
  const card = cards.find((item) => item.id === event.cardId);
  return card?.type === "monster" && card.cost >= 5;
}

function eventCardClass(
  instance: BattleState["brother"]["board"][number],
  activeEvent: BattleEvent | null,
  cards: Card[],
  guardPreludeDone: boolean,
  attackPreludeDone = true,
  summonPreludeDone = true,
): string {
  if (!activeEvent) return "";
  const sourceId = activeEvent.sourceInstanceId ?? activeEvent.instanceId;
  const isSource = sourceId === instance.instanceId;
  const isTarget = activeEvent.targetInstanceId === instance.instanceId || activeEvent.targetInstanceIds?.includes(instance.instanceId);
  if (!isSource && !isTarget) return "";
  if (activeEvent.type === "attack" && isSource) {
    if (isGuardInterceptAttack(activeEvent, cards) && !guardPreludeDone) return "attack-prelude-wait";
    if (!attackPreludeDone) return "attack-windup";
    return "event-attack " + (activeEvent.side === "brother" ? "attack-toward-opponent" : "attack-toward-brother") + (activeEvent.targetLeader ? " attack-to-leader" : "");
  }
  if (activeEvent.type === "attack" && isTarget) {
    if (isGuardInterceptAttack(activeEvent, cards) && !guardPreludeDone) return `guard-intercept-prelude ${activeEvent.side === "brother" ? "guard-intercept-opponent" : "guard-intercept-brother"}`;
    return "attack-contact-target " + (activeEvent.side === "brother" ? "target-knockback-opponent" : "target-knockback-brother");
  }
  if (activeEvent.type === "play" && isSource) return summonPreludeDone ? "event-summon" : "summon-prelude";
  if (activeEvent.type === "effect" && isSource) return "effect-source-flash";
  if ((activeEvent.type === "effect" || activeEvent.type === "destroyed") && isTarget) return "effect-target-flash";
  if (activeEvent.type === "sync_bonus" && isTarget) return "event-sync-flash";
  if (activeEvent.type === "ace" && isSource) return "event-ace-card";
  return isSource && activeEvent.type === "sync_bonus" ? "event-sync-flash" : "";
}

const BEFORE_RESOLUTION_BOARD_EVENTS = new Set<BattleEventType>(["attack", "effect", "destroyed"]);

/**
 * Select the board state for the event currently being presented.
 *
 * Impact events need their before-state so the source and target remain
 * mounted for the animation. All other events use their after-state (notably
 * play, whose after-state contains the newly summoned card). Keeping this
 * selection tied to the playback cursor prevents the transient fallback to
 * the final BattleState between two queued events.
 */
function boardSnapshotForPlayback(event: BattleEvent | undefined) {
  if (!event) return undefined;
  return (BEFORE_RESOLUTION_BOARD_EVENTS.has(event.type) ? event.beforeSnapshot ?? event.snapshot : event.snapshot ?? event.beforeSnapshot);
}

/**
 * Board cards live and die by events, not by which snapshot the playback cursor happens to read.
 *
 * The snapshot supplies stats and ordering, but a card is only dropped once a destroyed event
 * for it has actually been played. If a snapshot momentarily loses a card that no event removed,
 * the previous entry is carried over so the element stays mounted instead of being rebuilt.
 * That is what keeps "a card that stays on the board is the same DOM element" true by construction.
 */
function reconcileBoard(
  previous: readonly BattleCardInstance[],
  incoming: readonly BattleCardInstance[],
  removedIds: ReadonlySet<string>,
): { board: BattleCardInstance[]; carriedOver: string[] } {
  const present = new Set(incoming.map((item) => item.instanceId));
  const carriedOver: string[] = [];
  const board = [...incoming];
  previous.forEach((item, index) => {
    if (present.has(item.instanceId) || removedIds.has(item.instanceId)) return;
    carriedOver.push(item.instanceId);
    board.splice(Math.min(index, board.length), 0, item);
  });
  return { board, carriedOver };
}

/** Ids the played events have taken off the board. Nothing else may remove a card. */
function removedInstanceIds(playedEvents: readonly BattleEvent[]): Set<string> {
  const removed = new Set<string>();
  for (const event of playedEvents) {
    if (event.type !== "destroyed") continue;
    if (event.targetInstanceId) removed.add(event.targetInstanceId);
    event.targetInstanceIds?.forEach((id) => removed.add(id));
    event.targetInstances?.forEach((item) => removed.add(item.instanceId));
  }
  return removed;
}

function useStableBoards(
  incomingBrother: readonly BattleCardInstance[],
  incomingOpponent: readonly BattleCardInstance[],
  removedIds: ReadonlySet<string>,
  resetKey: string,
): { brother: BattleCardInstance[]; opponent: BattleCardInstance[] } {
  const previous = useRef<{ key: string; brother: BattleCardInstance[]; opponent: BattleCardInstance[] }>({ key: resetKey, brother: [], opponent: [] });
  const base = previous.current.key === resetKey ? previous.current : { key: resetKey, brother: [], opponent: [] };
  const brother = reconcileBoard(base.brother, incomingBrother, removedIds);
  const opponent = reconcileBoard(base.opponent, incomingOpponent, removedIds);
  previous.current = { key: resetKey, brother: brother.board, opponent: opponent.board };
  // An invariant probe: it only fires when a snapshot contradicts the event log, which should never
  // happen. The counter is what the playthrough check reads to prove the guarantee holds.
  const carried = [...brother.carriedOver, ...opponent.carriedOver];
  if (carried.length && typeof window !== "undefined") {
    const probe = window as unknown as { __boardIdentity?: { carryOvers: number; ids: string[] } };
    probe.__boardIdentity ??= { carryOvers: 0, ids: [] };
    probe.__boardIdentity.carryOvers += carried.length;
    probe.__boardIdentity.ids.push(...carried);
    console.warn("[board-identity] snapshot dropped a card no event removed:", carried.join(", "));
  }
  return { brother: brother.board, opponent: opponent.board };
}

function opponentHandForPlayback(event: BattleEvent | undefined, fallback: BattleState["opponent"]["hand"]): BattleState["opponent"]["hand"] {
  if (!event) return fallback;
  if (event.type === "play" && event.side === "opponent") return event.beforeSnapshot?.opponent.hand ?? fallback;
  if (event.type === "draw" || (event.type === "effect" && event.keyword === "draw")) return event.snapshot?.opponent.hand ?? fallback;
  return fallback;
}



function AnimatedBoardCard({ instance, cards, ace = false, activeEvent = null, guardPreludeDone = true, attackPreludeDone = true, summonPreludeDone = true }: { instance: BattleState["brother"]["board"][number]; cards: Card[]; ace?: boolean; activeEvent?: BattleEvent | null; guardPreludeDone?: boolean; attackPreludeDone?: boolean; summonPreludeDone?: boolean }) {
  const card = cards.find((item) => item.id === instance.cardId)!;
  const syncBonus = instance.grantedKeywords.length > 0 || instance.grantedAtk > 0;
  const className = "board-card " + (instance.intervention ? "intervened " : "") + (syncBonus && !ace ? "sync-granted " : "") + (ace ? "ace-granted " : "") + eventCardClass(instance, activeEvent, cards, guardPreludeDone, attackPreludeDone, summonPreludeDone);
  return <div className={className} title={card.name} data-instance-id={instance.instanceId} data-event-id={activeEvent?.instanceId === instance.instanceId ? activeEvent.id : undefined}>{instance.intervention && <span className="intervention-mark">兄</span>}{card.species && <span className="species-tag">{card.species}</span>}{syncBonus && !ace && <span className="sync-mark">SYNC</span>}{ace && <span className="ace-mark">ACE</span>}<KeywordBadges keywords={instanceVisibleKeywords(instance, cards)} compact /><b>{card.name.slice(0, 1)}</b><small>{card.name}</small><div><span>{instance.atk}</span><span>{instance.hp}</span></div></div>;
}

function AnimatedBattleHandCard({ instance, cards, ace, activeEvent = null, guardPreludeDone = true, attackPreludeDone = true, summonPreludeDone = true }: { instance: BattleState["brother"]["hand"][number]; cards: Card[]; ace?: boolean; activeEvent?: BattleEvent | null; guardPreludeDone?: boolean; attackPreludeDone?: boolean; summonPreludeDone?: boolean }) {
  const card = cards.find((item) => item.id === instance.cardId)!;
  const syncBonus = instance.grantedKeywords.length > 0 || instance.grantedAtk > 0;
  const className = "hand-card " + (syncBonus && !ace ? "sync-granted " : "") + (ace ? "ace-granted " : "") + eventCardClass(instance, activeEvent, cards, guardPreludeDone, attackPreludeDone, summonPreludeDone);
  return <div className={className} data-event-id={activeEvent?.instanceId === instance.instanceId ? activeEvent.id : undefined}><CardFace compact card={card} intervention={instance.intervention} keywords={instanceVisibleKeywords(instance, cards)} />{syncBonus && !ace && <span className="sync-mark">SYNC</span>}{ace && <span className="ace-mark">ACE</span>}</div>;
}

function AnimatedOpponentHandCard({ instance, activeEvent = null }: { instance: BattleState["opponent"]["hand"][number]; activeEvent?: BattleEvent | null }) {
  const drawEvent = activeEvent?.side === "opponent" && (activeEvent.type === "draw" || (activeEvent.type === "effect" && activeEvent.keyword === "draw"));
  const entered = drawEvent && (activeEvent.type === "draw"
    ? activeEvent.snapshot?.opponent.hand.at(-1)?.instanceId === instance.instanceId
    : activeEvent.targetInstanceIds?.includes(instance.instanceId));
  const left = activeEvent?.type === "play" && activeEvent.side === "opponent" && activeEvent.instanceId === instance.instanceId;
  const className = `opponent-hand-card${entered ? " opponent-hand-draw" : ""}${left ? " opponent-hand-play" : ""}`;
  return <div className={className} data-event-id={left ? activeEvent.id : undefined} aria-hidden="true"><span className="opponent-card-back"><i /></span></div>;
}

function battleLogText(item: BattleEvent, cards: Card[]): string {
  if (item.type !== "attribution" || !item.cardId) return item.text;
  const cardName = cards.find((card) => card.id === item.cardId)?.name ?? item.cardId;
  return `兄ちゃんが選んだ${cardName}が活躍！`;
}

function compactAttributionEvents(events: BattleEvent[]): BattleEvent[] {
  const shownCardIds = new Set<string>();
  return events.filter((item) => {
    if (item.type !== "attribution" || !item.cardId) return true;
    if (shownCardIds.has(item.cardId)) return false;
    shownCardIds.add(item.cardId);
    return true;
  });
}

function BattleSpeedControls({ speed, onChange }: { speed: PlaybackSpeed; onChange: (speed: PlaybackSpeed) => void }) {
  return <div className="battle-speed-controls" aria-label="バトル演出速度"><span>演出</span>{(["normal", "fast", "skip"] as PlaybackSpeed[]).map((item) => <button key={item} type="button" className={speed === item ? "active" : ""} aria-pressed={speed === item} onClick={() => onChange(item)}>{PLAYBACK_SPEED_LABELS[item]}</button>)}</div>;
}

function TurnTransitionBanner({ banner }: { banner: { side: BattleEvent["side"]; text: string; duration: number } | null }) {
  if (!banner) return null;
  const side = banner.side === "brother" ? "brother" : "opponent";
  return <div className={`turn-transition-banner ${side}`} style={{ "--turn-banner-duration": `${banner.duration}ms` } as CSSProperties} role="status" aria-live="polite"><span>{banner.text}</span></div>;
}

function BattleLogModal({ open, recent, cards, opponentName, onOpen, onClose }: { open: boolean; recent: BattleEvent[]; cards: Card[]; opponentName: string; onOpen: () => void; onClose: () => void }) {
  return <>
    <button className="battle-log-launcher" type="button" onClick={onOpen} aria-haspopup="dialog" aria-expanded={open}>ログ</button>
    {open && <div className="battle-log-modal-backdrop" role="presentation" onClick={onClose}>
      <section className="battle-log-modal" role="dialog" aria-modal="true" aria-label="バトルログ" onClick={(event) => event.stopPropagation()}>
        <div className="panel-heading"><span>BATTLE LOG</span><b>PAUSED</b><button type="button" onClick={onClose}>閉じる</button></div>
        <div className="battle-log-entries">{recent.map((item) => <p key={item.id} className={item.type === "attribution" ? "highlight" : item.type === "sync_bonus" ? "sync-event" : item.type === "ace" ? "ace-event" : ""}><span>{item.side === "brother" ? "ユウタ" : opponentName}</span>{battleLogText(item, cards)}</p>)}</div>
      </section>
    </div>}
  </>;
}

function BattleEffectLayer({ activeEvent, cards, guardPreludeDone, attackAfterglow }: { activeEvent: BattleEvent | null; cards: Card[]; guardPreludeDone: boolean; attackAfterglow: boolean }) {
  if (!activeEvent) return null;
  const amount = eventDamageAmount(activeEvent);
  const targetSide = activeEvent.side === "brother" ? "opponent" : "brother";
  const sourcePlayer = activeEvent.side === "brother" ? activeEvent.snapshot?.brother : activeEvent.snapshot?.opponent;
  const sourceVisible = Boolean(sourcePlayer && activeEvent.sourceInstanceId && [...sourcePlayer.board, ...sourcePlayer.hand].some((item) => item.instanceId === activeEvent.sourceInstanceId));
  const sourceInstance = activeEvent.sourceInstance ?? (activeEvent.cardId ? { instanceId: activeEvent.sourceInstanceId ?? activeEvent.instanceId ?? "effect-source", cardId: activeEvent.cardId } : undefined);
  const sourceCard = sourceInstance ? cards.find((card) => card.id === sourceInstance.cardId) : undefined;
  const destroyedInstance = activeEvent.targetInstances?.[0];
  const destroyedCard = destroyedInstance ? cards.find((card) => card.id === destroyedInstance.cardId) : undefined;
  const isGuardPrelude = activeEvent.type === "attack" && isGuardInterceptAttack(activeEvent, cards) && !guardPreludeDone;
  const isAttackOnCard = activeEvent.type === "attack" && Boolean(activeEvent.targetInstanceId) && !isGuardPrelude;
  const attackerSide = activeEvent.side;
  return <div className="battle-effect-layer" aria-live="polite">
    {isAttackOnCard && <span className={`attack-impact ${attackerSide === "brother" ? "opponent" : "brother"} ${attackAfterglow ? "afterglow" : ""}`} aria-hidden="true" />}
    {isAttackOnCard && activeEvent.retaliationDamage !== undefined && <span className={`damage-pop attack-retaliation ${attackerSide}`}>-{activeEvent.retaliationDamage}</span>}
    {amount !== null && !isGuardPrelude && <span className={`damage-pop ${targetSide} ${isAttackOnCard ? "attack-contact" : "effect-hit"}`}>-{amount}</span>}
    {activeEvent.type === "play" && <span className={"summon-pop " + activeEvent.side}>登場！</span>}
    {activeEvent.type === "effect" && sourceCard && !sourceVisible && <div className={`effect-source-label ${activeEvent.side}`}><span>EFFECT</span><b>{sourceCard.name}</b></div>}
    {activeEvent.type === "effect" && <span className={`effect-hit-label ${targetSide}`}>{activeEvent.keyword === "destroy" ? "BREAK!" : activeEvent.keyword === "damage" ? "HIT!" : "EFFECT!"}</span>}
    {destroyedCard && <div className="destruction-pop"><b>BREAK!</b><small>{destroyedCard.name}</small></div>}
  </div>;
}

function BattleCutIn({ kind }: { kind: CutInKind }) {
  return <div className={"battle-cut-in " + kind} role="status" aria-live="assertive"><div className="cut-in-rays" aria-hidden="true" /><div className="cut-in-art-layer" aria-hidden="true" /><div className="cut-in-band"><span>{kind === "ace" ? "DESTINY DRAW" : "FINISH"}</span><strong>{kind === "ace" ? "ディスティニードロー！！" : "勝負あり！！"}</strong></div></div>;
}

function postBattleLine(battle: BattleState, cards: Card[], child: ChildProfile): string {
  const index = battle.events.length;
  const choose = (lines: string[]) => lines[index % lines.length];
  const cardName = (cardId: string | undefined) => cards.find((card) => card.id === cardId)?.name ?? cardId ?? "このカード";

  if (battle.winner === "opponent") return choose(child.postBattle.defeat);
  if (battle.winner === "brother") {
    const aceEvent = battle.events.find((item) => item.type === "ace");
    if (aceEvent) return choose(child.postBattle.aceWin).replace("{name}", cardName(aceEvent.cardId));
    const attribution = [...battle.events].reverse().find((item) => item.type === "attribution" && item.cardId);
    if (attribution) return choose(child.postBattle.gratitude).replace("{name}", cardName(attribution.cardId));
  }
  return choose(child.postBattle.victory);
}

function BattleScreen({ battle, cards, child, opponent, onNext, onManualNext, onAuto, auto, onFinish, finalBattle, speed, onSpeedChange }: { battle: BattleState; cards: Card[]; child: ChildProfile; opponent: OpponentDefinition; onNext: () => void; onManualNext: () => void; onAuto: () => void; auto: boolean; onFinish: () => void; finalBattle: boolean; speed: PlaybackSpeed; onSpeedChange: (speed: PlaybackSpeed) => void }) {
  // A fresh battle restarts identity tracking; within one battle the boards must stay continuous.
  const battleIdentity = `${opponent.id}-${battle.seed}`;
  const [visibleEventCount, setVisibleEventCount] = useState(0);
  const [activeEvent, setActiveEvent] = useState<BattleEvent | null>(null);
  const [cutIn, setCutIn] = useState<{ kind: CutInKind; visible: boolean } | null>(null);
  const [playbackBusy, setPlaybackBusy] = useState(false);
  const [guardPreludeDone, setGuardPreludeDone] = useState(true);
  const [attackPreludeDone, setAttackPreludeDone] = useState(true);
  const [summonPreludeDone, setSummonPreludeDone] = useState(true);
  const [attackAfterglow, setAttackAfterglow] = useState(false);
  const [turnBanner, setTurnBanner] = useState<{ side: BattleEvent["side"]; text: string; duration: number } | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const turnBannerTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (turnBannerTimer.current !== null) window.clearTimeout(turnBannerTimer.current);
  }, []);

  useEffect(() => {
    if (logOpen) return;
    if (visibleEventCount >= battle.events.length) {
      setPlaybackBusy(false);
      setActiveEvent(null);
      setCutIn(null);
      setGuardPreludeDone(true);
      setAttackPreludeDone(true);
      setSummonPreludeDone(true);
      setAttackAfterglow(false);
      if (turnBannerTimer.current !== null) window.clearTimeout(turnBannerTimer.current);
      turnBannerTimer.current = null;
      setTurnBanner(null);
      return;
    }
    const item = battle.events[visibleEventCount];
    const timing = EVENT_PLAYBACK_TIMING[item.type];
    const guardPreludeDuration = item.type === "attack" && isGuardInterceptAttack(item, cards) ? timing.guardIntercept?.[speed] ?? 0 : 0;
    const attackPreludeDuration = item.type === "attack" ? timing.attackPrelude?.[speed] ?? 0 : 0;
    const attackAfterglowDuration = item.type === "attack" ? timing.attackAfterglow?.[speed] ?? 0 : 0;
    const summonPreludeDuration = isLargeSummon(item, cards) ? timing.summonPrelude?.[speed] ?? 0 : 0;
    const preludeDuration = guardPreludeDuration + attackPreludeDuration + summonPreludeDuration;
    if (item.type === "turn" || speed === "skip") {
      if (turnBannerTimer.current !== null) window.clearTimeout(turnBannerTimer.current);
      turnBannerTimer.current = null;
      setTurnBanner(null);
      const turnBannerDuration = item.type === "turn" ? timing.turnBanner?.[speed] ?? 0 : 0;
      if (turnBannerDuration > 0) {
        setTurnBanner({ side: item.side, text: item.side === "brother" ? "ユウタのターン！" : `${opponent.name}のターン！`, duration: turnBannerDuration });
        turnBannerTimer.current = window.setTimeout(() => {
          setTurnBanner(null);
          turnBannerTimer.current = null;
        }, turnBannerDuration);
      }
    }
    const cutInKind: CutInKind | null = item.type === "ace" ? "ace" : item.type === "result" ? "finisher" : null;
    const timers: number[] = [];
    const finishEvent = () => {
      setCutIn(null);
      setActiveEvent(null);
      setGuardPreludeDone(true);
      setAttackPreludeDone(true);
      setSummonPreludeDone(true);
      setAttackAfterglow(false);
      setPlaybackBusy(false);
      setVisibleEventCount((count) => count + 1);
    };

    setPlaybackBusy(true);
    setActiveEvent(item);
    setGuardPreludeDone(guardPreludeDuration === 0);
    setAttackPreludeDone(attackPreludeDuration === 0);
    setSummonPreludeDone(summonPreludeDuration === 0);
    setAttackAfterglow(false);
    if (cutInKind && timing.cutIn) {
      const cutInTiming = timing.cutIn[speed];
      setCutIn({ kind: cutInKind, visible: false });
      timers.push(window.setTimeout(() => setCutIn({ kind: cutInKind, visible: true }), cutInTiming.before));
      timers.push(window.setTimeout(finishEvent, cutInTiming.before + cutInTiming.hold + cutInTiming.after));
    } else {
      setCutIn(null);
      if (guardPreludeDuration > 0) timers.push(window.setTimeout(() => setGuardPreludeDone(true), guardPreludeDuration));
      if (attackPreludeDuration > 0) timers.push(window.setTimeout(() => setAttackPreludeDone(true), guardPreludeDuration + attackPreludeDuration));
      if (summonPreludeDuration > 0) timers.push(window.setTimeout(() => setSummonPreludeDone(true), summonPreludeDuration));
      if (attackAfterglowDuration > 0) timers.push(window.setTimeout(() => setAttackAfterglow(true), preludeDuration + timing[speed]));
      timers.push(window.setTimeout(finishEvent, preludeDuration + timing[speed] + attackAfterglowDuration));
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [battle.events.length, cards, logOpen, opponent.name, speed, visibleEventCount]);

  const playbackComplete = !playbackBusy && visibleEventCount >= battle.events.length;
  const visibleEvents = battle.events.slice(0, Math.min(battle.events.length, visibleEventCount + (activeEvent ? 1 : 0)));
  const brotherDialogueEvent = [...visibleEvents].reverse().find((item) => item.side === "brother" && item.dialogue);
  const opponentDialogueEvent = [...visibleEvents].reverse().find((item) => item.side === "opponent" && item.dialogue);
  const recent = compactAttributionEvents(visibleEvents).slice(-9).reverse();
  const aceEvent = [...battle.events].reverse().find((item) => item.type === "ace");
  const aceInstanceId = aceEvent?.instanceId;
  const playbackEvent = activeEvent ?? battle.events[visibleEventCount];
  const postBattleDialogue = playbackComplete && battle.winner ? postBattleLine(battle, cards, child) : null;
  const damageTargetSide = isDamageEvent(activeEvent) && activeEvent?.targetLeader ? activeEvent.side === "brother" ? "opponent" : "brother" : null;
  const boardSnapshot = boardSnapshotForPlayback(playbackEvent);
  const boardOpponent = boardSnapshot?.opponent ?? battle.opponent;
  const boardBrother = boardSnapshot?.brother ?? battle.brother;
  // Lifetime comes from the played events; the snapshot only supplies stats and ordering.
  const removedIds = useMemo(() => removedInstanceIds(visibleEvents), [visibleEvents]);
  const stableBoards = useStableBoards(boardBrother.board, boardOpponent.board, removedIds, battleIdentity);
  const opponentHand = speed === "skip" ? battle.opponent.hand : opponentHandForPlayback(playbackEvent, boardOpponent.hand);
  const brotherHand = speed === "skip" ? battle.brother.hand : boardBrother.hand;
  const lifeSnapshot = playbackEvent?.snapshot;
  const lifeOpponent = lifeSnapshot?.opponent ?? battle.opponent;
  const lifeBrother = lifeSnapshot?.brother ?? battle.brother;
  const leaderHitSide = activeEvent && isDamageEvent(activeEvent) && activeEvent.targetLeader ? activeEvent.side === "brother" ? "opponent" : "brother" : null;
  const activeTiming = activeEvent ? EVENT_PLAYBACK_TIMING[activeEvent.type] : null;
  const visualDuration = activeEvent ? `${activeTiming!.visual?.[speed] ?? activeTiming![speed]}ms` : undefined;
  const attackPreludeDuration = activeEvent?.type === "attack" ? `${activeTiming?.attackPrelude?.[speed] ?? 0}ms` : undefined;
  const attackAfterglowDuration = activeEvent?.type === "attack" ? `${activeTiming?.attackAfterglow?.[speed] ?? 0}ms` : undefined;
  const attackReach = activeEvent?.type === "attack" ? activeTiming?.attackReach?.[speed] : undefined;
  const attackLeaderReach = activeEvent?.type === "attack" ? activeTiming?.attackLeaderReach?.[speed] : undefined;
  const attackOverlap = activeEvent?.type === "attack" ? activeTiming?.attackOverlap?.[speed] : undefined;
  const attackKnockback = activeEvent?.type === "attack" ? activeTiming?.attackKnockback?.[speed] : undefined;
  const attackShake = activeEvent?.type === "attack" ? activeTiming?.attackShake?.[speed] : undefined;
  const guardInterceptDistance = activeEvent?.type === "attack" && isGuardInterceptAttack(activeEvent, cards) ? activeTiming?.guardInterceptDistance?.[speed] : undefined;
  const leaderShake = activeEvent?.type === "attack" && activeEvent.targetLeader ? activeTiming?.leaderShake?.[speed] : undefined;
  const attackImpactSize = activeEvent?.type === "attack" ? activeTiming?.attackImpactSize?.[speed] : undefined;
  const summonPreludeDuration = activeEvent && isLargeSummon(activeEvent, cards) ? `${activeTiming?.summonPrelude?.[speed] ?? 0}ms` : undefined;
  const guardPreludeVisualDuration = activeEvent?.type === "attack" && isGuardInterceptAttack(activeEvent, cards) ? `${EVENT_PLAYBACK_TIMING.attack.guardIntercept?.[speed] ?? 0}ms` : undefined;
  const cardAttackHit = activeEvent?.type === "attack" && Boolean(activeEvent.targetInstanceId);
  const arenaStyle: CSSProperties | undefined = visualDuration || guardPreludeVisualDuration || attackPreludeDuration || attackAfterglowDuration || summonPreludeDuration || attackReach || attackLeaderReach || attackOverlap || attackKnockback || attackShake || guardInterceptDistance || leaderShake || attackImpactSize ? {
    ...(visualDuration ? { "--event-duration": visualDuration } : {}),
    ...(guardPreludeVisualDuration ? { "--guard-intercept-duration": guardPreludeVisualDuration } : {}),
    ...(attackPreludeDuration ? { "--attack-prelude-duration": attackPreludeDuration } : {}),
    ...(attackAfterglowDuration ? { "--attack-afterglow-duration": attackAfterglowDuration } : {}),
    ...(summonPreludeDuration ? { "--summon-prelude-duration": summonPreludeDuration } : {}),
    ...(attackReach ? { "--attack-reach": attackReach } : {}),
    ...(attackLeaderReach ? { "--attack-leader-reach": attackLeaderReach } : {}),
    ...(attackOverlap ? { "--attack-overlap": attackOverlap } : {}),
    ...(attackKnockback ? { "--attack-knockback": attackKnockback } : {}),
    ...(attackShake ? { "--attack-shake": attackShake } : {}),
    ...(guardInterceptDistance ? { "--guard-intercept-distance": guardInterceptDistance } : {}),
    ...(leaderShake ? { "--leader-shake": leaderShake } : {}),
    ...(attackImpactSize ? { "--attack-impact-size": attackImpactSize } : {}),
  } as CSSProperties : undefined;

  useEffect(() => {
    if (!auto || battle.winner || !playbackComplete) return;
    const timer = window.setTimeout(onNext, 90);
    return () => window.clearTimeout(timer);
  }, [auto, battle.winner, onNext, playbackComplete]);

  return <main className="battle-screen">
    {/* 常時表示のシナジー帯はHUD整理のため一時停止。開戦時の宣言演出は別レイヤーで維持する。 */}
    <TurnTransitionBanner banner={turnBanner} />
    <div className="battle-turn-center" aria-label={`現在のターン ${battle.turn}`}>TURN <b>{battle.turn}</b></div>
    <span className="battle-opponent-title-label">{opponent.title}</span>
    <BattleMessageWindow side="opponent" name={opponent.name} marker={opponent.name.slice(0, 1)} text={!battle.winner ? opponentDialogueEvent?.dialogue : undefined} leader={lifeOpponent} hit={leaderHitSide === "opponent"} />
    <section className={`arena ${leaderHitSide ? `leader-hit-${leaderHitSide}` : ""} ${cardAttackHit ? "attack-hit-card" : ""} ${attackAfterglow ? "attack-afterglow" : ""}`} style={arenaStyle}>
      <div className={"fighter opponent-fighter " + (damageTargetSide === "opponent" ? "battle-target" : "")}><div className="opponent-hand-zone" aria-label={`相手の手札 ${opponentHand.length}枚`}><div className="opponent-hand-label"><span>相手の手札</span><b>{opponentHand.length}</b></div><div className="opponent-hand-cards">{opponentHand.map((item) => <AnimatedOpponentHandCard key={item.instanceId} instance={item} activeEvent={activeEvent} />)}</div></div></div>
      <div className={"board-zone opponent-board " + (damageTargetSide === "opponent" ? "battle-target" : "")}>{stableBoards.opponent.map((item) => <AnimatedBoardCard key={item.instanceId} instance={item} cards={cards} activeEvent={activeEvent} guardPreludeDone={guardPreludeDone} attackPreludeDone={attackPreludeDone} summonPreludeDone={summonPreludeDone} />)}{!stableBoards.opponent.length && <span className="empty-board">相手の場は空</span>}</div>
      <div className="board-line"><b>AUTO CARD BATTLE</b></div>
      <div className={"board-zone brother-board " + (damageTargetSide === "brother" ? "battle-target" : "")}>{stableBoards.brother.map((item) => <AnimatedBoardCard key={item.instanceId} instance={item} cards={cards} ace={item.instanceId === aceInstanceId} activeEvent={activeEvent} guardPreludeDone={guardPreludeDone} attackPreludeDone={attackPreludeDone} summonPreludeDone={summonPreludeDone} />)}{!stableBoards.brother.length && <span className="empty-board">ユウタの場は空</span>}</div>
      <div className="hand-zone">{brotherHand.map((item) => <AnimatedBattleHandCard key={item.instanceId} instance={item} cards={cards} ace={item.instanceId === aceInstanceId} activeEvent={activeEvent} guardPreludeDone={guardPreludeDone} attackPreludeDone={attackPreludeDone} summonPreludeDone={summonPreludeDone} />)}</div>
      <BattleEffectLayer activeEvent={activeEvent} cards={cards} guardPreludeDone={guardPreludeDone} attackAfterglow={attackAfterglow} />
    </section>
    <BattleMessageWindow side="brother" name="ユウタ" marker="ユ" text={!battle.winner ? brotherDialogueEvent?.dialogue : undefined} leader={lifeBrother} hit={leaderHitSide === "brother"} portraitSrc={tanjunBustSmile} />
    {/* The battle log is modal-only; the launcher and pause surface are rendered below. */}
    {!battle.winner && <div className="battle-controls"><BattleSpeedControls speed={speed} onChange={onSpeedChange} /><button onClick={onManualNext} disabled={auto || playbackBusy}>ターンを進める</button><button className="primary-action" onClick={onAuto} disabled={auto || playbackBusy}>{auto ? "自動再生中…" : "最後までスキップ"}<span>▶</span></button></div>}
    <BattleLogModal open={logOpen} recent={recent} cards={cards} opponentName={opponent.name} onOpen={() => setLogOpen(true)} onClose={() => setLogOpen(false)} />
    {cutIn?.visible && <BattleCutIn kind={cutIn.kind} />}
    {playbackComplete && battle.winner && <div className="result-overlay"><div className={"result-burst " + (battle.winner === "brother" ? "win" : "lose")}><span>{battle.winner === "brother" ? "VICTORY!" : battle.winner === "draw" ? "DRAW" : "DEFEAT"}</span><h1>{battle.winner === "brother" ? "ユウタの勝利！" : battle.winner === "draw" ? "引き分け！" : opponent.name + "の勝利！"}</h1><p>{battle.winner === "brother" ? "デッキは狙い通りに仕事をしただろうか？" : "次の相手とのバトルへ進もう。"}</p>{postBattleDialogue && <div className="post-battle-commentary"><Speech speaker={child.displayName} text={postBattleDialogue} /></div>}<button className="primary-action" onClick={onFinish}>{finalBattle ? "結果を見る" : "次の相手へ"}<span>▶</span></button></div></div>}
  </main>;
}

function ClearScreen({ run, cards, child, opponents, onTitle }: { run: RunState; cards: Card[]; child: ChildProfile; opponents: OpponentDefinition[]; onTitle: () => void }) {
  const opponentById = new Map(opponents.map((opponent) => [opponent.id, opponent]));
  return <main className="clear-screen"><section className="clear-panel"><span className="section-kicker">ARCADE CLEAR</span><h1>6戦完走！</h1><section className="run-results"><h2>バトルの記録</h2>{run.battleResults.map((result, index) => <div className="run-result-row" key={`${result.opponentId}-${index}`}><span>{index + 1}戦目</span><strong className={result.outcome}>{result.outcome === "win" ? "○" : result.outcome === "loss" ? "×" : "△"}</strong><b>{opponentById.get(result.opponentId)?.name ?? result.opponentId}</b></div>)}</section><section className="run-facts"><div className="run-fact"><span>受動介入</span><strong>{run.summary.passiveInterventions}回</strong><small>支持 {run.summary.passiveSupports} / 却下 {run.summary.passiveRejects}</small></div>{child.showCrush !== false && <div className="run-fact"><span>一目惚れで入った札</span>{run.summary.loveCardIds.length ? <ul>{run.summary.loveCardIds.map((cardId, index) => <li key={`${cardId}-${index}`}>{cards.find((card) => card.id === cardId)?.name ?? cardId}</li>)}</ul> : <strong>なし</strong>}</div>}<div className="run-fact"><span>最後のシンクロ状態</span><strong>{syncStageLabel(run.summary.finalSync, child)}</strong></div></section><button className="primary-action" onClick={onTitle}>タイトルへ<span>↻</span></button></section></main>;
}

export default function Home() {
  const [cards, setCards] = useState<Card[]>([]);
  const [child, setChild] = useState<ChildProfile | null>(null);
  const [opponents, setOpponents] = useState<OpponentDefinition[]>([]);
  const [synergyConfig, setSynergyConfig] = useState<SpeciesSynergyConfig | null>(null);
  const [game, setGame] = useState<SavedGame>(defaultSave);
  const [hydrated, setHydrated] = useState(false);
  const [autoBattle, setAutoBattle] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<PlaybackSpeed>(loadPlaybackSpeed);
  const [reaction, setReaction] = useState<KidReaction | null>(null);
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null);
  const [pickFlash, setPickFlash] = useState<PickFlash | null>(null);
  const [pendingGame, setPendingGame] = useState<SavedGame | null>(null);
  const [autoPick, setAutoPick] = useState<{ key: string; phase: AutoPickPhase } | null>(null);
  useLandscapeStage();

  useEffect(() => {
    Promise.all([
      fetch("./data/cards.json").then((response) => response.json()),
      fetch("./data/children/tanjun.json").then((response) => response.json()),
      fetch("./data/opponents.json").then((response) => response.json()),
      fetch("./data/species.json").then((response) => response.json()),
    ])
      .then(([cardData, childData, opponentData, speciesData]) => { setCards(cardData); setChild(childData); setOpponents(opponentData); setSynergyConfig(speciesData); setGame(loadSavedGame(localStorage.getItem(SAVE_KEY)) ?? createDefaultSave(childData.sync.initial)); setHydrated(true); });
  }, []);

  useEffect(() => { if (hydrated) localStorage.setItem(SAVE_KEY, JSON.stringify(game)); }, [game, hydrated]);

  // Hold the taken card on screen just long enough for its glow, then swap in the next offer.
  useEffect(() => {
    if (!pendingGame || !pickFlash) return;
    const timer = window.setTimeout(() => {
      setGame(pendingGame);
      setPendingGame(null);
      setPickFlash(null);
    }, pickFlash.duration ?? PICK_FLASH_MS[pickFlash.strength]);
    return () => window.clearTimeout(timer);
  }, [pendingGame, pickFlash]);

  useEffect(() => {
    if (game.battle?.winner) setAutoBattle(false);
  }, [game.battle?.winner]);

  const byId = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const autoPickOfferKey = game.phase === "draft" && game.draft && game.offer && !game.adviceOpen && !pickFlash && (!game.offer.wantsIntervention || game.offer.decision.love)
    ? `${game.draft.seed}:${game.draft.pick}:${game.offer.cards.map((card) => card.id).join(",")}`
    : null;

  function nextNormalOffer(draft: DraftState): SavedGame {
    if (!child) return game;
    if (draft.pick >= 15) return { ...game, phase: "deck", draft, offer: null, adviceOpen: false };
    if (isAdviceDue(draft, child)) return { ...game, phase: "draft", draft, offer: null, adviceOpen: true };
    const generated = generateOffer(draft, cards, child);
    return { ...game, phase: "draft", draft: generated.state, offer: generated.offer, adviceOpen: false, battle: null };
  }

  function clearPickFlash() {
    setPickFlash(null);
    setPendingGame(null);
    setAutoPick(null);
  }

  function beginArcade() {
    if (!child) return;
    setAutoBattle(false);
    setReaction(null);
    setSyncNotice(null);
    clearPickFlash();
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    setGame({ ...createDefaultSave(child.sync.initial, seed), phase: "mode" });
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
    clearPickFlash();
    const seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
    const draft = createDraft(seed, child, game.run.carrySync);
    const generated = generateOffer(draft, cards, child);
    setGame({ ...game, phase: "draft", draft: generated.state, offer: generated.offer, adviceOpen: false, battle: null });
  }

  function takePick(index?: 0 | 1, autoConfirmDuration?: number, hand?: { style: HandStyle; timing: HandTiming }) {
    if (!game.draft || !game.offer || !child || pickFlash) return;
    const offer = game.offer;
    const ruled = offer.source === "normal" && offer.wantsIntervention && !offer.decision.love && index !== undefined;
    const supported = ruled && index === offer.decision.preferredIndex;
    if (ruled) {
      const lines = supported ? child.dialogue.support : child.dialogue.reject;
      setReaction({ tone: supported ? "support" : "reject", text: lines[game.draft.pick % lines.length] });
    } else {
      setReaction(null);
    }
    const beforeStage = syncStage(game.draft.syncRate, child);
    const next = resolveOffer(game.draft, game.offer, child, index);
    const nextStage = syncStage(next.syncRate, child);
    setSyncNotice(nextStage > beforeStage ? { stage: nextStage, label: syncStageLabel(next.syncRate, child) } : null);

    const kidPicked = !offer.wantsIntervention || offer.decision.love;
    const strength: PickFlash["strength"] | null = supported ? "burst" : kidPicked ? "soft" : null;
    const committed = nextNormalOffer(next);
    if (!strength) { setGame(committed); return; }
    setPickFlash({
      strength,
      index: ruled && index !== undefined ? index : offer.decision.preferredIndex,
      ...(autoConfirmDuration !== undefined ? { duration: autoConfirmDuration } : {}),
      // Only the kid's own picks get the hand: a ruling is the brother's call, not his grab.
      ...(hand && strength === "soft" ? { hand } : {}),
    });
    setPendingGame(committed);
  }

  useEffect(() => {
    if (!autoPickOfferKey) {
      setAutoPick(null);
      return;
    }
    setAutoPick((current) => current?.key === autoPickOfferKey ? current : { key: autoPickOfferKey, phase: "mulling" });
  }, [autoPickOfferKey]);

  useEffect(() => {
    if (!autoPick || !autoPickOfferKey || autoPick.key !== autoPickOfferKey || !game.draft || !game.offer || !child) return;
    const timing = BUILD_PICK_TIMING[playbackSpeed];
    const delay = autoPick.phase === "mulling"
      ? timing.mulling + timing.mullingPause
      : timing.decision;
    const timer = window.setTimeout(() => {
      if (autoPick.phase === "mulling") {
        setAutoPick((current) => current?.key === autoPick.key ? { ...current, phase: "deciding" } : current);
        return;
      }
      setAutoPick((current) => current?.key === autoPick.key ? { ...current, phase: "confirming" } : current);
      const handTiming = HAND_TIMING[playbackSpeed][DEFAULT_HAND_STYLE];
      const handPlays = handTotal(handTiming) > 0;
      // Hold the offer until the hand has finished, so the grab is never cut off by the next pick.
      takePick(undefined, handPlays ? Math.max(timing.confirm, handTotal(handTiming)) : timing.confirm, handPlays ? { style: DEFAULT_HAND_STYLE, timing: handTiming } : undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [autoPick, autoPickOfferKey, playbackSpeed, game.draft?.pick, game.offer?.wantsIntervention, game.offer?.decision.love, child, pickFlash]);

  function chooseAdvice(category: Exclude<AdviceCategory, "skip">, targetSpecies?: Species) {
    if (!game.draft || !child) return;
    const adviceLines = child.dialogue.advice;
    setReaction({ tone: "support", text: adviceLines[game.draft.pick % adviceLines.length] });
    // The order only tilts the offer pool from here on; the next pick is an ordinary one.
    const next = applyAdvice(game.draft, category, child, targetSpecies);
    const generated = generateOffer(next, cards, child);
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
    clearPickFlash();
    const opponentId = getCurrentOpponentId(game.run);
    const opponent = opponentId ? getOpponentById(opponents, opponentId) : undefined;
    if (!opponent) return;
    const battle = createBattle(game.draft.deck, opponent, cards, game.draft.seed ^ 0xa5a5a5a5, game.draft.syncRate, aceCardId, synergyConfig);
    setGame({ ...game, phase: "battle", battle, aceCardId });
  }

  function finishBattle() {
    if (!game.draft || !game.battle?.winner || !child) return;
    const nextRun = advanceRun(game.run, game.draft, game.battle.winner, child);
    setAutoBattle(false);
    setGame({ ...game, phase: isRunComplete(nextRun) ? "clear" : "opponent", draft: null, offer: null, adviceOpen: false, battle: null, run: nextRun, aceCardId: null });
  }

  function advanceCurrentBattle() {
    setGame((current) => {
      if (!current.battle || !child) return current;
      const opponentId = getCurrentOpponentId(current.run);
      const opponent = opponentId ? getOpponentById(opponents, opponentId) : undefined;
      return opponent ? { ...current, battle: advanceBattle(current.battle, cards, child, opponent) } : current;
    });
  }

  function advanceCurrentRound() {
    setGame((current) => {
      if (!current.battle || !child) return current;
      const opponentId = getCurrentOpponentId(current.run);
      const opponent = opponentId ? getOpponentById(opponents, opponentId) : undefined;
      if (!opponent) return current;
      let battle = advanceBattle(current.battle, cards, child, opponent);
      if (!battle.winner) battle = advanceBattle(battle, cards, child, opponent);
      return { ...current, battle };
    });
  }

  function changePlaybackSpeed(next: PlaybackSpeed, startBattle = false) {
    setPlaybackSpeed(next);
    window.localStorage.setItem(PLAYBACK_SPEED_KEY, next);
    if (startBattle) {
      if (next === "skip") setAutoBattle(true);
      else if (playbackSpeed === "skip") setAutoBattle(false);
    } else {
      setAutoBattle(false);
    }
  }

  function returnToTitle() {
    if (!child) return;
    setAutoBattle(false);
    setReaction(null);
    setSyncNotice(null);
    clearPickFlash();
    setGame(createDefaultSave(child.sync.initial));
  }

  const currentOpponentId = getCurrentOpponentId(game.run);
  const currentOpponent = currentOpponentId ? getOpponentById(opponents, currentOpponentId) : undefined;

  function renderScreen() {
  if (!hydrated || !child || !synergyConfig || cards.length !== 96 || opponents.length === 0) return <main className="boot-screen"><div className="logo-burst"><span>NOW LOADING</span><b>カードをまぜてるぞ！</b></div></main>;
  if (game.phase === "title") return <main className="title-screen"><div className="halftone" /><section className="title-copy"><span className="prototype-label">DECK BUILD SUPPORT GAME / PROTOTYPE</span><h1><small>兄ちゃん！</small>俺のデッキ<br />作って！</h1><p>好きなカードは、変えたくない。<br /><b>だから兄ちゃん、勝てる形にしてくれよ！</b></p><button className="primary-action title-start" onClick={beginArcade}>ゲームを始める！<span>▶</span></button><div className="save-note">途中経過はこのブラウザに自動保存</div></section><section className="title-cards"><div className="tilted-card one"><CardFace card={byId.get("zexvain")!} /></div><div className="tilted-card two"><CardFace card={byId.get("dolguard")!} intervention /></div><div className="title-shout">「カッコいい」で<br />勝ちたいんだ！</div></section><footer>15 PICKS · 2 ADVICES · 1 AUTO BATTLE</footer></main>;
  if (game.phase === "mode") return <ModeSelectScreen onSelect={selectMode} />;
  if (game.phase === "character") return <CharacterSelectScreen onSelect={selectCharacter} />;
  if (game.phase === "opponent" && currentOpponent) return <OpponentPreviewScreen opponent={currentOpponent} battleNumber={game.run.currentBattle + 1} onStart={startDraft} />;
  if (game.phase === "draft" && game.draft) return <DraftScreen draft={game.draft} offer={game.offer} cards={cards} child={child} adviceOpen={game.adviceOpen} reaction={reaction} syncNotice={syncNotice} pickFlash={pickFlash} autoPickPhase={autoPick?.phase ?? null} synergyConfig={synergyConfig} speed={playbackSpeed} onSpeedChange={(speed) => changePlaybackSpeed(speed)} onPick={takePick} onAdvice={chooseAdvice} />;
  if (game.phase === "deck" && game.draft) return <DeckScreen draft={game.draft} cards={cards} child={child} reaction={reaction} synergyConfig={synergyConfig} onBattle={prepareBattle} />;
  if (game.phase === "ace" && game.draft) return <AceSelectionScreen draft={game.draft} cards={cards} selectedCardId={game.aceCardId ?? null} onSelect={selectAceCard} onConfirm={() => startBattle()} onSkip={() => startBattle(null)} />;
  if (game.phase === "battle" && game.battle && currentOpponent) return <BattleScreen battle={game.battle} cards={cards} child={child} opponent={currentOpponent} onNext={advanceCurrentBattle} onManualNext={advanceCurrentRound} onAuto={() => setAutoBattle(true)} auto={autoBattle} onFinish={finishBattle} finalBattle={game.run.currentBattle === game.run.opponentIds.length - 1} speed={playbackSpeed} onSpeedChange={(speed) => changePlaybackSpeed(speed, true)} />;
  if (game.phase === "clear") return <ClearScreen run={game.run} cards={cards} child={child} opponents={opponents} onTitle={returnToTitle} />;
  return <main className="boot-screen"><button className="primary-action" onClick={returnToTitle}>タイトルへ</button></main>;
  }

  return (
    <>
      <div className="landscape-stage">{renderScreen()}</div>
      <RotateNotice />
    </>
  );
}
