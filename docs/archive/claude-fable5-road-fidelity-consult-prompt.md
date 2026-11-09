# 相談プロンプト: 手続き生成が道路・線路の位置を侵食し続ける問題

以下をそのままFable 5に貼ってください。

---

three.js製のブラウザゲーム「ChronoDrift」(実世界の地図データをOSM/Overpass APIから取得し、リアルタイムに街を生成して歩き回れるゲーム)で、「手続き生成の建物・木が、本来道路・線路があるべき位置を邪魔する」という不具合が、何度か対症療法を重ねても再発し続けています。私はこのゲームの大原則として「マップデータ(道路・線路・建物などの実データ)の忠実な表現を、手続き生成やパフォーマンスより常に最優先する」ことを掲げたいと考えており、この前提でもう一段深い根本原因・根本設計を検討してほしいです。

## アプリの構成

- `index.html` + `js/legacy/part1.js`〜`part10.js`(元は1つの巨大なインラインスクリプトを機械的に分割したもの。グローバルスコープを共有する昔ながらの`<script>`タグの並び読み込みで、ES Modulesではない)
- `js/lib/pure.js`: 純粋関数のみ(distSqPointToSeg等)
- サーバーは`server/server.js`(Node)、Renderにデプロイ(pushで自動デプロイ)
- OSM Overpass APIからタイル単位(`OSM_TILE_M`四方)で道路・線路・建物・landuse等を取得。取得はタイル単位のキュー(`processOSMTileQueue`)経由で、成功したタイルは`roadReadyTiles`/`buildingReadyTiles`に印が付く。
- ワールドは`CHUNK_SIZE`四方の「チャンク」単位で手続き生成(`generateChunk`、part8.js)。チャンクは**生成が一発きりで、再生成の仕組みが無い**(道路・建物のような個別の「後から届いたデータで補正する」再構築ロジックはあるが、チャンクという単位そのものをまるごと作り直すことはしない)。

## 症状

線路(場合によっては道路)があるべき位置に、手続き生成の家・木がそのまま残ってしまい、線路・道路が視覚的に途切れる。何度か修正を入れたが、ユーザー(実プレイヤー=私自身)が最新の修正後も「やっぱりまだ発生している」と報告している状態です。

## これまでの原因分析と対策(新しい→古い順)

### 対策3: 事後清掃の判定マージンを配置時のマージンに合わせる(2026-08-02、これでも直っていない)

`removeBuildingsOverlappingRoad`(建物の事後清掃)は「道路リボンとの厳密な重なり判定」で建物を撤去する設計でした。しかし手続き生成時の配置ガード(`generateChunk`内、part8.js)は`isOnRoad(qx, qz, bw + LOT_MARGIN*2, bd + LOT_MARGIN*2)`という**LOT_MARGIN分だけ余裕を持たせた緩い判定**で弾いています。つまり「配置時に避けた余白」より「事後清掃が刈り取る範囲」の方が狭く、線路のすぐ脇ギリギリ(重ならないが近すぎる)に建った手続き生成の家だけが清掃を素通りして残っていました。これを`PROC_CLEANUP_EXTRA_MARGIN = 8`として手続き生成物にだけ上乗せする形で揃えました(実建物は据え置き、`fitRealBuildingToRoads`が別途縮小するため広げると健全な実建物まで巻き込む懸念があるため)。

```js
// js/legacy/part1.js
const PROC_CLEANUP_EXTRA_MARGIN = 8;
function removeBuildingsOverlappingRoad(r) {
  if (r.type === 'water') return;
  if (buildingRecords.length === 0) return;
  const rhwReal = (r.rw || 5) / 2 + 0.5;
  const rhwProc = rhwReal + PROC_CLEANUP_EXTRA_MARGIN;
  const pad = 40 + PROC_CLEANUP_EXTRA_MARGIN;
  // ...(空間グリッドmeshedBuildingGridから近傍候補を集め、rec.realかどうかでrhwReal/rhwProcを
  //     使い分けて厳密な重なり判定。overlapすればsceneから除去しremoveBuildingsByIdsで記録も消す)
}
```

木・下草側にも同種の事後清掃(`queueVegetationCleanup`→フレーム予算付きキューで`_removePoolInstancesNearSeg`を実行)を新設しました。

```js
// js/legacy/part1.js
function _removePoolInstancesNearSeg(pool, x1, z1, x2, z2, rhw) {
  // InstancedMeshのinstanceMatrix.arrayを直接読み、rhw以内なら「詰めずに捨てる」
  // スワップ圧縮(compactPoolと同じ手法)
}
function queueVegetationCleanup(r) {
  if (r.type === 'water') return;
  const rhw = (r.rw || 5) / 2 + 2;
  _vegCleanupQueue.push({ x1: r.x1, z1: r.z1, x2: r.x2, z2: r.z2, rhw });
}
const VEG_CLEANUP_BUDGET_MS = 4; // フレーム予算(道路セグメント大量到着時のフリーズ回避のため)
function processVegCleanupQueue() { /* キューをVEG_CLEANUP_BUDGET_MSずつ間引いて処理 */ }
function addRoadRecord(r) {
  roadRecords.push(r); roadGridAdd(r);
  removeBuildingsOverlappingRoad(r);
  queueVegetationCleanup(r);
}
```

**この対策を入れた後もユーザーは「まだ線路・道路が手続き生成物に邪魔されている」と報告しています。** マージンの数値調整では埋まらない、もっと構造的な穴があるのではないかと疑っています。

### 対策2: 事後清掃自体の新設(それ以前は一切無かった)

根本原因は次の通りです。タイル取得は最大4回リトライし、それでも失敗すると「諦めて」そのタイルを`gaveUpTiles`に加え、道路・建物データが空のまま「揃った」ことにして先へ進めます(でないと恒久的にそのタイルが永遠に生成待ちのままになるため)。

```js
// js/legacy/part8.js (fetchタイルのcatchブロック内)
if (h >= 4) {
  gaveUpTiles.add(sk);
  // これ以上は該当レイヤーの生成をブロックしない(=成功時と同じ「既知にする」処理を流用)
  unlockTileReadiness(k, batchKind);
}
```

このため「本当は線路が通っているのに、諦めタイルのせいでその区画が空地だと誤認され、そこに手続き生成の家・木が建ってしまう」ケースが発生します。その後バックグラウンドの再試行が成功して本物の道路・線路データが遅れて届いても、**チャンク自体は一発生成・再生成なしの設計**なので、誰も「もう一度そのチャンクを正しく作り直す」ことをしません。そこで「新しい道路・線路レコードが登録される瞬間(`addRoadRecord`)に、その場所と重なる既存の建物・植生だけを事後的に撤去する」という対策2を導入しました(対策3はこのマージンの精度を上げただけ)。

### 対策1: チャンク生成自体のゲート強化(道路・建物の到達を待つ)

`osmTilesReadyAround(x, z, pad)`は、チャンク中心から`pad`(=`CHUNK_SIZE/2 + 64`)以内にかかる全OSMタイルについて、`roadReadyTiles`と`buildingReadyTiles`の両方が立つまで`generateChunk`を待たせるゲートです。

```js
// js/legacy/part8.js
function osmTilesReadyAround(x, z, pad) {
  const t0x = Math.floor((x - pad) / OSM_TILE_M), t1x = Math.floor((x + pad) / OSM_TILE_M);
  const t0z = Math.floor((z - pad) / OSM_TILE_M), t1z = Math.floor((z + pad) / OSM_TILE_M);
  for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
    const k = `${tx},${tz}`;
    if (!roadReadyTiles.has(k)) return false;
    if (!buildingReadyTiles.has(k)) return false; // 2026-07-26に追加(建物データの到達も必須化)
  }
  return true;
}
function chunkTilesReady(chunkX, chunkZ) {
  const cx = chunkX * CHUNK_SIZE + CHUNK_SIZE / 2, cz = chunkZ * CHUNK_SIZE + CHUNK_SIZE / 2;
  return osmTilesReadyAround(cx, cz, CHUNK_SIZE / 2 + 64);
}
```

ただしこのゲートは「`roadReadyTiles`/`buildingReadyTiles`にタイルキーが立っているか」だけを見ており、**そのタイルが本物のデータで揃ったのか、`gaveUpTiles`によって空データのまま強制的に「揃ったことにされた」のかを区別していません**。`unlockTileReadiness`は成功時とgiveUp時の両方で同じ`roadReadyTiles.add(k)`的な処理を共有しているためです(コード上、成功パスとgiveUpパスが「readiness済みにする」という同一の関数を呼ぶ設計になっている)。

## 現在のアーキテクチャ上の疑問点(相談したい核心)

1. **チャンク生成の一発性そのものが根本原因ではないか**: `generateChunk`は`gaveUpTiles`で強制的に「空地」と誤認したタイル上でもそのまま実行されてしまいます。事後清掃(対策2・3)は「個々のオブジェクト単位」で後から重なりを刈り取る対症療法であり、「そもそも不完全なデータでチャンクを生成してしまう」という発生源には手を付けていません。`gaveUpTiles`によって強制的にreadiness扱いされたタイルにかかるチャンクだけは、`generateChunk`の実行自体を完全に禁止し、本物のデータが届いた時点で(そのタイルが)後から`generateChunk`を初めて実行する、という設計に変えるべきでしょうか。それとも一発生成の制約(パフォーマンス・メモリ上の理由があったはず)を維持したまま、別の手段で防ぐべきでしょうか。

2. **「本物のチャンク再生成」は現実的か**: 現状「一度generateChunkされたチャンクは二度と手続き生成をやり直さない」という制約があります(コード内コメントにも「1チャンク1回きりで再生成の仕組みが無い」と明記されている)。この制約を破って、`gaveUpTiles`起因で不完全生成されたチャンクに限り、本物のデータ到着後に「そのチャンクの手続き生成物を全部消してもう一度generateChunkし直す」処理を実装するとした場合、見落としがちな落とし穴(二重生成、プレイヤーがそのチャンクに立っている最中の破棄、建物ID・InstancedMeshプールの整合性など)にはどんなものがあると思いますか。

3. **事後清掃(個別オブジェクト単位の重なり除去)を今後も併用するにしても、他に見落としている「実データ到着 vs 手続き生成」の競合パターンはないか**: 現状は「道路・線路レコードが追加された瞬間」だけをトリガーにしています(`addRoadRecord`)。他にトリガー漏れの可能性がある経路(例えば建物データが道路より後に届く、landuseポリゴンが後から届いて回避判定が変わる、等)はありそうですか。

4. **「マップデータ忠実性を最優先する」という大原則を実装レベルの指針に落とし込むなら、どんな設計原則を明文化すべきか**: 例えば「不完全なデータでの生成を一切許可しない(readiness判定はgiveUpを区別する)」「一発生成をやめて差分再生成を前提にする」「パフォーマンス上の妥協(フレーム予算・タイムアウト)は表現の正確さを犠牲にする形では絶対に行わない」といった方針が考えられますが、他に重要な観点があれば教えてください。

Macが無く実機のライブデバッグができないため(過去の別件の相談でも同様でした)、コードレビュー・設計レビューベースでの助言が中心になります。よろしくお願いします。
