# 実装指示: 陸パッチを「半平面交差」から「サブセル・ラスタ化」へ置き換える

作成: 2026-08-05 / 実機報告「謎の黒いエリア」「陸・建物が水面扱い」「川が大きな四角」への対処。
`DESIGN_20260804_WATER.md` 4章(適合カット)の実装方式の差し替え。

---

## 0. 原因は確定している(「推定」ではない)

現在 `part5.js` のコメントは「原因は推定される」となっているが、**確定できる。**

`part4.js:1139` `computeLandPatchPolygon` は、セル矩形を
**水域ポリゴンの辺1本ずつの半平面で順に切って**いる。

```js
for (const a,b of ring の全辺) {
  poly = _clipPolyByEntryEdgeLandSide(poly, entry, a.x, a.z, b.x, b.z);
  if (poly.length < 3) return poly;   // ← ここに落ちる
}
```

**半平面の逐次交差(Sutherland-Hodgman)は、クリップ側の多角形が凸である前提を必要とする。**
川・海岸線の輪郭は激しく非凸なので、全辺の半平面を交差させると
真の陸側よりはるかに小さい領域になり、多くのセルで空になる。

同じ指摘が `part4.js:1167-1170` のコメントに既にある:

> 半平面の逐次交差(旧v3実装)は被クリップ側=タイルが凸である前提が必要だが、
> 現実の海岸線は湾曲・入江で非凸なため、直線近似のクリップだと
> 「地図に忠実じゃない」形になっていた

**海岸線リボンで v3→v4 で潰した誤りが、陸パッチで再発している。**

3つの症状はすべてここから説明できる:

| 症状 | 説明 |
|---|---|
| 黒いエリア | 境界セルで陸パッチが空 → `farGeo` も `farBoundaryPatchGeo` も何も描かない穴 |
| 陸・建物が水面 | 同上。地形が消え、奥の水面(河口なので Phase2 の1600m海タイル矩形)が見える |
| 川が大きな四角 | 見えている青の輪郭が、川の形ではなく「陸パッチの崩れた範囲 + 200m内部穴 + Phase2矩形」の合成 |

**ロールバック(境界セルを通常の2三角形に戻す)は既に入っている。現状は「岸線が最大200m粗いが壊れてはいない」状態。**
以下はその上に正しい方式で積み直す指示。

---

## 1. 方針: 多角形クリップをやめ、サブセル・ラスタ化にする

境界セル(4隅のうち1〜3隅が水面内側)を **25m格子(8×8)に割り、
サブセルの中心が水域の外なら陸として三角形を張る。**

- 判定は `pointInPolygon` のみ。**非凸・自己交差・多重リング・中州のどれにも壊れない。**
- 数値的な例外ケース(平行辺・退化辺・端点一致)が原理的に存在しない。
- 岸線の誤差は **200m → 12.5m**(サブセル半分)。残る誤差の帯は水面ポリゴン(実輪郭)が覆う。

**正しさより先に「壊れないこと」を取る。** 多角形ブーリアン(Weiler-Atherton等)は
正確だが、この規模のコードベースで縮退ケースまで正しく実装・検証するのは現実的でない。

---

## 2. 実装

### 2-1. 水域内外判定(マスクと必ず同じ集合を使う)

```js
// part4.js — _markWaterNodes が対象にしているのと「完全に同じ」entry集合で判定すること。
// ここがズレると、内部穴(ノードマスク)と境界パッチ(ラスタ)の境目に隙間や重なりが出る。
function isWaterPointForMask(x, z) {
  for (const e of queryPolyGrid(areaPolyGrid, x, x, z, z)) {
    if (e.kind !== 'flat' || !e.maskedTerrain) continue;   // ★ maskTerrain=false の近似ポリゴンは無視
    if (x < e.minX || x > e.maxX || z < e.minZ || z > e.maxZ) continue;
    if (!pointInPolygon(x, z, e.pts)) continue;
    if (e.holes && e.holes.some(hp => hp.length >= 4 && pointInPolygon(x, z, hp))) continue;
    return true;
  }
  return false;
}
```

**`_markWaterNodes` の内側判定も、この関数を使う形にリファクタして共通化すること。**
2箇所に同じ判定を書くと、片方だけ直した時に境目が壊れる(このプロジェクトで繰り返している事故)。

### 2-2. 境界セルのラスタ化

`part5.js` `updateFarMesh` のセルループ。

```js
const SUB = 8;                       // 25m(= FAR_STEP / SUB)
const waterCount = (wa?1:0)+(wb?1:0)+(wc?1:0)+(wd?1:0);
if (waterCount === 4) continue;                       // 完全に水 → 穴
if (waterCount === 0) { idxArr.push(a, b, d, b, c, d); continue; }  // 完全に陸 → 従来どおり
// 境界セル → farGeo には張らず、パッチ側へラスタ化して積む
_pushLandPatchRaster(i0 + jx, j0 + jz, patchPos, patchCol, SUB);
```

```js
// part5.js
function _pushLandPatchRaster(ni, nj, vertsPos, vertsCol, SUB) {
  const cx0 = ni * FAR_STEP, cz0 = nj * FAR_STEP, s = FAR_STEP / SUB;
  for (let sj = 0; sj < SUB; sj++) {
    for (let si = 0; si < SUB; si++) {
      const x0 = cx0 + si * s, z0 = cz0 + sj * s, x1 = x0 + s, z1 = z0 + s;
      if (isWaterPointForMask(x0 + s / 2, z0 + s / 2)) continue;   // 中心が水 → 張らない
      // 【重要】分割の向きは親セル(a,b,d / b,c,d)と揃える。farSurfaceY の面と誤差を最小にする
      _pushQuad(x0, z0, x1, z1, vertsPos, vertsCol);
    }
  }
}
function _pushQuad(x0, z0, x1, z1, vertsPos, vertsCol) {
  const P = [[x0,z0],[x0,z1],[x1,z0], [x0,z1],[x1,z1],[x1,z0]]; // a,b,d / b,c,d と同じ巻き順
  for (const [x, z] of P) {
    const h = farSurfaceY(x, z);            // ★ 必ず farSurfaceY。描画面との不変条件
    vertsPos.push(x, h, z);
    const c = terrainColorRGB(h - FAR_Y);
    vertsCol.push(c[0], c[1], c[2]);
  }
}
```

**セル境界に隙間(T-junction)は出ない。** サブ頂点は `farSurfaceY` から高さを取り、
セルの辺上では `farSurfaceY` は2ノード間の線形補間なので、
隣接する完全陸セル(`farGeo` が描く)の辺と厳密に一致する。

### 2-3. 三角形数の抑制(任意・後回し可)

素直に実装すると境界セル1枚で最大 64サブセル × 2三角形 = 128三角形。
境界セルが数百枚なら数万三角形になる。気になる場合は
**行方向に連続する陸サブセルを1枚の矩形にまとめる**(ランレングス結合)だけで大幅に減る。
判定結果は変わらないので、後から足しても見た目は一切変わらない。

### 2-4. 旧コードは削除する

`computeLandPatchPolygon` と `_clipPolyByEntryEdgeLandSide`、`LAND_PATCH_EDGE_MARGIN` は
**削除すること。** 「部分的なデバッグ・再挑戦のため残す」と現状のコメントにあるが、
方式が誤っていると確定した以上、残すと必ず誰かが再度有効化する。
`farBoundaryPatchMesh` / `terrainPatchMat` / `_pushLandPatchTriangles` の器は
そのまま流用してよい(中身の生成方法だけ差し替える)。

---

## 3. 検証

1. **黒いエリアが出ないこと**(どのセルも「穴」か「陸(全面 or ラスタ)」のいずれかになる)
2. **陸・建物が水面扱いにならないこと**
3. **川の輪郭が四角の集まりではなく、実際の川筋に沿うこと**(誤差12.5m)
4. 相模川河口(平塚)と NY(ハドソン)の両方で確認する
   —— 前者は Phase2 海タイルが絡む河口、後者は幅1.5kmの大河川で、
   崩れ方が違うので**両方見ないと片方の修正が他方を壊しているのに気づけない**
5. 一度離れて戻ったとき、陸が消えたままにならないこと(マスク参照カウントの対漏れ検出)

**この段階でも「浮き」の評価はしないこと。** `WATER_CONFORMING_CUT` のクランプが
まだ効いているので、意図的に浮かせている状態。浮きの判定はクランプを外す次段で行う。

---

## 4. 大原則への追記

27. **アルゴリズムの前提条件(凸性・単純性・向き)は、コメントではなくコードで守る。**
    Sutherland-Hodgman は「クリップ側が凸」を要求する。この前提はコードのどこにも
    書かれず、非凸な川の輪郭に対して静かに誤った答えを返した。
    前提を満たせないなら、**前提を必要としない方式(ラスタ化)を選ぶ。**

28. **同じ誤りを2度目に踏んだら、それは知識ではなく設計の問題。**
    半平面交差の非凸問題は、海岸線リボン v3→v4 で一度潰し、
    その理由がコード内コメントに残っていた。それでも陸パッチで再発した。
    **「過去に潰した誤り」は、コメントではなく共有ユーティリティとして封じる**
    (例: 「非凸多角形を扱う関数は `pointInPolygon` 経由のラスタ判定しか使わない」を規約にする)。
