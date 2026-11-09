# コードレビュー 2026-08-28（第3部・総合）— 生成の速さ / 長時間の安定 / 建物のリアリティ

対象: `index.html` / `js/legacy/part1-10.js` / `js/core/audio.js` / `server/server.js`（2026-08-28 時点、トンネル対応B-1適用後）
目的: **調査のみ。** 実装は別途。
既存レポート: `CODE_REVIEW_20260826_PERF_AND_CRASH.md`（性能）/ `CODE_REVIEW_20260826_REALISM.md`（見た目）。**本書はそれらと重複しない新発見のみ**を扱い、末尾に3本を統合した優先順位を置く。

すべての行番号は 2026-08-28 時点の実ファイルで確認済み。エージェントによる調査結果は、主要な主張をすべて自分で再検証した（1件、数値を訂正している。§A-2 参照）。

---

## 総評 — 3つの軸それぞれに「1つの支配的な原因」がある

| 軸 | 支配的な原因 | 場所 |
|---|---|---|
| **サクサク生成** | 手続き生成の候補点1つごとに、**海・大河川の巨大ポリゴンの全頂点を最大2周**している | `part8.js:1945` `inAvoid` |
| **長時間の安定** | **駅ラベル**が canvas＋テクスチャ＋ジオメトリ＋マテリアルごと永久に残り、しかも毎フレーム全走査される | `part4.js:95-116` / `part9.js:1014` |
| **建物のリアリティ** | **`applySizeFloor` が実測ジオメトリを踏み潰し**、狭小住宅を 15m×12m×12m の同一寸法の箱に置き換えている | `part3.js:85-95` / `part8.js:645` |

この3つを直すだけで体感が最も大きく変わる、というのが本レビューの結論。

---

## A. サクサク道路・建物が生成されること

前提として確認した実測値（すべて実ファイルから）:

| 定数 | 値 | 場所 |
|---|---|---|
| `CHUNK_SIZE` | 120m | `part1.js:2024` |
| `CHUNK_RADIUS`(std) | 8 → **17×17 = 289チャンク** | `part1.js:1259, 2049` |
| `ROAD_CELL` / `BUILDING_CELL` / `POLY_CELL` | 40 / 80 / 200 | `part1.js:719, 1474, 994` |
| `getGroundY` 1回 | = `farNodeY` **4回**（各回で文字列キー生成＋Map参照） | `part5.js:95-104, 137` |
| `processChunkQueue` | **1フレームに1チャンクだけ生成** | `part8.js:2541` |

`processChunkQueue` が1フレーム1チャンクなので、**generateChunk 1回のコストがそのまま「建物が出てくる速さ」の上限**になる。std設定の初回289チャンクは最短でも289フレーム。ここが本節の主題。

### A-1. `inAvoid` が巨大水域・海ポリゴンの全頂点を、候補点ごとに最大2周する ★最重要

**該当**: `part8.js:1945-1951`

```js
  const inAvoid = (x, z) => nearAvoid.some(p => {
    // バウンディングボックス(+余白)の粗いふるい落としで、ほとんどの候補点は
    // 高コストな境界距離計算に入らず即falseになる。
    if (x < p.minX - AVOID_MARGIN || x > p.maxX + AVOID_MARGIN ||
        z < p.minZ - AVOID_MARGIN || z > p.maxZ + AVOID_MARGIN) return false;
    return pointInPolygon(x, z, p.pts) || _nearPolyBoundary(x, z, p.pts, AVOID_MARGIN);
  });
```

コメントは「bboxでほとんど落ちる」と想定している。**その想定が成り立っていない。**

`avoidPolygons` には海面ポリゴン（`part4.js:712-713`）と大河川の水域ポリゴン（`part4.js:1502, 1547`）が入る。しかもサイズ上限が無く、間引きの粗さから **span 3000m 超のポリゴンが想定されている**ことが分かる:

```js
// part4.js:1567
      const tp = thinPts(pts, span > 3000 ? 30 : span > 400 ? 10 : 0);
```

つまり bbox が数km四方のポリゴンが存在する。**bbox が巨大なので、海岸から数km内陸のチャンクでも必ず bbox を通過**し、`pointInPolygon`（O(頂点数)）と `_nearPolyBoundary`（O(頂点数)、`part8.js:1938-1944`）が**両方**実行される。30m間引きでも8kmのポリゴンは数百頂点。

`inAvoid` は1チャンクあたり約250回呼ばれる（§1道路沿い約104点＋§3格子81点＋§4下草36点＋α）ので、**1チャンクで25万〜100万回の辺演算**。伊勢原は相模湾から約8kmで、まさにこの bbox の内側にある。

**確認方法**: `console.log(nearAvoid.map(p => p.pts.length))` を `generateChunk` 冒頭に1回入れる。数百の要素が出れば確定。

**方向性**: `avoidPolygons` 登録時に 200m 程度のセルマスク（Set of "gx,gz"）を持たせ、`inAvoid` はまずマスクを引く。あるいは `nearAvoid` を作る時点で「チャンク矩形 × ポリゴン bbox の交差」で落とす。

### A-2. `isOnRoad` が毎回 `Math.sqrt` を取り、25〜49セルを走査する

**該当**: `part2.js:976-991`

```js
function isOnRoad(cx, cz, bw, bd) {
  const halfDiag = Math.sqrt(bw*bw + bd*bd) / 2;
  const searchR = MAX_ROAD_HALF_W + halfDiag + 1;
  const cellR = Math.max(1, Math.ceil(searchR / ROAD_CELL)) + 1;
  ...
      const dist = Math.sqrt(distSqPointToSeg(cx, cz, r.x1, r.z1, r.x2, r.z2));
      if (dist < (r.rw||5)/2 + halfDiag + 1) return true; // 1m margin
```

2つ問題がある。

1. **比較のためだけに `Math.sqrt` を取っている。** `roadNear`（`part1.js:1432`）は既に二乗のまま比較しているので、同じ書き方に揃えるだけでよい。1チャンクあたり数万回。
2. **`MAX_ROAD_HALF_W = 30`（幅60mの大河川用、`part2.js:971`）が全呼び出しに効く。** 7m四方の家の判定でも `cellR = 2` → 5×5 = **25セル = 200m四方**。20m×15mの建物なら `cellR = 3` → 49セル = 280m四方。

> **【訂正】** 初期調査では「常に49セル」としていたが、実際に計算すると小さい建物では 25セルだった。ここに記載したのが正しい値。

さらに `roadGridAdd`（`part1.js:730-733`）は線分を **AABB全域**に登録するため、長い斜めの幹線1本が数十セルに重複登録され、1セルあたりの本数が実際の通過本数より膨らむ。

**方向性**: 二乗比較に変える（1行）。幅広の水域・幹線だけ別グリッドに分けて `MAX_ROAD_HALF_W` を下げる。

### A-3. `isSteepSlope` が地形解像度より2桁細かい距離を測り、同じ値を再計算し続ける

**該当**: `part8.js:2047-2052`

```js
  const SLOPE_CHECK_DIST = 8, SLOPE_MAX_DH = 2.2;
  const isSteepSlope = (qx, qz) => {
    const h0 = getGroundY(qx, qz);
    return Math.abs(getGroundY(qx + SLOPE_CHECK_DIST, qz) - h0) > SLOPE_MAX_DH ||
           Math.abs(getGroundY(qx, qz + SLOPE_CHECK_DIST) - h0) > SLOPE_MAX_DH;
  };
```

`getGroundY` は **200m格子の双線形補間**（`part5.js:95-104`）で、その節点自体が 540〜665m間隔の NEAR 標高の補間値（`part6.js:48`）。したがって:

- **1つの200m三角形の内部は完全な平面**。8m離れた2点の差は三角形内のどこでも同一。判定は**200m三角形ごとに全部建つ／全部建たない**の二値になり、結果として斜め直線で切られた200m単位の空白が生じる。宅地スケールの傾斜（擁壁・段差）は原理的に検出できない。
- コスト面では `buildable()` 1回につき `getGroundY` 3回 = **`farNodeY` 12回**（文字列キー生成＋Map参照つき）。1チャンク約200回の `buildable` で **約2,400回**。そのほぼ全部が同じ値の再計算。

**方向性**: `farNodeY(i,j)` の格子ノード差分から勾配を求める（1回計算して三角形全体で使い回せる）。realism レポートの C-1（地形解像度を上げる）を入れれば、この判定自体が意味を持つようになる。

### A-4〜A-6. 二重呼び出しと無駄なループ（まとめ）

| # | 内容 | 該当 |
|---|---|---|
| A-4 | `buildable`(pad=3) を通った点に `hasRoomToBuild`(pad=4) が**同じ9セル走査をやり直す**。pad=4 の1回で pad=3 は包含される | `part8.js:2059-2067` |
| A-5 | §4下草で `inAvoid` が2回走る（`buildable` の中にもある）。しかも**最も安い `getGroundY` 1回の山判定が、最も高い `buildable` より後**。下草1本の判定に `getGroundY` を最大5回 | `part8.js:2188-2195` |
| A-6 | §2 が `nearLanduse` の**全ポリゴン**に81点の `pointInPolygon` を掛ける。`POLY_CELL=200` かつ bbox 全域登録なので、数百m離れたポリゴンも返る。**ポリゴンbbox × チャンク矩形の交差判定が1行も無い** | `part8.js:2119-2132` |

### A-7. `rebuildStationsInBounds` がチャンク生成ごとに `stationRecords` を全走査する

**該当**: `part4.js:134-139`

```js
function rebuildStationsInBounds(x0, x1, z0, z1) {
  for (const rec of stationRecords) {
    if (rec.refX < x0 || rec.refX > x1 || rec.refZ < z0 || rec.refZ > z1) continue;
    rebuildStationHeight(rec);
  }
}
```

コメント（`part4.js:133`）は「駅は数が少ないため空間グリッドは使わず線形走査で十分」としているが、**件数を抑える機構が存在しない**（→ §B-1）。呼び出し経路は `generateChunk`（`part8.js:2202`）← `processChunkQueue`（1チャンク/フレーム）なので、移動中は最大60回/秒。駅が1,000件まで育つと **60,000回/秒の走査**。

**方向性**: `namedPlaceGrid` と同じ `polyGridAdd`/`queryPolyGrid` に載せる。§B-1 を直せば件数自体が抑えられるので、そちらが先。

---

## B. 長時間プレイしても処理落ちしないこと

**調査方法**: 全ファイルの `const X = []` / `new Map()` / `new Set()` を列挙し、追加側と削除側を個別に grep して突き合わせた。**削除機構があるものを誤って「漏れ」と報告しないよう、必ず削除側を確認している。**

対策済みとして除外したもの: `railSegs`（削除済み）、`nodeUse`・`bridgeSlopes`・`motorwaySlopes`（08-27に対策済み）、`collisionBoxes`/`minimapBuildings`/`placedBuildings`（`part1.js:2007-2009` の filter）、`landusePolygons`/`namedPlacePoints`/`avoidPolygons`/`areaPolyMeshes`（`part4.js:1096-1127` のコンパクション）、`chunkWaitBuildings`/`tileWaitBuildings`（`part1.js:1948`、ローカル別名 `map` 経由なので単純 grep では出ない）、`torchLights`（固定6個で増えない）、`_seaNodeCache`（40000で clear）。

### B-1. 駅ラベルが canvas＋テクスチャ＋ジオメトリ＋マテリアルごと永久リーク ★最重要

**該当**: `part4.js:95-120`（生成・登録）/ `part9.js:1014`（毎フレーム走査）

```js
  const cvs = document.createElement('canvas');
  cvs.width = 512; cvs.height = 96;
  ...
  const tex = new THREE.CanvasTexture(cvs);
  const labelMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 8),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthTest: false })
  );
  scene.add(labelMesh);
  stationLabels.push({ type: 'label', mesh: labelMesh, x, z });
```

駅1つにつき **専用 canvas 1枚・CanvasTexture 1枚・PlaneGeometry 1個・MeshBasicMaterial 1個**を新規生成。`stationLabels`/`stationRecords` の全参照は `part4.js:74,116` と `part9.js:584,1014` の**4箇所だけ**で、`scene.remove` も `dispose()` も存在しない。`dropTileRemnants`（`part1.js:1817`）→ `dropAreaRecordsInTile`（`part4.js:1073`）も駅には触れない。

**増加率の見積もり**（根拠つき）:
- `OSM_TILE_M = 1600`、`prefetchR = 2` → 進行方向に幅5タイルの帯
- 通常移動 5 m/s（18 km/h）→ 約 **55タイル/時**。Shiftダッシュ 45 m/s → 約 **500タイル/時**（BIRDモードはさらに3倍）
- 対象タグは `railway=station` / `halt` / **`public_transport=station`**（`part8.js:345`）。最後のタグは都市部でバス停・路面電車停留所にも付くため、1タイル(2.56km²)あたり都市部で概ね5〜20件
- 1件あたり canvas 196KB(CPU) + GPUテクスチャ約262KB + GLバッファ4本 → **約0.4〜0.7MB**

→ **都市部を歩いて 70〜400MB/時。ダッシュだとその10倍。** 単独でモバイルのタブクラッシュを説明できる規模。

加えて **`animate()` から毎フレーム・間引き無しで全走査される**。`animate()` から呼ばれる関数を全部辿って先頭のガードを確認したところ、**間引きが無いのはここ1箇所だけ**だった:

| 関数 | ガード |
|---|---|
| `unloadFarBuildings` `part1.js:1574` | `% 90 !== 0` |
| `reactivateNearbyDormantBuildings` `part1.js:1665` | `% 90 !== 18` |
| `evictFarDormant` `part1.js:1758` | `% 90 !== 27` |
| `unloadFarAreaPolys` `part4.js:1176` | `% 90 !== 63` |
| `checkOSMTiles` `part8.js:1821` | `% 30 !== 0` |
| `drawMinimap` `part7.js:866` | `% 3 !== 0` |
| `updateMemDiag` `part9.js:549` | `% 120 !== 60` |
| **`stationLabels` ループ `part9.js:1014`** | **無し** |

**方向性**: `stationRecords` に `bid` 相当を持たせ、`unloadFarBuildings` と同じ距離基準で `scene.remove` + `map.dispose()` + `geometry.dispose()` + 3配列（`stationLabels`/`stationRecords`/`seenStations`）からの除去。最低限、駅名テクスチャは文字列キーの共有キャッシュ（上限付き）にするだけでも効く。

### B-2. `minimapWaterPolys` — 削除が無く、しかもタイル再取得で**二重に積まれる**

**該当**: `part4.js:311-312`（宣言）/ `part4.js:265-266, 708-709`（追加）

```js
  minimapWaterPolys.push(entry);
  polyGridAdd(minimapWaterGrid, entry);
```

全参照は `part4.js:265,311,708` と読み出し2箇所（`part7.js:892`, `part8.js:2228`）のみ。**削除・clear は皆無**（grep で確認済み）。

単なる漏れ以上に悪いのは、**同じ関数 `dropAreaRecordsInTile`（`part4.js:1073`）が兄弟の配列（`areaPolyMeshes`/`avoidPolygons`/`landusePolygons`/`namedPlacePoints`/`pendingAreaTrees`）は全部掃除しているのに、これだけ抜けている**点。

さらに `dropTileRemnants` → `resetTileForRefetch`（`part8.js:277`）は `seenOSMWays.delete(id)` で way を un-see するため、**staleタイルへ戻るたびに同じ水域ポリゴンが再 push される**（重複防止キーが無い）。行ったり来たりする遊び方では線形以上に増える。

なお `part7.js:887` のコメントは「以前は minimapWaterPolys/roadRecords（取得済み全件。増え続けて減らない）を全走査していた」と書いており、**走査は空間ハッシュに移したが、配列が増え続ける根本は残ったまま**という状態。

**方向性**: `dropAreaRecordsInTile` に `areaPolyMeshes` と同じ形のコンパクション＋`minimapWaterGrid` の作り直しを足す。

### B-3. `globalStationPoints` — 削除なし ＋ 0.5秒ごとに全走査

**該当**: `part2.js:669, 680`（追加）/ `part7.js:74`（全走査）

```js
// part2.js:680
      globalStationPoints.set(el.id, p);
```
```js
// part7.js:74
  for (const s of globalStationPoints.values()) {
```

全参照8箇所を確認、`delete`/`clear` は皆無。`part7.js:69` のコメントは「駅の総数はセッション全体でもせいぜい数百件程度」と仮定しているが、それを保証する機構が無い。`nearestStationWithin` は `checkNearbyPlace`（`% 30` ≒ 2Hz）から呼ばれる。

メモリは1件約100Bで軽微（5,000件で0.5MB）。**問題は CPU で 2回/秒 × N件**。§B-1 と同じペースで増える。

**方向性**: すぐ下にある `nearestNamedPlaceWithin`（`part7.js:84`）が既に `queryPolyGrid` 方式なので、それに揃える。

### B-4. `_facadeBoxCache` — 理論上限 4,096（コメントの「数百」と10倍の乖離）

**該当**: `part2.js:363-364, 376-379`

```js
const _facadeBoxCache = new Map();
const _UV_STEPS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];
...
    g.userData.shared = true; // アンロード時にdisposeしない印
    _facadeBoxCache.set(key, g);
```

キーは3軸とも `_UV_STEPS`（**16段**）に量子化 → 理論上限 **16³ = 4,096件**。`part2.js:361` のコメントは「キャッシュの種類数を数百に抑える」と書いているが、実際の上限は約10倍。削除・LRU は無く、`userData.shared = true` によりチャンクアンロード時の `dispose()`（`part8.js:2448`）からも明示的に除外される。

BoxGeometry は GLバッファ4本。**同じファイル自身が実測した「1本あたり D3D11 の最小確保単位 64KB」**（`part2.js:468-471`）を当てはめると、上限到達時 4,096 × 4 × 64KB ≈ **1GB**。実際に到達する組み合わせ数は建物形状の分布次第なので増加率は見積もり不能だが、**HUD の `boxGeo` 表示（`part9.js:544`）で実測できる**。まずそこを見るのが早い。

**方向性**: `_UV_STEPS` を8段に減らす（8³ = 512 で 1/8）、または `FACADE_CACHE_MAX` と同じハード上限を設ける。

### B-5. `matCache` / `roofMatCache` — 上限なし

**該当**: `part2.js:20-26` / `part2.js:473-479`

`quantizeColor`（1チャンネル8段 → 9³ = 729色）× `tintWall`（6種、`part3.js:114-120`）で `matCache` は約4,374件（約4〜5MB）。`roofMatCache` は4種 × 729色 ≈ 2,916件（約3MB）。どちらも `delete`/`clear` が全ファイルに存在しない。

**クラッシュの主因ではない**（同一パラメータ構成なので `WebGLProgram` は共有され、シェーダ再コンパイルも起きない）が、減らないキャッシュとして計上しておくべき。

### B-6. その他（実害小・記録のみ）

| # | 対象 | 状況 |
|---|---|---|
| B-6a | `seenStations`（`part8.js:340`） | 削除なし。1件約30Bで実害小だが、**§B-1 で駅を距離アンロードするなら同時に忘れさせないと再接近時に復活しない**。修正時にセットで扱う |
| B-6b | `meijiCells` / `modernBuildingDensity`（`part4.js:1313, 1321`） | 削除なし。**現実モードでは増えない**（`USES_MEIJI_LANDUSE` ガード内のみ）。明治・江戸で約1MB/時 |
| B-6c | `edoRoadSegGrid`（`part4.js:1394`） | 削除なし。江戸モードのみ。`roadRecords` が evict されても線分参照が残る |
| B-6d | `_gsiMissing`（`part5.js:216`） | **意図的に上限を設けない設計**（コメントに明記）。10万件で約4MB。対応不要 |

**イベントリスナ・タイマーは漏れなし**（`addEventListener` 84箇所・`setInterval` 2箇所・`setTimeout` 12箇所を全数確認。動的に再登録されて増えるものは無い）。`document.createElement('canvas')` 15箇所のうち per-instance で増えるのは §B-1 のみ。

### B-7. 将来の地雷 — `generateChunk` の `scene.children` インデックス差分

**該当**: `part8.js:1922`（`const beforeCount = scene.children.length;`）/ `part8.js:2205`（`scene.children.slice(beforeCount)`）

`generateChunk` の実行中に**1つでも `scene.remove()` が走ると `scene.children` が左詰めされ、末尾のメッシュが `chunkMeshes` に登録されない孤児**（永久に dispose されない）になる。

現時点では該当範囲から到達する関数（`addBuilding`/`plantScrub`/`addFireTower`/`rebuildRoadsNearChunk`）はいずれも同期的な `scene.remove` を含まないので**安全**。ただし `removeBuildingsOverlappingRoad`（`part1.js:808` で `scene.remove(p)`）が将来この経路に入ると、静かなリークになる。

**方向性**: インデックス差分ではなく、生成中に追加したメッシュを明示的に配列へ積む。

---

## C. 建物のデザインとリアリティ

### C-1. `applySizeFloor` が実測ジオメトリを踏み潰し、住宅街に同寸法の箱を撒く ★最重要

**該当**: `part3.js:85-95` / `part3.js:41-43` / `part8.js:626, 644-645`

```js
// part3.js:85
const SIZE_FLOOR = {
  apartment:  { w: 15, d: 12, h: 12 },
  industrial: { w: 20, d: 16, h: 8  },
  office:     { w: 15, d: 12, h: 12 },
};
function applySizeFloor(style, w, d, h) {
  if (!style) return { w, d, h };
  const f = SIZE_FLOOR[style.type];
  if (!f) return { w, d, h };
  return { w: Math.max(w, f.w), d: Math.max(d, f.d), h: Math.max(h, f.h) };
}
```
```js
// part3.js:41
function classifyResidential(style, w, d, h, x, z) {
  if (style && style.type !== 'house' && style.type !== 'default') return style;
  if (h >= APT_HEIGHT_M || w * d >= APT_FOOTPRINT_M2) {
```
```js
// part8.js:626
    const levels = parseInt(tags['building:levels']) || (lvMin8 + Math.floor(Math.random() * (lvMax8 - lvMin8 + 1)));
    let h = resolvedH != null ? resolvedH : Math.max(levels*3,3)+Math.random()*2;
...
// part8.js:645
    ({ w: fw, d: fd, h: fh } = applySizeFloor(style, w, d, h));
```

日本のOSMで最多の `building=yes`（階数タグ無し）は 1〜3階が一様抽選され、**約1/3が h = 9〜11m**。うち h ≥ `APT_HEIGHT_M`(10) が `APARTMENT_STYLE` に昇格し、**実測が 6m×5m の狭小住宅でも強制的に 15m×12m×12m に膨らむ**。

結果、戸建て住宅街の中に**まったく同じ寸法・同じaptファサードの12m箱が20〜30mおきに散在**し、隣家のフットプリントに食い込む（`fitRealBuildingToRoads` は道路との重なりしか縮めないので、建物同士の重なりは残る）。

さらに `w * d >= APT_FOOTPRINT_M2`(200) の分岐により、**平屋の農家母屋・倉庫・体育館（200m²超）まで h が 12m に底上げ**され、平屋が4階建てマンションになる。

コメント（`part3.js:84`）は「実測タグ由来の大きい建物は Math.max なので縮まない」としているが、問題は**縮まないこと**ではなく**小さいものが膨らむこと**。

**方向性**: `applySizeFloor` は実測ジオメトリ由来（`real === true`）の建物には適用しない。`APT_HEIGHT_M`/`APT_FOOTPRINT_M2` による昇格も、タグ由来の高さがある場合のみに限定する。

### C-2. `detailOK()` が「生成順の850棟」判定で、日本の市街地では恒久的に false

**該当**: `part2.js:514`

```js
const detailOK = () => minimapBuildings.length < 850;
```

`PERF.bMax` は std で **12,000**（`part1.js:1259`）。閾値850は**上限の7%**で、日本の市街地なら生成開始から数秒で超え、以後ずっと false。

これで消えるもの:
- **屋上の貯水槽・室外機・アンテナ**（`part3.js:551-557`）
- 住宅の玄関庇（`part3.js:614`）、ビル1階のエントランスガラス（`part3.js:621`）
- 敷地の余白（`part3.js:399`）、スタジアムの照明塔（`part3.js:526`）

**距離判定ではなく生成順**なので、スポーン地点付近の最初の850棟だけがディテールを持ち、**プレイヤーが歩いて近づく建物ほどディテールがゼロ**になる。日本のビル街の特徴（屋上の貯水槽・キュービクル・室外機の林）が丸ごと出ない。

**方向性**: プレイヤーからの距離ベース（例: 150m以内は常に許可）に置き換え、総数上限は近傍以外にだけ効かせる。

### C-3. 日本の国プロファイルが存在せず、一番貧しい既定経路に落ちる

**該当**: `part2.js:616-623`

```js
const COUNTRY_BUILDING_PROFILES = {
  hk: REGION_PROFILES.denseHighRise,
  us: REGION_PROFILES.sprawlingSuburban,
};
```

`REGION_FALLBACK_BY_COUNTRY` にも `jp` は無いので `getCountryBuildingProfile('jp')` は null。結果:

- 壁色は `DEFAULT_WALLS_REAL` の6色のみ、屋根色は `ROOF_COLS` の6色
- 屋根形状は重み無しの完全ランダム
- **`lotPaddingRange` が無いため、敷地の余白（庭・駐車場）の描画がゼロ**
- 瓦テクスチャの適用が `type === 'house'` に限定される:

```js
// part3.js:607
      const defaultTileBias = cprof ? (cprof.roofMaterialBias === 'tile') : (MODE === 'real' && type === 'house');
```

→ **日本で圧倒的多数の `building=yes`（＝ `type === 'default'`）は瓦テクスチャが付かず、のっぺりした単色屋根**になる。隣の `building=house` タグの家だけ瓦になるので、同じ住宅街に「瓦の家」と「プラスチックみたいな単色屋根の家」が混在する。

**方向性**: `jp` プロファイルを追加（瓦bias、切妻/寄棟優先、`flatRoofHeightThreshold` を 12〜15、`lotPaddingRange: [0.3, 1.5]`）。既存の仕組みに1エントリ足すだけ。

### C-4. 戸建てのファサードが 1×1×1 で、玄関が4面すべてに出る

**該当**: `part3.js:373-381`

```js
  const geo = ... : kind ? sharedFacadeBoxGeo(
        kind === 'house' ? 1 : Math.max(1, Math.round(w / tw)),
        kind === 'house' ? 1 : Math.max(1, Math.round(d / tw)),
        kind === 'house' ? 1 : floors)
```

house は `colsX = colsZ = floors = 1` で固定。一方テクスチャ側は玄関ドア・雨戸戸袋・掃き出し窓を焼き込んでいる（`part2.js:243-247`）。

結果:
- **1棟に玄関が4つ**（前後左右すべての面に同じドア）
- 12m×6m の家では長辺と短辺で同じ画像を引き伸ばすため、**窓の横幅が面によって2倍違う**
- 平屋（`floors === 1`）でも常に2階窓が描かれる
- 建物の大小に関わらず窓・ドアの絶対サイズが変わる（小さい家ほどドアが小さく、大きい家ほど巨大な玄関）

**方向性**: house も実寸連動の `sharedFacadeBoxGeo(round(w/6), round(d/6), floors)` にするか、正面用と側面用でテクスチャを分けて面ごとのマテリアル配列にする。

### C-5. 斜面で高さを延長した結果、階数・種別・屋根形状まで変わる

**該当**: `part3.js:281-282, 295, 356, 546`

```js
  const gy = Math.min(...hs);   // 基礎 = 最低点
  h += Math.max(...hs) - gy;    // 斜面の高低差ぶん建物を延長して埋まりを防ぐ
  ...
  const floors = Math.max(1, Math.round(h / 3));
  ...
    (floors <= 2 && (type === 'house' || type === 'default' || type === 'shop')) ? 'house' :
    (type === 'house' || type === 'apartment') ? 'apt' : 'office';
```

2階建て（h=6m）の家が 4m の傾斜地に建つと h=10 になり、`floors = 3` → kind が `house` から **`office`（ガラスカーテンウォール）**に変わり、さらに `h >= flatThreshold(10)` で**陸屋根**になる。

つまり**斜面沿いの戸建てだけが「屋上パラペット付きのガラス張り小型ビル」に化ける**。伊勢原・鎌倉・多摩のような丘陵住宅地で、列単位で発生する。`ELEV_SCALE = 2.0` で斜面が2倍に誇張されているため、実際の発生率は見た目の倍。

**方向性**: `floors`・`kind`・`isFlat` の判定には斜面延長前の `_origH` を使う（`_origH` は `part3.js:273` に既にある）。

### C-6. 乱数がすべて `Math.random()` — 戻ってくると街並みが別物になる

**該当**: `part3.js:341, 348, 360, 425, 430, 604`（建物）/ `part8.js:2099-2112, 2133-2135, 2166-2167, 2188-2189`（手続き生成）

```js
// part3.js:604
        const r = Math.random();
        geoR = type === 'industrial' ? SHED_GEO : r < 0.5 ? GABLE_GEO : r < 0.85 ? HIP_GEO : SHED_GEO;
```

アンロード時に保存されるのは寸法と `style` だけで、確定した見た目は保存されない（`part1.js:1642`）。再生成時に `addBuilding` が再実行され全部再抽選される。

`buildingRecords.length >= PERF.bMax * 0.95` に達すると保持半径がヒストグラムで動的に縮む（`part1.js:1590-1618`）ため、**密集地では evict/revive が常時発生する**。結果、**振り返って戻るだけで同じ家の壁色・屋根色・屋根形状（切妻↔寄棟↔片流れ）が変わる**。

手続き生成側はさらに露骨で、`updateChunks` は距離アンロード時に `loadedChunks.delete(key)`（`part8.js:2452`）して再生成を許すため、**1200m 離れて戻るだけで家の位置・大きさ・色・軒数がすべて変わる**。

`facadeMat` 内部の乱数はキー由来で決定的（`part2.js:147`）だが、そのキー自体を毎回振り直しているので意味がない。森の `plantTree`（`part2.js:904-918`）は既に `_fhash` の座標決定的乱数を使っているので、**同じ仕組みが既にある**。

**方向性**: `(x, z)` をハッシュした決定的乱数を `addBuilding` 冒頭で1つ作り、色・variant・屋根形状の抽選をすべてそれに置き換える。手続き生成側も `_fhash` に統一。

### C-7. 種別ごとに単一色を決め打ち — 商店街が全部同じ蛍光オレンジ

**該当**: `part2.js:1153, 1171`

```js
  } else if (tags.shop || am === 'supermarket' || am === 'convenience') {
    style = { color: 0xff8840, roofColor: 0xcc5500, emissive: 0x221100, type: 'shop' };
```

`part3.js:330` の分岐で `style.color` がそのまま採用され、`wallPalette` を持つ office/apartment/industrial と違って**抽選が入らない**。あとは `tintWall`（6段階）だけ。

→ 商店街や幹線道路沿いで、**すべての店舗が明度違いの同じ蛍光オレンジ (0xff8840) の箱**として並ぶ。日本のコンビニ・薬局・飲食店は白・グレー・ガラスが基本なので極端に浮く。`building=house` の家も全部タン色 (0xd4b070) の6段階明暗のみ。

**方向性**: `SHOP_WALL_PALETTE` / `HOUSE_WALL_PALETTE` を足して `wallPalette` 経由の棟別抽選に乗せる（既存の `OFFICE_WALL_PALETTE` と同じ仕組みなので追加は1行ずつ）。

### C-8. 店構え・玄関・庇が常に +Z 面固定で、道路の向きを見ていない

**該当**: `part3.js:614, 621, 634-637`

```js
      dm(UNIT_PLANE, STOREFRONT_MAT, x, gy + 1.1, z + d / 2 + 0.06, Math.min(w * 0.85, 10), 1.6, 1);
```

`rot`（`part8.js:619` の `bRot = -_ang`、フットプリント最長辺の方位）で一括回転されるだけなので、+Z 面が道路を向く保証はまったく無い。

→ **店の看板とガラス面が約半数で裏側・隣家側を向く**。日本の街は「道路に正対した店構え」が景観の骨格なので、これが崩れると一気に嘘っぽくなる。

**方向性**: `addBuilding` に最寄り道路への方位を渡す（`queryRoadGrid` は既にある）。±X/±Z のうち道路に最も近い面に付ける。

### C-9. 勾配屋根が常に約37°固定、陸屋根には屋根面が無い

**該当**: `part3.js:611`

```js
      pitched(geoR, geoR === SHED_GEO ? Math.max(0.8, minWD * 0.18)
                                      : Math.min(4.2, Math.max(1.5, minWD * 0.38)), 1.0, rM);
```

棟高 = `minWD * 0.38`、半スパン = `minWD / 2` → **勾配は常に atan(0.76) ≒ 37.2°**（minWD > 11m でのみ 4.2m キャップが効く）。日本の標準は4寸(21.8°)〜5寸(26.6°)。軒の出も `ov = 1.0` の半分 = 0.5m で、日本の 0.6〜0.9m より浅い。

→ 遠景のスカイラインが「同じ急角度の三角の繰り返し」になり、日本の街というよりアルペン風に見える。

陸屋根側（`part3.js:548`）は屋根面メッシュを追加せず、箱の天面UVが無地の壁色領域を指す（`part2.js:344` の face 2,3）。→ **上から見ると屋根が壁と同じ色ののっぺり面**で、防水シート・砂利・設備が無い（C-2 でパラペット以外の設備も出ない）。

**方向性**: 棟高を `minWD * (0.20 + hash * 0.10)` 程度に下げて勾配自体もばらす。陸屋根には `roofSurfMat` の薄い板を1枚 `gy + h` に置く（共有ジオメトリなので負荷増なし）。

### C-10. `FOREST_MIN_H` の基準ずれ — 市街地が「山」扱いされている可能性が高い

**該当**: `part9.js:15, 75` / `part8.js:2192` / `part6.js:91, 170` / `part5.js:134`

```js
// part9.js:15
const FOREST_MIN_H = 30;          // 局所比高がこの高さ(≈15m)以上を「山」とみなす(平地の街には生えない)
```

コメントは「**局所比高**」と主張しているが、比較対象の `getGroundY` は局所比高ではない。実際の定義を追うと:

```js
// part6.js:170
    arr[i] = (m == null) ? oceanFloor : (Math.max(m, landFloorM) - elevBase) * ELEV_SCALE;
```
```js
// part6.js:91
  elevBase = finite.length ? Math.min(...finite) : 0;
```

つまり `getGroundY` = **(実標高m − elevBase) × 2.0** の絶対値で、`elevBase` は WIDE グリッド（±14km）全域の**最小標高**。

伊勢原の場合、±14km には相模湾方向の低地が含まれるので `elevBase` は 0〜10m 程度。市街地の実標高は 40〜60m なので `getGroundY ≒ (50 − 5) × 2 = 90`。これは `FOREST_MIN_H = 30` を**大幅に超える**。

帰結:
- `part8.js:2192` の `if (getGroundY(jx, jz) >= FOREST_MIN_H) continue;` により、**市街地全域で下草が一切生えない**
- `part9.js:75` の `if (h < FOREST_MIN_H || h > TREELINE) continue;` により、**`rebuildForest` が市街地全域を「山」とみなして森の木を撒く**（個別に `roadNear`/`boxNear` で弾かれるだけ）

算術は追跡済みだが、**`elevBase` の実値は実機で未確認**。`console.log(elevBase, getGroundY(player.position.x, player.position.z))` を1回出すだけで即座に確定できる。

**方向性**: `FOREST_MIN_H` を「周辺 N m の最小 `getGroundY` からの比高」に変える（定数名とコメントが元々そう主張している）。

### C-11. `decorateRoad` — 信号機が街区の真ん中に立ち、橋の上では川底に沈む

**該当**: `part4.js:7`（シグネチャ）/ `part4.js:37-49`

```js
function decorateRoad(x1, z1, x2, z2, type, w, rec) {
```
```js
  const minor = (type === 'road' || type === 'tertiary');
  if (minor) {
    // 電柱・電線は撤去済み / 自販機も撤去済み
  } else {
    // ガードレール撤去済み
    if (PROP_SIGNALS && len > 60 && Math.random() < 0.1) {
      const sx = x1 + dx * 0.5 + px * (w / 2 + 0.8), sz = z1 + dz * 0.5 + pz * (w / 2 + 0.8);
```

現在生成されるのは**信号機（＋ポール＋灯火）だけ**。問題が4つ:

1. **配置が `dx * 0.5` ＝ セグメントの中点**。OSMのwayは交差点ノードで分割されるので、`len > 60` を満たすのは交差点から遠い直線区間であり、**信号機は必ず街区の真ん中に立つ**。実際の信号機は交差点にある。
2. **引数 `rec` が本体で一度も使われていない**（`awk` で関数全体を走査して確認済み）。`rec` は橋情報 `bridgeY` を持つのに、位置は `getGroundY(sx, sz)` ＝ 橋の下の地面。→ **橋の上の道路に信号機を置くと川底・谷底に沈む**。
3. `minor` 分岐が**空ブロック**なのに、その手前で `len`(sqrt)・`nx,nz,px,pz`・`ry`(atan2) を毎セグメント計算している（`part4.js:14-18`）。細街路は道路の大多数なので全部捨てられる計算。
4. 交差点・水面・建物への被り判定が無い。

また `motorway_link`（ランプ）は `'trunk'` に変換される（`part8.js:479`）ので、**高速のランプの中点にも信号機が出る**。

**方向性**: 信号機は交差点検出（`part3.js:1376-1382` の `nodeUse` が既に3本以上の共有ノードを数えている）に相乗りさせる。Y は `rec.bridgeY` があれば `bridgeSegmentY` を使う。`minor` の空ブロックは早期 return に。

### C-12. `signalP` が300で枯渇し、以降は「ポールと空中の灯火だけ」になる

**該当**: `part2.js:871-873`

```js
const signalP    = makePool(
  IS_MEIJI ? new THREE.BoxGeometry(0.6, 0.9, 0.45) : new THREE.BoxGeometry(1.1, 0.38, 0.35),
  IS_MEIJI ? ... : new THREE.MeshLambertMaterial({ color: 0x333338 }), IS_MEIJI ? 600 : 300, 'signalP');
```

現実モードで `poleP = 3000` / `lampP = 700` / `signalP = **300**`。`decorateRoad` は3つを**独立に** `poolAdd` する（`part4.js:59-65`）ので、**`signalP` が最初に枯渇し、以降は「ポール＋空中に浮く灯火、信号機の箱なし」が `lampP` の700まで生成され続ける**。

プールはセッション累計でリサイクルされない（`compactPool` は 90% 到達時のみ、かつ距離基準）。警告は `poolFull` が初回1回コンソールに出すだけ。

**方向性**: 3つの `poolFull` を事前にまとめてチェックし、1つでも満杯なら何も置かない。上限は3つとも揃える。

### C-13. 明治・江戸モードの配置ガード漏れ（参考）

`part4.js:19-26` の街道並木は `isOnRoad`/`isNearWater` を通さずに `addTree` する。同じファイルの `scatterTreesIn`（`part4.js:1256-1259`）は両方チェックしているので、**同一ファイル内で対策が食い違っている**。`part8.js:2356` の `addFireTower` は `inAvoid`/`isOnRoad`/`hasBuildingNearby` を1つも通っていない。

→ 街道が渡る川の上に街路樹が生え、火の見櫓が街道の真ん中や町家の中に立ちうる。現実モードには影響しない。

---

## 統合優先順位（3レポート横断）

### 第1段 — 安い・効果が大きい・副作用が小さい

| # | 項目 | 出典 | 効く軸 |
|---|---|---|---|
| 1 | **駅ラベルの距離アンロード**（+ `seenStations` も同時に忘れる） | 本書 B-1 / 性能 B-2 | 長時間安定 ★★★ |
| 2 | **`applySizeFloor` を実測建物に適用しない** | 本書 C-1 | リアリティ ★★★ |
| 3 | **`inAvoid` にセルマスク or bbox交差** | 本書 A-1 | 生成速度 ★★★ |
| 4 | `detailOK()` を距離ベースに | 本書 C-2 | リアリティ ★★ |
| 5 | anisotropy を全テクスチャに（1行×6箇所） | realism A-3 | リアリティ ★★ |
| 6 | 現実モードの松明ライト6個を削除 | realism A-9 | リアリティ ★★／性能も改善 |
| 7 | `height` タグを読む（1行） | realism B-2 | リアリティ ★★ |
| 8 | `jp` 国プロファイルを追加 | 本書 C-3 | リアリティ ★★ |
| 9 | `isOnRoad` を二乗比較に（1行） | 本書 A-2 | 生成速度 ★ |
| 10 | `minimapWaterPolys` を `dropAreaRecordsInTile` に足す | 本書 B-2 | 長時間安定 ★ |
| 11 | `stationLabels` の毎フレーム走査を間引く | 本書 B-1 | 長時間安定 ★ |
| 12 | HemisphereLight / 夜のライト位置 | realism A-4, A-6 | リアリティ ★ |

### 第2段 — 中コスト

建物の決定的乱数化（本書 C-6）、斜面での種別変化の修正（C-5）、店構えの道路向き（C-8）、shop/house のパレット化（C-7）、屋根勾配（C-9）、`decorateRoad` の信号機を交差点へ（C-11）、`FOREST_MIN_H` の基準修正（C-10、**先に実機で `elevBase` を1回確認**）、歩道・小径の分類（realism B-3）、フォグ（realism A-8）、`globalStationPoints` の空間ハッシュ化（本書 B-3）、`_facadeBoxCache` の段数削減（本書 B-4）。

### 第3段 — 重い・前提あり

sRGB出力パイプライン（realism A-1、全体の色再調整が必要）、地形解像度 545m → 10〜50m（realism C-1）、影（realism A-2）、`ELEV_SCALE` 2.0 → 1.0〜1.3（realism C-2）、`processTileData` のフレーム分割（性能 A-2）、house ファサードの実寸連動（本書 C-4）。

---

## 実機で1回だけ確認すべきこと（コードだけでは決まらない）

1. **`elevBase` と市街地中心の `getGroundY`** → C-10 が実際に発動しているかが確定する。1行の `console.log` で済む
2. **`[mem]` ログの `stn:`**（`part9.js:584`）が単調増加するか → B-1 の増加率
3. **HUD の `boxGeo`**（`part9.js:544`）の到達値 → B-4 が実害かどうか
4. **`generateChunk` 先頭で `nearAvoid.map(p => p.pts.length)`** → A-1 の実際の頂点数
5. `[tileData]` ログのms → 性能レビュー A-2 の残り分

---

## 調査範囲と限界

本書は静的解析のみ。実機の画面もプロファイラも見ていない。3領域（建物デザイン／手続き生成／リーク）を並行調査し、**主要な主張はすべて実ファイルで再検証した**。その過程で1件、初期調査の数値（`isOnRoad` のセル数）が誤っていたため訂正している（§A-2）。

「未確認」と明記した項目（C-10 の `elevBase` 実値、B-4 の実到達件数）は、上記の実機確認で1回測れば確定する。それ以外の項目は、引用したコードがそのまま根拠になっている。
