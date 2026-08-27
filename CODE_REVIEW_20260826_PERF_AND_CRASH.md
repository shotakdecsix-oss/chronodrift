# コードレビュー 2026-08-26 — 読み込み/生成の遅延ボトルネックとクラッシュ要因

対象: `index.html` / `js/core/*` / `js/lib/*` / `js/legacy/part1-10.js` / `server/server.js`（計 約16,000行）
目的: **調査・分析のみ**。修正は別チャットで実施する前提。
読み方: 各項目に「症状 → 該当箇所 → なぜ遅い/落ちるか → 確認方法」を書いてある。優先度は A > B > C > D > E の順。

---

## 総評

設計自体はよく出来ている。フレーム分割（建物160-400棟/フレーム、道路24-42ms、植生4ms）、距離アンロード、dormant退避、隔離キュー、空間ハッシュ、サーバ側の優先度レーンとペース配分 — 遅延対策の「型」は一通り揃っている。

**問題は、その型から漏れている経路が数本残っていること。** 具体的には:

1. **タイル応答の取り込み（`processTileData`）だけがフレーム分割されていない。** 建物と道路の「メッシュ生成」は分割済みなのに、その手前の「データ取り込み」は1フレーム同期。しかもその中に全件再構築が仕込まれている（A-1）。
2. **海岸線判定に空間インデックスが無い。** 地形の高さ計算（`getGroundY`）の内側に全セグメント走査が入っている（A-3）。
3. **距離アンロードから取り残された配列が3本ある。** うち1本は毎フレーム全走査される（B-1〜B-4）。
4. **静的配信が無圧縮・キャッシュ検証子なし。** 遠距離ジャンプごとに約1MBを生で再取得している（D-1, D-2）。

---

## A. 生成が固まる（1フレームが数百ms〜数秒ブロックする）

### A-1. 道路1セグメントごとに空間ハッシュ3本を全再構築している ★最重要

**該当**
- `part1.js:1939-1950` `removeBuildingsByIds()`
- 呼び出し元 `part1.js:802` `removeBuildingsOverlappingRoad()` ← `part1.js:878` `addRoadRecord()` ← `part3.js:1322` `addRoad()` ← `part8.js:447` `processTileData()`

**何が起きているか**

```js
function removeBuildingsByIds(removeIds) {
  if (!removeIds || removeIds.size === 0) return;
  for (let i = buildingRecords.length - 1; i >= 0; i--) {   // 全走査 + splice
    if (removeIds.has(buildingRecords[i].bid)) buildingRecords.splice(i, 1);
  }
  collisionBoxes   = collisionBoxes.filter(...);   // 全走査
  minimapBuildings = minimapBuildings.filter(...); // 全走査
  placedBuildings  = placedBuildings.filter(...);  // 全走査
  rebuildCollGrid();             // Map作り直し + 全件をセルに再登録
  rebuildBuildingGrid();         // 同上
  rebuildPlacedBuildingsGrid();  // 同上
}
```

`addRoadRecord` は **道路のwayではなくセグメント（頂点間）単位** で呼ばれる。`processTileData` の `for (let i = 0; i < el.geometry.length-1; i++) addRoad(...)` がそれ。1600m四方の密集タイルには道路セグメントが数千本あり、そのうち既存の建物に被るものが1本でもあれば上記が丸ごと走る。

`PERF.bMax` は std=12,000 / high=25,000（`part1.js:1226-1228`）。つまり **「1セグメントあたり最大25,000件の全走査×5 + Map3本の再構築」** を、被った回数だけ繰り返している。

- unloadFarBuildings（`part1.js:1583`）と updateChunks（`part8.js:2344`）からの呼び出しは removeIds をまとめてから1回だけなので問題ない。**道路経路だけが1件ずつ呼んでいる。**

**確認方法**: `[tileData] XXms elems=N` ログ（`part8.js:719`、閾値20ms）。密集地でこれが数百msを超えていれば確定。`removeBuildingsByIds` の呼び出し回数を1タイルあたりでカウントすると一撃で分かる。

---

### A-2. `processTileData` がタイル応答を1フレームで同期処理している

**該当**: `part8.js:368-720`

**何が起きているか**

- `data.elements` を **5周** する（道路→面フィーチャ→建物→landuse→way帰属）。
- 冒頭で `data.elements.concat(synthesizeBuildingRelationWays(...))`（`part8.js:377`）— elements 配列の完全コピーを作る。10MB級の応答では一時的にヒープが倍になる。
- 道路ループの中の `addRoad`（`part3.js:1246-1348`）は、1回あたり
  `roadGridAdd` + `removeBuildingsOverlappingRoad`（A-1）+ `queueVegetationCleanup` + `decorateRoad` + `poolAdd` + `getGroundY`（A-4）
  を同期実行する。
- 建物ループも1棟ごとに `getBuildingStyle` / `localDensityProfileAt` / `classifyResidential` / `realBuildingIndexAdd` を回す。

建物メッシュ生成（`part9.js:1116` の予算ループ）と道路メッシュ生成（`part1.js:1126` の24-42ms予算）は丁寧にフレーム分割されているのに、**その手前のデータ取り込みには予算が無い**。`OSM_TILE_CONCURRENCY = 8`（`part8.js:74`）なので、応答が連続して返ると `processTileData` が連発でメインスレッドを塞ぐ。

**確認方法**: 同じく `[tileData]` ログ。A-1を直しても残る分がここ。

---

### A-3. 海岸線判定が空間インデックス無しの全件走査 — 地形高さ計算の内側にある ★湾岸で致命的

**該当**
- `part4.js:857-874` `coastGeomAt()`
- `part5.js:71-86` `farNodeY()` → `part5.js:95-104` `farSurfaceY()` → `part5.js:137` `getGroundY()`
- `part4.js:752-793` `rebuildCoastlineChains()`

**何が起きているか**

```js
function coastGeomAt(x, z) {
  for (const r of coastlineRings) if (pointInPolygon(x, z, r)) { ... }  // 全リング × リング頂点数
  for (const s of coastlineSegs) { ... }                                // 全セグメント線形走査
}
```

bbox の早期リジェクト（`part4.js:863-864`）はあるが、**`coastlineSegs` 全件を必ずループする**。空間ハッシュ（`polyGridAdd`/`queryPolyGrid` が既に `part1.js:968-988` にある）が使われていない。

さらに悪いのが無効化の連鎖:

```
新しい海岸線wayが届く
  → _coastlineChainsDirty
  → rebuildCoastlineChains()          (part4.js:1030)
  → coastlineVersion++                (part4.js:791)  ← _seaNodeCache 全無効化
  → _seaMeshDirty = true
  → scanSeaBed()                      (part4.js:902-909, 3秒ごと)
  → updateFarMesh(true)               (part5.js:107)
  → farNodeY() を 61×61 = 3,721ノード分、全部キャッシュミスで再計算
```

湾岸都市（東京湾・NY・香港）では OSM の海岸線が非常に細かく、`coastlineSegs` が数万本になる。**3,721 × 数万 = 数千万〜1億回の距離計算を1フレーム同期で回す**ことになる。数秒のフリーズとして体感されるはず。

加えて `rebuildCoastlineChains` 自体も重い:

```js
for (;;) { const i = takeNext(c[c.length - 1]); if (i < 0) break;
  c = c.concat(...); }   // part4.js:769, 772 — 毎回チェイン全体をコピー = O(n²)
```

**確認方法**: `[coastline] chains=... segs=...` ログ（`part4.js:786`）で segs の実数を見る。`[seabed] mesh rebuilt (XXms)` ログ（`part4.js:907`）が既にあるので、これがそのまま証拠になる。

**関連**: メモリの `project_isehara_game_sea_coastline` にある v16〜v19 の一連の作業でこの経路が出来た。機能としては正しく動いているが、計算量の設計が入っていない。

---

### A-4. `getGroundY` 1回につき文字列4個 + Map操作4回

**該当**: `part5.js:71-104`

```js
function farNodeY(i, j) {
  const k = i + '|' + j;              // 文字列生成
  let e = _seaNodeCache.get(k);       // Map参照
  if (!e || e.v !== coastlineVersion) { ...; _seaNodeCache.set(k, e); }
  ...
}
function farSurfaceY(x, z) { ... farNodeY×4 ... }
function getGroundY(x, z) { return farSurfaceY(x, z); }
```

`addBuilding` は冒頭で `getGroundY` を **5回**呼ぶ（`part3.js:276-280`、中心+四隅）。つまり建物1棟あたり **文字列20個 + Map操作20回**。初期ラッシュ時は `_buildBudget` が最大400（`part9.js:1073`）なので、1フレームで8,000文字列。GC圧としてかなり効く。

`poolAdd`（木・小物）や `decorateRoad` も `getGroundY` を呼ぶので実際はもっと多い。

さらに `_seaNodeCache` は40,000件を超えると **`clear()` で全捨て**（`part5.js:82`）。FAR_STEP=200m なので40,000ノード ≈ 40km四方。長距離移動を続けると定期的に全ミス → A-3の全件走査が再発する。

**確認方法**: Performance プロファイラで `farNodeY` の self time と、GC（minor GC）の頻度。

---

## B. 徐々に重くなる / 長時間プレイで落ちる（リーク）

### B-1. `bridgeSlopes` / `motorwaySlopes` — 毎フレーム全走査、かつ永久に増える ★

**該当**
- 定義: `part3.js:1143` `const bridgeSlopes = []` / `part3.js:917` `const motorwaySlopes = []`
- 追加: `part3.js:1320` / `part3.js:970`（push のみ）
- 走査: `part7.js:1488-1515` `floorHeightAt()` が **両方を毎回線形走査**
- 呼び出し: `part9.js:673`（exploreOnUpdate）/ `part9.js:897`（geoOnUpdate）/ `part10.js:247`（経路シム）= **毎フレーム**

**何が起きているか**

grep で確認した結果、この2配列には **削除・トリム・クリアのコードが1行も存在しない**。道路メッシュは `unloadFarRoads` で解放され、道路レコード自体も `evictFarRoads` で破棄されるのに、**slope配列だけが取り残されている**。

結果:
- 橋・高架を通過するたびに配列が伸びる
- `floorHeightAt` の1回あたりコストが単調増加する
- 毎フレーム呼ばれるので **走れば走るほどFPSが落ちる**

これは「経路シム中のタブクラッシュ」（`ESCALATION_20260728_CRASH.md` の系統）と症状が完全に一致する。長距離を自動走行するモードで最も効く。

**確認方法**: コンソールで `bridgeSlopes.length + motorwaySlopes.length` を定期的に出す。移動距離に対して単調増加なら確定。`updateMemDiag`（`part9.js:534`）の `[mem]` ログに1行足すだけで観測できる。

---

### B-2. 駅ラベルが永久に残る — GPU常駐 + 毎フレームループ ★

**該当**
- 生成: `part4.js:88-121` `addStation()`
- 保持: `stationLabels`（`part4.js:74`）/ `stationRecords`（`part4.js:80`）
- 毎フレーム走査: `part9.js:1001-1008`

**何が起きているか**

```js
const cvs = document.createElement('canvas');
cvs.width = 512; cvs.height = 96;
...
const tex = new THREE.CanvasTexture(cvs);
const labelMesh = new THREE.Mesh(new THREE.PlaneGeometry(40, 8),
  new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: DoubleSide, depthTest: false }));
scene.add(labelMesh);
stationLabels.push({ type: 'label', mesh: labelMesh, x, z });
```

grep の結果、**`stationLabels` / `stationRecords` に対する削除・`dispose()` が1箇所も無い**。`seenStations`（`part8.js:353`）で重複生成は防いでいるが、一度作った駅は距離に関係なくシーンに残り続ける。

- GPU: 512×96×4B = 196KB、mipmap込みで約260KB／駅。都市部を横断すると数百駅 → **数十MBが解放されないままGPUに常駐**
- CPU: `animate()` 内で毎フレーム `stationLabels` を全件回して `quaternion.copy()` を実行 → ループ長が単調増加
- `depthTest: false` かつ `transparent: true` なので、透明パスで常にソート対象になる

建物・道路・面ポリゴンには全部アンロード機構があるのに、駅だけ抜けている。

**確認方法**: `[mem]` ログに既に `stn:` として `stationLabels.length` が出ている（`part9.js:571`）。これが単調増加していれば確定。`[gpuBytes]` の texMB も併せて見る。

---

### B-3. `nodeUse` Map が永久に増える

**該当**: 定義 `part3.js:847`、書き込み `part3.js:1334`

```js
const nodeUse = new Map();  // 道路端点(1m格子)の使用回数
...
const k = Math.round(ex) + ',' + Math.round(ez);
nodeUse.set(k, (nodeUse.get(k) || 0) + 1);
```

grep で `clear` / `delete` が**1件も無い**ことを確認。用途は「同じ端点が3回使われたら交差点 → 横断歩道を置く」だけ（`part3.js:1335`）。

道路セグメントごとに最大2エントリが増える。密集地を長時間走ると数十万〜百万エントリになりうる。文字列キー1個あたりV8で数十バイト+Mapのオーバーヘッドなので、**数十MB〜100MB級のJSヒープ**を無言で食う。

横断歩道は一度置けば再判定不要なので、距離ベースで捨てるか、道路レコードの eviction に合わせて掃除できるはず。

---

### B-4. `railSegs` は書き込み専用のデッドデータ

**該当**: 定義 `part3.js:846`、push `part3.js:1303`

```js
const railSegs = [];  // 現実モード: 線路セグメント(踏切検出・駅ホーム配置用)
...
railSegs.push({ x1, z1, x2, z2 });
```

**読み出しが1箇所も無い。** コメントにある「踏切検出・駅ホーム配置」は実装されていない。線路セグメントごとにオブジェクトを積み続けるだけの純粋な無駄。丸ごと削除して問題ないはず（削除前に他ファイルからの参照が無いことの再確認は必要）。

---

### B-5. 診断計器が本番で常時稼働している（2件）

**B-5a. `logGpuBytes` — 10秒ごとに scene 全体を traverse**

`part9.js:476-532`。`updateMemDiag()`（`part9.js:534`、animate から毎フレーム呼ばれる）の**先頭で無条件に呼ばれ**、中で `% 600` している。

```js
scene.traverse((o) => { ... });   // シーン全オブジェクト
top.sort((a, b) => b.b - a.b);    // 全ユニークジオメトリのソート
```

`part9.js:356-358` のコメントに「🩺オーバーレイと無関係に常時出す」と明記されている。当時の切り分けには必要だったが、シーンに数万オブジェクトある状態では10秒ごとの明確なスパイクになる。

**B-5b. `installGlByteTracker` — `gl.bufferData` の恒久パッチ**

`part9.js:395-431`。全ジオメトリアップロードで `gl.getParameter(ARRAY_BUFFER_BINDING)` が1回増える。

コメント（`part9.js:403-404`）は「Chromeのコマンドバッファがクライアント側にキャッシュしているのでGPU同期は発生しない」としており、Chrome では正しい。ただし**実機がiPhone（iOS Safari / WebKit）なら前提が変わる**。WebKit の `getParameter` は実装が違い、状態問い合わせのコストが Chrome と同等とは限らない。生成ラッシュ中は `bufferData` が1フレームに数百〜数千回走るので、ここは実機で測る価値がある。

どちらも「デバッグフラグで既定OFF」にできる性質のもの。

---

## C. 定期的なカクつき — 保守処理の位相が全部重なっている

**該当**: `animate()` `part9.js:1188-1220` から呼ばれる保守関数群

| 周期 | 関数 |
|---|---|
| `% 90 === 0` | `unloadFarBuildings` (part1:1508) / `reactivateNearbyDormantBuildings` (part1:1599) / `evictFarDormant` (part1:1693) / `scanGateWaitQueues` (part1:1862) / `unloadFarRoads` (part1:1243) / `unloadFarAreaPolys` (part4:1162) / `scanPendingAreaTrees` (part4:1279) / `scanPendingAreaWaterPolys` (part4:284) / `scanPendingCoastlineTiles` (part4:918) / `checkCurrentTileRush` (part8:1664) |
| `% 180 === 0` | `compactPools` (part2:780) / `scanSeaBed` (part4:902) |
| `% 300 === 0` | `evictFarRoads` (part1:1309) |
| `% 120 === 0` | `updateMemDiag` (part9:534) |
| `% 300 !== 7` | `reviveStaleTiles` (part1:1778) ← **これだけ位相がずらしてある** |

**何が起きているか**

剰余が全部 `=== 0` なので、**90の倍数フレームで10個が同一フレームに集中する**。さらに 900フレーム（15秒）ごとに 90 / 180 / 300 の全部が重なる。それぞれが `roadRecords` / `buildingRecords` / `dormantGrid` / `areaPolyMeshes` の全件走査なので、1.5秒周期と15秒周期の明確なカクつきになる。

`reviveStaleTiles` だけ `% 300 !== 7` と 7 だけずらしてあるので、**同じ発想を他にも適用するだけで済む**。修正コストが極めて低い割に体感が変わる項目。

**確認方法**: Chrome DevTools の Performance で15秒録画。1.5秒間隔の等間隔スパイクが見えるはず。

---

## D. 初期読み込みが遅い（起動・ジャンプ時）

### D-1. 静的配信に圧縮が一切かかっていない ★

**該当**: `server/server.js:1348-1385` `handleStatic()`

```js
res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
res.end(data);
```

gzip / brotli の処理が無い。転送量:

| ファイル | サイズ |
|---|---|
| js/legacy/part1-10.js | 約 900KB |
| index.html | 41KB |
| js/core + js/lib | 36KB |
| **合計** | **約 977KB を毎回そのまま送信** |

JS は gzip で概ね 1/5 になる。モバイル回線では体感差が非常に大きい。Node 標準の `zlib` で `Accept-Encoding` を見て `createGzip` を挟むだけ。

### D-2. `Cache-Control: no-cache` + 検証子（ETag / Last-Modified）が無い ★

**該当**: `server/server.js:1372`（index.html）, `1383`（その他全部）

`server.js:1377-1382` のコメントにある意図（デプロイ後に古いJSを掴ませない）は完全に正しい。**ただし ETag も Last-Modified も付けていないため、ブラウザは条件付きリクエストを送れず、304 を返せない。** 結果として `no-cache` が実質 `no-store` として働き、**毎回フルダウンロード**になっている。

しかも遠距離ジャンプは `location.reload()`（`part7.js:172`）なので、**マップジャンプのたびに約1MBを生で再取得している**。

`ETag`（ファイル内容の sha1 か mtime+size）を付ければ、`no-cache` のまま「毎回検証するが中身が同じなら304・0バイト」になる。鮮度と速度が両立する。**D-1 と D-2 は同じ関数を触るので一緒に直せる。**

### D-3. Leaflet を起動時に同期ロードしている

**該当**: `index.html:655-656`

```html
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
```

Leaflet はマップジャンプパネル（`openMapJump`, `part7.js:255`）を開くまで使わない。それを同期 `<script>` で、しかも three.js（cdnjs）とは**別のCDN**から取っている。追加のDNS解決＋TLSハンドシェイク1往復がクリティカルパスに乗る。

地図を開いた時に動的にロードすれば、起動時のブロッキングから外れる。

### D-4. 初回起動が実質2周する

**該当**: `part9.js:1308-1360`（ブートストラップ）+ `part7.js:149-173`（`jumpToLatLon`）

保存位置が無い初回:

```
loadNearTerrain(0, 0)          ← 伊勢原の地形をロード（ネットワーク待ち）
  → loadOSM()                  ← 伊勢原のOSMをロード
  → await getStartLocation()   ← 位置情報を最大8秒待つ（part6.js:488）
  → jumpToLatLon(現在地)
      → distFromOrigin > RECENTER_DIST_M なら location.reload()   ← part7.js:172
```

つまり **伊勢原の地形とOSMを丸ごとロードしてから捨てて、全JSを再取得してやり直す**。伊勢原以外に住んでいるユーザーの初回起動は、この往復ぶん丸損している。

`startLocP` は既に `part9.js:1309` で並行起動しているので、`await` の位置を前倒しして「現在地が確定してから最初の地形ロードを始める」形にできる可能性が高い（8秒のタイムアウトをどう扱うかは要検討）。

### D-5. タイル取得のゲートに住所取得が挟まっている

**該当**: `part6.js:472-478`

```js
showToast(t('mapLoadingToast'), { sticky: true });
awaitingDestinationLoad = true;
await Promise.race([
  updateAddressDisplay(),           // 逆ジオコーディングのネットワーク往復
  new Promise(res => setTimeout(res, 1500)),
]);
initialWorldLoaded = true;          // ← これが立つまでタイル取得が一切始まらない
```

`initialWorldLoaded` は `checkOSMTiles` の先頭ゲート（`part8.js:1705`）。住所表示（HUDの文字）はゲームの生成と無関係なのに、**最大1.5秒ぶんタイル取得の開始を遅らせている**。`initialWorldLoaded = true` を先に立てて、住所取得は fire-and-forget にできるはず。

---

## E. 潜在的なハング・その他

### E-1. `fetchOSMTileBatch` の同期前半が try で保護されていない ★要注意

**該当**: `part8.js:783`（呼び出し元）, `part8.js:1003-1382`（保護されていない区間）, `part8.js:1383`（try開始）, `part8.js:1424` / `1652`（デクリメント）

```js
// processOSMTileQueue (part8.js:782-784)
osmTileActiveCount++;
fetchOSMTileBatch({ soloOnly: _farFull });   // await していない = rejection を誰も拾わない
```

`osmTileActiveCount--` は **1424行（キャッシュヒット）と1652行（末尾）の2箇所だけ**で、`finally` に入っていない。そして `try {` は 1383行から始まる。

**つまり 1003〜1382 行のどこかで例外が飛ぶと、未処理の rejected promise になって枠が永久に返らない。** 8枠あるので、8回起きれば**世界の読み込みが完全に停止する**（画面は動くがタイルが一切来なくなる）。

具体的に危ないのが `part8.js:1245`:

```js
const nextTile = osmTileQueue[0];                              // 1156行
const _headBlocking = !!(nextTile && _blockingTiles.has(...));  // 1224行 ← ガードあり
const _headNearSplit = _isNearSplit(nextTile);                  // 1245行 ← ガード無し
//    _isNearSplit = (t) => Math.max(Math.abs(t.tx - _pTileX), ...)  → t が undefined なら TypeError
```

1156行と1224行は `nextTile &&` でガードしているのに、**1245行だけ素通し**になっている。現状の呼び出し経路では `osmTileQueue.length > 0` が保証されているように見えるが、ガードの一貫性が崩れているのは危ない。

さらに `part8.js:1305-1311` のコメントに、**過去に実機で「osmTileActiveCount が 2 のまま固まり、成功も失敗も一切記録されない」状態が観測された**と書かれている。その時は AbortController 未使用が原因と結論づけているが、**枠のデクリメントが finally に入っていない構造は今も残っている**。同じ症状が再発しうる。

対策の方向としては、(a) 1245行のガード追加、(b) `osmTileActiveCount--` を `try/finally` で必ず対にする、(c) 呼び出し側で `.catch()` を付けて未処理rejectionを潰す — の3点。

### E-2. `updateChunks` のアンロードが `buildingRecords` 全走査 × アンロードチャンク数

**該当**: `part8.js:2326-2343`

```js
for (const [key, meshes] of chunkMeshes.entries()) {
  if (アンロード対象) {
    ...
    for (const rec of buildingRecords) {      // 最大 25,000
      if (rec.ck === key) removeIds.add(rec.bid);
    }
  }
}
```

`updateChunks` はチャンク境界（`CHUNK_SIZE = 120m`）をまたぐたびに走る。`CHUNK_RADIUS = 8`（std）だと、境界越え1回で外周1列 ≈ 20チャンク前後がアンロード対象になる。

→ **20 × 25,000 = 50万回のループ**を、120m進むごとに実行。ダッシュ（最大45m/s）なら2〜3秒ごと。

`rec.ck → bid[]` の逆引きMapを1本持てば消える。

### E-3. `processChunkQueue` が毎フレーム最大441件を空回りしている

**該当**: `part8.js:2407-2431`

```js
for (let i = 0; i < chunkGenQueue.length; i++) {
  ...
  if (!chunkTilesReady(c.x, c.z)) continue;   // 毎回 osmTilesReadyAround → 文字列キー生成 × 4
  if (!chunkNearTerrainReady(c.x, c.z)) continue;
  chunkGenQueue.splice(i, 1);
  generateChunk(c.x, c.z);
  return;                                      // 1フレーム1チャンクだけ
}
```

`CHUNK_RADIUS` は std=8（289チャンク）、high=10（441チャンク）。**準備が整っていない間、毎フレーム全件を評価して1個も生成せずに抜ける。** `chunkTilesReady` → `osmTilesReadyAround`（`part8.js:2358`）は毎回 `` `${tx},${tz}` `` を作って Set 参照するので、1フレームで千数百回の文字列生成。

「ready になった時だけ再評価する」形（tile到着時にそのタイルに属するチャンクだけ起こす）にすれば消える。

### E-4. `osmTileQueue.sort` が dispatch のたびに全ソート

**該当**: `part8.js:1127-1132`

```js
osmTileQueue.sort((a, b) => {
  const ra = (osmTileNextRetryAt.get(_tileKey(a)) || 0) > _now ? 1 : 0;   // Map参照 + 文字列生成
  ...
  return _tileScore(a) - _tileScore(b);   // 内部で Date.now() と Map参照
});
```

`_tileScore` は比較のたびに `osmTileQueuedAt.get(tileStateKey(...))` を呼ぶ（`part8.js:1091`）。`processOSMTileQueue` は空き枠のぶんだけ `fetchOSMTileBatch` を回すので、**最大8回連続でフルソート**が走る。キューが数百件あると無視できない。

スコアを事前計算して1回だけソートする（Schwartzian transform）か、優先度キューにすれば済む。

### E-5. 監視項目（今は問題ないが将来効く）

- **`FACADE_CACHE_MAX`**（`part2.js:98`）が std/high で `Infinity`。参照カウントで解放されるので現状は健全だが、解放漏れが1つでもあると refCount が 0 に落ちずキャッシュに残り続ける。`releaseFacadeMat` の警告カウンタ（`part2.js:324` `_facadeReleaseWarnCount`）が非0になっていないか実機で確認する価値あり。
- **サーバのメモリ**（`server.js:1258` `const buf = up.body`）。応答は全部メモリにバッファする。`server/cache/overpass/` に **10.7MB の応答が4本**ある。クライアント同時8本 × 大きい応答が重なると RSS が跳ねる。Render のインスタンスサイズ次第では OOM再起動 → 全リクエスト失敗 → クライアント側の 429/5xx バックオフ発動、という連鎖になる。`server.js:607-617` の `[rss]` ログで既に観測できる。
- **`landusePolygons` / `namedPlacePoints`** はタイル破棄で掃除される（`part4.js:1098-1120`）。`seenOSMWays` / `tileWays` / `tileRelations` は訪問エリアに比例して増えるが、`resetTileForRefetch` で削除経路がある。ここは健全。

---

## 優先順位まとめ（修正コスト対効果）

| # | 項目 | 症状 | 修正の重さ | 効果 |
|---|---|---|---|---|
| 1 | **A-1** 道路ごとの全グリッド再構築 | タイル到着で数百ms〜秒のフリーズ | 中（バッチ化） | ★★★ |
| 2 | **D-1 + D-2** gzip + ETag | 起動・ジャンプが毎回1MB生ロード | **軽**（server.js 1関数） | ★★★ |
| 3 | **B-1** bridgeSlopes/motorwaySlopes | 走るほどFPS低下、長時間で落ちる | 軽〜中 | ★★★ |
| 4 | **A-3** coastGeomAt 全件走査 | 湾岸で数秒フリーズ | 中（空間ハッシュ導入） | ★★★（湾岸限定） |
| 5 | **C** 保守処理の位相集中 | 1.5秒/15秒周期のカクつき | **極軽**（剰余をずらすだけ） | ★★ |
| 6 | **B-2** 駅ラベルの永久残留 | GPU数十MB + 毎フレームループ増加 | 中（アンロード実装） | ★★ |
| 7 | **E-1** fetch枠のリーク耐性 | 最悪、読み込みが完全停止 | **軽**（ガード+finally） | ★★（保険） |
| 8 | **B-3/B-4** nodeUse / railSegs | JSヒープの無言の増加 | **極軽**（B-4は削除のみ） | ★★ |
| 9 | **A-2** processTileData のフレーム分割 | A-1修正後に残るフリーズ | 重（構造変更） | ★★ |
| 10 | **D-4 + D-5** 初回起動の二度手間 | 初回起動が数秒〜十数秒余計 | 中 | ★★ |
| 11 | **B-5** 診断計器の常時稼働 | 10秒ごとのスパイク、iOS要検証 | **極軽**（フラグ化） | ★ |
| 12 | **E-2/E-3/E-4** 空回りループ | 常時の地味な負荷 | 中 | ★ |
| 13 | **A-4** getGroundY の文字列コスト | GC圧 | 中 | ★ |

**最初の一手として推奨**: 2（gzip+ETag）と 5（位相ずらし）と 8（railSegs削除）。どれも局所的で副作用が小さく、効果が実機ですぐ分かる。その結果を見てから 1 → 3 → 4 の順で本丸に入るのが安全。

---

## 調査範囲について

読んだもの: `index.html`、`js/legacy/part1-10.js` 全体の関数マップ + 主要ホットパスの本文、`js/core/audio.js`、`js/lib/pure.js`、`server/server.js` の配信・キャッシュ・スケジューラ部分。

読んでいないもの: `js/legacy/part10.js`（経路シム）の詳細、`server/server.js` の INJECT スクリプト本体とミラー切替のエラー処理詳細、`historical-data/`、各種 `.md` 設計書。

すべて静的解析。実機計測はしていないため、各項目の「確認方法」で裏を取ってから着手することを推奨する。特に A-1 と A-3 は影響の大きさが場所（都市の密度・海岸線の有無）に強く依存する。
