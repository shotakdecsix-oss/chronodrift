# 実装指示: 設計変更後の2つの破綻を止める(修正A・B)

作成: 2026-08-05 / 対象コミット `7459cea`(DESIGN_20260804_WATER.md の実装)後の実機報告
「陸であるべき場所が水面扱い」「川が大きな四角の集まりになる」への対処。

**どちらも小さい。まずこの2つだけを1コミットで入れて、実機で四角が消えることだけを確認する。**

---

## 症状と原因の対応

| 症状 | 原因 | 修正 |
|---|---|---|
| 陸であるべき場所が水面扱いになる | coastline **Phase2 のタイル全塗り**が地形マスクに入っている | **A** |
| 川が大きな四角の集まりになる | 水位が `min` になったが**適合カットが未実装**で、水が地形に隠れ、200mセルの穴だけが見えている | **B** |

**Bは実装順の設計ミス(私の指示)。** `min` 水位と適合カット(`DESIGN_20260804_WATER.md` 4章)は
**同時に入らないと正しい中間状態が存在しない**。カットが入るまでは暫定クランプで凌ぐ。

---

## 修正A: 地形マスクの入力を実形状ポリゴンに限定する

### A-1. `buildFixedFlatAreaPoly` に `maskTerrain` を足す

`js/legacy/part4.js:1014`

```js
// 変更前
function buildFixedFlatAreaPoly(pts, mat, yOff, fixedY, holes) {
// 変更後(既定は false = マスクしない。近似ポリゴンを足したとき自動でマスクされない側に倒す)
function buildFixedFlatAreaPoly(pts, mat, yOff, fixedY, holes, maskTerrain) {
```

同関数内の `_markWaterNodes(entry, true);`(現 `:1034` 付近)を条件付きにする。

```js
if (maskTerrain) _markWaterNodes(entry, true);
entry.maskedTerrain = !!maskTerrain;   // ★ 破棄時に対で外すため必ず記録する
```

**破棄側も必ず対にすること。** `_markWaterNodes(e, false)` を呼んでいる2箇所
(現 `:1379` / `:1511` 付近)を `if (e.maskedTerrain) _markWaterNodes(e, false);` にする。
これを忘れると参照カウントが減らず、陸が永久に消えたままになる。

`buildAreaPoly`(`natural=water` / `riverbank` = OSM実測輪郭)側は**従来どおり常にマスクする**。

### A-2. 呼び出し側で明示する

| 行 | 何を塗るか | `maskTerrain` |
|---|---|---|
| `:1258` Phase1 ribbon | 陸側の縁が実測 coastline | **`true`** |
| `:1321` Phase2 whole-tile | 5点多数決の近似(1600m矩形) | **`ribbonCount === 0`** |

```js
// :1321
buildFixedFlatAreaPoly(wholeTile, waterAreaMat, WATER_VISUAL_MARGIN, seaY, holes,
                       ribbonCount === 0);
```

**理由**: coastline がこのタイルを1本も通っていない(`ribbonCount === 0`)なら、
そのタイルは本当に開けた海なのでマスクしてよい。
`ribbonCount > 0` のタイルは Phase1 の ribbon が正しい海側を既にマスクしているので、
Phase2 は**描画のみ**に留める(近似で陸を消さない)。

`ribbonCount` はログ出力(現 `:1328`)で既に数えている変数をそのまま使う。
**宣言位置が `:1321` より後なら、カウント処理ごと Phase2 の前へ移動すること**
(移動できない構造なら、Phase1 で ribbon を積んだ配列の length を見る)。

---

## 修正B: 適合カットが入るまでの暫定クランプ

`js/legacy/part4.js:768` `_waterYAt` の末尾、プロファイル由来の値を返す直前に入れる。

```js
// 【2026-08-05・暫定】DESIGN_20260804_WATER.md 4章の適合カットが入るまでの繋ぎ。
// 水位を物理的に正しいmin基準へ変えたが、地形を輪郭で切る側が未実装のため、
// 岸寄りのセルで水面が地形の下に隠れ、200mセルの穴だけが見える(=川が四角の集まりに見える)。
// カットが入るまでは、地形より必ず上に来る下限を張って可視性を優先する。
// 【重要】カットを入れたコミットで、このブロックごと必ず削除する。
// 残すと「水面が浮く」失敗モードが復活し、min化の意味が消える。
const y = m0 + (m1 - m0) * t + entry.yOff;
if (!window.WATER_CONFORMING_CUT) {
  return Math.max(y, getGroundY(x, z) + LEGACY_WATER_MARGIN);
}
return y;
```

```js
const LEGACY_WATER_MARGIN = 0.45; // 旧 WATER_MARGIN(0.3) + yOff(0.15) 相当のゲーム単位
```

`window.WATER_CONFORMING_CUT` は既定 `undefined`(= クランプ有効)。
4章を実装したコミットで `true` を立て、同時に上のブロックを削除する。

---

## 検証(この2つだけを見る)

1. **四角の集まりが消え、川が連続した水面として見えること**(修正B)
2. **ガバナーズ島・リバティ島・埠頭など、陸が消えていないこと**(修正A)
3. 一度離れて戻ったとき、陸が消えたままになっていないこと(A-1の破棄側の対漏れ検出)

**浮きの評価はこの段階ではしないこと。** クランプで意図的に浮かせているので、
今それを見ても直せない問題を見ていることになる。浮きの判定は適合カット後に行う。

---

## 次段への申し送り

`DESIGN_20260804_WATER.md` の実装順は誤りだった。正しくはこう:

| # | 内容 | 単独で出せるか |
|---|---|---|
| 1 | 水域エンティティ化・種別判定 | ○(済) |
| 2 | 岸サンプルによる水位決定(min) | **✕ 3とセット** |
| 3 | **適合カット(4章)** | **✕ 2とセット** |
| 4 | `WATER_VISUAL_MARGIN` / `seaYOffset` 撤去、`surfaceY` 差し替え | ○ |
| 5 | 旧コード削除 | ○ |

**2と3は1コミットで入れる。** 片方だけでは、水が地形に隠れるか(今回)、
水が地形に浮くか(以前)のどちらかに必ずなる。

> **大原則への追記 26**
> 「Aを入れてからBを入れる」と分割するとき、**Aだけが入った中間状態が
> 成立するかを必ず確認する。** 成立しないなら、それは分割してはいけない1つの変更。
> 今回の min 化と適合カットは、互いの前提を打ち消し合う関係にあった。
