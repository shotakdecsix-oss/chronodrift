# 実装指示 ⑤:地面を landuse で塗り分ける(B-3)

## 着手前に必ず

```
grep -n "terrainColorRGB\|updateFarMesh\|terrainMat\|FAR_SEGS\|FAR_STEP" js/legacy/part5.js
grep -n "landuseTypeAt\|landusePolygons\|landuseGrid" js/legacy/part1.js
grep -n "landusePolygons" js/legacy/part4.js
```

## 前提(調査済みの事実)

1. **landuse ポリゴンは既に取得・保持されている。**
   - `landusePolygons`(`part1.js:1928`)+ 空間ハッシュ `landuseGrid`
   - 参照関数:`landuseTypeAt(x, z)`(`part1.js:973`)
   - 取得タグ:`residential | commercial | industrial | retail | mixed_use | farmland | orchard | meadow | allotments | forest`
2. **しかし現在の用途は「建物の見た目を決めること」だけ。** `part3.js:44`(商業/工業区画ならオフィス寄りの外観)、`part8.js`(手続き生成の可否 `buildable()`)、`part4.js:1501`(`isFarm` 判定)。
3. **地面の色は標高だけで決まっている。** `terrainColorRGB(h)`(`part5.js:146-157`)。低地の緑 → 山地の深緑 → 岩 → 雪。landuse は一切参照していない。
4. 地形マテリアルは `MeshLambertMaterial({ vertexColors: true })`(`part5.js:25`)。**頂点カラーを差し替える口は既に開いている。**
5. 地形メッシュは `FAR_SIZE = 12000` / `FAR_SEGS = 60` → **格子は 200m 間隔**。頂点数は 61×61 = 3,721。

## 目的

伊勢原の平野が住宅地も水田も畑も**まったく同じ緑1色**になっている状態を解消し、地面に情報を持たせる。

## 方針:頂点カラーに弱くブレンドする(案A のみ)

`updateFarMesh` の頂点色計算で、`terrainColorRGB(h)` の結果に `landuseTypeAt(x, z)` 由来の色を**弱くブレンド**する。混合比は 0.3〜0.4 程度から始めて調整。

色の割り当て案:

| landuse | 方向性 |
|---|---|
| `farmland` / `meadow` / `allotments` | 黄緑〜明るい緑 |
| `orchard` | やや暗めの緑 |
| `forest` | 濃い緑 |
| `residential` | 灰みがかった緑 |
| `commercial` / `retail` / `industrial` / `mixed_use` | 灰色寄り |
| なし(null) | 従来どおり(ブレンドしない) |

**200m格子なので境界はぼやける。それでよい。** 「この一帯は田んぼ、あの一帯は住宅地」という**面の傾向が伝われば成功**。

## 実装上の罠(ここが唯一の要注意点)

**`landusePolygons` はタイル取得のたびに増減する。** `part4.js:1090` 付近で、破棄されたタイル分のポリゴンが削除され `landuseGrid` が再構築されている。

頂点色を焼き込んだままだと**古い色が残る**、あるいは**landuse が後から届いた場所が緑のまま**になる。対策:

- `updateFarMesh` を **landuse の増減があったときにも再実行**する。
- ただし毎回フル再計算すると重い可能性があるので、**「landuse が変わった」フラグを立てて次のメッシュ更新時にまとめて反映**する形にする。
- ⚠ フラグを握りつぶす実装にしないこと。過去に `_dirty` を握りつぶして水面バグの主因になった前科がある([[project_isehara_game_water_poly_budget_retry]])。

## やらないこと

- **案B(landuse ポリゴンを板として地面に重ねる)は絶対にやらない。**
  水面ポリゴンとまったく同じ構造の問題(地形との z-fighting、地形が遅れて届いたときのズレ、ポリゴン予算切れ)を招く。あの10回以上の往復を再演することになる。
- **`farNodeY` / `farSurfaceY` / `getGroundY` には一切触らない。** 地形の高さ・水面・海岸線の合意事項がすべてそこに集約されている。**このタスクは色だけを変える。高さは1mmも変えない。**
- 時代モードの分岐を壊さない。`terrainColorRGB` には `space` / `edo` / `marchen` の分岐がある。**landuse ブレンドは `現実` と `明治` だけに適用**し、他モードは従来どおりにする。

## 性能について

- 頂点数 3,721 に対して `landuseTypeAt` を呼ぶだけ。`landuseTypeAt` は空間ハッシュ(`queryPolyGrid`)を使っているので十分速いはず。
- ただし **`updateFarMesh` の呼ばれる頻度を確認すること**。もし毎フレーム呼ばれているなら、landuse 参照を足すのは避け、キャッシュを挟む。

## 完了判定

1. 上空(🕊 バードビュー)から見て、市街地・田畑・森が色で見分けられる。
2. 歩いていて、田んぼの一帯と住宅地の一帯の地面の色が違う。
3. **FPS が変化していない**(DevTools の Performance で before/after を比較)。
4. 遠方へジャンプして戻ってきても、前の場所の色が残っていない。
5. 時代モードを 江戸 / メルヘン / 宇宙 に切り替えると、従来どおりの色になる。
6. **水面・橋・海岸線の見た目が一切変わっていない**(高さに触っていないことの確認)。
