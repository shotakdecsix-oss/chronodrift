# 修正指示 2026-08-19 — GSI標高タイルの種別フォールバック(404=海ではない)

対象ファイル: `js/legacy/part5.js`(GSI標高タイル取得)、`js/legacy/part6.js`(oceanFloor / recenterOrigin)
**修正Aと修正Bは別コミット。修正Aの実機確認が済むまで修正Bに進まないこと。**
**この指示以外のことは一切やらないこと。**

---

## 1. 直す症状

東京・晴海三丁目(35.65644, 139.78539)で、**見渡す限りの地面が水没**している。
建物は屋根だけが水面から出ている状態。

実機コンソールでの切り分け結果:

```
seaMesh.visible = false          → 地面が出現(= 海面ポリゴンではなく大域seaMeshが覆っていた)
raw=-9.846  base=-9.846  surf=-10.43  SEA_Y=-9.6  elevBase=4.8
```

- `raw === base` なので `seaClampY`(SHORE_RAMP / SEA_BED_DROP)は**無罪**
- `ELEV_SCALE = 2`(SEA_Y=-9.6 ÷ elevBase=4.8 で逆算)
- `raw = -9.846` を実標高に戻すと **-0.12m**。しかし `LAND_FLOOR_MARGIN_M = 0.5` があるので
  有効値なら絶対に `-8.6` を下回れない。→ **oceanFloorとの補間値であることが確定**

---

## 2. 真因

`part5.js` の GSI標高タイル取得が **dem_png(DEM10B、z14)しか見ていない**。

| URL | 結果 |
|---|---|
| `dem_png/14/14556/6456.png` | **404** |
| `dem5a_png/15/29107/12906.png` | **3.64m** ← 同じ地点。晴海の実標高そのもの |

GSIの標高タイルは **DEM5A / 5B / 5C(z15)/ DEM10B(z14 = dem_png)** の4種類あり、
公式にも上位から順にフォールバックせよとされている。
**東京都心・湾岸は DEM5A のみ整備、DEM10B は未整備。**

`part5.js:186,199` の「404 = 海上 = データ無し」というコメントと実装が**誤り**だった。
404には「本当に海」と「このDEM種別では未整備(他の種別にはある)」の2通りがある。
404は `null` 扱いなので opentopodata フォールバックも効かない(`'gsiError'` 時のみ)。

結果、z14タイル1枚(2.4km四方)が丸ごと404 → 晴海・豊洲・有明がまとめて
`oceanFloor = SEA_Y - 10` に落ち、大域 `seaMesh`(60000×60000、part6.js:408)に覆われた。

### 修正後のクリアランス(数学的保証)

```
地形 - 海面 = (3.64 - E)×2 - (0 - E)×2 = 3.64 × 2 = 7.28
```

**elevBase(E)が約分で消える**ため、地域基準がどう再確定されようと海面より7.28m上が保証される。

---

## 3. 実装前検証(実施済み・すべて安全側。再検証不要)

「DEM5Aが水面で0m付近の実数を返して海が陸になる」リスクを疑ったが、**起きない**ことを実測で確認済み:

| 地点 | dem5a の応答 |
|---|---|
| 東京湾中央 (35.60, 139.85) | **404** → 欠測(正しい) |
| 豊洲沖 (35.62, 139.80) | タイルは200だが**ピクセルが無効値(2^23)** → 欠測(正しい) |

豊洲沖のパターン(200だが無効値)は、既存の
`out[i] = (x === 8388608) ? NaN : ...`(part5.js:214)と
`Number.isFinite(h) ? h : null`(part5.js:270)が**そのまま正しく処理する**。
→ **無効値処理は一切変更しない。触るのは404の扱いだけ。**

---

## 4. 修正A — 種別フォールバック(part5.js)

### 方針

> **404は「このDEM種別に無い」だけ。次の種別を試し、全種別で404のときだけ「データ無し」とする。**

タイル種別ごとにズームが違う(dem_png=z14、dem5*=z15)ため、
**種別ごとにタイル座標とピクセル座標を計算し直す**必要がある。

### (4-1) 種別テーブルとキャッシュキー

`GSI_DEM_Z = 14` の宣言(part5.js:189)を置き換える。

```js
// 【2026-08-19・IMPL_PROMPT_20260819_GSI_DEM_FALLBACK.md】404は「海」ではない。
// GSIの標高タイルはDEM5A/5B/5C(z15)/DEM10B(z14=dem_png)の4種類あり、整備範囲が異なる。
// 東京都心・湾岸はDEM5Aのみ整備でdem_pngは全面404。実測: dem_png/14/14556/6456=404、
// 同一地点の dem5a_png/15/29107/12906 = 3.64m。404を「海」と断定していたため、
// 晴海・豊洲・有明が丸ごとoceanFloorに落ち水没していた。
// 【無効値(2^23)は従来どおり「水面=データ無し」で確定させる】これは実測で正しいと確認済み
// (豊洲沖はタイル200・ピクセル無効値)。再挑戦するのは「タイル自体が404」の点だけ。
const GSI_DEM_SETS = [
  { name: 'dem_png',   z: 14 },  // DEM10B。全国だが都市部・平野部に穴がある
  { name: 'dem5a_png', z: 15 },  // 航空レーザ。都市部・平野部
  { name: 'dem5b_png', z: 15 },
  { name: 'dem5c_png', z: 15 },
];
const _gsiTiles = new Map(); // "set/tx,ty" -> Promise<Float32Array|null> (null=そのDEMにタイル無し)
const GSI_TILE_CACHE_MAX = 240; // 【2026-08-19】z15はz14の4倍の枚数が要るので120→240
```

`GSI_DEM_Z` を参照している箇所が他に無いか **grep して確認すること**。あれば併せて直す。

### (4-2) `_gsiLoadTile` に種別を渡す

シグネチャを `_gsiLoadTile(set, tx, ty)` に変更。**変えるのはURLとキャッシュキーだけ。**
`createImageBitmap` 以降のデコード処理(`bmp.close()` / 2^23判定 / Float32Array生成)は**一切触らない**。

```js
function _gsiLoadTile(set, tx, ty) {
  const key = set.name + '/' + tx + ',' + ty;
  let p = _gsiTiles.get(key);
  if (p) return p;
  p = (async () => {
    const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/${set.name}/${set.z}/${tx}/${ty}.png`);
    if (res.status === 404) return null; // このDEMには無い。呼び出し側が次のDEMを試す
    if (!res.ok) throw new Error('GSI HTTP ' + res.status);
    // ↓ここから下は既存のまま(1行も変えない)
    ...
  })();
  p.catch(() => _gsiTiles.delete(key));
  _gsiTiles.set(key, p);
  // 既存の追い出し処理もそのまま
  ...
}
```

### (4-3) タイル座標の計算を種別ごとに切り出す

```js
// 【2026-08-19】DEM種別ごとにズームが違うので、タイル座標とピクセル座標を種別ごとに求める
function _gsiTileXY(set, lat, lon) {
  const n = 2 ** set.z;
  const xt = (lon + 180) / 360 * n;
  const latR = lat * Math.PI / 180;
  const yt = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
  const tx = Math.floor(xt), ty = Math.floor(yt);
  return { key: set.name + '/' + tx + ',' + ty, tx, ty,
    px: Math.min(255, Math.floor((xt - tx) * 256)),
    py: Math.min(255, Math.floor((yt - ty) * 256)) };
}
```

### (4-4) 1種別ぶんの取得を関数化する

既存 `fetchElevationsGSI` の中身(jobs構築 → runLimited → out生成)をここへ移す。
**変更点は「タイル自体が404だった点を確定させず、再挑戦リストへ回す」ことだけ。**

```js
// 【2026-08-19】1つのDEM種別について、まだ値が決まっていない点(idxs)だけを取得する。
// 戻り値 = 次のDEMで再挑戦すべき点のindex配列(=そのDEMにタイルが無かった点)。
// 無効値(水面)と'gsiError'はここで確定させる(再挑戦しない)。
async function _gsiFetchPass(set, latlons, idxs, out) {
  const jobs = idxs.map(i => Object.assign({ i }, _gsiTileXY(set, latlons[i].lat, latlons[i].lon)));
  const tiles = new Map(); // key -> Float32Array | null(タイル無し) | 'error'(取得失敗)
  const keys = [...new Set(jobs.map(j => j.key))];
  await runLimited(keys, async (k) => {
    const j = jobs.find(jb => jb.key === k);
    try {
      tiles.set(k, await _gsiLoadTile(set, j.tx, j.ty));
    } catch (e) {
      try {
        tiles.set(k, await _gsiLoadTile(set, j.tx, j.ty)); // 1回だけリトライ(既存の方針を踏襲)
      } catch (e2) {
        tiles.set(k, 'error'); // このタイルの点だけ呼び出し側でopentopodataに回す
      }
    }
  }, 8);
  const retry = [];
  for (const j of jobs) {
    const tile = tiles.get(j.key);
    if (tile === 'error') { out[j.i] = 'gsiError'; continue; }
    if (tile == null) { retry.push(j.i); continue; }   // ★タイル自体が無い → 次のDEMへ
    const h = tile[j.py * 256 + j.px];
    out[j.i] = Number.isFinite(h) ? h : null;          // 無効値=水面。ここで確定(再挑戦しない)
  }
  return retry;
}
```

### (4-5) 学習付きの試行順序

湾岸のようにdem_pngが全滅する地域で毎回404を2回引くのは無駄なので、
**「この地域はdem_pngが404だった」を覚えて順序を入れ替える**。

```js
// 【2026-08-19】dem_pngが404だった地域では、以降dem5aを先に試す(404の空振りを減らす)。
// 地域をまたぐと整備状況が変わるので、recenterOriginでfalseに戻すこと(part6.js側)。
let _gsiPreferHiRes = false;
function _gsiSetsOrdered() {
  if (!_gsiPreferHiRes) return GSI_DEM_SETS;
  return [GSI_DEM_SETS[1], GSI_DEM_SETS[0], GSI_DEM_SETS[2], GSI_DEM_SETS[3]];
}
```

`_gsiFetchPass` で `set.name === 'dem_png'` かつ `retry.length > 0` のとき `_gsiPreferHiRes = true` にする。

### (4-6) `fetchElevationsGSI` を多段化

```js
async function fetchElevationsGSI(latlons) {
  if (!latlons.length || !latlons.every(ll => gsiCovers(ll.lat, ll.lon))) return null;
  const out = new Array(latlons.length);
  let pending = latlons.map((_, i) => i);
  for (const set of _gsiSetsOrdered()) {
    if (pending.length === 0) break;
    pending = await _gsiFetchPass(set, latlons, pending, out);
  }
  for (const i of pending) out[i] = null; // 全DEMで404 = 本当にデータが無い(海・国外)
  // ↓【2026-07-21・国外の誤判定対策】は既存のまま1行も変えない
  const hasRealData = out.some(v => typeof v === 'number');
  const hasError = out.some(v => v === 'gsiError');
  if (!hasRealData && !hasError) return null;
  return out;
}
```

**戻り値の形(数値 / null / 'gsiError' の3種)は従来と完全に同じ。** 呼び出し側(part6.js
`loadNearTerrain` / `loadWideTerrain`)は**一切変更しない**。

### (4-7) 診断ログ

湾岸で何段目のDEMが当たったか分かるよう、**バッチにつき1行だけ**出す(点ごとに出さないこと)。

```js
console.log('[gsiDem] ' + set.name + ': 確定=' + (idxs.length - retry.length) +
            ' 次DEMへ=' + retry.length);
```

---

## 5. 修正B — oceanFloorを浅くする(part6.js)【修正Aの実機確認後・別コミット】

### なぜ必要か

汀線から一定幅の陸が沈む問題は、**修正Aでは1ミリも改善しない**。

```
陸ノードから海面を切る距離 = 543 × (実標高×2) / (実標高×2 + D)
  543 = NEARグリッドの間隔(m)   D = oceanFloorの落差(現状10)
```

晴海(3.64m)なら `543 × 7.28/17.28 ≒ 229m`。
**elevBaseは分子分母に等しく効いて約分で消える**ため、標高データがどれだけ正確になっても不変。
分母の `D` を小さくするしか手が無い。

| D | 陸が海面上に残る距離 |
|---|---|
| 10(現状) | 229m |
| 1.0 | **477m** |
| 0.5 | 507m |

### 実装

`part6.js:162` と `part6.js:297` の2箇所(`loadWideTerrain` / `loadNearTerrain`)。

```js
// 【2026-08-19】欠測ノードを海面より10も下に置いていたため、陸ノードとの543m補間が
// 汀線から229mにわたって海面を割っていた(543×7.28/17.28)。海の見た目は不透明なseaMeshが、
// 本物の海の沈降はcoastline由来のseaClampY(SEA_BED_DROP=0.6)がそれぞれ担当するので、
// 欠測ノード自体を深く沈める必要は無い。1.0にすると同じ計算が477mへ広がる。
const OCEAN_FLOOR_DROP = 1.0;   // 唯一の調整つまみ
const oceanFloor = (0 - elevBase) * ELEV_SCALE - OCEAN_FLOOR_DROP;
```

2箇所で同じ定数を使うこと(片方だけ変えるとNEARとWIDEで海底の高さが食い違う)。

### 修正Bの副作用チェック(検証時に必ず見る)

- 水面ポリゴン(`waterAreaMat`)に透明度がある場合、**水深1mだと海底が透けて見える**可能性
- `seaClampY` は `y < base ? y : base` なので、海底-1.0 に対し SEA_BED_DROP(-0.6)は効かず
  -1.0 のまま。**矛盾は起きない**(確認済み)
- プレイヤーの足場は `surfaceY = max(地形, 水面)` なので海底の深さは接地に影響しない

---

## 6. 触ってはいけないもの

- `createImageBitmap` 以降のデコード処理(`bmp.close()` / **2^23の無効値判定** / Float32Array生成)
- `Number.isFinite(h) ? h : null` — 無効値=水面の確定。実測で正しいと確認済み
- 末尾の【2026-07-21・国外の誤判定対策】(`hasRealData` / `hasError`)
- `gsiCovers` の矩形、opentopodataフォールバック経路、`runLimited` の実装
- `fetchElevationsGSI` の**戻り値の形**(数値 / null / 'gsiError')
- part6.js の `loadNearTerrain` / `loadWideTerrain` 本体、`establishRegionBase`、`LAND_FLOOR_MARGIN_M`
- `seaClampY` / `coastGeomAt` / `SHORE_RAMP` / `SEA_BED_DROP` / `SEA_BED_INSET`(**今回は無罪**)
- `isSeaPoint` / `rebuildCoastlineChains` / `_fillCoastlineTile`
- 標高の取得解像度(`NEAR_SEGS` / `WIDE_SEGS`)— 海外はopentopodataの1日1000コール上限に当たる
- **並列数を8から上げないこと。** z15で枚数が増えるからと上げると、過去に潰した
  「標高取得がOSM取得を巻き添えにする」不具合が再発する

---

## 7. 検証手順(ユーザーが実施)

デプロイ後 **Ctrl+Shift+R**。
**`establishRegionBase` は recenterOrigin 時しか走らないため、必ずリロードすること**
(elevBaseが下がって地域の高さ基準が再確定される)。

### (a) 東京・晴海三丁目 — 今回の主目的

- **地面が水没していないこと**(建物の屋根だけが出ている状態でないこと)
- コンソールに `[gsiDem] dem_png: 確定=0 次DEMへ=NNN` → `[gsiDem] dem5a_png: 確定=NNN` が出ること

### (b) 数値

```js
(()=>{const p=player.position;console.log({raw:terrainYOrNull(p.x,p.z),base:terrainY(p.x,p.z),surf:farSurfaceY(p.x,p.z),SEA_Y,elevBase,実標高:terrainYOrNull(p.x,p.z)/ELEV_SCALE+elevBase});})()
```

- `実標高` が **3〜4m** になること(修正前は -0.12m)
- `surf > SEA_Y` になること。差が **7前後**あれば理論値どおり

### (c) 海が陸になっていないこと(逆転チェック)

東京湾・お台場沖に視線を向け、**海が水色のままであること**。
陸に見えたら修正Aを revert して報告すること(DEM5Aが水面で数値を返している)。

### (d) 伊勢原 — 省略しない(回帰確認)

dem_pngが健在な地域。**追加リクエストが発生していないこと**が要点。

- コンソールに `[gsiDem] dem_png: 確定=NNN 次DEMへ=0` だけが出て、dem5a_pngの行が出ないこと
- 地形の見た目が今までと変わらないこと
- 初回ロード時間が体感で伸びていないこと

### (e) 負荷

- `[mem]` の `heapMB` が従来比で大きく増えていないこと(キャッシュ120→240の影響)
- 湾岸で初回ロードが極端に遅くなっていないこと(z15は同面積で約3.4倍の枚数)

### 不合格の見分け

| 症状 | 対処 |
|---|---|
| まだ水没する | `[gsiDem]` ログを見る。dem5aの行が出ていなければ(4-6)の多段ループが繋がっていない |
| 海が陸になった | 修正Aを revert。DEM5Aが水面で数値を返している |
| 伊勢原でdem5aを引いている | `_gsiPreferHiRes` が地域をまたいで残っている。recenterOriginでのリセット漏れ |
| 汀線から200m程度が沈む | 想定内。**修正B**へ進む |
| 初回ロードが極端に遅い | `_gsiPreferHiRes` の学習が効いていない(毎回dem_pngの404を引いている) |

---

## 8. デプロイ

修正A:

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "terrain: fall back to DEM5A/5B/5C tiles when dem_png returns 404, since 404 means the tile is missing from that dataset rather than the point being sea"; git push
```

修正B(Aの実機確認後):

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "terrain: raise the ocean floor for missing elevation nodes from 10 to 1.0 so the 543m interpolation stops dragging the shoreline under the sea"; git push
```
