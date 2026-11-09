# 実装指示: 残り3件(陸パッチが黒い / 遠方の黒い帯 / キルスイッチ)

作成: 2026-08-05 / 実機の切り分け結果を反映。**上から順に、1件ずつ別コミットで。**

---

## 前提: 切り分け済みの事実

| 観測 | 意味 |
|---|---|
| パッチのマテリアルを `MeshBasicMaterial(red)` に差し替えたら**黒が赤い帯になった** | ジオメトリ・座標は正しい。**属性かライティングの問題** |
| 陸に見える地点で `pointInPolygon` が **`[]`** | 「河川敷が水域としてマッピングされている」説は**棄却** |
| `描画セル数 3444 / 3600`、`パッチ三角形 14606`、`NaN 0` | 地形はほぼ描かれている。黒は欠損ではない |
| `maskNodes 75` / `足元isWater false`(近傍) | 近傍の黒はマスク由来ではない |

**訂正**: 直前に「`_pushQuad` の巻き順が裏返っているのでは」と伝えたが、
現在の並び `[[x0,z0],[x0,z1],[x1,z0]]` / `[[x0,z1],[x1,z1],[x1,z0]]` は
外積を計算すると**両方とも +Y**。巻き順は正しい。原因は下記1が有力。

---

## 修正1【最有力】パッチの `normal` 属性が古いまま使い回されている

`updateFarMesh` は毎回こうしている:

```js
farBoundaryPatchGeo.setAttribute('position', new THREE.Float32BufferAttribute(patchPos, 3));
farBoundaryPatchGeo.setAttribute('color',    new THREE.Float32BufferAttribute(patchCol, 3));
farBoundaryPatchGeo.setIndex(null);
farBoundaryPatchGeo.computeVertexNormals();
```

**`position` と `color` は毎回新しい属性に差し替えているが、`normal` は差し替えていない。**

`BufferGeometry.computeVertexNormals()` は、既に `normal` 属性が存在する場合
**それを再利用する**(無ければ position.count に合わせて新規作成する)。
境界セル数はプレイヤーの移動や水域の読み込みで毎回変わるため、
**`normal.count < position.count` になった瞬間、はみ出した頂点への書き込みは
TypedArray の範囲外書き込みとして黙って捨てられ、法線が (0,0,0) のまま残る。**

法線ゼロ + `MeshLambertMaterial` = **光が当たらない = 真っ黒**。
`MeshBasicMaterial` はライティングを無視するので赤く見えた。観測と完全に一致する。

頂点数が増えるほど黒い領域が増えるので、**端末・タイミングで見え方が変わる**のも説明が付く。

### 確認(実装前に1回)

```js
const g = farBoundaryPatchGeo, p = g.attributes.position, n = g.attributes.normal;
console.log('pos.count', p.count, 'normal.count', n ? n.count : 'none');
console.log('normal[0]',    n.getX(0), n.getY(0), n.getZ(0));
console.log('normal[last]', n.getX(p.count-1), n.getY(p.count-1), n.getZ(p.count-1));
```

**`normal.count < pos.count`、または `normal[last]` が `0 0 0`** なら確定。

### 修正

```js
farBoundaryPatchGeo.setAttribute('position', new THREE.Float32BufferAttribute(patchPos, 3));
farBoundaryPatchGeo.setAttribute('color',    new THREE.Float32BufferAttribute(patchCol, 3));
farBoundaryPatchGeo.setIndex(null);
farBoundaryPatchGeo.deleteAttribute('normal');   // ★ 毎回作り直させる
farBoundaryPatchGeo.computeVertexNormals();
farBoundaryPatchGeo.computeBoundingSphere();
```

**併せて `terrainPatchMat` を廃止し、`terrainMat` を共用する。**
差分は `side: THREE.DoubleSide` だけで、巻き順が正しい以上不要。
複製マテリアルを持つと設定が将来ドリフトする。

> 元のコメントにある「巻き順を一致させる保証が無いのでDoubleSideで保険」は誤り。
> **`MeshLambertMaterial` は頂点シェーダでライティングするため、
> DoubleSide でも裏返った法線は救えない**(`gl_FrontFacing` が使えない)。
> 保険にならないので、コメントごと差し替えること。

---

## 修正2 遠方の黒い帯: マスクの寿命をメッシュの寿命に合わせる

`unloadFarAreaPolys`(part4.js:1447)は距離 `AREA_POLY_UNLOAD_DIST` を超えた水面の
**GPUメッシュだけを解放**し(`entry.mesh = null`)、**地形マスクを外していない。**

`_markWaterNodes(e, false)` を呼んでいるのは `dropAreaRecordsInTile` と
`evictFarAreaPolys`(`ROAD_RECORD_KEEP_DIST` ≈ 6000m)だけ。
→ **`AREA_POLY_UNLOAD_DIST` 〜 6000m の帯は「穴は開いたまま、水面は描かれない」= 黒。**
`farMesh` は ±6000m あるので、上空視点ではこの帯が画面の大半を占める。

### 修正

「開けてよいか(能力)」と「今開けているか(状態)」を分け、冪等にする。

```js
// entry.maskTerrain : 能力(実形状ポリゴンなら true。coastline Phase2 の近似は false)
// entry.masked      : 現在の状態
function setWaterMask(entry, on) {
  if (!entry.maskTerrain) return;
  if (!!entry.masked === !!on) return;
  _markWaterNodes(entry, on);
  entry.masked = !!on;
}
```

| 場所 | 呼び出し |
|---|---|
| `_instantiateAreaPolyMesh` 成功直後 | `setWaterMask(entry, true)` |
| `unloadFarAreaPolys` のメッシュ解放(:1466-1468) | **`setWaterMask(entry, false)`** ← 現在欠落 |
| `unloadFarAreaPolys` の再接近再構築(:1462) | `setWaterMask(entry, true)` |
| `dropAreaRecordsInTile` / `evictFarAreaPolys` | `setWaterMask(entry, false)` |

**`buildAreaPoly` / `buildFixedFlatAreaPoly` 末尾の直接呼び出しは削除し、
`_instantiateAreaPolyMesh` の1箇所に集約すること。** 生成経路が2つあると、
また片方だけ直す事故になる。

---

## 修正3 キルスイッチ(独立・最小)

```js
// part4.js _isWaterNode(:662)の先頭
function _isWaterNode(i, j) {
  if (window.TERRAIN_HOLES === false) return false;
  return waterNodeMask.has(i + ',' + j);
}
```

前回コンソールで叩いても効かなかったのは、これが入っていないため。
**これが無いと今後も毎回「穴あけが原因か」を切り分けられない。**

---

## 修正4【NYで陸が水面になる】暫定クランプを海(固定Y)に適用しない

2026-08-05 実機: 相模川周辺は改善。**ニューヨークでまだ陸が水面になる。**

原因は `_waterYAt`(part4.js:828)の暫定クランプが**全種別に効いていること**。

```js
if (typeof window !== 'undefined' && !window.WATER_CONFORMING_CUT) {
  return Math.max(y, getGroundY(x, z) + LEGACY_WATER_MARGIN);   // ★ 海にも効く
}
```

- coastline **Phase2 はタイル矩形(1600m)を丸ごと**海として描く(`:1358`)。
  `ribbonCount === 0` のゲートは**マスクだけ**の話で、**描画は従来どおり全タイル**。
- 以前は海面が実標高0m固定だったので、**陸(0.5m以上)がポリゴンを突き抜けて見えていた**
  = 実害なし。
- ところがクランプが入ると、海面が `地形 + 0.45` に持ち上がり
  **タイル全域で地形の上に貼り付く毛布**になる。→ **陸が水面になる。**

NYは coastline が密でPhase2タイルが多いため顕在化し、相模川内陸では出にくい。

### 修正

**固定Y(海)のエントリはクランプの対象外にする。** 海は実標高0m固定が正しく、
そこより高い陸が見えるのが正常な状態。

```js
const y = m0 + (m1 - m0) * t + entry.yOff;
// 【重要】海(buildFixedFlatAreaPoly / levelSource='sea-fixed')は実標高0m固定が正しい。
// 地形に追従させると、Phase2のタイル全塗りが陸を覆う毛布になる(2026-08-05 NY実機)。
const isFixedSea = entry.levelSource === 'sea-fixed' || entry.waterKind === 'sea';
if (!isFixedSea && typeof window !== 'undefined' && !window.WATER_CONFORMING_CUT) {
  return Math.max(y, getGroundY(x, z) + LEGACY_WATER_MARGIN);
}
return y;
```

**このクランプ自体が適合カットまでの繋ぎ**なので、`WATER_CONFORMING_CUT` を立てる
コミットでブロックごと削除すること(修正4の分岐も一緒に消える)。

---

## 検証

**PCとスマホの両方**で、リロードしてから見る(コンソールでマテリアルを差し替えた状態は無効)。
**相模川(内陸の川)とNY(海岸+Phase2タイル)の両方**を必ず見ること。
片方だけだと、一方の修正が他方を壊しているのに気づけない。

1. 川沿いの黒い帯が消えているか(修正1)
2. 遠方の黒い帯が消えているか(修正2)
3. どちらか残っていたら `window.TERRAIN_HOLES = false; updateFarMesh(true);`
   → **消えるなら穴あけ側、消えないなら別原因**。ここで次の切り分けが1回で決まる

**この段階では「浮き」を評価しないこと。** `WATER_CONFORMING_CUT` のクランプが
まだ効いていて意図的に浮かせている。浮きの判定はクランプを外す次段で行う。

---

## 大原則への追記

29. **毎フレーム/毎更新で作り直す BufferGeometry は、全属性を同時に作り直す。**
    `position` だけ差し替えて `normal` を再利用すると、
    要素数が増えたときに範囲外書き込みが黙って捨てられ、
    法線ゼロ=真っ黒という「エラーにならない壊れ方」をする。

30. **保険として入れた設定が、本当に保険になっているかを確認する。**
    `side: DoubleSide` は巻き順ミスの保険のつもりだったが、
    `MeshLambertMaterial`(頂点シェーダでライティング)では機能しない。
    **効かない保険は、症状を「見えない」から「黒い面」に変えるだけで、
    原因の特定を遅らせる。**
