import type { OpponentDefinition } from "./types";

export const OPPONENTS: OpponentDefinition[] = [
  {
    id: "wall",
    name: "ゴウダ",
    title: "鉄壁番長",
    color: "#3867d6",
    faceBias: 0.22,
    intro: "オレの鉄壁陣を、お前のデッキで抜けるかな！",
    taunts: ["そんな貧弱な攻撃でオレの壁を抜けるつもりか！", "守りを崩す札がなけりゃ、ここで終わりだ！", "どうした？ 手札の切り札は飾りかよ！"],
    deck: ["dolguard","dolguard","gaiorg","gaiorg","lilibel","lilibel","fiorina","fiorina","grim","grim","holyblade","judgment","steel-blessing","phoenixeed","drakevine"],
  },
  {
    id: "rush",
    name: "ハヤテ",
    title: "電光石火",
    color: "#ef3e36",
    faceBias: 0.92,
    intro: "守るヒマなんてやらねえ！ 一気に決めるぜ！",
    taunts: ["遅い遅い！ 重いカードを抱えてる場合かよ！", "場に残れないモンスターじゃ、オレは止まらないぜ！", "守りが薄い！ そのまま押し切る！"],
    deck: ["noelka","noelka","flamebullet","flamebullet","balga","balga","dolga","dolga","mewrin","mewrin","shadowkite","shadowkite","followarrow","thunder","alvine"],
  },
];

