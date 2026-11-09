# 修正指示 2026-08-13 — 海の下の地形を海面より下げる(v2・海岸線から直接判定)

対象ファイル: `js/legacy/part4.js`(判定関数)、`js/legacy/part6.js`(地形)、`js/legacy/part9.js`(1行)
1変更 = 1コミット。**この指示以外のことは一切やらないこと。**

**`IMPL_PROMPT_20260812_TERRAIN_YIELDS_TO_WATER.md` は破棄する。** あれは実装・デプロイ・実機テストまで
進んだうえで `git revert` された。その版の欠陥は §2 に書く。

---

## 1. なぜ必要か(実測)

海面ポリゴンは正しくなった。しかし**湾はまだ緑の地面に見える**。

```
NY・実測: 海面Y=11.30 に対し、湾の上の地形が +0.6〜3 高い
```

DEMは陸の製品で、水域上の値は測定されていない。提供側が内挿や既定値で埋めた正の値を返すため、
地形メッシュが固定海面より上に来て、海が地形の下に隠れる。

**海面を上げて逃げてはいけない。** 上げれば今度は岸より高くなる。高さで追いかけるのが
2週間の往復の構造だった。地形側を下げる。

---

## 2. 前回版(revert済み)の欠陥 — 同じ失敗をしないために

前回は `[waterbed] lowered nodes=39` しか下がらず、しかも陸が水没した。原因は2つ。

**欠陥1: 余裕を測る相手を間違えていた。**

```js
if (_nearPolygonBoundary(x, z, e.pts, WATER_BED_INSET)) continue; // ← 矩形の縁から40m
```

海面ポリゴンは100m四方の矩形の集まりなので、40mの余裕を取ると**中央の20m帯しか残らない**。
隣接矩形が連なっていても各矩形の縁から40m以内なので、ほぼ全ノードが除外された。
`lowered nodes=39` はこれで説明がつく。

> **余裕は「海岸線」から測る。ポリゴンの縁から測らない。**

**欠陥2: 海面ポリゴンを判定の入力にしていた。**

当時のポリゴンは陸を36%巻き込んでいたため、下げた少数のノードが陸に当たり水没した。

> **今回はポリゴンを一切経由せず、海岸線から直接判定する。**

---

## 3. 実装

### (3-1) `part4.js` — 海底判定を1つ追加する

`isSeaPoint` / `coastlineSegs` / `coastlineRings` の直後に置く。

```js
// 【2026-08-13】DEMは水域の上に測定されていない正の値を返すため、そのまま描くと
// 海面が地形の下に隠れる(NY実測: 海面11.30 に対し地形が+0.6〜3)。
// 海岸線から直接「海であり、かつ岸から十分離れている」ノードだけを海面下へ落とす。
//
// 岸際を下げない理由(実測): 地形格子は200m間隔なので、汀線の陸側ノードと海側ノードの
// 間が線形補間になり、岸から200m以内は地形が海面から陸の高さへ滑らかに立ち上がる。
// ここを下げると汀線が最大200m内陸へ食い込む。触らないのが正しい。
// (セル一辺を100→50mにしても残差が全く動かなかったことでこの解釈は確定済み)
const SEA_BED_INSET = 150;   // 海岸線からこの距離以内のノードは下げない(m)
const SEA_BED_DROP  = 0.6;   // 海面(seaLevelY)からこれだけ下に置く
const SEA_BED_FAR   = 3000;  // これより遠い区間は判定に使わない(COAST_DECIDE_MAX と同じ思想)

// 海なら「下げるべき高さ」を、そうでなければ null を返す。
function seaBedYAt(x, z) {
  if (!coastlineSegs || coastlineSegs.length === 0) return null; // 海岸線が無ければ判定しない
  for (const r of coastlineRings) if (pointInPolygon(x, z, r)) return null; // 島の内側は陸
  let best = Infinity, dot = 0;
  for (const s of coastlineSegs) {
    if (s.minX - x > SEA_BED_FAR || x - s.maxX > SEA_BED_FAR ||
        s.minZ - z > SEA_BED_FAR || z - s.maxZ > SEA_BED_FAR) continue; // 粗い枝刈り
    const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = s.ax + dx * t, cz = s.az + dz * t;
    const d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
    if (d < best) { best = d; dot = (x - cx) * (-dz) + (z - cz) * dx; }
  }
  if (best === Infinity) return null;              // 近くに海岸線が1本も無い → 判定しない
  if (dot < 0) return null;                        // 陸側
  if (Math.sqrt(best) < SEA_BED_INSET) return null; // 岸際は触らない
  return seaLevelY() - SEA_BED_DROP;
}
```

**川・池には一切関与しない。** 川は地形にドレープする実装で実機合格済み。ここで扱うのは海だけ。

### (3-2) `part6.js` — 地形を作る瞬間に適用する

`loadWideTerrain` と `loadNearTerrain` の両方で、`arr` を埋めるループの**直後**、
`wideElev = arr` / `nearElev = arr` の**直前**に入れる。

```js
// 【2026-08-13】海の下の地形を海面より下げる(part4.js seaBedYAt 参照)
if (typeof seaBedYAt === 'function') {
  let k = 0, n = 0;
  for (let iz = 0; iz < WIDE_SEGS1; iz++)
    for (let ix = 0; ix < WIDE_SEGS1; ix++, k++) {
      const wx = centerX - WIDE_W/2 + ix * WIDE_W / WIDE_SEGS;
      const wz = centerZ - WIDE_D/2 + iz * WIDE_D / WIDE_SEGS;
      const bed = seaBedYAt(wx, wz);
      if (bed !== null && bed < arr[k]) { arr[k] = bed; n++; }
    }
  console.log('[seabed] WIDE lowered=' + n + '/' + arr.length);
}
```

`loadNearTerrain` 側は `NEAR_SEGS1 / NEAR_W / NEAR_D` に読み替え、ログを `NEAR` にする。

> **`pts` を作ったときと完全に同じ添字の回し方(`iz` 外側・`ix` 内側)にすること。**
> 取り違えると地形がXZ転置する。

### (3-3) `part4.js` — 海岸線が地形より後に届いた場合の回収

海岸線は地形より後に届くことが多い。`rebuildCoastlineChains()` の末尾で印を立て、
低頻度スキャンで既存の格子を下げ直す。**下げる方向にしか動かないので何度走らせても安全。**

```js
let _seaBedDirty = true;      // rebuildCoastlineChains() の末尾で true にする
let _seaBedScanFrame = 0;
let _seaBedTurn = 0;          // NEAR と WIDE を交互に処理して1回の負荷を抑える

function scanSeaBed() {
  _seaBedScanFrame++;
  if (_seaBedScanFrame % 180 !== 0) return;   // 3秒に1回程度
  if (!_seaBedDirty) return;
  const t0 = performance.now();
  let n = 0, label;
  if (_seaBedTurn === 0) {
    label = 'NEAR';
    n = _lowerGridToSeaBed(nearElev, nearCX, nearCZ, NEAR_W, NEAR_D, NEAR_SEGS, NEAR_SEGS1);
  } else {
    label = 'WIDE';
    n = _lowerGridToSeaBed(wideElev, wideCX, wideCZ, WIDE_W, WIDE_D, WIDE_SEGS, WIDE_SEGS1);
    _seaBedDirty = false;                     // NEAR→WIDE の2回で1周とみなす
  }
  _seaBedTurn = 1 - _seaBedTurn;
  console.log('[seabed] ' + label + ' lowered=' + n + ' (' + (performance.now() - t0).toFixed(0) + 'ms)');
  if (n > 0) updateFarMesh(true);             // 地形メッシュを新しい高さで作り直す
}

function _lowerGridToSeaBed(grid, cX, cZ, W, D, SEGS, SEGS1) {
  if (!grid) return 0;
  const stepX = W / SEGS, stepZ = D / SEGS;
  const x0 = cX - W / 2, z0 = cZ - D / 2;
  let n = 0;
  for (let iz = 0; iz < SEGS1; iz++)
    for (let ix = 0; ix < SEGS1; ix++) {
      const k = iz * SEGS1 + ix;
      const bed = seaBedYAt(x0 + ix * stepX, z0 + iz * stepZ);
      if (bed !== null && bed < grid[k]) { grid[k] = bed; n++; }
    }
  return n;
}
```

### (3-4) `part9.js` — スキャナを1行足す

1129行付近、`scanPendingAreaWaterPolys();` の直後に:

```js
scanSeaBed(); // 【2026-08-13】海の下の地形を海面下へ落とす低頻度スキャン(part4.js)
```

---

## 4. 触ってはいけないもの

- `seaLevelY()` / `seaYOffset()` / `LAND_FLOOR_MARGIN_M` — **高さは1mmも動かさない**
- `isSeaPoint` / `rebuildCoastlineChains` / `_fillCoastlineTile` / `COAST_CELL_M` — 海面ポリゴン側は完成している
- 川・池の地形ドレープ(`_waterYAt` / `fixedY` を持たない面)
- `waterSurfaceYAt` / `WATER_QUERY_MARGIN`(橋のクリアランス用)
- 地形に穴を開ける / ポリゴンでクリップする — **今回も地形の三角形構成は一切変えない**。
  配列の要素を下げるだけ

---

## 5. 検証手順(ユーザーが実施)

デプロイ後、**Ctrl+Shift+R**。

### (a) NY — 見た目が変わる回

- **ニューヨーク湾・ハドソン川が水面に見えるか**(今まで緑の地面だった所)
- **マンハッタン・ジャージーシティが水没していないか**
- コンソールに `[seabed] NEAR lowered=...` `[seabed] WIDE lowered=...` が出るか

`lowered=0` のままなら効いていない。前回の `39` のような極端に小さい値も失敗。
海の面積27.5km²に対し、200m格子なら**数百ノード規模**下がるのが正常。

### (b) 数値

```js
(()=>{const px=player.position.x,pz=player.position.z;const r=[];for(const d of[0,200,600,1200]){const t=terrainYOrNull(px+d,pz);r.push(d+'m: terrain='+(t==null?'欠測':t.toFixed(2)));}return r.join(' | ')+' || seaY='+(seaLevelY()+seaYOffset()).toFixed(2)})()
```

水上の地点で `terrain` が `seaY` より**低い**こと。

### (c) 日本 — 退行チェック(省略しないこと)

- **伊勢原**: 市街地・相模川周辺が水没していないか
- **東京**: 湾岸・市街地が水没していないか

### 不合格の見分け

| 症状 | 対処 |
|---|---|
| 陸が水没する | `SEA_BED_INSET` を 150 → 300 へ。**それ以外は触らない** |
| `lowered=0` のまま | `coastlineSegs` が空か、`_seaBedDirty` が立っていない |
| 汀線が内陸へ食い込む | `SEA_BED_INSET` を上げる。**海面の高さは触らない** |
| スキャンで一瞬止まる | ログの ms を見る。100msを超えるなら報告。区間の空間インデックスが要る |

---

## 6. 既知の限界(直さないこと)

- 岸から `SEA_BED_INSET`(150m)以内の地形は下げない。そこは地形格子200mの補間帯で、
  下げると汀線が内陸へ食い込む。**海面が岸ぎりぎりまで来ないのは仕様**
- 河口・入江は海として扱われない(OSMのcoastlineが河口を直線で閉じるため)。
  そこは川ポリゴンが担当する

---

## 7. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "terrain: lower grid nodes under the sea below sea level, judged directly from coastline chains instead of sea polygons"; git push
```
