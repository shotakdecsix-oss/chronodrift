# 修正指示 2026-08-12 — 川・池の水面を地形に沿わせ、水位の推定を全廃する

対象ファイル: `js/legacy/part4.js` のみ
1変更 = 1コミット。**この指示以外のことは一切やらないこと。**
特に**海(`buildFixedFlatAreaPoly` / `seaLevelY` / `seaYOffset` / `processCoastlineFill`)には触らない。**

---

## 1. なぜ方針を変えるか

DEMは陸の製品で、水域上の値は測定されていない。その値から水位を推定する限り、
推定を間違えれば水面は上へ逃げるか下へ沈む。実測でその両方が起きた。

```
2026-08-12 NY(推定方式・p10導入前): 水面Y 57.65 / 地形 13〜22  → 水面が頭上43に浮く
2026-08-12 NY(p10導入後):          川 water=12.03 / terrain=8.42 → 改善したが原理は同じ
```

**推定をやめる。** 水面はその場所の地形の真上に置く。これで2つの災害モードが定義上消える。

- 水面が上空に浮く → **不可能**(地形に貼り付いているので)
- 水面が地形の下に隠れる → **不可能**(常に地形より上なので)

代償は「水面が厳密に水平でなくなる」こと。ただし実測で **270枚中262枚が長辺1000m以下**、
中央値27m。200m格子の地形はその範囲でほぼ平坦なので、実害はほぼ無い。

海だけは別扱いのまま残す。海面は「平均海面と同じ高さ」という確かな事実があり、
遠景の海面プレーンとも段差を作れないため。**海は固定、それ以外は地形に沿う。**

---

## 2. 前提の確認(実装前に必ず読むこと)

`buildAreaPoly`(`entry.kind === 'flat'`)は **水域からしか呼ばれていない**。
公園・田畑・キャンパス・校庭は全て `buildTerrainFollowingAreaPoly`(`kind === 'terrain'`)。

```
part4.js:249  buildAreaPoly(pts, waterAreaMat, 0.15, holes)   ← _commitWaterPoly(川・池)のみ
part4.js:1056 buildFixedFlatAreaPoly(..., seaY, holes)        ← 海
part4.js:1103 buildFixedFlatAreaPoly(..., seaY, holes)        ← 海
```

`waterSurfaceYAt` の呼び出し元は **part3.js の道路・橋のみ**(4箇所)。
プレイヤーの足場判定は `getGroundY` を使っており、この変更の影響を受けない。

---

## 3. 変更内容

### (1) 海のエントリに `fixedY` を持たせる

`buildFixedFlatAreaPoly` の中で、偽のプロファイル

```js
entry.waterProfile = { ux: 1, uz: 0, sMin: 0, M: [fixedY] };
```

を削除し、代わりに

```js
entry.fixedY = fixedY; // 【2026-08-12】海だけは平均海面で水平に固定する
```

### (2) `_waterYAt` を2行にする

```js
// 【2026-08-12】水位の推定をやめた。DEMは水域上の値を測定していないため、そこから
// 水位を導く限り上に逃げるか下に沈む(実測で両方発生)。海だけ平均海面で水平に固定し、
// それ以外は地形の真上に置く。getGroundY(=farSurfaceY)は「描画される地形メッシュ表面と
// 厳密に一致する高さ」なので、水面は地形の平行オフセット面になる。
function _waterYAt(entry, x, z) {
  if (entry.fixedY != null) return entry.fixedY + entry.yOff; // 海
  return getGroundY(x, z) + entry.yOff;                        // 川・池
}
```

### (3) `waterSurfaceYAt` のフィルタから `waterProfile` を外す

```js
if (e.kind !== 'flat') continue;   // 旧: if (e.kind !== 'flat' || !e.waterProfile) continue;
```

`waterProfile` はもう存在しない。**ここを直し忘れると橋が全部水面を見失う。**

### (4) `rebuildAreaPolyMesh` の `flat` 分岐を簡素化する

プロファイル再計算のブロック(`entry.waterNodeInfo` を使う部分、`_waterProfileChanged` と
`rebuildRoadsInBounds` の呼び出しを含む)を丸ごと削除し、頂点Yの書き換えだけ残す。

```js
if (entry.kind === 'flat') {
  if (entry.fixedY != null) return; // 海は高さが変わらないので何もしない
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, _waterYAt(entry, x, z));
  }
}
```

> 地形が後から届いたときの追従は、`loadNearTerrain` / `loadWideTerrain` が
> `rebuildAreaPolysInBounds` を呼ぶ既存経路でそのまま効く。新しい仕組みは要らない。

### (5) 削除するもの(**全部消すこと。残すと死んだコードが次の誤読を生む**)

| 削除対象 | 場所 |
|---|---|
| `_collectWaterNodes` | part4.js |
| `_binLowPercentile`(および残っていれば `_binPercentileMax`) | part4.js |
| `_computeWaterProfileFromNodes` | part4.js |
| `_computeWaterProfile`(`[water] profile` のログごと) | part4.js |
| `_waterProfileChanged` | part4.js |
| `_isNearCoverage`(上の診断ログ専用) | part4.js |
| 定数 `WATER_BIN` / `WATER_FLAT_MAX_SPAN` / `WATER_MAX_SAMPLES` / `MAX_RISE_PER_BIN` / `WATER_MARGIN` | part4.js |
| `buildAreaPoly` 内の `entry.waterProfile = _computeWaterProfile(entry)` | part4.js |
| `entry.waterNodeInfo` への代入・参照すべて | part4.js |

`part5.js` の `farNodeYOrNull` は他から使われている可能性があるので**残す**。

### (6) 地形との競合を描画側で解決する

水面と地形はほぼ同じ高さになる。**これを高さで解決しようとしないこと**(それが2週間の往復の
原因だった)。深度バイアスとオフセットで解く。

```js
const waterAreaMat = new THREE.MeshBasicMaterial({
  color: MODE_CONF.water, side: THREE.DoubleSide,
  // 【2026-08-12】水面は地形の真上に貼り付くので、遠距離では深度バッファの精度で
  // 地形と混ざる(旧yOff=0.15では数km先で負けていた)。深度側でずらす。
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8
});
```

あわせて2つ:

- `_commitWaterPoly` の `buildAreaPoly(pts, waterAreaMat, 0.15, holes)` を **`0.5`** に
- `_instantiateAreaPolyMesh` の `subdivideTriangles(..., 100)`(最長辺100m)を **`50`** に
  — 水面の弦が地形の三角形をまたいで沈まないよう、分割を細かくする

---

## 4. 触ってはいけないもの

- **海**: `buildFixedFlatAreaPoly` の `fixedY` の値、`seaLevelY()`、`seaYOffset()`、`processCoastlineFill`、`seenCoastlineTiles`、海岸線ストアと保留の回収経路
- `LAND_FLOOR_MARGIN_M` と地形の底上げ
- `WATER_QUERY_MARGIN = 20`(橋のクリアランス用の外側マージン)
- `pendingAreaWaterPolys` の予算切れ再試行キュー
- `minimapWaterPolys` / `isNearWater` / ミニマップ描画
- 地形に穴を開ける / 適合カット — 今回は**そもそも地形を触らない**

---

## 5. 関連する別の指示書について

`IMPL_PROMPT_20260812_TERRAIN_YIELDS_TO_WATER.md`(地形ノードを水面下へ落とす)は、
**海だけが対象になる**。川は地形に沿うので、地形を下げる必要が無くなった。

あの指示書を実行する場合は、`waterBedYAt` の判定に次を足すこと:

```js
if (e.fixedY == null) continue; // 海(固定水面)だけを対象にする。川は地形に沿うので不要
```

**ただし、この指示書とあれを同時に入れないこと。** まずこちら(川)を単独で確認する。

---

## 6. 検証手順(ユーザーが実施)

1. デプロイ後、PC Chrome + DevTools で **NY(ハドソン川)** へ、60秒待つ
2. 貼り直し不要の1行:

```js
(()=>{const px=player.position.x,pz=player.position.z;const r=[];for(const d of[0,50,200,600]){const w=waterSurfaceYAt(px+d,pz),t=terrainYOrNull(px+d,pz),g=getGroundY(px+d,pz);r.push(d+'m: water='+(w==null?'なし':w.toFixed(2))+' terrain='+(t==null?'欠測':t.toFixed(2))+' ground='+g.toFixed(2));}return r.join(' | ')+' || playerY='+player.position.y.toFixed(2)+' seaY='+(seaLevelY()+seaYOffset()).toFixed(2)})()
```

3. **伊勢原(相模川)** と **東京** でも同じ

**合格条件**

- 川のある地点で `water` が `ground` より **ちょうど 0.5 上**。それ以外の値なら実装が違う
- `[water] profile` のログが **1行も出ない**(推定機構が消えた証拠)
- 見た目: 川が水面に見える。**上空に浮いた板が1枚も無い**
- 橋が水没していない

**不合格の見分け**

- 川の一部で地形が突き抜ける → `subdivideTriangles` の `50` を `25` へ。**それ以外は触らない**
- 遠距離でチラつく → `polygonOffsetUnits` を `-8` → `-16` へ。**高さ(0.5)は触らない**
- 橋が水没する → (3) の `waterProfile` フィルタを外し忘れている

**この変更で直らないもの(想定内。次のコミットで扱う)**

- ニューヨーク湾が緑の地面のまま → 海の問題。§5 の指示書が担当

---

## 7. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "water: drape river/lake surfaces on the terrain and delete all water-level estimation; sea stays fixed at mean sea level"; git push
```
