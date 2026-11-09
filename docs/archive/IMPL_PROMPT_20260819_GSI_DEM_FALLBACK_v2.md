# 修正指示 2026-08-19 v2 — GSI標高タイルの優先順位を精度順に反転する

対象ファイル: `js/legacy/part5.js`
前提: `IMPL_PROMPT_20260819_GSI_DEM_FALLBACK.md`(v1)が実装・デプロイ済み。
本書はその**修正**であり、v1の多段フォールバック機構(`_gsiFetchPass` / `_gsiTileXY` /
`GSI_DEM_SETS`)はそのまま使う。**変えるのは「順序」と「次のDEMへ回す条件」の2点だけ。**
**この指示以外のことは一切やらないこと。**

---

## 1. v1が効かなかった理由(実測で確定)

晴海三丁目(35.65644, 139.78539)を両DEMで直接読んだ結果:

```
dem_png    この地点= 0.5m   タイル内の無効値率= 46.4%
dem5a_png  この地点= 3.64m  タイル内の無効値率= 51.1%
```

**dem_pngは404でも無効値でもなく、`0.5m` という値を返していた。**
DEM10Bは地形図の等高線由来のため、等高線が引かれていない埋立地が周囲の水面(0m)から
補間されて潰れている。データは存在するが精度が壊滅的、という第3の状態だった。

v1のフォールバック条件は「タイルが404」だけだったので、dem_pngが値を返す限り
dem5aは永久に引かれない。ログの `[gsiDem] dem_png: 確定=441 次DEMへ=0` がそれ。

### 水没する理由(数値)

`ELEV_SCALE = 2`、`elevBase = 4.8`、`SEA_Y = -9.6`、`FAR_Y = -0.15`。
`LAND_FLOOR_MARGIN_M = 0.5` なので `max(0.5, 0.5) = 0.5` となり底上げも効かない。

| ソース | ゲーム高さ | 海面との差 | FAR_Y込みの余裕 |
|---|---|---|---|
| dem_png (0.5m) | **-8.60** | 1.00 | **0.85** |
| dem5a (3.64m) | -2.32 | **7.28** | 7.13 |

余裕0.85mでは、隣接する欠測ノード(`oceanFloor = SEA_Y - 10 = -19.6`)との543m補間で
即座に海面を割る。前回実測の `raw = -9.846` はまさにその補間値だった。

---

## 2. 方針

> **精度の高いDEMから先に引く。値があっても、それが最も精度の低いDEMのものなら採用しない。**

v1は「リクエスト数を節約するため、全国カバーのdem_pngを先に引く」設計だった。
これが誤り。**dem_pngは最後の保険**(DEM5系が未整備な山間部用)として置く。

---

## 3. 実装

### (3-1) `GSI_DEM_SETS` の順序を反転し、dem5cを削除

```js
// 【2026-08-19 v2】精度順に並べる。先頭から試し、値が取れた時点で確定する。
// dem_png(DEM10B)は等高線由来のため、等高線の無い埋立地が周囲の水面(0m)から補間されて
// 潰れる(実測: 晴海三丁目で dem_png=0.5m に対し dem5a=3.64m。真値は3.64m)。
// 「値が返る=正しい」ではないので、精度の低いDEMを先に引いてはいけない。
// dem_pngは最後の保険(DEM5系が未整備な山間部を拾う)として残す。
// dem5c_pngはログで一度も確定に寄与しなかった(確定=0を連発)ため外す。
// ここまで到達する点は本物の海であり、海の高さはcoastline判定(part4.js seaClampY)が
// 受け持つので、標高が取れなくてよい。
const GSI_DEM_SETS = [
  { name: 'dem5a_png', z: 15 },  // 航空レーザ5mメッシュ。都市部・平野部。最優先
  { name: 'dem5b_png', z: 15 },  // 写真測量5mメッシュ。5Aが無い地域を補う
  { name: 'dem_png',   z: 14 },  // DEM10B。全国だが低平地の精度が壊滅的。最後の保険
];
```

### (3-2) 無効値も次のDEMへ回す

`_gsiFetchPass` の判定部を変更する。**変更するのはこの2行だけ。**

```js
    const tile = tiles.get(j.key);
    if (tile === 'error') { out[j.i] = 'gsiError'; continue; }
    if (tile == null) { retry.push(j.i); continue; }        // タイルが無い → 次のDEMへ
    const h = tile[j.py * 256 + j.px];
    // 【2026-08-19 v2】無効値(2^23)も次のDEMへ回す。「このDEMでは測っていない」という
    // 意味しかなく、水面とは限らない(実測: dem5aのタイル内無効値率51%、dem_pngは46%)。
    // 全DEMで欠測だった点だけが本物の海として null に落ちる(§3-3のループ末尾)。
    if (!Number.isFinite(h)) { retry.push(j.i); continue; }
    out[j.i] = h;
```

### (3-3) `fetchElevationsGSI` のループ末尾は v1 のまま

```js
  for (const i of pending) out[i] = null; // 全DEMで欠測 = 本当にデータが無い(海・国外)
```

`hasRealData` / `hasError` による【2026-07-21・国外の誤判定対策】も**v1のまま1行も変えない**。

### (3-4) `_gsiPreferHiRes` の意味を反転する

v1では「dem_pngが404だった地域ではdem5aを先に」だった。順序が反転したので、
**「dem5aが1点も当たらなかった地域ではdem_pngを先に」**に意味を変える。
山間部でdem5a/5bの空振りを2回引くのを避けるため。

```js
// 【2026-08-19 v2】DEM5系が1点も当たらない地域(山間部・離島)では、以降dem_pngを先に試す。
// 地域をまたぐと整備状況が変わるので、recenterOriginでfalseに戻すこと(part6.js側)。
let _gsiPreferWide = false;
function _gsiSetsOrdered() {
  if (!_gsiPreferWide) return GSI_DEM_SETS;
  return [GSI_DEM_SETS[2], GSI_DEM_SETS[0], GSI_DEM_SETS[1]];
}
```

`_gsiFetchPass` の末尾で、`set.name === 'dem5a_png'` かつ **確定が0件**(`retry.length === idxs.length`)
のとき `_gsiPreferWide = true` にする。1点でも当たったらフラグは立てない。

v1で `_gsiPreferHiRes` を参照している箇所を **grepして全て置き換えること**
(part6.js の recenterOrigin でのリセットも名前を合わせる)。

---

## 4. 触ってはいけないもの

- `createImageBitmap` 以降のデコード処理(`bmp.close()` / 2^23判定 / Float32Array生成)
- `_gsiLoadTile` / `_gsiTileXY` の中身(v1のまま)
- 末尾の【2026-07-21・国外の誤判定対策】(`hasRealData` / `hasError`)
- `fetchElevationsGSI` の**戻り値の形**(数値 / null / 'gsiError')
- part6.js の `loadNearTerrain` / `loadWideTerrain` 本体、`establishRegionBase`
- `LAND_FLOOR_MARGIN_M`(0.5のまま。これを上げると本物の海が陸になる)
- `seaClampY` / `coastGeomAt` / `SHORE_RAMP` / `SEA_BED_DROP`(今回も無罪)
- **並列数を8から上げないこと**(標高取得がOSM取得を巻き添えにする不具合が再発する)

---

## 5. 検証手順(ユーザーが実施)

デプロイ後 **Ctrl+Shift+R**(`establishRegionBase` を再確定させるため必須)。

### (a) 東京・晴海三丁目 — 主目的

- **地面が水没していないこと**
- ログが `[gsiDem] dem5a_png: 確定=NNN 次DEMへ=少数` になること
  (v1では `dem_png: 確定=441 次DEMへ=0` だった。ここが反転していれば適用成功)

### (b) 数値

```js
(()=>{const p=player.position;console.log({raw:terrainYOrNull(p.x,p.z),surf:farSurfaceY(p.x,p.z),SEA_Y,elevBase,実標高:terrainYOrNull(p.x,p.z)/ELEV_SCALE+elevBase});})()
```

- `実標高` が **3〜4m**(v1適用後は 0.5m 相当だった)
- `surf - SEA_Y` が **7前後**

### (c) 海が陸になっていないこと

東京湾・お台場沖を見て、**海が水色のまま**であること。
dem5a/5bで欠測した海の点が dem_png に回り、そこで 0.5m のような値を拾う経路が新たに
生まれる。地形が海面をわずかに超えたら、`coastGeomAt` が海と判定して `SEA_BED_DROP` で
沈めるはずだが、判定が届いていない沖合で陸化する可能性がある。**ここが今回の最大の新規リスク。**

### (d) 伊勢原 — 省略しない(回帰確認)

DEM5系の整備が薄い可能性がある山側で確認する。

- 山の形が今までと変わっていないこと(dem5aは5mメッシュなので、むしろ細かくなるのは正常)
- ログに `[gsiDem] dem_png: 確定=NNN` が出て地形が埋まること(= 最後の保険が機能している)
- 初回ロードが極端に遅くなっていないこと(dem5a/5bの空振り2回 → `_gsiPreferWide` で解消されるはず)

### 不合格の見分け

| 症状 | 対処 |
|---|---|
| まだ水没する | `[gsiDem]` の1行目がdem5a_pngになっているか確認。dem_pngのままなら(3-1)未適用 |
| 沖合の海が陸になった | (c)のリスクが顕在化。`GSI_DEM_SETS` から `dem_png` を一時的に外して切り分ける |
| 伊勢原の山が消えた/平らになった | dem_pngが最後に到達していない。(3-2)の無効値→retryが効きすぎている可能性 |
| 初回ロードが遅い | `_gsiPreferWide` の学習が効いていない((3-4)の条件を確認) |
| 汀線から200m程度が沈む | 想定内。v1指示書の**修正B**(oceanFloor 10→1.0)へ進む |

---

## 6. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "terrain: query the high-accuracy DEM5 tiles before DEM10B, since DEM10B returns a value for reclaimed land that is flattened to near sea level rather than a missing-data marker"; git push
```
