# 実装指示: 橋が川に埋もれる不具合の真因

作成: 2026-08-03 / 対象: `js/legacy/part1.js`(`processRoadMeshQueue`)、`js/legacy/part4.js`
(`buildAreaPoly` / `rebuildAreaPolyMesh` / `_computeWaterProfile`)、`js/legacy/part3.js`(`bridgeSegmentY`)

---

## 0. 結論

**疑い1〜4のどれも主因ではない。** 真因は2つあり、どちらも
「修正3が発火していない」ではなく **「発火しているのに握りつぶされている」** という形をしている。

- **M1: 橋の再構築要求が、距離チェックで捨てられるうえに `_dirty=false` に書き換えられる**(決定打)
- **M2: 水面プロファイルが生成時の1回きりで凍結され、NEAR地形が届いても更新されない**(相乗)

修正3(`_commitWaterPoly` → `rebuildRoadsInBounds`)は設計としては正しい。
その要求が届く前に消されているだけ。

---

## 1. M1【決定打】`_dirty` が距離チェックで false に書き換えられる

`part1.js:1112-1116` `processRoadMeshQueue`:

```js
const _rlim2 = r.type === 'motorway' ? MOTORWAY_UNLOAD_DIST**2
  : isMinorRoadType(r.type) ? MINOR_ROAD_MESH_DIST**2 : lim2;
if (mx * mx + mz * mz > _rlim2) { r._dirty = false; continue; }   // ★ ここ
if (r.mesh && !r._dirty) continue;                                 // ★ そしてここ
rebuildRoadMesh(r);
```

### 何が起きるか

1. 相模川の水面relationは**先読み(5×5タイル=±3200m)で、プレイヤーが遠い間に届く**。
2. `_commitWaterPoly` が `rebuildRoadsInBounds(bbox±60)` で橋を `_dirty=true` にして再キューする。
3. しかしその橋は `MINOR_ROAD_MESH_DIST` / `ROAD_UNLOAD_DIST` の**外**にある。
   → 上の距離チェックに掛かる。
4. ここで `continue` するだけなら害は無い。だが **`r._dirty = false` を書いている。**
   「今は作らない」という判断を、**「もう作り直す必要はない」に書き換えてしまっている。**
5. プレイヤーが近づく。`r.mesh` は既に存在する(水面がまだ無かった時代に作られた、沈んだ橋)。
   `_dirty` は false。→ **`if (r.mesh && !r._dirty) continue;` で永久にスキップされる。**

**橋は二度と作り直されない。** 修正3は毎回きちんと発火していて、毎回ここで消えている。

### 「頻発するが全部ではない」の説明もつく

救済してくれる経路は2つだけで、どちらも条件付き:

- `loadNearTerrain` 成功時の `rebuildRoadsInBounds`(`part6.js:309`)
  → NEARは窓の40%を移動しないと再取得されない。既にNEARが橋を覆っていれば発火しない。
- `generateChunk` 末尾の `rebuildRoadsNearChunk`
  → チャンクは1回しか生成されない。既に生成済みなら発火しない。

**どちらが偶然刺さるかで「直る橋」と「沈んだままの橋」に分かれる。**
これが「橋によって埋もれる/埋もれない」というムラの正体。

---

## 2. M2【相乗】水面の高さが「生成時の地形」で凍結される

`part4.js buildAreaPoly`:

```js
entry.waterProfile = _computeWaterProfile(entry);   // ← ここ1回きり
if (!_instantiateAreaPolyMesh(entry)) { ... }
```

`rebuildAreaPolyMesh`(NEAR地形更新時)は `_waterYAt` を呼ぶだけで、**プロファイルを再計算しない。**

- 水面ポリゴンが届くのは、プレイヤーがまだ**3km近く離れている**先読みの段階。
- その時点で NEAR(540m格子)はその範囲を覆っていないので、`farNodeY` は **WIDE(約1km格子)**を返す。
- **1km格子は川の谷を完全に潰す。** 拾えるのは両岸の丘の高さで、
  `_computeWaterProfile` はそこから**最大値**を取る。
  → **水位が実際よりかなり高い値で凍結される。**
- プレイヤーが近づき NEAR が届くと地形は正しく下がるが、**水面だけ高いところに取り残される。**

M1で橋の再構築が封じられているので、**「水位は高いまま凍結」+「橋は低いまま固定」**が同時に成立する。
これが「頻発」の実体。

> 皮肉なことに、これは 2026-08-03 に学んだはずの教訓の再演である。
> 「`_instantiateAreaPolyMesh` と `rebuildAreaPolyMesh` の両方が `_waterYAt` を通ること」で
> 二重実装は防いだが、**「プロファイル自体を更新する経路が存在しない」という第三の穴**を
> 開けてしまった。同期させる対象を1段間違えている。

---

## 3. 疑い1〜4の評価

| | 評価 |
|---|---|
| **疑い1(way分割で継ぎ目が沈む)** | **本物。ただし主因ではない。** M1/M2を直した後に必ず残るので直すこと。修正は簡単(4-3) |
| **疑い2(motorway未対応)** | **事実だが「頻発」の説明にはならない。** 相模川を渡る自動車専用道路は限られる。構造的な穴なので最後に塞ぐ |
| **疑い3(直線補間サンプリング)** | **本物。軽い。** カーブした橋で `waterSurfaceYAt` が null を返す区間が出る。修正は小さい(4-4) |
| **疑い4(予算切れ)** | **今回の症状とは別。** 予算切れなら水面自体が見えない。「水面は見えていて橋が沈んでいる」という報告と矛盾する |

---

## 4. 修正指示

### 4-1【最優先】`_dirty` を距離チェックで消さない + 接近時に再キューする

```js
// part1.js processRoadMeshQueue
if (mx * mx + mz * mz > _rlim2) { continue; }   // ★ r._dirty は絶対に落とさない
```

これだけだとキューから外れた後に誰も拾わないので、**接近時に拾い直す経路**を必ずセットで入れる。
既存の道路の距離スキャン(`unloadFarRoads` の周期パス)の中に1行:

```js
// 範囲内に戻ってきた & まだ作り直しが必要 → キューへ戻す
if (!r._q && (r._dirty || !r.mesh) && d2 <= _rlim2) queueRoadMesh(r);
```

**この「保留を保留のまま残す」規律は道路以外にも横展開すること。**
`_dirty=false` のように「後でやる」を「やらなくてよい」に変換している箇所が他にもないか、
`= false` を検索して一通り確認してほしい。

### 4-2【最優先】水面プロファイルを NEAR 地形更新時に再計算する

```js
// part4.js rebuildAreaPolyMesh の冒頭(kind==='flat' のときだけ)
if (entry.kind === 'flat') {
  const before = entry.waterProfile;
  entry.waterProfile = _computeWaterProfile(entry);
  // 水位が実質的に変わったら、その範囲の道路(=橋)も作り直させる
  if (_waterProfileChanged(before, entry.waterProfile, 0.2)) {
    rebuildRoadsInBounds(entry.minX - 60, entry.maxX + 60, entry.minZ - 60, entry.maxZ + 60);
  }
}
```

**性能上の注意(必ず対応すること)**: `_computeWaterProfile` はノードごとに
`pointInPolygon`(相模川は輪郭点が数百)を呼ぶ。毎回のNEAR更新でこれをやると重い。
**ポリゴン内外の判定結果は地形が変わっても変わらない**ので、初回に
「採用したノードのリスト `[{i, j, bin}]`」を `entry.waterNodes` にキャッシュし、
再計算時は `farNodeY(i, j)` を読み直すだけにする。これで再計算はほぼ無料になる。

### 4-3 way分割対策: 「端 = 地面」という仮定をやめる

グルーピングは不要。**端点が水の上かどうかを直接聞けばよい。**

```js
// part3.js bridgeSegmentY
const aOnWater = waterSurfaceYAt(bridgeInfo.ax, bridgeInfo.az) != null;
const bOnWater = waterSurfaceYAt(bridgeInfo.bx, bridgeInfo.bz) != null;
// ...heightAt(f) の中で
let edgeT;
if (aOnWater && bOnWater)      edgeT = 1;                      // 両端とも川の上 = 中間断片。満額
else if (aOnWater)             edgeT = (1 - f) / BRIDGE_RAMP_FRAC; // A側は継ぎ目、B側だけ地面
else if (bOnWater)             edgeT = f / BRIDGE_RAMP_FRAC;
else                           edgeT = Math.min(f, 1 - f) / BRIDGE_RAMP_FRAC; // 従来
```

**「地面道路との接続点」の定義を、位置(f=0/1)ではなく実データ(そこに水があるか)に置き換える。**
これで way が何本に分割されていても、川の上の継ぎ目が沈むことはなくなる。

### 4-4 サンプリングを実ジオメトリに乗せる

`heightAt(f)` の位置推定 `ax + (bx-ax)*f` をやめる。
`addRoad` の呼び出し元(`part8.js`)はそのセグメントの実座標 `a`/`b` を持っているので、
`bridgeY` に `sx,sz,ex,ez`(このセグメントの実端点)を足し、`bridgeSegmentY` は
`fracA` → `(sx,sz)`、`fracB` → `(ex,ez)` で問い合わせる。
直線推定が消え、カーブした橋でも水面を外さない。

### 4-5 motorway(最後でよい)

`addMotorway` / `rebuildMotorwayMesh` にも `waterSurfaceYAt` を通し、
`getGroundY + MWY_H` を `Math.max(getGroundY + MWY_H, wy + clearance)` にする。

**見た目の一貫性への注意**: 高架は「常時空中に浮く」設計なので、
水面上だけ急に持ち上がると桁が折れて見える。`bridgeSegmentY` と同じく
**両側に助走区間(smoothstep)を設ける**か、そのway全体で一律に
`max` を取る(高架は元々水平に近いので後者でも不自然になりにくい)。

---

## 5. 診断(実機なしで主因を確定させる)

**計器を先に入れること。** これが無いと4回目も勘で直すことになる。

```js
// part1.js processRoadMeshQueue の距離チェック
if (mx * mx + mz * mz > _rlim2) {
  if (r._dirty) _dirtyDropped++;      // ★ 捨てた「作り直し要求」の数
  continue;
}
```

`_commitWaterPoly` の直後に `_dirtyDropped` が跳ね上がれば **M1確定**。

```js
// part3.js bridgeSegmentY の中
if (wy == null && f > 0.3 && f < 0.7) _bridgeMidNoWater++;  // 中央なのに水が無い = 疑い3 or 4
```

```js
// part4.js buildAreaPoly
console.log('[water] profile bins=' + n + ' min=' + min.toFixed(1) + ' max=' + max.toFixed(1) +
            ' near=' + (nearElev ? 'yes' : 'NO'));   // ★ near=NO なら M2確定
```

**OSM上で橋が何本のwayに分割されているかの確認**(Macは不要、ブラウザだけで可能):
[overpass-turbo.eu](https://overpass-turbo.eu/) で以下を実行し、相模川の橋を目視する。

```
[out:json][timeout:25];
way["bridge"]["highway"](35.36,139.30,35.45,139.38);
out tags geom;
```

返ってきた way の件数と、同じ道路名(`name`)が複数の way に分かれていないかを見れば、
疑い1が実在するかがその場で分かる。`highway=motorway` が含まれていれば疑い2も該当。

---

## 6. 作業順

| # | 内容 | 効く症状 | 規模 |
|---|---|---|---|
| 0 | 上の3つの計器を入れる | 主因の確定 | 極小 |
| 1 | `_dirty` を距離で消さない + 接近時の再キュー | **橋が永久に沈んだままになるのが止まる** | 小 |
| 2 | 水面プロファイルの再計算 + ノードリストのキャッシュ | 水位が実地形に追従する | 中 |
| 3 | 端点の「水上か」判定でランプを制御 | way分割された橋の継ぎ目 | 小 |
| 4 | 実セグメント座標でのサンプリング | カーブした橋 | 小 |
| 5 | motorway 対応 | 高速道路の橋 | 中 |

**1と2は必ずセットで出すこと。** 片方だけだと
「橋は作り直されるが水位が嘘のまま」または「水位は正しいが橋が作り直されない」になり、
どちらも症状が残るため「また直っていない」になる。

---

## 7. 大原則への追記

13. **「今はやらない」を「やらなくてよい」に変換しない。**
    距離・予算・優先度で処理を見送るとき、**保留フラグを消してはいけない。**
    見送りは必ず「後で必ず拾い直す経路」とセットで実装する。
    (今回の `r._dirty = false`、過去の gaveUp による readiness 汚染、
    `_vegCleanupQueue` の滞留は、すべてこの同じ誤りの別の姿である)
14. **キャッシュした派生値には、必ず「無効化のトリガー」を対で設計する。**
    `entry.waterProfile` は入力(地形)が変わるのに再計算経路が無かった。
    キャッシュを足すときは「何が変わったらこれは古くなるか」をコメントに書き、
    その変化点から無効化を呼ぶ。
15. **「端」「境界」の判定は、位置ではなく実データで行う。**
    `f=0/1 なら地面` はOSMの way 分割という現実の前に成立しない。
    「そこに水があるか」を直接問えるなら、常にそちらを使う。
