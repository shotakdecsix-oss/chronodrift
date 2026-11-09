# 実装指示: ニューヨークで陸が水面になる(暫定クランプが海に効いている)

作成: 2026-08-05 / 実機報告「相模川周辺は改善。NYはまだ陸が水面になる部分がある」

**変更は1箇所・数行。** `IMPL_PROMPT_20260805_WATER_FIX3.md` の修正1〜3は実装済みの前提。

---

## 1. 原因

`js/legacy/part4.js:817` `_waterYAt` の暫定クランプが、**水域の種別を問わず全部に効いている。**

```js
const y = m0 + (m1 - m0) * t + entry.yOff;
if (typeof window !== 'undefined' && !window.WATER_CONFORMING_CUT) {
  return Math.max(y, getGroundY(x, z) + LEGACY_WATER_MARGIN);   // ★ 海(固定Y)にも効く
}
return y;
```

このクランプは「適合カット(`DESIGN_20260804_WATER.md` 4章)が入るまで、
水面が地形に隠れないようにする繋ぎ」として入れたもの。**川には必要だが、海には有害。**

### 何が起きるか

- coastline の **Phase2 はタイル矩形(1600m四方)を丸ごと海として描く**(`part4.js:1358`)。
- 先に入れた `ribbonCount === 0` のゲートは **地形マスクの可否だけ**を制御していて、
  **描画は従来どおり全タイルで行われる**(ここが見落としやすい)。
- 従来は海面が実標高0m固定だったため、**陸(`landFloorM` = 0.5m以上)がポリゴンを
  突き抜けて見えていた** → 実害なし。
- クランプが入ると海面が `地形 + LEGACY_WATER_MARGIN(0.45)` に持ち上がり、
  **タイル全域で地形に貼り付く毛布**になる → **陸が水面になる。**

### なぜNYだけか

NYは `natural=coastline` が密で Phase2 タイルが多い(ログの `[coastline] tile ...` 参照)。
相模川の内陸側は Phase2 がほとんど発生しないため出ない。
**「相模川は改善したがNYは駄目」という差がそのまま裏付けになっている。**

---

## 2. 修正

**固定Y(海)のエントリをクランプの対象外にする。**
海は実標高0m固定が正しく、そこより高い陸が見えているのが正常な状態。

```js
// js/legacy/part4.js _waterYAt
const y = m0 + (m1 - m0) * t + entry.yOff;
// 【2026-08-05・NY実機】海(buildFixedFlatAreaPoly / levelSource='sea-fixed')は実標高0m固定が
// 正しく、地形に追従させてはいけない。追従させると coastline Phase2 のタイル全塗り(1600m矩形)が
// 陸を覆う毛布になり、陸が水面として描かれる。クランプは川(bank-min)専用の繋ぎ。
const isFixedSea = entry.levelSource === 'sea-fixed' || entry.waterKind === 'sea';
if (!isFixedSea && typeof window !== 'undefined' && !window.WATER_CONFORMING_CUT) {
  return Math.max(y, getGroundY(x, z) + LEGACY_WATER_MARGIN);
}
return y;
```

判定は `levelSource`/`waterKind` のどちらか一方でも足りるが、
**両方見ておく**(`buildFixedFlatAreaPoly` は `levelSource='sea-fixed'` を設定し、
`waterKind` は呼び出し経路によって未設定のことがあるため)。

---

## 3. 検証

**リロードしてから、NYと相模川の両方**を見る。

1. **NY**: マンハッタン南端・ジャージーシティ側の**陸が水面になっていないこと**
2. **NY**: 海(ハドソン川・湾)は従来どおり水面として見えること
3. **相模川**: 前回の改善が維持されていること(**デグレしていないこと**)

**この段階でも「浮き」は評価しない。** クランプで意図的に浮かせている状態のため。

---

## 4. 次段への申し送り(重要)

**このクランプ自体が適合カットまでの繋ぎ。**
`window.WATER_CONFORMING_CUT` を立てるコミットで、

- `_waterYAt` のクランプブロックを**丸ごと削除**する
- 同時に今回の `isFixedSea` 分岐も消える(繋ぎのための分岐なので残す意味がない)

残すと「水面が浮く」失敗モードが復活し、`min` 基準に変えた意味が消える。

---

## 5. 大原則への追記

31. **「暫定の安全策」は、適用範囲を最小に絞って入れる。**
    今回のクランプは川の可視性のために入れたが、種別を絞らなかったため
    海にも適用され、**別の場所で新しい破綻を生んだ。**
    暫定策こそ「どの条件で効くか」を明示的に書く。全体に効かせない。

32. **ゲートを足したとき、それが「描画」と「判定」のどちらを止めているのかを明記する。**
    `ribbonCount === 0` は地形マスクだけを止めていて描画は止めていない。
    この区別が曖昧だと、「Phase2は除外したはず」という誤った安心を生む。
