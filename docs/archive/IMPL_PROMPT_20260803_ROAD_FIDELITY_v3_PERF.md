# 実装指示 v3: 修正A・B投入後の「生成が遅くなった」の原因と対処

作成: 2026-08-03 / 対象コミット `1220517`(修正A)、`95dd491`(修正B暫定)

症状が直ったのは修正Aが効いた証拠。一方の速度低下も**修正Aが持ち込んだもの**で、
心当たりが3つある。P1がほぼ確実な主因、P2は体感の「道路がなかなか安定しない」に効く。

---

## P1【主因】way帰属の算出が、タイル到着処理の同期パスで全ノードを舐めている

`part8.js` processTileData 末尾(修正Aで追加):

```js
if (el.geometry && el.geometry.length) {
  const seenTilesForWay = new Set();          // ← way 1本ごとに Set を確保
  for (const g2 of el.geometry) {
    const p2 = latLonToXZ(g2.lat, g2.lon);    // ← ノードごとに {x,z} オブジェクトを確保
    seenTilesForWay.add(osmTileKeyOfXZ(p2.x, p2.z));  // ← ノードごとに文字列を確保
  }
  ...
}
```

これが **応答に含まれる全way**(= 圧倒的多数は建物)に対して走る。

- 密集地の1600mタイル1枚は way 数千〜数万、ノード総数10万オーダー。
- 1ノードあたり **オブジェクト1個 + 文字列1個 + Set挿入1回**。
  way 1本ごとに Set も1個。→ 1タイルで数十万アロケーション。
- `processTileData` は**完全に同期**。ここが伸びた分、フレームループが止まる。
  止まっている間は `processRoadMeshQueue` / 建物生成 / `processChunkQueue` が
  1件も進まない。**取得が速くなっても生成が進まない**という体感になる。
- VK Maps 化で並列度を 8 に上げているので、タイル到着が重なるとこの同期ブロックも重なる。

**しかも99%は無駄。** 建物・小さな公園ポリゴンは 1600m タイルをまたがない。
またぐのは線路・幹線道路・大きな森ポリゴンだけで、全体のごく一部。

### 修正P1: bbox で早期脱出する(アロケーション0で判定)

```js
// 1) まず lat/lon の min/max だけを数値で求める(オブジェクトも文字列も作らない)
let mnLat = Infinity, mxLat = -Infinity, mnLon = Infinity, mxLon = -Infinity;
for (const g2 of el.geometry) {
  if (g2.lat < mnLat) mnLat = g2.lat;
  if (g2.lat > mxLat) mxLat = g2.lat;
  if (g2.lon < mnLon) mnLon = g2.lon;
  if (g2.lon > mxLon) mxLon = g2.lon;
}
// 2) bbox の四隅だけ座標変換してタイル範囲を出す(latLonToXZ 呼び出しは2回だけ)
const pA = latLonToXZ(mnLat, mnLon), pB = latLonToXZ(mxLat, mxLon);
const tx0 = Math.floor(Math.min(pA.x, pB.x) / OSM_TILE_M), tx1 = Math.floor(Math.max(pA.x, pB.x) / OSM_TILE_M);
const tz0 = Math.floor(Math.min(pA.z, pB.z) / OSM_TILE_M), tz1 = Math.floor(Math.max(pA.z, pB.z) / OSM_TILE_M);

if (tx0 === tx1 && tz0 === tz1) {
  // 単一タイルに収まる = 全体の99%(建物・小ポリゴン)。1キーだけ登録して終了
  pushTileWay(tx0 + ',' + tz0, el.id);
} else {
  // タイルをまたぐwayだけ、従来どおりノード単位で通過タイルを集める
  ...既存の Set ループ...
}
```

**注意**: bbox が複数タイルにまたがる場合に「bbox内の全タイル」を登録して済ませてはいけない。
斜めに走る長い線路では通過しないタイルまで帰属し、そのタイルがstaleになるたびに
無関係な長いwayを un-see することになり、P2の症状を悪化させる。**またぐwayだけは
ノード単位で正確に**(数が少ないので全体コストには効かない)。

### 計測(先にこれを入れて主因を確定させること)

`processTileData` の先頭と末尾で `performance.now()` を取り、
`console.log('[tileData] ' + ms.toFixed(1) + 'ms elems=' + data.elements.length)` を出す。
修正A前後で比較できないなら、**上の早期脱出を入れた前後**で比較すればよい。
密集地で 100ms → 10ms 程度に落ちるはず。落ちなければ P1 は主因ではない。

---

## P2 stale タイルの作り直しが、プレイヤーの目の前の道路まで巻き込むようになった

修正Aで `reviveStaleTiles` は「位置ベース削除」から「**wid ベース削除**」に変わった。
これは正しい変更だが、副作用として **距離の保証が壊れている**。

- `markTileStale` は「タイル中心が `STALE_REVIVE_DIST` の外」を保証する
  (2026-08-01 の CODE_REVIEW で入れたガード)。
- しかし wid ベース削除は、**そのタイルを通る way の全セグメントを位置を問わず消す**。
  遠いタイルに掛かる幹線道路・線路は、当然プレイヤーの足元まで伸びている。
- → 遠方タイル1枚の作り直しのたびに、**近くの幹線・線路が一度丸ごと消えて再取得・再メッシュ**される。
- `pendingRoadMeshes` にどっと積まれ、道路メッシュ生成のフレーム予算を食う。
  密集地では `[staleTile]` が定期的に出るので、これが繰り返し起きる。

**「道路の生成が遅い・いつまでも安定しない」という体感はこれで説明できる。**
2026-08-01 に潰した「捨てる境界 < 作り直す境界」の反転と、構造的に同じ罠を
way 単位化によって別の形で復活させてしまっている。

### 修正P2: 近傍に生存セグメントを持つ way は、その回は作り直さない

`evictFarRoads` が既に `_survivingWids` を作っているのと同じ発想を `reviveStaleTiles` にも入れる。

```js
// widSet を作った直後、削除の前に
const nearLim2 = ROAD_UNLOAD_DIST * ROAD_UNLOAD_DIST;
const nearWids = new Set();
for (const r of roadRecords) {
  if (r.wid == null || !widSet.has(r.wid)) continue;
  const mx = (r.x1 + r.x2) / 2 - px, mz = (r.z1 + r.z2) / 2 - pz;
  if (mx * mx + mz * mz <= nearLim2) nearWids.add(r.wid);
}
for (const id of nearWids) widSet.delete(id);   // 目の前で描画中のwayは触らない
// 除外した way は un-see もしない(protectedWids として dropTileRemnants へ渡す)
for (const tk of targets) dropTileRemnants(tk, nearWids);
```

- 対象タイルの区間は、そのwayがプレイヤーから離れた時に改めて作り直される。
- **「まだ描画されている道路は絶対に消さない」という元々の設計方針に戻る。**
- 現在 `reviveStaleTiles` は `dropTileRemnants(tk)` を **protectedWids 無し**で呼んでいる
  (`evictFarRoads` 側だけ渡している)。ここを揃えるだけの変更でもある。

---

## P3 修正B暫定の「20回待ったら諦めて撒く」が、大きいポリゴンでは常に発動する

`_areaTreesReady` は **ポリゴンbboxが掛かる全タイル**の road/building ready を要求する。
数百m〜数kmの森ポリゴンは複数タイルに掛かるので、条件成立はまれ。
結果、**30秒待ってから結局ゲート無しで撒く**動作になり、修正Bの効果が薄い
(ただし速度低下の原因ではない。%90スキャンなので負荷は軽い)。

### 修正P3: ゲートを「ポリゴン単位」から「木1本単位」へ下ろす

`scatterTreesIn` の中、既存の `isOnRoad` / `isNearWater` チェックの隣に1行足すだけ。

```js
if (!roadReadyTiles.has(osmTileKeyOfXZ(x, z))) continue; // その木の足元のタイルが未確定なら撒かない
```

- ポリゴン全体を待たせる必要が消えるので、タイムアウト諦め弁も不要になる。
- 揃っている場所から自然に埋まり、揃っていない場所は空くだけ(=忠実性優先の正しい挙動)。
- 撒き漏れた分は、後で `pendingAreaTrees` の再スキャンで拾う(既存の仕組みのまま使える)。

**併せて**: `pendingAreaTrees` は原点付け替え(近距離ジャンプ)・`dropAreaRecordsInTile` で
クリアされない。古い座標のポリゴンが残ると別の場所に木が湧くので、両方でパージすること。

---

## 作業順

| # | 内容 | 効く症状 | 規模 |
|---|---|---|---|
| P1 | way帰属を bbox 早期脱出に | **生成が遅い(主因)** | 小 |
| 計測 | processTileData の所要msログ | P1の確定 | 極小 |
| P2 | 近傍生存wayを作り直し対象から除外 | 道路が繰り返し消えて再生成される | 小 |
| P3 | 木のゲートを1本単位に + キューのパージ | 修正Bの実効性 | 小 |

いずれも小さい。**P1と計測を先に1回で出し、`[tileData]` のmsが密集地でどう変わるかを見る。**
体感が戻れば P1 で確定。戻らなければログの数字を持って再度切り分ける。
