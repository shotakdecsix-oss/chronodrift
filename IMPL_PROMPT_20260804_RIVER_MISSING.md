# 実装指示: 川が地面になって消える — 修正A-3が作った「保留のまま固定」状態

作成: 2026-08-04 / 実機ログで確定。`IMPL_PROMPT_20260803_BRIDGE_WATER_v2.md` の修正A-3の設計ミスが原因。

---

## 0. 結論

ログに `[water] profile UNAVAILABLE (全ビン欠測、地形データ待ち)` が大量に出ている。
これは修正A-3で新設した状態で、**そこから抜ける経路が実質的に存在しなかった。**

- 抜けられない間、水面は `getGroundY(x,z) + 0.15`(実測7.5cm上)で描かれる
- 地形メッシュは200m三角形、水面は100m三角形なので、**弦と面のズレだけで7.5cmは軽く超える**
- → **水面が地形に飲まれて見えなくなる**(スクリーンショットの緑一色の平面)

---

## 1. 事実関係

### 1-1. `near=yes` は嘘をついている

```js
function _isNearCoverage(x, z) {
  if (typeof nearCX === 'undefined' || typeof NEAR_W === 'undefined') return null;
  return Math.abs(x - nearCX) <= NEAR_W / 2 && Math.abs(z - nearCZ) <= NEAR_D / 2;
}
```

**`nearElev` が null かどうかを見ていない。** `nearCX`/`nearCZ` は初期値0で、
マップジャンプ直後はプレイヤーが原点付近にいるため、**地形が1バイトも届いていない状態でも
`near=yes` になる。**

→ ログの大量の `UNAVAILABLE … near=yes` は「NEARはあるのに欠測」ではなく、
**単に地形がまだ無い時刻に水面ポリゴンが作られた**という意味。
ジャンプ直後のタイル一斉到着で、その地点の主要な水域(ハドソン川・ニューヨーク湾)が
まとめてこの状態で生成されている。

### 1-2. profile が null のときの表示が地形に張り付く

```js
// part4.js _waterYAt
if (!p) return getGroundY(x, z) + entry.yOff;   // yOff = 0.15 ゲーム単位 = 実測7.5cm
```

地形(200m格子の区分線形)と水面(100m細分の三角形)は同じ関数から高さを取っても
**辺の位置がズレる**ため、7.5cmのマージンでは足りない。水面が地形に埋もれる。

### 1-3. null から抜ける経路が塞がっている

```js
function rebuildAreaPolyMesh(entry) {
  if (!entry.mesh) return;   // ★ 遠方でGPU解放中はここで抜ける = プロファイル再計算もされない
  ...
  if (entry.waterNodeInfo) { entry.waterProfile = _computeWaterProfileFromNodes(...); }
```

- 遠方で `unloadFarAreaPolys` がメッシュを解放している間にNEAR地形が届くと、
  **再計算ごと素通りする。**
- 再接近時の `_instantiateAreaPolyMesh` はプロファイルを計算し直さない
  (`_waterYAt` を呼ぶだけ)。
- → **`waterProfile === null` のまま恒久固定される。**

v2の文書で「地形到着後に `rebuildAreaPolyMesh` が再計算する」と書いたのは誤り。
メッシュが生きている場合しか再計算されない。

---

## 2. 確認(先にこれだけ実行すること)

```js
areaPolyMeshes.filter(e => e.kind === 'flat' && !e.waterProfile).length
```

**2桁以上なら確定。0なら以下の修正は的外れなので着手しないこと。**

併せて、`_isNearCoverage` に `nearElev` 判定を足してログの嘘を止める:

```js
function _isNearCoverage(x, z) {
  if (!nearElev) return false;   // ★ データが無ければ「覆っていない」
  ...
}
```

---

## 3. 修正

### 修正A【本体】地形が無い間は水面ポリゴンを「作らない」。ただし必ず後で拾う

不完全なデータで作って後から直す、をやめる。**既存の `pendingAreaWaterPolys`
(予算切れ再試行キュー)と同じ仕組みに相乗りする。**

```js
// _commitWaterPoly / buildAreaPoly 呼び出しの手前で
if (!_terrainCoversPoly(entry)) {      // NEAR/WIDEどちらかが実データを返せるか
  queueWaterPolyRetry(pts, holes, minX, maxX, minZ, maxZ);   // 既存キューへ
  return;
}
```

`_terrainCoversPoly` は、ポリゴンの代表点(中心+4隅程度)で
`farNodeYOrNull` が1つでも非nullを返すかを見るだけでよい。

- **利点**: 「作ってから直す」経路が消えるので、`_waterYAt` の null 分岐そのものが不要になる。
- 既存の再試行スキャン(90フレームごと)がそのまま拾うので、新しい常駐処理は増えない。

### 修正B【保険】それでも null 状態が生まれた場合の2つの穴を塞ぐ

修正Aを入れても、既に生成済みのエントリや将来の別経路のために両方塞いでおく。

**B-1. メッシュ解放中でもプロファイルは再計算する**

```js
function rebuildAreaPolyMesh(entry) {
  // ★ プロファイルの再計算はメッシュの有無に関係なく先に行う
  if (entry.kind === 'flat' && entry.waterNodeInfo) {
    const before = entry.waterProfile;
    entry.waterProfile = _computeWaterProfileFromNodes(entry.waterNodeInfo);
    if (_waterProfileChanged(before, entry.waterProfile, 0.2) && ...) { rebuildRoadsInBounds(...); }
  }
  if (!entry.mesh) return;   // ★ 頂点の書き換えだけをここで打ち切る
  ...
}
```

**B-2. null のときのフォールバック高さを、地形に張り付かせない**

`getGroundY + 0.15` をやめ、**確定プロファイルと同じ余裕**(`WATER_MARGIN` 相当)を使う。
地形の200m格子と水面の三角形のズレを吸収できる量にすること。
「見えない水面」より「少し浮いた水面」の方が実害が小さい
(見えなければユーザーは水域の存在自体を認識できない)。

### 修正C【設計】「保留」は必ず能動的に回収する

修正Aで作らない選択をした以上、**回収漏れが即「水域が永久に無い」になる。**
`pendingAreaWaterPolys` の滞留件数を `[mem]` ログに1項目足して、
溜まり続けていないか常時見えるようにすること(`pendWater N`)。

---

## 4. 検証

1. NYへジャンプ直後、`areaPolyMeshes.filter(e=>e.kind==='flat'&&!e.waterProfile).length` が **0** であること
2. 地形が届いた後、ハドソン川・湾が**青く描かれる**こと
3. `[water] profile UNAVAILABLE` が**1行も出ない**こと(出るなら修正Aの判定が抜けている)
4. `pendWater` が単調増加していないこと

---

## 5. 大原則への追記(13の再確認)

**大原則13「今はやらないをやらなくてよいに変換しない」の裏返しを今回踏んだ。**

今回は「やらない」を正しく選んだが、**「後でやる」を実行する経路が存在しなかった。**

> 20. **保留を作るときは、保留を回収する経路を同じコミットで実装し、
>     滞留件数を計器に出す。** 「後で誰かが拾う」を前提にしてはいけない。
>     このプロジェクトでは gaveUpタイル・`_dirty`・`_vegCleanupQueue`・
>     `pendingAreaWaterPolys` と、同じ失敗を4回繰り返している。

また、診断フラグ自体の正しさも検証対象に含めること。
今回 `near=yes` が嘘をついていたため、「NEARがあるのに欠測」という
存在しない現象を追いかけるところだった。
**計器が嘘をつくと、その先の推論は全部無駄になる。**
