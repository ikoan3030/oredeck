# 兄ちゃん！俺のデッキ作って！（仮）

カードゲーム好きの弟が選んだ「好きなカード」を否定せず、偏りによって生じた欠損を兄が補修するビルド支援ゲームのプロトタイプです。

## 収録範囲

- 単純弟1人
- カード40種、15ピック、同一カード上限2枚
- 一目惚れ、受動介入、信頼度
- 5枚目・10枚目後の定点アドバイス
- 「除去／守護／低コスト／見送る」の4択
- 鉄壁デッキ、速攻デッキとのオート対戦
- 介入カードが実効的な仕事をした時だけ発生する帰責台詞
- `localStorage`による自動保存

## 開発開始

Node.js 22以上を使用します。

```bash
npm install
npm run dev
```

## Gitリポジトリとして初期化

```bash
git init -b main
git add .
git commit -m "Initial prototype"
```

GitHub上に空のリポジトリを作成した後は、表示されたURLを使って次のように接続します。

```bash
git remote add origin https://github.com/USER/REPOSITORY.git
git push -u origin main
```

## GitHub Pages

`.github/workflows/deploy.yml`を収録しています。GitHubのリポジトリ設定で、PagesのSourceを「GitHub Actions」にすると、`main`へのpushで公開されます。

Viteの`base`は相対パスに設定済みなので、ユーザーサイトとプロジェクトサイトのどちらでも動作します。

## データ調整

- `data/cards.json` — カードプール
- `data/children/tanjun.json` — 決定表、信頼度、台詞、提示重み

開発サーバー起動中にJSONを編集すると、`public/data/`へ自動同期して画面を再読み込みします。数値調整のためにTypeScriptを編集する必要はありません。

## 構造

```text
data/                  調整用JSON
src/core/              React・DOM非依存の純粋ロジック
src/App.tsx            UIとゲーム進行
src/styles.css         表示スタイル
scripts/simulate.ts    一括シミュレーション
```

## 検証

```bash
npm test
npm run simulate -- 200000
npm run build
```

20万周時の基準値は、一目惚れ約2.8回、受動介入約6回、欠損数約2.03です。
