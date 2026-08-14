# 修正指示 2026-08-12 — 地形を水域ポリゴンに譲らせる(格子ノードの高さだけを下げる)

対象ファイル: `js/legacy/part6.js`(地形)、`js/legacy/part4.js`(水域)、`js/legacy/part9.js`(1行追加)
1変更 = 1コミット。**この指示以外のことは一切やらないこと。**

---

## 1. 実測の根拠(2026-08-12 NY・ハドソン川河口)

```
0m:   water=7.30  terrain=7.92  ground=7.71
50m:  water=7.30  terrain=8.16  ground=7.81
200m: water=7.30  terrain=8.88  ground=8.68
playerY=8.06  seaY=7.30
```

- `water=7.30` は `seaY` と完全一致。**海面ポリゴンは正しく存在している**
- しかし `terrain` が 7.92〜8.88 で、**海面より 0.6〜1.6 上**
- 結果、ニューヨーク湾一面が緑の地面として描かれる(ユーザー報告・スクリーンショット確認済み)

真因は **DEMが水域の上に正の標高値を返していること**。DEMは陸の製品で、水域上の値は測定されて
いない(提供側が内挿や既定値で埋めた値)。`DESIGN_20260804_WATER.md` の前提そのもの。

**海面を上げて逃げてはいけない。** 2026-08-04 に `seaYOffset` を上げて直したのは
「landFloorM による底上げ」が原因のケース。今回は DEM の実値なので、上げれば今度は岸より
高くなる。高さで追いかけると必ず上へ逃げていく(2週間の往復の構造そのもの)。

---

## 2. 方針

> **地形格子のノードが水域ポリゴンの内側にあるなら、そのノードの高さをDEMから取らず、
> 水面より少し下に置く。**

ジオメトリの切除ではなく、`nearElev` / `wideElev` の**配列要素を1つ書き換えるだけ**。

過去に失敗した2つとは別物であることを明記しておく:

| 失敗した手法 | なぜ今回は踏まないか |
|---|---|
| 地形に穴を開ける(terrain hole) | 切らない。三角形の構成は一切変えない |
| Sutherland-Hodgman の半平面逐次交差 | クリップしない。点が内側かを判定するだけ |

境界セルの三角形は、内側ノード(下げた)と岸ノード(下げない)を結ぶ**水際へ向かう斜面**に
自然になる。陸パッチも黒い穴も発生しない。

---

## 3. 変更内容

### (1) `part4.js` — 地形を下げるための厳密判定を1つ足す

既存の `waterSurfaceYAt` は橋のクリアランス用に `WATER_QUERY_MARGIN = 20` の**外側マージン**を
持っている。地形を下げる用途にそれを使うと岸を20m削るので、**専用の厳密版**を作る。

```js
// 【2026-08-12】地形格子ノードを水面下へ落とすための判定。waterSurfaceYAt と違い
//   ・外側マージンを持たない(岸を削らないため)
//   ・さらに WATER_BED_INSET だけ内側に入っていることを要求する
//   ・複数の水域が重なる場合は「最も低い水面」を返す(max を使わない。高い方に合わせると
//     もう一方の水面が地形に埋もれるため)
//   ・waterProfile 未確定(地形データ待ち)の面は対象外。_waterYAt が getGroundY を
//     返すため、地形→水位→地形 の帰還ループになる
const WATER_BED_INSET = 40;  // 輪郭からこれだけ内側のノードだけを下げる(m)
const WATER_BED_DROP  = 0.6; // 水面からこれだけ下に置く(ゲーム単位)

function waterBedYAt(x, z) {
  let best = null;
  for (const e of queryPolyGrid(areaPolyGrid, x, x, z, z)) {
    if (e.kind !== 'flat') continue;
    // 【重要】海(固定水面)だけを対象にする。川・池は地形に沿う実装になったので
    // 地形を下げる必要が無く、下げると _waterYAt が getGroundY を返す関係で
    // 地形→水面→地形 の帰還ループになる。
    if (e.fixedY == null) continue;
    if (x < e.minX || x > e.maxX || z < e.minZ || z > e.maxZ) continue;
    if (!pointInPolygon(x, z, e.pts)) continue;
    if (_nearPolygonBoundary(x, z, e.pts, WATER_BED_INSET)) continue; // 岸際は下げない
    if (e.holes) {
      let inHole = false;
      for (const hp of e.holes) { if (hp.length >= 4 && pointInPolygon(x, z, hp)) { inHole = true; break; } }
      if (inHole) continue; // 中州は陸なので下げない
    }
    const y = _waterYAt(e, x, z);
    if (best === null || y < best) best = y; // 最小を採る
  }
  return best === null ? null : best - WATER_BED_DROP;
}
```

### (2) `part6.js` — 地形を作る瞬間に適用する

`loadWideTerrain` と `loadNearTerrain` の両方で、`arr` を埋めるループの**直後**、
`wideElev = arr` / `nearElev = arr` の**直前**に入れる。

```js
// 【2026-08-12】DEMは水域の上に測定されていない正の値を返す。そのまま描くと海面・川面が
// 地形の下に隠れる(NYで実測: 海面7.30 に対し地形7.92〜8.88)。水域ポリゴンの内側の
// ノードだけ、DEMではなく水面基準の高さにする。ポリゴンは実測輪郭なのでこれが忠実。
if (typeof waterBedYAt === 'function') {
  let k = 0;
  for (let iz = 0; iz < WIDE_SEGS1; iz++)
    for (let ix = 0; ix < WIDE_SEGS1; ix++, k++) {
      const wx = centerX - WIDE_W/2 + ix * WIDE_W / WIDE_SEGS;
      const wz = centerZ - WIDE_D/2 + iz * WIDE_D / WIDE_SEGS;
      const bed = waterBedYAt(wx, wz);
      if (bed !== null && bed < arr[k]) arr[k] = bed;
    }
}
```

`loadNearTerrain` 側は `NEAR_SEGS1 / NEAR_W / NEAR_D` に読み替えて同じものを入れる。
**`pts` を作ったときと完全に同じ添字の回し方(`iz` 外側・`ix` 内側)にすること。**
順序を取り違えると地形がXZ転置する。

### (3) `part4.js` — 水域が地形より後に届いた場合の回収経路

水域ポリゴンは地形より後に届くことが多い。そのときは既存の格子を後から直す必要がある。
**ポリゴン1枚ごとにメッシュを作り直すと重すぎるので、範囲をためて低頻度で1回だけ適用する。**

```js
// 【2026-08-12】水域が地形より後に届いた場合の回収経路。ポリゴンごとに即時反映すると
// updateFarMesh が何百回も走るため、影響範囲(bbox)を union で溜めて低頻度で1回だけ適用する。
let _waterBedDirty = null; // {minX,maxX,minZ,maxZ} or null
function markWaterBedDirty(minX, maxX, minZ, maxZ) {
  if (!_waterBedDirty) _waterBedDirty = { minX, maxX, minZ, maxZ };
  else {
    _waterBedDirty.minX = Math.min(_waterBedDirty.minX, minX);
    _waterBedDirty.maxX = Math.max(_waterBedDirty.maxX, maxX);
    _waterBedDirty.minZ = Math.min(_waterBedDirty.minZ, minZ);
    _waterBedDirty.maxZ = Math.max(_waterBedDirty.maxZ, maxZ);
  }
}
let _waterBedScanFrame = 0;
function scanWaterBedLowering() {
  _waterBedScanFrame++;
  if (_waterBedScanFrame % 90 !== 0) return; // scanPendingAreaWaterPolys と同じ周期
  if (!_waterBedDirty) return;
  const d = _waterBedDirty;
  _waterBedDirty = null;
  let changed = 0;
  changed += _lowerGridInBounds(nearElev, nearCX, nearCZ, NEAR_W, NEAR_D, NEAR_SEGS, NEAR_SEGS1, d);
  changed += _lowerGridInBounds(wideElev, wideCX, wideCZ, WIDE_W, WIDE_D, WIDE_SEGS, WIDE_SEGS1, d);
  console.log('[waterbed] lowered nodes=' + changed +
    ' bounds=' + Math.round(d.minX) + ',' + Math.round(d.minZ) +
    '..' + Math.round(d.maxX) + ',' + Math.round(d.maxZ));
  if (changed > 0) {
    updateFarMesh(true); // 地形メッシュを新しい高さで作り直す
    rebuildAreaPolysInBounds(d.minX, d.maxX, d.minZ, d.maxZ);
    if (typeof rebuildRoadsInBounds === 'function') rebuildRoadsInBounds(d.minX, d.maxX, d.minZ, d.maxZ);
  }
}
// grid の該当範囲のノードだけを走査して下げる。下げた件数を返す。
function _lowerGridInBounds(grid, cX, cZ, W, D, SEGS, SEGS1, d) {
  if (!grid) return 0;
  const stepX = W / SEGS, stepZ = D / SEGS;
  const x0 = cX - W / 2, z0 = cZ - D / 2;
  let ix0 = Math.max(0, Math.floor((d.minX - x0) / stepX));
  let ix1 = Math.min(SEGS, Math.ceil((d.maxX - x0) / stepX));
  let iz0 = Math.max(0, Math.floor((d.minZ - z0) / stepZ));
  let iz1 = Math.min(SEGS, Math.ceil((d.maxZ - z0) / stepZ));
  let n = 0;
  for (let iz = iz0; iz <= iz1; iz++)
    for (let ix = ix0; ix <= ix1; ix++) {
      const k = iz * SEGS1 + ix;
      const bed = waterBedYAt(x0 + ix * stepX, z0 + iz * stepZ);
      if (bed !== null && bed < grid[k]) { grid[k] = bed; n++; }
    }
  return n;
}
```

呼び出し元(この2箇所だけ):

- `_commitWaterPoly(...)` の末尾 → `markWaterBedDirty(minX, maxX, minZ, maxZ)`
- `buildFixedFlatAreaPoly(...)`(海)で entry を作った直後 → `markWaterBedDirty(entry.minX, entry.maxX, entry.minZ, entry.maxZ)`

### (4) `part9.js` — スキャナを1行足す

1129行付近、`scanPendingAreaWaterPolys();` の**直後**に:

```js
scanWaterBedLowering(); // 【2026-08-12】水域内の地形ノードを水面下へ落とす低頻度スキャン(part4.js)
```

---

## 4. 触ってはいけないもの

- `seaYOffset()` / `seaLevelY()` / `LAND_FLOOR_MARGIN_M` — **1mmも動かさない**。高さで追いかけると必ず上へ逃げる
- `waterSurfaceYAt` の `WATER_QUERY_MARGIN = 20` — 橋のクリアランス用。地形用は別関数にした
- **川・池の水面** — `IMPL_PROMPT_20260812_RIVER_DRAPES_ON_TERRAIN.md` で地形に沿う実装に変更済み・実機確認済み(相模川OK)。地形を下げる対象は**海だけ**
- `fixedY` を持たない面(= 川・池)— 対象外にしないと 地形→水面→地形 の帰還ループになる
- 地形の三角形分割・チャンク生成・`side: DoubleSide` — 一切触らない

---

## 5. 既知の限界(直さないこと。認識だけ合わせる)

地形格子は 200m。**水際は最大200mずれる。** 内側ノードを下げ、岸ノードを下げないので、
その間の三角形が水面と交わる点が見かけの汀線になる。実測輪郭より最大1セルぶん内外する。

これは「地形に穴を開ける」で200mずれたのと同じ制約だが、今回は**穴もパッチも作らない**ので
黒い面・陸の消失にはならない。精度を上げたくなったら格子を細かくする話であって、
ポリゴン切除に戻る話ではない。

---

## 6. 検証手順(ユーザーが実施)

1. デプロイ後、PC Chrome + DevTools で NY(ハドソン川河口・ジャージーシティ沖)へ、60秒待つ
2. コンソールに貼る(貼り直し不要の1行):

```js
(()=>{const px=player.position.x,pz=player.position.z;const r=[];for(const d of[0,50,200,600]){const w=waterSurfaceYAt(px+d,pz),t=terrainYOrNull(px+d,pz),g=getGroundY(px+d,pz);r.push(d+'m: water='+(w==null?'なし':w.toFixed(2))+' terrain='+(t==null?'欠測':t.toFixed(2))+' ground='+g.toFixed(2));}return r.join(' | ')+' || playerY='+player.position.y.toFixed(2)+' seaY='+(seaLevelY()+seaYOffset()).toFixed(2)})()
```

**合格条件**

- 水面のある地点で `terrain` が `water` より **低い**(現在は 0.6〜1.6 高い)
- `[waterbed] lowered nodes=` が正の値で出る。0 のままなら判定が効いていない
- 見た目: ニューヨーク湾・ハドソン川が水面になる
- 伊勢原・東京でも、陸が水没していないこと(**これが一番怖い退行**)

**不合格の見分け**

- 陸が水没する → `WATER_BED_INSET` を 40 → 80 へ上げる。**それ以外は触らない**
- 汀線がガタつく → 200m格子の既知の限界。**高さで直そうとしない**
- `lowered nodes=0` のまま → 海面ポリゴン(`fixedY` を持つ面)が届いていないか、
  `WATER_BED_INSET` が広すぎて内側ノードが1つも残っていない。
  `areaPolyMeshes.filter(e=>e.fixedY!=null).length` を数える

---

## 7. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "terrain: lower grid nodes inside water polygons to just below the water surface, so DEM values fabricated over water no longer hide the sea"; git push
```
