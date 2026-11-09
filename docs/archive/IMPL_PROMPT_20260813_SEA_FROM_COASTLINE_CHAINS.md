# 修正指示 2026-08-13 — 海面を「つなげた海岸線 + セル判定」で作り直す

対象ファイル: `js/legacy/part4.js` のみ
1変更 = 1コミット。**この指示以外のことは一切やらないこと。**
川・池(`fixedY` を持たない面)、地形、`seaLevelY()` / `seaYOffset()` には**触らない**。

---

## 1. なぜ作り直すか(実測)

現行の Phase1 ribbon / Phase2 タイル全塗りは、**海面ポリゴンの面積の約36%が本物の陸**だった。

```
__cdSea (2026-08-13 NY): サンプル6697点中、地形が海面より+3以上高い = 2387点 (35.6%)
  うち +30超 = 536点。座標はマンハッタン Upper East Side / Wall St / ブルックリン
  超過+3以上のうち Phase2全塗り由来 = 31%。残り69%は Phase1 ribbon 由来
```

固定海面Y(7.30)が偶然の陸フィルタとして働き、マンハッタン(地形+90)の下に海面が埋もれて
いたため今まで見えていなかった。地形を下げた瞬間に「陸の水面化」として噴出した。

ribbon は「chain の両端点だけ」で海側を決めるため、四方を海岸線に囲まれた島では
島の内側を覆う。**自己交差しないことと、正しい側を覆うことは別問題だった。**

---

## 2. 新方式が実測で検証済みであること

`DEBUG_PROBE_20260813_COASTLINE_RINGS_V2/V3.js` で、コードを変更せずに検証済み。

```
way 73本 → 端点でつないで chain 8本(閉じた2 / 開いた6)
閉じた2つ = 面積0.69km² と 0.06km² → ガバナーズ島(実面積0.70km²)とリバティ/エリス島。実物と一致
既知18地点での判定: 実質 17/18(陸9件は9/9)
```

外れた1件(ナローズ)は最近傍の海岸線が4093m先=**データ未取得**。判定の失敗ではない。

「誤判定」に見えた1件(ニュータウンクリーク河口)は、実地確認の結果 **OSM仕様どおりの正しい挙動**
だった。coastline は河口を直線で閉じ、入江の中へは入らない。最近傍区間の始点(40.73698,-73.96267)
は水の真ん中にあり、その両端(40.73928 と 40.73342)は実際の岸の上にあることを地図で確認済み。

### 検証で否定された選択肢(再挑戦しないこと)

| 試したこと | 結果 |
|---|---|
| 接線の平滑化(50/150/400m) | **効果ゼロ**。0mと完全に同じ判定。実装に入れる必要なし |
| 上位8区間の 1/d² 重み付き多数決 | 効果なし(上位8区間が全会一致だった) |
| レイ交差の巻き数で内外判定 | **不可**。4方向の偶奇が 偶/奇/偶/奇 とバラバラ |

---

## 3. この判定が返すものの意味(重要)

> **返すのは「陸か水か」ではなく「海か、海ではないか」。**

「海ではない」側には、陸と **河口・入江の水** の両方が入る。その水は `natural=water` の
川ポリゴンが担当し、川は既に地形へドレープする実装になっている(相模川で実機合格済み)。
**役割分担は既に成立しているので、ここで河口の水を拾おうとしないこと。**

---

## 4. 実装

### (4-1) chain の組み立て

`coastlineWayStore` と `coastlineIslandStore` の**両方**を入力にする。

```js
// 【2026-08-13】coastline way は端点を共有して連なる。つなげてから使う。
// 実測(NY): way 73本 → chain 8本。閉じた2本はガバナーズ島とリバティ島で実面積と一致。
let coastlineChains = null;      // [ [{x,z},...], ... ]
let coastlineRings = null;       // 閉じた chain(島)だけ
let coastlineSegs = null;        // {ax,az,bx,bz,minX,maxX,minZ,maxZ} のフラット配列
let _coastlineChainsDirty = true;

const COAST_JOIN_EPS = 1.0;      // 端点が一致とみなす距離(m)

function rebuildCoastlineChains() {
  const ways = [];
  for (const w of coastlineWayStore.values()) if (w && w.pts && w.pts.length >= 2) ways.push(w.pts);
  for (const w of coastlineIslandStore.values()) if (w && w.pts && w.pts.length >= 2) ways.push(w.pts);
  const key = p => Math.round(p.x / COAST_JOIN_EPS) + '|' + Math.round(p.z / COAST_JOIN_EPS);
  const ends = new Map();
  ways.forEach((pts, i) => { for (const p of [pts[0], pts[pts.length - 1]]) {
    const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
  const used = new Array(ways.length).fill(false);
  const takeNext = p => { for (const i of (ends.get(key(p)) || [])) if (!used[i]) return i; return -1; };
  const chains = [];
  for (let s = 0; s < ways.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    let c = ways[s].slice();
    for (;;) { const i = takeNext(c[c.length - 1]); if (i < 0) break; used[i] = true;
      const w = ways[i];
      c = c.concat(key(w[0]) === key(c[c.length - 1]) ? w.slice(1) : w.slice(0, -1).reverse()); }
    for (;;) { const i = takeNext(c[0]); if (i < 0) break; used[i] = true;
      const w = ways[i];
      c = (key(w[w.length - 1]) === key(c[0]) ? w.slice(0, -1) : w.slice(1).reverse()).concat(c); }
    chains.push(c);
  }
  coastlineChains = chains;
  coastlineRings = chains.filter(c =>
    Math.hypot(c[0].x - c[c.length - 1].x, c[0].z - c[c.length - 1].z) <= COAST_JOIN_EPS * 2);
  coastlineSegs = [];
  for (const c of chains) for (let i = 0; i < c.length - 1; i++) {
    const a = c[i], b = c[i + 1];
    coastlineSegs.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z,
      minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x),
      minZ: Math.min(a.z, b.z), maxZ: Math.max(a.z, b.z) });
  }
  _coastlineChainsDirty = false;
  console.log('[coastline] chains=' + chains.length + ' rings=' + coastlineRings.length +
    ' segs=' + coastlineSegs.length);
}
```

way を store に入れる箇所で `_coastlineChainsDirty = true;` を立てる。
`recenterOrigin()` でストアを clear している箇所では、`coastlineChains = null; _coastlineChainsDirty = true;` も行う。

### (4-2) 1点が「海か」を判定する

```js
// 海側ベクトル = 進行方向の右手 = (-dz, dx)。既存 _crossSide と同じ導出。
// segs は「そのタイル近辺だけに絞ったリスト」を渡す(全件走査しないため)。
function isSeaPoint(px, pz, segs) {
  for (const r of coastlineRings) if (pointInPolygon(px, pz, r)) return false; // 島の内側は海ではない
  let best = Infinity, dot = 0;
  for (const s of segs) {
    const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((px - s.ax) * dx + (pz - s.az) * dz) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = s.ax + dx * t, cz = s.az + dz * t;
    const d = (px - cx) * (px - cx) + (pz - cz) * (pz - cz);
    if (d < best) { best = d; dot = (px - cx) * (-dz) + (pz - cz) * dx; }
  }
  if (best === Infinity) return false;
  return dot >= 0;
}
```

**平滑化も多数決も入れないこと。** 実測で効果ゼロと確定している。

### (4-3) タイル1枚を、セル単位で塗る

```js
const COAST_CELL_M = 100;    // 判定セルの一辺。1600mタイル → 16×16
const COAST_DECIDE_MAX = 3000; // この距離内に海岸線が1本も無いタイルは判定せず保留する

function _fillCoastlineTile(tx, tz, seaY) {
  const x0 = tx * OSM_TILE_M, x1 = x0 + OSM_TILE_M;
  const z0 = tz * OSM_TILE_M, z1 = z0 + OSM_TILE_M;
  const m = COAST_DECIDE_MAX;
  const segs = coastlineSegs.filter(s =>
    s.minX <= x1 + m && s.maxX >= x0 - m && s.minZ <= z1 + m && s.maxZ >= z0 - m);
  if (segs.length === 0) {
    pendingCoastlineTiles.set(tx + ',' + tz, { tx, tz }); // 判定しない。海岸線が届いてから
    return;
  }
  seenCoastlineTiles.add(tx + ',' + tz);
  pendingCoastlineTiles.delete(tx + ',' + tz);

  const N = Math.round(OSM_TILE_M / COAST_CELL_M);
  const grid = new Uint8Array(N * N);
  let seaCells = 0;
  for (let jz = 0; jz < N; jz++)
    for (let ix = 0; ix < N; ix++) {
      const cx = x0 + (ix + 0.5) * COAST_CELL_M, cz = z0 + (jz + 0.5) * COAST_CELL_M;
      if (isSeaPoint(cx, cz, segs)) { grid[jz * N + ix] = 1; seaCells++; }
    }
  if (seaCells === 0) {
    console.log('[coastline] tile ' + tx + ',' + tz + ': segs=' + segs.length + ' seaCells=0');
    return;
  }
  // 横方向の連続を run にまとめ、さらに上下で同じ run を矩形に結合する
  // (全部海のタイルは矩形1枚になる。ドローコールを抑えるため)
  const rects = [];
  const doneRow = new Uint8Array(N * N);
  for (let jz = 0; jz < N; jz++)
    for (let ix = 0; ix < N; ix++) {
      if (!grid[jz * N + ix] || doneRow[jz * N + ix]) continue;
      let ex = ix; while (ex + 1 < N && grid[jz * N + ex + 1] && !doneRow[jz * N + ex + 1]) ex++;
      let ez = jz;
      for (;;) { // 下の行が同じ範囲で全部海なら伸ばす
        const nz = ez + 1;
        if (nz >= N) break;
        let same = true;
        for (let k = ix; k <= ex; k++) if (!grid[nz * N + k] || doneRow[nz * N + k]) { same = false; break; }
        if (!same) break;
        ez = nz;
      }
      for (let r = jz; r <= ez; r++) for (let k = ix; k <= ex; k++) doneRow[r * N + k] = 1;
      rects.push({ x0: x0 + ix * COAST_CELL_M, x1: x0 + (ex + 1) * COAST_CELL_M,
                   z0: z0 + jz * COAST_CELL_M, z1: z0 + (ez + 1) * COAST_CELL_M });
    }
  let built = 0, budgetFail = 0;
  for (const r of rects) {
    if (!areaPolyBudgetOK('sea')) { budgetFail++; continue; }
    buildFixedFlatAreaPoly(
      [{ x: r.x0, z: r.z0 }, { x: r.x1, z: r.z0 }, { x: r.x1, z: r.z1 }, { x: r.x0, z: r.z1 }],
      waterAreaMat, seaYOffset(), seaY, null);   // ← holes は不要。島は判定で除外済み
    built++;
  }
  console.log('[coastline] tile ' + tx + ',' + tz + ': segs=' + segs.length +
    ' seaCells=' + seaCells + '/' + (N * N) + ' rects=' + rects.length +
    ' built=' + built + ' budgetFail=' + budgetFail);
}
```

`processCoastlineFill` は、way をストアへ入れる → `_coastlineChainsDirty` なら
`rebuildCoastlineChains()` → tileList の各タイルで `_fillCoastlineTile` を呼ぶだけになる。

---

## 5. 削除するもの(全部消すこと)

| 削除対象 | 理由 |
|---|---|
| `_buildCoastlineRibbon` | 構築物。島の内側を覆う原因 |
| `_wayLocalRibbonsForTile` | 同上 |
| `_clipPolyBySeaSide` / `_clipPolyToTile` | 半平面クリップ。非凸で破綻(2度目の再発済み) |
| `_crossSide` | Phase2 の5点投票専用 |
| `_distPointToSegment` | 同上。**他から呼ばれていないことを grep で確認してから消す** |
| 定数 `COASTLINE_SEA_FAR`(3000) | ribbon 専用 |
| Phase2 の 5点多数決ブロック(`seaVotes >= 3`)まるごと | 陸を巻き込む原因の31% |

---

## 6. 触ってはいけないもの

- `seaLevelY()` / `seaYOffset()` / `LAND_FLOOR_MARGIN_M` / 地形 — 高さは一切動かさない
- 川・池(`fixedY` を持たない面)の地形ドレープ — 実機合格済み
- `seenCoastlineTiles` / `pendingCoastlineTiles` / `scanPendingCoastlineTiles` — 保留の回収経路。そのまま使う
- `coastlineWayStore` / `coastlineIslandStore` への追加処理と `recenterOrigin` での clear
- `areaPolyBudget` の値、`dropAreaRecordsInTile` の `seenCoastlineTiles.delete`
- 接線の平滑化・重み付き多数決・レイ交差の巻き数 — **実測で否定済み。入れないこと**

---

## 7. 検証手順(ユーザーが実施)

1. デプロイ後、NY(ハドソン川河口)へジャンプ、90秒待つ
2. `DEBUG_PROBE_20260813_SEA_COVERAGE.js` を貼って `__cdSea()`

**合格条件**

- `地形が海面より高い` の割合が **35.6% → 10%未満**(前回計測が基準)
- `+30超` の区分が **ほぼ0**(マンハッタンやブルックリンを覆っていない証拠)
- `[coastline] chains=` が出て、chain数が way 数より大幅に少ない(つなげられている証拠)
- タイルログの `seaCells` が、外洋タイルで 256/256、陸のタイルで 0
- 見た目: ニューヨーク湾・ハドソン川が水面。**マンハッタンやジャージーシティが水没していない**
- 伊勢原・東京でも、陸が水没していないこと(**これが最も怖い退行**)

**不合格の見分け**

- 陸が水没する → 海側/陸側の符号が逆。`isSeaPoint` の `return dot >= 0` を `<= 0` にする。**それ以外は触らない**
- 海が塗られない → `[coastline] tile ...` の `segs=0` が多いか確認。多ければ保留が回収されていない
- 汀線がガタつく → `COAST_CELL_M` を 100 → 50 へ。**判定ロジックは触らない**
- ドローコールが増えすぎる → `COAST_CELL_M` を 100 → 200 へ。矩形結合が効いているかは `rects` の数で分かる

---

## 8. 既知の限界(直さないこと。認識だけ合わせる)

- **河口・入江の水は海面として塗られない。** OSMの coastline は河口を直線で閉じるため。
  そこは `natural=water` の川ポリゴンが担当する(実測でこの挙動を確認済み)
- **海岸線が `COAST_DECIDE_MAX`(3000m)以内に無いタイルは塗られない。** データが届いてから
  保留キュー経由で塗られる。ナローズの誤判定(最近傍4093m)はこれで防がれる
- 汀線の分解能は `COAST_CELL_M`(100m)。地形格子が200mなので、これより細かくしても
  地形側が追いつかない

---

## 9. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "coastline: build sea from assembled coastline chains with per-cell side test, replacing ribbons and whole-tile fill that covered 36% land"; git push
```
