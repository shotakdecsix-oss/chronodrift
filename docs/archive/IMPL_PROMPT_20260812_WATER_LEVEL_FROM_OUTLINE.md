# 修正指示 2026-08-12 — 水位を「輪郭ノードの低位パーセンタイル」で決める

対象ファイル: `js/legacy/part4.js` のみ
1変更 = 1コミット。**この指示以外のことは一切やらないこと。**
特に `waterSurfaceYAt` と海(`buildFixedFlatAreaPoly` / `seaYOffset`)には**触らない**。

---

## 1. 実測の根拠(2026-08-12 NY・PC Chrome)

```
対象ポリゴン=290 / 下がる=180 / 上がる=48 / 輪郭が全欠測=0
差(新-現) 中央値=-1.01  最小=-24.33  最大=+22.01
件数=270 中央値=27m 最大=9771m
  200m超=18 / 500m超=10 / 1000m超=8 / 2000m超=5 / 5000m超=3
```

読み取れること:

- **輪郭ノードは必ずDEMが答える(全欠測=0)。** 内部の格子点を見ていたから欠測していた
- **現方式は「高すぎる」ではなく「バラバラ」。** −24〜+22。20m以内にある水面同士が10以上ずれる
- **270枚中262枚(97%)が長辺1000m以下。** 1ポリゴン=1水平面で足りる
- **例外は8枚だけ。** ここだけ軸方向の分割を残せばよい

参考(現状の症状): 水面がプレイヤーの頭上43浮いていた。`固定海面Y=13.30 / プレイヤーY=14.63` に対し水面Y 57.65、地形13〜22。

---

## 2. 設計

> **水位 = そのポリゴンの輪郭ノード(=OSMの実測点)で地形高さを引き、その下位10パーセンタイル。
> ポリゴン内部のDEMは一切見ない。長辺1000m以下なら1枚1水平面。**

根拠: 水面は流出口(縁の最も低い点)の高さで決まる。それより高ければ溢れる。
最小値そのものだと低い側の外れ値1点で沈むので、p10で丸める。

---

## 3. 変更内容

### (1) `_collectWaterNodes` — 格子点収集を輪郭ノード収集に置き換える

現行は `FAR_STEP` 格子点を、ポリゴン内部+外側 `NODE_MARGIN`(=100m)まで拾っている。
**これを丸ごと捨て、`entry.pts` の点そのものを使う。**

```js
// 長辺がこれ以下なら1ビン(=ポリゴン全体で1つの水平面)。
// 実測(2026-08-12 NY): 270枚中262枚がここに入る。
const WATER_FLAT_MAX_SPAN = 1000;
const WATER_MAX_SAMPLES = 400; // 長い川の輪郭点を間引く上限

function _collectWaterNodes(entry) {
  const { pts, minX, maxX, minZ, maxZ } = entry;
  const dx = maxX - minX, dz = maxZ - minZ;
  const ux = dx >= dz ? 1 : 0, uz = dx >= dz ? 0 : 1; // 長辺方向を主軸
  const span = Math.max(dx, dz);
  let sMin = Infinity, sMax = -Infinity;
  for (const p of pts) {
    const s = p.x * ux + p.z * uz;
    if (s < sMin) sMin = s;
    if (s > sMax) sMax = s;
  }
  if (!(sMax > sMin)) sMax = sMin + 1;
  // 短いポリゴンは分割しない(1水平面)。長いポリゴンだけ主軸方向にビン分割する。
  const nBins = (span <= WATER_FLAT_MAX_SPAN) ? 0 : Math.max(1, Math.ceil((sMax - sMin) / WATER_BIN));
  const stride = Math.max(1, Math.floor(pts.length / WATER_MAX_SAMPLES));
  const nodes = []; // フラット配列 [x0,z0,b0, x1,z1,b1, ...]
  for (let i = 0; i < pts.length; i += stride) {
    const p = pts[i];
    let b = 0;
    if (nBins > 0) {
      b = Math.floor((p.x * ux + p.z * uz - sMin) / WATER_BIN);
      if (b < 0) b = 0; else if (b > nBins) b = nBins;
    }
    nodes.push(p.x, p.z, b);
  }
  return { ux, uz, sMin, nBins, nodes };
}
```

**削除するもの**: `NODE_MARGIN` の外側許容、`pointInPolygon` による内部判定、`inAnyHole`、
`_nearPolygonBoundary` の呼び出し(関数自体は他で使っていれば残す)。
輪郭ノードは定義上すべて境界上なので、内部判定もホール除外も不要。

### (2) `_binPercentileMax` を `_binLowPercentile` に置き換える

```js
// 【2026-08-12】水面は流出口(縁の最低点)の高さで決まる。最大側を採るのは物理的に逆だった。
// ただし厳密な最小値は低い側の外れ値1点で沈むので、下位10%点で丸める。
function _binLowPercentile(heights) {
  if (heights.length <= 3) {
    let m = heights[0];
    for (let k = 1; k < heights.length; k++) if (heights[k] < m) m = heights[k];
    return m;
  }
  const sorted = heights.slice().sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.10 * sorted.length) - 1)];
}
```

`_binPercentileMax` は**削除**する(他から呼ばれていないことを確認すること)。

### (3) `_computeWaterProfileFromNodes` — 上げる方向の演算を全廃する

```js
function _computeWaterProfileFromNodes(nodeInfo) {
  const { ux, uz, sMin, nBins, nodes } = nodeInfo;
  const buckets = new Array(nBins + 1);
  for (let b = 0; b <= nBins; b++) buckets[b] = [];
  for (let k = 0; k < nodes.length; k += 3) {
    const h = terrainYOrNull(nodes[k], nodes[k + 1]); // 欠測は0に潰さず捨てる
    if (h === null || h === undefined) continue;
    buckets[nodes[k + 2]].push(h);
  }
  let anyData = false;
  const M = new Array(nBins + 1).fill(null);
  for (let b = 0; b <= nBins; b++) {
    if (buckets[b].length === 0) continue;
    anyData = true;
    M[b] = _binLowPercentile(buckets[b]);
  }
  if (!anyData) return null; // 保留。地形到着後に再計算される(既存の仕組みを残す)

  // 欠測ビンは両隣の確定ビンから線形補間する。片側しか無ければその値をコピー。
  // 【重要】以前の「近傍からコピー→ラチェット→平滑化」は全て上げる方向にしか働かず、
  // 1点の外れ値を全域へ配る増幅器になっていた。補間は上下対称なのでバイアスが無い。
  for (let b = 0; b <= nBins; b++) {
    if (M[b] !== null) continue;
    let lo = -1, hi = -1;
    for (let k = b - 1; k >= 0; k--) if (M[k] !== null) { lo = k; break; }
    for (let k = b + 1; k <= nBins; k++) if (M[k] !== null) { hi = k; break; }
    if (lo >= 0 && hi >= 0) M[b] = M[lo] + (M[hi] - M[lo]) * ((b - lo) / (hi - lo));
    else if (lo >= 0) M[b] = M[lo];
    else if (hi >= 0) M[b] = M[hi];
  }
  return { ux, uz, sMin, M };
}
```

**この関数から完全に消えるもの:**

| 消す処理 | 消す理由 |
|---|---|
| `_binPercentileMax`(90%点) | 上げる方向 |
| ラチェット伝播(`M0` / `MAX_RISE_PER_BIN` / `headAvg` / `tailAvg`) | 上げる方向 |
| 上向き平滑化(`M2[b] = Math.max(M[b], 平均)`) | 上げる方向 |
| `WATER_MARGIN = 0.3` の加算 | 上げる方向。高さで競合を解決しようとしていた |

`MAX_RISE_PER_BIN` と `WATER_MARGIN` の定数宣言も削除する。

### (4) 地形との競合は高さではなく深度バイアスで解く

小さい水面(中央値27m)は、200m格子の地形から見ると点にすぎない。
水位を正しい高さに置くと、地形とほぼ同一平面になり z-fighting する。
**これを高さ(余裕の積み増し)で解決しようとしたのが今までの失敗の構造。**
描画側で解決する。

```js
const waterAreaMat = new THREE.MeshBasicMaterial({
  color: MODE_CONF.water, side: THREE.DoubleSide,
  // 【2026-08-12】地形と同一平面になっても水面を確実に手前に描く。
  // これがあるので水位に安全余裕(旧WATER_MARGIN)を積む必要が無くなった。
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4
});
```

`_commitWaterPoly` の `yOff = 0.15` は**そのまま**にする(変更を1つに絞るため)。

---

## 4. 触らないもの

- `waterSurfaceYAt` の `max` 集約 — 別問題。水位が正しくなれば害は小さい。次コミットで単独対応
- 海(`buildFixedFlatAreaPoly` / `seaLevelY` / `seaYOffset` / `processCoastlineFill`)— 前コミットで動作確認済み
- `pendingAreaWaterPolys` の予算切れ再試行キュー — 保留の回収経路なので残す
- `anyData === false` のときプロファイルを確定させない保留 — 残す
- `rebuildAreaPolyMesh` の再計算経路 — `waterNodeInfo` の中身が変わるだけで構造は同じ
- 地形に穴を開ける / 適合カット / `DoubleSide` を巻き順の保険にする — いずれも失敗確定済み

---

## 5. 検証手順(ユーザーが実施)

1. デプロイ後、PC Chrome + DevTools で NY(ハドソン川)へジャンプ、60秒待つ
2. `DEBUG_PROBE_20260812_WATER_PERF.js` を貼り、`__cdReport()` と `__cdNewLevel()`
3. 伊勢原(相模川)でも同じ

**合格条件**

- `[water] profile` のログに **100超の値が出ない**(周辺地形と同じ桁に収まる)
- `__cdReport()` の (A-4) で `水面が地形より高い_m` が **概ね 0〜1**(今は +35〜49)
- `__cdNewLevel()` の `差(新-現)` の**中央値が概ね 0**(新方式が実装に入ったので当然そうなるべき)
- `[water] profile UNAVAILABLE` が**ほぼ出ない**(輪郭は欠測しないため)
- 見た目: 川が水面に見える。上空に板が浮いていない

**不合格の見分け**

- 川がまだ地面に見える → 水位が下がりすぎて地形に潜っている。`_binLowPercentile` の
  0.10 を 0.25 へ上げて再確認する。**それ以外は触らない**
- 水面がチラつく(z-fighting) → `polygonOffsetUnits` を -4 → -8 へ。**高さは触らない**
- 相模川が1枚の長いポリゴンで届き、勾配が段になる → `WATER_BIN` の値を見直す。
  `WATER_FLAT_MAX_SPAN` を下げれば分割される枚数が増える

---

## 6. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "water: derive surface level from outline nodes (low percentile) and remove all upward-biased aggregation"; git push
```
