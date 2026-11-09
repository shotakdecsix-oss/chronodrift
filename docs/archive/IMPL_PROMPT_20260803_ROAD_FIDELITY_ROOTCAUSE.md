# 実装指示: 手続き生成が道路・線路を侵食し続ける問題の真因と修正

作成: 2026-08-03 / 分析: 設計レビュー(実機デバッグ不可のためコードベース)
対象: `js/legacy/part8.js`(タイル取得・チャンク生成)、`js/legacy/part1.js`(事後清掃)

---

## 0. 結論(先に読むこと)

**対策2・3(事後清掃 `removeBuildingsOverlappingRoad` / `queueVegetationCleanup`)は、
設計として正しいが、発動する前提が壊れているためほぼ一度も発火していない。**

事後清掃は「gaveUpタイルの実データが、背景リトライで**後から届く**」ことを前提にしている。
しかし現在のコードでは **road ジョブを諦めたタイルは、二度とキューに積まれない**。
つまり本物の道路・線路データは永久に届かず、`addRoadRecord` が呼ばれないので清掃も走らない。

だからマージン(`PROC_CLEANUP_EXTRA_MARGIN`)をいくら調整しても症状は変わらない。
数値の問題ではなく、**リトライ経路が閉じている**ことが真因。

---

## 1. 真因P0-1: giveUp したタイルの road ジョブが再投入されない

### 経路(コードで追える事実)

1. `fetchOSMTileBatch` の catch 節、`part8.js:1487-1494`

```js
if (h >= 4) {
  gaveUpTiles.add(sk);
  unlockTileReadiness(k, batchKind);   // ← ここ
}
```

2. `unlockTileReadiness`(`part8.js:1243-1257`)

```js
} else if (kind === 'road') {
  roadReadyTiles.add(posKey);          // ← 道路readyを立てる
  ... building ジョブだけ積む
} else { // combined(kind未指定)
  roadReadyTiles.add(posKey);
  buildingReadyTiles.add(posKey);      // ← 両方立ててしまう
}
```

3. 次の `checkOSMTiles` → `queueTile`(`part8.js:1621-1627`)

```js
if (roadReadyTiles.has(key)) {
  queuedTiles.add(key);
  if (!buildingReadyTiles.has(key) && !buildingQueuedTiles.has(key)) { ...building だけ積む... }
  return;                              // ★ road ジョブはここで永久に打ち切られる
}
```

road ジョブを push する箇所は `part8.js:1638`(near split)と `:1643`(複合)の2つだけで、
**どちらも上の early return より下にある**。よって `roadReadyTiles` に入った瞬間、
そのタイルの道路・線路は二度と取得されない。

### さらに悪いこと

- 現在 `SPLIT_NEAR_QUERIES` の既定は **false**(2026-07-27変更)なので、近傍タイルも複合クエリ。
  複合ジョブが giveUp すると `roadReadyTiles` と `buildingReadyTiles` の**両方**が立ち、
  road も building も永久に取得されない完全な凍結状態になる。
  → タイルは「緑(=生成可)」に見えるのに実データはゼロ。チャンクゲートは通る。
  → 手続き生成の家・木だけがそこを埋める。**報告されている症状そのもの。**

- `checkCurrentTileRush`(`part8.js:1552-1562`)は「プレイヤーが足を踏み入れたら白紙に戻す」
  意図で `gaveUpTiles` / 各失敗カウンタを消しているが、コメント通り
  `roadReadyTiles` からは外していない。上の early return は `roadReadyTiles` だけを見るので、
  **この救済処置は何の効果も持っていない**(意図と実装が食い違っている)。

- 復旧経路として残っているのは `reviveStaleTiles`→`resetTileForRefetch` だけだが、
  これは「遠方でdormant破棄が起きたタイル」が対象で、しかも `STALE_REVIVE_DIST` の
  外側でしか stale にならない。目の前の gaveUp タイルは救われない。

---

## 2. 真因P0-2(設計): readiness が2つの意味を兼務している

`roadReadyTiles` は現在、次の2つを同時に表している。

| 意味 | 使う側 |
|---|---|
| A. 「このレイヤーはもう待っても増えない」(=描画ゲート解除) | `osmTilesReadyAround` → `generateChunk` |
| B. 「このタイルはもう取得しなくてよい」(=再取得抑止) | `queueTile` |

giveUp は本来 **Aだけ**を立てたい(フリーズ回避)。しかしBまで立ってしまうので取得が止まる。
これがP0-1の構造的な原因であり、今後も同じ穴を生む。**この2つは必ず別の集合に分ける。**

---

## 3. 真因P1: チャンクゲートが gaveUp を区別しない

`osmTilesReadyAround`(`part8.js:2240-2256`)は `roadReadyTiles`/`buildingReadyTiles` の
有無しか見ず、「本物のデータで揃った」のか「諦めて揃ったことにした」のかを区別しない。
仮にP0-1を直してリトライが復活しても、**最初の1回の誤生成は依然として起きる**
(そこは事後清掃が拾うが、清掃は個別オブジェクト単位の対症療法なので取りこぼしが残る)。

---

## 4. 真因P2: 「チャンク再生成が無い」は正確ではない — 半分実装済みで、植生だけ非対称

相談文では「一発生成・再生成の仕組みが無い」としているが、実際には
`updateChunks`(`part8.js:2206-2224`)が距離アンロード時に

```js
chunkMeshes.delete(key);
loadedChunks.delete(key); // allow re-generation if player returns
```

とやっており、**再訪時にはチャンクは作り直されている**。破棄と再生成の機構は既に存在する。

ただし致命的な非対称がある:

- 建物は `rec.ck === key` でタグ付けされ、アンロード時に `removeBuildingsByIds` で消える。
- **木・下草(`addTree`/`plantScrub`/道路小物)は InstancedMesh プールへの追記のみで、
  チャンクタグを持たない。** `chunkMeshes` は `scene.children.slice(beforeCount)` の差分なので、
  プールのメッシュ(最初に1回だけ scene に入る)は入らない。

結果:
1. チャンクを再訪するたびに、そのチャンクの木が**二重・三重に増え続ける**(既存の別バグ)。
2. 「gaveUp起因のチャンクだけ作り直す」対策を入れても、**木は消えないので線路の上に残り続ける**。

→ **チャンク再生成を武器にするなら、先に植生のチャンク帰属を実装しなければ意味がない。**

---

## 5. 真因P3: 事後清掃のトリガ漏れ・判定の非対称(残りの取りこぼし)

- **配置ガードと清掃で数値が二重管理されている。** 建物側は 2026-08-02 に揃えたが、植生は未対応:
  - 配置: `scatterTreesIn` は `isOnRoad(x,z,2.5,2.5)` → 実効しきい値 `rw/2 + 2.77`
  - 清掃: `queueVegetationCleanup` は `rhw = rw/2 + 2`
  → 差 0.77m の帯に植えた木は清掃をすり抜ける(建物で起きたのと同じ構図)。
- **水面・landuseポリゴンの後着に対する清掃が存在しない。** `addRoadRecord` は
  `type === 'water'` を明示的に除外し、面ポリゴン(公園・森・水面)到着時のフックも無い。
  過去に繰り返し報告されている「水上の木」はこの系統。
- `_vegCleanupQueue` は原点付け替え(近距離ジャンプ)時にクリアされない。
  積み残しがあると、付け替え後の座標系で**無関係な木を消す**事故になりうる。

---

## 6. 実装指示(この順で。1つずつデプロイして実機確認すること)

### 修正1【最優先・最小・これだけで大半が直るはず】readiness と fetched を分離する

`part8.js` に「取得を諦めた=再取得対象」であることを表す集合を明示的に持たせ、
`queueTile` の early return をそれで無効化する。

```js
// part8.js queueTile 内、既存の early return を差し替え
// gaveUp で readiness だけ立てたタイルは「取得済み」ではないので、再投入対象に戻す。
const roadDegraded = gaveUpTiles.has(key) || gaveUpTiles.has(key + '|road');
if (roadReadyTiles.has(key) && !roadDegraded) {
  ...(既存の building 追いかけ処理そのまま)...
  return;
}
// roadDegraded の場合は下へ落ちて road ジョブ(または複合ジョブ)を積み直す
```

併せて:

- `queuedTiles` / `buildingQueuedTiles` に残っていると下の `if (!queuedTiles.has(key))` で
  弾かれるため、**giveUp した時点で `queuedTiles.delete(key)` を必ず行う**
  (catch 節では消しているが、`unlockTileReadiness` が別経路で `queueTile` から
  `queuedTiles.add(key)` し直している点に注意。上の分岐を通るときは add しないこと)。
- **無限リトライだが低頻度に**する。gaveUp タイル専用のバックオフを持たせる:
  `osmTileNextRetryAt.set(sk, Date.now() + Math.min(600000, 60000 * 2**(h-4)))`
  (60秒→最大10分)。Overpass への負荷は増やさない。
- `checkCurrentTileRush` の「足を踏み入れたら白紙」処理を実効化する。
  `gaveUpTiles.delete` だけでなく、**足元タイルに限り `roadReadyTiles.delete(key)` /
  `buildingReadyTiles.delete(key)` はせず**(建物ゲートを巻き戻さないという既存判断は正しい)、
  代わりに road ジョブを直接 `osmTileQueue.push({tx,tz,kind:'road'})` で即時投入する。
  上の修正1と重複投入しないよう `queuedTiles` で排他する。

**期待される効果**: 諦めタイルの道路・線路が遅れて届くようになり、既に実装済みの
`removeBuildingsOverlappingRoad` / `queueVegetationCleanup` が**初めて実際に発火する**。

### 修正2【発生源を断つ】degraded タイルの上に手続き生成物を置かない

`osmTilesReadyAround` は触らない(地形・実データの描画は進めたい)。代わりに
`generateChunk` の**手続き生成パートだけ**を抑止する。

```js
// part8.js
function tileDegradedAt(x, z) {
  const k = osmTileKeyOfXZ(x, z);
  return gaveUpTiles.has(k) || gaveUpTiles.has(k + '|road') || gaveUpTiles.has(k + '|building');
}
```

- `generateChunk` 冒頭でチャンクが跨ぐ全タイルを調べ、1枚でも degraded なら
  **手続き生成の建物・木・下草をスキップ**する(地形・実データ由来の描画はそのまま実行)。
  「嘘の街並みを描くより、空き地のほうがマシ」——これが大原則の具体化。
- そのチャンクキーを `degradedChunks` に記録する。
- タイルの degraded が解除された(実データが届いた)時点で、対応する
  `degradedChunks` のエントリを `loadedChunks` から外して再キューする。
  → **修正3が完了するまでは、この再キューは有効にしないこと**(木が二重化するため)。
  修正2の第一段階は「置かない」だけでよい。

### 修正3【再生成を安全にする前提】植生インスタンスにチャンク帰属を持たせる

`pool.resnap` 並行配列(2026-08-02実装)と同じ手法で `pool.ck`(チャンクキー)を持たせる。

- `poolAdd` 時に `pool.ck[idx] = currentChunkKey`(`part1.js:671`。generateChunk 実行中のみ非null)。
- `compactPool` / `_removePoolInstancesNearSeg` のスワップ詰めで `pool.resnap` と**同時に**
  `pool.ck` も移動させる(片方だけ忘れると別インスタンスを消す事故になる)。
- `removePoolInstancesByChunk(pool, key)` を追加し、チャンクアンロード時に呼ぶ。
  → これで「再訪のたびに木が増える」既存バグも同時に解消される。
- 実装後、修正2の再キューを有効化する。

**再生成で他に注意すべき落とし穴(質問2への回答):**

| 落とし穴 | 対処 |
|---|---|
| プレイヤーが立っているチャンクの破棄 | 足元チャンクは再生成の対象外にし、離れた時に処理する(または当該チャンクのみ「追加のみ」で妥協) |
| 実建物(`ck === null`)の巻き添え | `removeBuildingsByIds` は ck 一致のみ対象。実建物は触らないことをテストで担保 |
| 二重生成 | `loadedChunks` から外すのと `chunkMeshes.delete` を**必ず原子的に**行う(`resetTileForRefetch` と同じ規律) |
| 当たり判定の残留 | `collisionBoxes`/`collGrid`、`minimapBuildings` も同じ ck で消す(既存の6点セットに合わせる) |
| `bid` の再利用 | 再生成で新しい bid を発番する。古い bid を参照するキュー(`pendingBuildings` 等)に残っていないか確認 |
| 道路小物(信号機・街灯) | 木と同じプール管理。修正3の `pool.ck` に必ず含める |

### 修正4【SSOT化】配置ガードと事後清掃で同じ述語を共有する

数値を2箇所に書くのをやめる。

```js
// part1.js — 唯一の真実
const PROC_CLEARANCE = 4;   // 手続き生成物が道路・線路から確保すべき余裕(m)
function procBlockedByRoad(x, z, w, d) { return isOnRoad(x, z, w + PROC_CLEARANCE*2, d + PROC_CLEARANCE*2); }
function procCleanupHalfWidth(r) { return (r.rw || 5) / 2 + PROC_CLEARANCE; }
```

- `generateChunk` の全配置ガード、`scatterTreesIn`、`plantScrub`、`rebuildForest` の `roadNear`、
  `removeBuildingsOverlappingRoad`、`queueVegetationCleanup` を**すべてこの2関数経由に置き換える**。
- 以後「配置は避けたのに清掃が拾わない」という今回の類型は構造的に発生しなくなる。

### 修正5【トリガ漏れ】清掃フックの拡張

- 水面ポリゴン・landuse ポリゴン到着時にも植生清掃を呼ぶ(`isNearWater` 相当の判定で)。
  「水上の木」の恒久対策。
- 近距離ジャンプ・原点付け替え時に `_vegCleanupQueue.length = 0` を実行する。

---

## 7. 検証手順(実機・Macなしで可能)

1. `🩺 タイル状況` オーバーレイを開く。**紫(gaveUp)のタイルを探す。**
2. 修正1の前: 紫タイルは何分待っても紫のまま(=road が再投入されていない証拠)。
3. 修正1の後: 紫 → 赤(取得中) → 緑 に遷移すること。これが直接の合格判定。
4. 紫だった区画へ行き、線路・道路が遅れて敷かれ、その上の家・木が消えることを目視。
5. 同じチャンクを一度離れて戻り、**木の本数が増えていない**こと(修正3の合格判定)。

計器を1つ足すと切り分けが速い: HUD に
`gaveUp件数 / gaveUp解除件数(累計) / 清掃で消した建物・木の累計` を出す。
**清掃カウンタが 0 のままなら、清掃は今も発火していない**ということが一目で分かる。

---

## 8. 大原則の実装レベルへの落とし込み(質問4への回答)

1. **「未知」と「無し」を絶対に混同しない。** 取得失敗は「そこに何も無い」ではなく
   「まだ分からない」。未知の区画には手続き生成物を置かない。空白のほうが嘘より忠実。
2. **状態は2値ではなく3値で持つ。** `unknown / degraded(諦めたが未確定) / known(実データで確定)`。
   ゲート解除は degraded で許してよいが、**手続き生成の許可は known でのみ**。
3. **諦めるのは「表示」だけ。「取得」は決して諦めない。** giveUp はフリーズ回避のための
   描画側の妥協であって、ネットワーク側の終了条件にしてはならない。
4. **配置ガードと事後清掃は同じ述語を共有する(SSOT)。** 同じ幾何学的条件を2箇所に
   別の数値で書いた時点でバグは時間の問題。今回の PROC_CLEANUP_EXTRA_MARGIN が実例。
5. **パフォーマンス上の妥協は「遅延」で行い、「省略」では行わない。**
   フレーム予算キュー(`VEG_CLEANUP_BUDGET_MS`)は正しい形(遅れて必ず実行される)。
   一方 giveUp は省略なので誤り。この区別を今後の判断基準にする。
6. **オブジェクトのライフサイクルは所有者を1つに決める。** 建物は `ck` を持つのに植生は
   持たない、という非対称が今回の再生成案を封じている。プールに入れるものにも
   必ず帰属タグを持たせる(`OBJECT_LIFECYCLE.md` に追記すること)。

---

## 9. 作業分割の推奨

| # | 内容 | 規模 | 単独デプロイ可 |
|---|---|---|---|
| 修正1 | queueTile の early return を degraded 対応に | 小(20行程度) | ○ **まずこれだけ出す** |
| 修正2前半 | degraded チャンクで手続き生成をスキップ | 小 | ○ |
| 修正3 | `pool.ck` とチャンク単位の植生削除 | 中 | ○ |
| 修正2後半 | degraded 解除時のチャンク再生成 | 中 | 修正3の後 |
| 修正4 | SSOT 化リファクタ | 中(機械的) | ○ |
| 修正5 | 水面・landuse フック、キュークリア | 小 | ○ |

修正1 を単独で出し、オーバーレイの紫が緑に変わるかを先に確認すること。
ここが変わらなければ以降の対策はすべて無意味であり、逆にここが直れば
既存の事後清掃が働き始めるので、体感症状はかなり改善するはず。
