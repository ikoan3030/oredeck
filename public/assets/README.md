# public/assets/

画面から参照する画像素材を置く場所です。ここに入れたものは vite がそのまま配信し、`/assets/...` で参照できます。

**採用が確定したものだけを置いてください。** 生成時のプロンプトや没案などの元データは `assets-draft/`（git管理外）に残します。

## フォルダ

| フォルダ | 用途 |
|---|---|
| `characters/` | キャラクター素材（手、バストアップ、立ち絵） |
| `cards/` | カードイラスト（将来） |
| `icons/` | 種族アイコン等のUI小物（将来） |

## 命名

キャラクター素材は `{キャラID}-{部位}-{バリエーション}.png` とします。キャラIDは `data/children/` のファイル名（`tanjun` など）に合わせてください。

- `tanjun-hand-open.png`
- `tanjun-bust-smile.png`

## 参照のしかた

CSSからは `url("/assets/characters/tanjun-hand-open.png")` のように絶対パスで書きます。`src/styles.css` はビルド後に `dist/assets/` へ出るため、CSSファイルからの相対パスは開発時とビルド後でずれます。

なお `vite.config.ts` の `base` は `"./"` です。プロジェクトサイト（`https://ユーザー名.github.io/リポジトリ名/`）へ配信する構成に変える場合は、この絶対パスも見直しが必要になります。その場合はCSSではなくTS側で `import handImage from "../public/assets/..."` の形にすると `base` に追従します。
