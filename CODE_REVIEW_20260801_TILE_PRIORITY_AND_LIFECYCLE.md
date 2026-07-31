# コードレビュー 2026-08-01 — 近傍優先タイル生成・移動時の優先度・遠方消去/再生成

対象: `js/legacy/part1.js`(建物/道路のライフサイクル)、`js/legacy/part8.js`(タイル取得キュー・
優先度スコア・チャンク)、`js/legacy/part9.js`(毎フレームの生成ループ・デバッグオーバーレイ)。

ユーザー報告の2症状:
- (A) 足元・近場より先に、ずっと遠くのタイルで道路・建物が生成されるケースがある
- (B) 一度離れて再び足元に来たタイルが「生成完了(緑緑緑)」なのに道路・建物が出ない

結論から言うと、**(A)と(B)は同じ1本のバグから出ている**可能性が高い。優先度スコアリング
(`_tileScore`)そのものは設計として概ね妥当で、真犯人は距離定数のラダーが1箇所ひっくり返って
いることと、way ID の重複排除キーとレコード消去キーが食い違っていることの2点。

---

## P0-1 【最重要】遠方タイルの「取得 → 破棄 → 再取得」無限ループ

### 距離ラダーの反転

`part1.js` の定数:

```js
const DORMANT_KEEP_DIST  = Math.max(4000, ROAD_UNLOAD_DIST * 1.6); // std: 4000m
const STALE_REVIVE_DIST  = Math.max(5000, ROAD_UNLOAD_DIST * 1.5); // std: 5000m
```

`DORMANT_KEEP_DIST (4000) < STALE_REVIVE_DIST (5000)` になっている。この2つは
「捨てる境界」と「作り直す境界」なので、**捨てる境界の方が内側にあると、捨てた瞬間に
作り直し条件を満たす**。std / lite の両方で反転している(high だけ 5120 > 5000 で辛うじて正しい)。

### 実際に起きること(1周1.5秒)

`animate()` の呼び出し順(part9.js:1095-1096)で、両者は**同一フレーム**に走る
(`_dormantEvictFrame` も `_staleReviveFrame` も毎フレーム +1 して `% 90` なので位相が一致):

```
evictFarDormant()   → 4000m 超の dormant セルを破棄 + markTileStale(そのタイル)
reviveStaleTiles()  → 5000m 以内の staleTiles を dropTileRemnants → resetTileForRefetch
checkOSMTiles()     → 未取得になったタイルを再キュー
```

具体的な循環:

1. `checkOSMTiles` の先読みが 4800m 先(`k=3`)のタイルを取得。道路レコードが登録され、
   建物は `bGenReal`(std 2200m)より遠いので `dormantAdd` される(part9.js:1029)。
2. 1.5秒後、`evictFarDormant` が 4000m 超なのでその dormant を全部捨て、`markTileStale`。
3. **同じフレームで** `reviveStaleTiles` が「5000m 以内なので作り直そう」と判断し、
   そのタイルの道路レコードを**全部削除**して `resetTileForRefetch`(= 未取得状態へ)。
4. 同じフレームの `checkOSMTiles` が「未取得タイル」として再びキューへ。
5. → 1 に戻る。

Overpass への再リクエストが 1.5 秒周期で永久に発生し続ける。

### 5×5 の外周リングも巻き込まれる

先読み半径 `prefetchR=2` の外周タイルはワールド座標で 3200〜4800m を占め、その外側半分が
4000m を超える。つまり**常時取得している 5×5 の外周 16 枚のうち、辺方向のタイルは
ほぼ確実にこのループに入る**(タイル中心 ≒ 4000m ≤ 5000m のため revive 条件も満たす)。

BIRD モードでは `_fwdKMax = 6 * BIRD_SPEED_MULT = 18` なので先読みが 28,800m まで伸び、
この帯に入るタイル数がさらに増える。

### これが症状 (A) の正体

- 遠方タイルが 1.5 秒ごとに「未取得」に戻るため、`queueTile` が延々と再投入し続ける。
- `_tileScore` は近傍を優先するが、**同時実行枠(`OSM_TILE_CONCURRENCY=8`、うち far 枠は
  最大 7)を実際に占有しているジョブは追い越せない**。遠方タイルが枠に居座り続けるので、
  後から来た足元ジョブが空きを待つ。
- デバッグオーバーレイ上では「遠くのタイルばかり色が変わり続ける」ように見える。

さらに `reviveStaleTiles` は対象があるたびに `roadRecords` 全件走査 + `roadGrid.clear()` +
全件再構築を行う。`evictFarRoads` にはある `ROAD_RECORD_SOFT_MIN = 20000` のガードが
こちらには無いので、**1.5 秒ごとに数万件のグリッド再構築**が走る。

### 修正案

```js
// 「捨てる」より「作り直す」を必ず内側にする(ヒステリシス)
const DORMANT_KEEP_DIST = Math.max(4000, ROAD_UNLOAD_DIST * 1.6);
const STALE_REVIVE_DIST = Math.min(DORMANT_KEEP_DIST * 0.7, ROAD_UNLOAD_DIST * 1.2);
// std: KEEP 4000m / REVIVE 2800m。ROAD_UNLOAD_DIST(2500m)より外なので
// 目の前の道路が消えて再生成される「ちらつき」も起きない。
```

加えて、**取得したばかりのものを捨てない**ためのガードを `evictFarDormant` に入れる:

```js
// 先読み範囲内のタイルは「これから使う」ので dormant を捨てない
const _prefetchKeep = (PERF.prefetchR + 1) * OSM_TILE_M; // std: 4800m
const keep2 = Math.max(DORMANT_KEEP_DIST, _prefetchKeep) ** 2;
```

そして `reviveStaleTiles` にも `evictFarRoads` と同じ「頻度・件数」ガードを入れる
(毎回の全件 roadGrid 再構築を避ける)。

---

## P0-2 【最重要】`seenOSMWays` のタイル帰属と、レコード消去のタイル帰属が食い違っている

### 現状

- **way ID の記録**(part8.js:571-585): way の *先頭ノード* が乗るタイルに帰属させる。

  ```js
  const g = (el.geometry && el.geometry[0]) || ...;
  const k = osmTileKeyOfXZ(pxz.x, pxz.z);
  tileWays.get(k).push(el.id);
  ```

- **道路レコードの消去**(part1.js `reviveStaleTiles` / `evictFarRoads`): *線分の中点* が
  乗るタイルで判定。

  ```js
  osmTileKeyOfXZ((r.x1 + r.x2) / 2, (r.z1 + r.z2) / 2)
  ```

タイルは 1600m 四方なので、幹線道路・線路・河川は当然のようにタイルをまたぐ。1本の way は
複数タイルに線分レコードを持つが、way ID は**先頭ノードのタイル1枚にしか記録されない**。

### 症状 (B) の直接原因

タイル B(way の先頭ノードはタイル A にある)が `resetTileForRefetch` された場合:

1. `resetTileForRefetch(B)` は `tileWays.get(B)` を見るが、その way ID は A 側にあるので
   `seenOSMWays` から**削除されない**。
2. 一方 `reviveStaleTiles` / `evictFarRoads` は中点基準なので、B にある線分レコードは
   **削除済み**。
3. B を再取得すると `processTileData` の
   `if (seenOSMWays.has(el.id)) return;`(part8.js:342 道路 / 415,423 建物 / 546 landuse)
   で全部素通り。
4. B は成功扱いなので `roadReadyTiles` / `buildingReadyTiles` に入り、**オーバーレイは緑緑緑**。
   しかし道路も建物も存在しない。

これは**戻ってくるたびに単調に悪化する**(戻る→破棄→再取得→さらに欠ける)ので、
「一度離れて再度足元に来たタイル」という報告の条件と完全に一致する。

### 逆向きの二重生成も起きる

タイル A(先頭ノード側)がリセットされると way ID は `seenOSMWays` から消えるが、
B・C にはその way のレコードが**生きたまま残っている**。A を再取得すると way 全体が
再処理され、B・C に**同じ道路がもう1本**生成される。コード内のコメント
(part8.js:227-232)が警戒している「二重生成」が、まさにこの経路で起きる。

### 修正案

「way の帰属タイル」を**一意に決め、レコード側もその同じキーで管理する**のが本筋。

1. `processTileData` で way を処理する時点で帰属タイルキー `otk`(owner tile key)を確定させ、
   `addRoad` / 建物ディスクリプタに `r.otk` / `b.otk` として焼き込む。
2. `evictFarRoads` / `reviveStaleTiles` / `dropTileRemnants` / `dormantAdd` は中点計算をやめて
   `r.otk` / `b.otk` を使う。
3. これで「タイル X をリセットして再取得すると、X の way が全部作り直される」が
   **過不足なく**成立する(欠落も二重生成も構造的に起きない)。

副次的に、`markTileStale(b.x, b.z)` も `markTileStale(b.otk)` に変わり座標→キー変換が消える。

暫定的な軽い対処だけ先に入れるなら、`tileWays` へ **way が跨る全タイル**を登録し、
`resetTileForRefetch` が跨りタイル分も `seenOSMWays` から落とすようにする方法もある
(欠落 = 症状 B は消えるが、二重生成のリスクが残るので推奨は 1〜3)。

---

## P1 スケジューリング・優先度まわり

### P1-1 far 枠の予約が 1 枠しかない

```js
const OSM_TILE_CONCURRENCY = 8;
const OSM_TILE_CONCURRENCY_FAR_MAX = Math.max(1, OSM_TILE_CONCURRENCY - 1); // = 7
```

同時実行が 2 だった頃の「1 枠だけ近傍用に空けておく」という設計をそのまま 8 に持ち上げた
形になっており、**遠方まとめクエリが 7 枠まで取れる**。優先度スコアは実行中のジョブを
追い越せないので、密集地で遠方クエリ(10〜30秒)が 7 本走っていると足元ジョブは最長で
その分待つ。近傍用の予約を絶対数ではなく比率にすべき:

```js
const OSM_TILE_CONCURRENCY_FAR_MAX = Math.max(1, Math.floor(OSM_TILE_CONCURRENCY / 2)); // 8→4
```

### P1-2 `t.kind === 'building'` が距離に関係なく tier2 帯に入る(潜在)

```js
if (t.kind === 'building') return base - agingTiebreak - 10000; // 距離無関係に tier2
```

2026-07-27 の修正意図(「近傍圏外に出た建物ジョブが恒久的に後回しになる」)は正しいが、
現在の `queueTile` は `roadReadyTiles.has(key)` の分岐を**全域**に出しているため、
9km 先の先読みタイルが road だけ確定した場合でも建物ジョブが tier2(= 足元の 3×3 と同じ帯)
に入る。`window.SPLIT_NEAR_QUERIES = false` が既定の今は road ジョブが作られないので
ほぼ発火しないが、`gaveUp` 経路(part8.js:1467-1470 → `unlockTileReadiness(k,'road')`)や
分離を再度有効化した瞬間に「遠くの建物が足元より先」に化ける。

距離でクランプするのが安全:

```js
if (t.kind === 'building') {
  const far = Math.max(Math.abs(t.tx - _pTileX), Math.abs(t.tz - _pTileZ)) > NEAR_TIER_R;
  return base - agingTiebreak - (far ? 8000 : 10000); // 圏外なら tier3 より下の独立帯
}
```

### P1-3 生成キューの距離再ソートが 30 フレーム(0.5秒)周期

`pendingBuildings` / `pendingRoadMeshes` はタイル到着時にそのバッチ内だけ距離ソートされ
(part8.js:411, 542)、全体の並べ直しは 30 フレームごと(part9.js:924, 947)。ラッシュ中の
建物予算は最大 400 棟/フレームなので、**再ソートまでの 0.5 秒で最大 12,000 棟**が
「古い順序」のまま処理されうる。遠方タイルが先に届いていれば、その 12,000 棟が
足元より先に建つ。これも症状 (A) に寄与する。

改善は 2 通り:
- 高速移動中(BIRD / 経路シム / ダッシュ)は再ソート周期を 10 フレームに縮める
- あるいは到着バッチを末尾 push ではなく距離マージ挿入にする(ソート済み同士のマージ)

### P1-4 `sortNewEntriesByDistanceToPlayer` の実装コスト

```js
const tail = arr.splice(fromIdx);   // 末尾を丸ごと新配列にコピー
tail.sort(...);
for (const t of tail) arr.push(t);  // 1件ずつ push で戻す
```

`pendingBuildings` が数万〜数十万件になる密集地で 0.5 秒ごとに実行される。
`splice` の新配列生成と `getXZ()` が比較のたびにオブジェクトリテラルを作る点
(`{x, z}` を O(n log n) 回生成)が GC 圧になる。インプレースソート + 事前に
距離を焼いた数値配列(または `getX`/`getZ` の2関数)に変えると効く。

### P1-5 `_tileScore` の距離とタイル昇格の距離が別物

- `_tileScore` の `base` はタイル index のマンハッタン距離 `|dx| + |dz|`
- `_blockingTiles` の tier1 昇格(part8.js:900-914)は矩形クランプのユークリッド距離

同じ「近さ」の話なのに尺度が違うので、斜め方向のタイルの順位が直感とずれる。
`base` もユークリッド(`Math.hypot`)に揃える方が読みやすく、挙動も素直になる。

---

## P2 ライフサイクルの整合性・上限のないデータ

### P2-1 無制限に増え続ける構造(長時間セッションで効く)

削除処理が一切ないもの:

| 構造 | 場所 | 備考 |
|---|---|---|
| `seenOSMWays` | part8.js:224 | `resetTileForRefetch` でしか減らない。数十万件規模 |
| `seenOSMRelations` | part8.js:264 | 同上 |
| `tileWays` / `tileRelations` | part8.js:233-234 | タイルごとの way ID 配列。訪問タイル数に比例 |
| `seenStations` | part8.js:296 | 減らない |
| `avoidPolygons` / `landusePolygons` / `avoidGrid` / `landuseGrid` | part4/part7 | コードにも「増え続けて減らない」と明記 |
| `minimapWaterPolys` / `areaPolyMeshes` | part8.js:408 付近 | 同上 |
| `loadedChunks` | part8.js | `chunkMeshes` にエントリがある分しか delete されない |

経路シム・BIRD で長距離移動する現在の使い方では、`dormantGrid` / `roadRecords` に上限を
入れたのと同じ理屈でここも効いてくる。少なくとも `seenOSMWays` / `tileWays` は
P0-2 の `otk` 化とセットで「捨てたタイルの way ID も捨てる」ようにできる。

### P2-2 `loadedChunks` の削除条件

```js
for (const [key, meshes] of chunkMeshes.entries()) {
  if (遠い) { ...; chunkMeshes.delete(key); loadedChunks.delete(key); }
}
```

`loadedChunks` から消えるのは `chunkMeshes` にエントリがあるチャンクだけ。
`generateChunk` は最後に必ず `chunkMeshes.set(key, added)` するので通常は対になるが、
`generateChunk` が冒頭で早期 return する経路(`!initialWorldLoaded` / `!meijiReady`)を
通ると `loadedChunks` に入ったまま `chunkMeshes` に入らず、**そのチャンクは二度と
生成されない**。`processChunkQueue` 側のゲート(`chunkTilesReady` / `chunkNearTerrainReady`)を
通ってから呼ばれるので現状は踏みにくいが、`loadedChunks` を「生成済み」ではなく
「キュー済み」の意味で使っている点は将来の落とし穴。

### P2-3 `processChunkQueue` の範囲外チャンク回収が途中で止まる

```js
for (let i = 0; i < chunkGenQueue.length; i++) {
  ... if (範囲外) { splice; continue; }
  if (!ready) continue;
  splice; generateChunk(...); return;   // ← ここで抜けるので以降は今フレーム未走査
}
```

生成できるチャンクが早い位置で見つかると、それより後ろの範囲外エントリはそのフレームでは
回収されない。次フレームで先頭から再走査されるので最終的には消えるが、キューが長いと
掃除が遅れる。掃除ループと生成ループを分けた方が挙動が読みやすい。

### P2-4 `pendingRoadMeshes` から距離で弾かれた道路の復帰経路

`processRoadMeshQueue` は `_rlim2` を超える道路をキューから外すだけ(`r.mesh` は null のまま)。
復帰は `unloadFarRoads` の

```js
if (!r.mesh) { if (dd <= lim2r) queueRoadMesh(r); continue; }
```

に頼っているが、これは `roadRecords` **全件走査**を 1.5 秒ごとに行う。経路シムでレコードが
10万件規模になると、この 1 行のために毎回 10 万回のループが回る。`roadGrid` を使った
近傍クエリ(プレイヤー周囲 `ROAD_UNLOAD_DIST` の矩形)に置き換えられる。

---

## 優先順位つきの推奨アクション

| # | 内容 | 効く症状 | 規模 |
|---|---|---|---|
| 1 | `STALE_REVIVE_DIST < DORMANT_KEEP_DIST` に修正 + 先読み範囲内は dormant を捨てない | (A)(B) 両方。遠方の無限再取得が止まる | 数行 |
| 2 | way の帰属タイルを `otk` として焼き込み、レコード消去・`seenOSMWays` 解除を同じキーで行う | (B) の恒久欠落・二重生成 | 中(part8 + part1 数十行) |
| 3 | `OSM_TILE_CONCURRENCY_FAR_MAX` を 7 → 4 | (A) 足元ジョブの待ち時間 | 1行 |
| 4 | `kind === 'building'` の tier を距離でクランプ | (A)(分離オン時) | 数行 |
| 5 | 高速移動中の距離再ソート周期を 30 → 10 フレーム | (A) | 数行 |
| 6 | `reviveStaleTiles` に頻度・件数ガード、`unloadFarRoads` を `roadGrid` 近傍クエリ化 | フレーム時間 | 小〜中 |
| 7 | `seenOSMWays` / `tileWays` の距離破棄 | 長時間セッションのメモリ | 小(2 とセット) |

1 と 3 は数行で入るうえ効果が大きいので、まずここだけ入れて実機のデバッグオーバーレイで
「遠方タイルの色が 1.5 秒周期で変わり続ける」現象が止まるか確認するのが良い。
2 は 1 を入れてもなお「戻ると緑なのに空」が残る場合の本命。

## 検証方法(実機)

1. 🩺 オーバーレイ ON で 5×5 の外周タイルを注視。修正前は 1.5 秒周期で
   緑 → 灰(unqueued)→ 赤(fetching)→ 緑 を繰り返しているはず。
2. コンソールの `[fetch] queue` が移動を止めても 0 に落ち着かない(常に数件残る)なら
   P0-1 のループが動いている証拠。
3. `[staleTile] Nタイルを作り直します` のログが移動していないのに定期的に出るなら確定。
