# CLAUDE.md

「兄ちゃん！俺のデッキ作って！（仮）」の開発ガイドです。ChatGPT(Codex)で作ったプロトタイプを移行したものを起点にしています。

## 最重要の構造制約

**`src/core/` はDOM・React非依存を維持すること。**

`src/core/` はゲームロジックの純粋な実装です。以下を絶対に持ち込まないでください。

- `react` / `react-dom` のimport
- `document`, `window`, `localStorage`, `navigator`, `HTMLElement` などのブラウザAPI

UIとの接続は `src/App.tsx` 側で行います。`src/core/` は `data/` のJSONを引数として受け取り、結果を返すだけに保ってください。この制約のおかげで `npm test` と `npm run simulate` がブラウザなしで動きます。

例外は `src/core/core.test.ts` のみで、テストのため `node:fs` / `node:path` / `node:test` を使います。

## データはJSON外出し、コード直書き禁止

カード・キャラクター・対戦相手のデータは `data/` 配下のJSONに置きます。TypeScriptに直接書かないでください。数値調整のためにコードを触る必要がない状態を保つのが方針です。

- `data/cards.json` — カードプール（40種）
- `data/children/tanjun.json` — 決定表、信頼度、台詞、提示重み

開発サーバ起動中にJSONを編集すると `public/data/` へ自動同期され、画面が再読み込みされます（`vite.config.ts` の `externalGameData` プラグイン）。`public/data/` は生成物なのでgit管理外です。

### 既知の例外: opponents.ts

`src/core/opponents.ts` だけは対戦相手データ（デッキ構成・台詞・faceBias）がコード直書きのままです。これは移行時点からの既知の負債で、**次の実装時に `data/opponents.json` へ外出しする予定**です。それまでの間、新しい対戦相手を増やす場合もここに追記して構いませんが、外出し前提の形を崩さないでください。

## 仕様であって、バグではないもの

以下は意図的な設計です。「おかしい」と見えても修正しないでください。

### 決定表で④美的スコアが最下位にあること

弟の二択判断は `src/core/decision.ts` で次の順に評価されます。

1. 一目惚れ（美的スコアが `loveThreshold` 以上なら他をすべて飛ばす）
2. モンスター優先
3. 低コスト優先
4. 高攻撃力優先
5. **美的スコア**
6. 先に提示された方

美的スコアが通常判断の最下位にあるのは仕様です。弟は「カッコよさ」で選ぶキャラですが、それは①の一目惚れで表現されており、一目惚れに至らない範囲では素直なカード効率で選びます。この非対称さがキャラクターの核なので、⑤を上位へ動かさないでください。`decisionOrder` の順序は `data/children/tanjun.json` にも記録されており、テストで固定されています。

### 除去不足83%

除去が不足したまま完成するデッキが約83%を占めますが、これは**意図的に残した固定の欠損**です。バランス調整の対象ではありません。兄（プレイヤー）の介入余地を作るための設計なので、確率を下げる方向の「修正」をしないでください。

## TODO

- [ ] `data/opponents.json` への対戦相手データ外出し（上記の既知例外）
- [ ] vite の脆弱性対応（`npm audit` で high 1件 / vite 8.0.13）。`server.fs.deny` バイパスと launch-editor のNTLMハッシュ漏洩で、いずれも開発サーバ側の問題。修正には vite 8.2.0 以降への更新が必要。**今回は未対応、意図的に先送り**
- [ ] `docs/` に設計文書（企画書・プロトタイプ仕様書）を配置

## 環境上の注意

**プロジェクトパスに日本語を含めないこと。** vite 8 が使うRolldownのネイティブバインディングが非ASCIIパスでクラッシュし（`0xC0000409`）、`npm run dev` も `npm run build` もエラーメッセージなしで即死します。移行時に `OneDrive\ドキュメント\` 配下からこの場所へ移したのはこのためです。テストはネイティブバインディングを使わないため日本語パスでも通ってしまい、原因が分かりにくいので注意してください。

Node.js 22以上が必要です。

## 検証コマンド

```bash
npm test              # src/core/ のユニットテスト（8件）
npm run simulate -- 200000
npm run build         # tsc --noEmit のあと vite build
```

`npm run simulate` の20万周時の基準値は、一目惚れ約2.8回、受動介入約6回、欠損数約2.03です。ロジックを触ったらこの値から大きくずれていないか確認してください。

## 公開

`main` へのpushで `.github/workflows/deploy.yml` がGitHub Pagesへデプロイします（リポジトリ設定でPagesのSourceを「GitHub Actions」にする必要があります）。`vite.config.ts` の `base` は `"./"` で、データ取得も `fetch("./data/...")` と相対パスなので、ユーザーサイト・プロジェクトサイトのどちらでも動きます。この相対前提を崩すため、階層URLを持つルーターを入れる場合は `base` とfetchの両方を見直してください。
