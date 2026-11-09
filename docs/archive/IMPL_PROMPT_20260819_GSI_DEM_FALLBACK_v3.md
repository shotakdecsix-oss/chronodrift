# 修正指示 2026-08-19 v3 — 標高タイルの取得枚数を元の水準へ戻す(建物生成の遅延解消)

対象ファイル: `js/legacy/part5.js`
前提: v2(`IMPL_PROMPT_20260819_GSI_DEM_FALLBACK_v2.md`)が実装・デプロイ済み。
**水の境界は改善したとユーザー確認済み。v2の方針(精度順・無効値も次のDEMへ)は戻さない。**
本書は v2 が持ち込んだ**性能退行だけ**を潰す。
**この指示以外のことは一切やらないこと。**

---

## 1. 直す症状

v2デプロイ後、**建物生成が極端に遅くなった**。

実測ログ:

```
[gsiDem] dem5a_png: 確定=346 次DEMへ=95
[gsiDem] dem5b_png: 確定=0  次DEMへ=95    ← 一度も当たらないのに毎回95点分を引く
[gsiDem] dem_png:   確定=23 次DEMへ=72    ← 72点は本物の海。永久に確定しない
```

### 原因: タイル取得枚数が約17倍に膨張した

| | 種別数 | ズーム | NEARグリッドのタイル枚数 |
|---|---|---|---|
| v1以前 | 1種 | z14 | 約25枚 |
| v2現在 | 3種 | z15優先 | 約144枚 × 3 = **432枚** |

z15化で4倍、3種類で3倍。さらに `GSI_TILE_CACHE_MAX = 240` では収まらず、
**キャッシュが毎回溢れて同じ404を何度も引き直している**。

`runLimited(..., 8)` の8並列がブラウザの接続枠を占有するため、Overpass(建物データ)の
リクエストが後ろに並ぶ。[[feedback_measure_bytes_not_counts]]の教訓と同系統で、
過去に潰した「標高取得を並列発行しすぎてOSM取得まで巻き添えになった」不具合の再発
(part5.js:160-163のコメント参照)。

---

## 2. 方針

> **同じ404を二度取りに行かない。当たらない種別は引かない。**

並列数(8)は**下げない**。下げると標高取得自体が遅くなり、地形待ちで建物生成が
ゲートされる別の不具合([[project_isehara_game_gatewait_queue_validated]])を招く。
枚数そのものを減らすことで解決する。

---

## 3. 実装

### (3-1) 修正A — `dem5b_png` を削除する

```js
// 【2026-08-19 v3】dem5b_pngは実測で「確定=0」を連発し、一度も寄与しなかった。
// dem5aが無い地域はdem_png(全国)が拾うため、中間の5Bは要らない。
// 3種→2種でリクエストが1/3減る。
const GSI_DEM_SETS = [
  { name: 'dem5a_png', z: 15 },  // 航空レーザ5mメッシュ。都市部・平野部。最優先
  { name: 'dem_png',   z: 14 },  // DEM10B。全国だが低平地の精度が壊滅的。最後の保険
];
```

`_gsiSetsOrdered()` が `GSI_DEM_SETS[2]` を参照していたら**添字を直すこと**
(2種になったので `[GSI_DEM_SETS[1], GSI_DEM_SETS[0]]` になる)。

### (3-2) 修正B — 404だったタイルを永続的に記憶する【最重要】

`_gsiMissing` は「そのタイルは存在しない」という事実だけを持つ Set なので、
Float32Array(1枚262KB)を抱える `_gsiTiles` と違ってメモリをほぼ食わない。
**`GSI_TILE_CACHE_MAX` の追い出し対象にしない**のが要点。

```js
// 【2026-08-19 v3】404だったタイルを永続記憶する。_gsiTilesはFloat32Array(1枚262KB)を
// 抱えるためGSI_TILE_CACHE_MAXで追い出されるが、「存在しない」という事実は軽いので
// 追い出さない。東京湾のように全DEMで欠測する海域は初回に1度404を引くだけで済み、
// v2で膨れた再取得(毎フレーム同じ404を引き直す)が消える。
const _gsiMissing = new Set(); // "set/tx,ty"

function _gsiLoadTile(set, tx, ty) {
  const key = set.name + '/' + tx + ',' + ty;
  if (_gsiMissing.has(key)) return Promise.resolve(null); // 二度と取りに行かない
  let p = _gsiTiles.get(key);
  if (p) return p;
  p = (async () => {
    const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/${set.name}/${set.z}/${tx}/${ty}.png`);
    if (res.status === 404) { _gsiMissing.add(key); return null; }
    if (!res.ok) throw new Error('GSI HTTP ' + res.status);
    // ↓ここから下は既存のまま(§3-3の1行追加を除く)
    ...
  })();
  // 以降(p.catch / _gsiTiles.set / 追い出し)はすべて既存のまま
  ...
}
```

**注意**: `_gsiMissing` は `recenterOrigin` でクリアしないこと。タイル座標は緯度経度由来の
絶対値なので、地域を移動しても意味が変わらない。クリアすると効果が消える。

### (3-3) 修正C — 全ピクセルが無効値のタイルも同じ扱いにする

既存のデコードループにカウンタを1つ足すだけ。ループは既に65536回まわっているのでコスト増はゼロ。

```js
    const out = new Float32Array(65536);
    let valid = 0;                                   // 【2026-08-19 v3】
    for (let i = 0; i < 65536; i++) {
      const x = d[i * 4] * 65536 + d[i * 4 + 1] * 256 + d[i * 4 + 2];
      out[i] = (x === 8388608) ? NaN : (x < 8388608 ? x : x - 16777216) * 0.01;
      if (x !== 8388608) valid++;                    // 【2026-08-19 v3】
    }
    // 【2026-08-19 v3】タイルは200で返るが中身が全部無効値、という状態が実在する
    // (実測: 豊洲沖)。次回以降このタイルを取りに行かないよう404と同じ扱いにする。
    if (valid === 0) { _gsiMissing.add(key); return null; }
    return out;
```

### (3-4) 診断ログに再取得の実数を出す

効果を実測できるよう、`_gsiFetchPass` の既存ログに1項目足す。

```js
console.log('[gsiDem] ' + set.name + ': 確定=' + (idxs.length - retry.length) +
            ' 次DEMへ=' + retry.length + ' 既知欠測=' + _gsiMissing.size);
```

---

## 4. 触ってはいけないもの

- **`runLimited` の並列数8を下げないこと**(標高取得が遅くなり地形待ちで建物生成が止まる)
- v2の方針そのもの(精度順 dem5a→dem_png、無効値も次のDEMへ)。**水の境界は改善済み**
- `createImageBitmap` / `bmp.close()` / 2^23の無効値判定式
- `Number.isFinite(h) ? h : null` と `retry.push` の判定(v2のまま)
- 末尾の【2026-07-21・国外の誤判定対策】(`hasRealData` / `hasError`)
- `fetchElevationsGSI` の戻り値の形(数値 / null / 'gsiError')
- part6.js は**一切触らない**
- `GSI_TILE_CACHE_MAX`(240のまま。増やすとheapMBが跳ねる。実測で既に900MB台まで来ている)

---

## 5. 検証手順(ユーザーが実施)

デプロイ後 **Ctrl+Shift+R**。

### (a) 建物生成の速度 — 主目的

- **建物がv2以前と同じ速さで出ること**(これが今回の合否)
- `[mem]` の `pendB`(建物の保留数)が積み上がったまま減らない状態にならないこと

### (b) ログ

```
[gsiDem] dem5a_png: 確定=NNN 次DEMへ=NN 既知欠測=NN
[gsiDem] dem_png:   確定=NN  次DEMへ=NN 既知欠測=NNN
```

- **`dem5b_png` の行が消えていること**
- `既知欠測` が増えていき、**2回目以降のバッチで `次DEMへ` の数に対して404リクエストが出なくなること**
  (Networkタブで `dem_png`/`dem5a_png` の404が初回だけになる)

### (c) 水没していないこと(回帰確認)

晴海三丁目で地面が水没していないこと。**ここが崩れたらv3の修正Aが効きすぎている**
(dem5b が実は効いていた地域がある)ので報告すること。

### (d) 伊勢原(回帰確認)

山の形が変わっていないこと。初回ロードが遅くなっていないこと。

### 不合格の見分け

| 症状 | 対処 |
|---|---|
| まだ建物が遅い | Networkタブで404の実数を見る。減っていなければ(3-2)が効いていない |
| `既知欠測` が0のまま | `_gsiMissing.add` が404パスに入っていない |
| heapMBが跳ねた | `_gsiMissing` にFloat32Arrayを入れてしまっている(Setにはキー文字列だけ) |
| 晴海がまた水没 | 修正Aを戻し、dem5bを復活させる(A以外はそのまま残す) |

---

## 6. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "terrain: remember missing DEM tiles permanently and drop the DEM5B pass, so elevation fetches stop crowding out the Overpass requests that feed building generation"; git push
```
