# 修正指示 2026-08-12 — 海面が塗られない真因(候補集合がバッチ応答に閉じている)

対象ファイル: `js/legacy/part4.js` のみ
1変更 = 1コミット。**この指示以外のことは一切やらないこと。**

---

## 1. 実測で確定した事実(2026-08-12 NY・PC Chrome)

```
seen=36 / 海面ありタイル=24 / 陸化候補=12 / sea予算残=3877
built=29  empty=0  budgetFail=0
陸化候補 12件すべて: phase12Log = (ログ無し=nearWays0で早期return)
```

- **予算切れではない**(残3877、budgetFail=0)
- **クリップ退化でもない**(empty=0)
- **12件全部が Phase1/Phase2 に到達すらしていない**

生ログにも決定的な1行がある:

```
[coastline] batch: openWays=0 islands=1 tiles=1
```

このタイルは `seenCoastlineTiles` に印だけ付いて、**何も塗られないまま永久に確定**した。

陸化候補の座標(いずれもハドソン川・イーストリバーの水上。Googleマップで確認済み):

| tile | 座標 | 距離 |
|---|---|---|
| -1,0 | 40.69831, -74.03083 | 113m |
| -2,-2 | 40.72714, -74.04985 | 3394m |
| 1,-2 | 40.72714, -73.99281 | 3394m |
| (以下9件も同様) | | |

---

## 2. 真因

`processCoastlineFill(elements, tileList)` は、**そのバッチのOverpass応答に含まれる
coastline way だけ**を候補集合(`openWays`)にしている。

```js
const nearWays = openWays.filter(w => w.minX <= x1 + m && ...);  // m = 3000
if (nearWays.length === 0) continue;
```

Overpass の `way(bbox)[natural=coastline]` は **bbox と交差する way しか返さない**。
タイルが川・湾の内側に完全に収まっていれば、そのタイルのbboxを海岸線は1本も横切らないので
応答は空になる。

つまり:

> **Phase2 は「タイル中心から3000m以内の最寄り海岸線を探して海側か判定する」設計なのに、
> 探す対象の集合が、その海岸線を構造的に含み得ない。**

Phase2 は「渚から離れた開けた水面」を救うために作られたのに、
まさにその条件(=タイル内に海岸線が無い)のときだけ候補が空になる。
偶然、同じバッチの別タイルが海岸線を持っていた場合にだけ動いていた。

さらに悪いことに、`seenCoastlineTiles.add(key)` は**判定より前**に打たれる:

```js
seenCoastlineTiles.add(key);          // ← 先に印
if (openWays.length === 0) continue;  // ← データが無かっただけなのに永久確定
...
if (nearWays.length === 0) continue;  // ← 同上
```

後から隣のタイルの応答で海岸線が届いても、二度と回収されない。
これは大原則「**保留を作るなら回収経路と滞留計器を同じコミットで入れる**」の違反。
コメントの根拠「coastlineの位置は実データなので何度到着しても結果は変わらない」は、
結果が**バッチ応答の中身**に依存する以上、成立していない。

---

## 3. 修正内容(この3点で1コミット。分割しないこと)

### (1) 海岸線 way をセッション全体で保持する

`processCoastlineFill` の外に、届いた coastline way を貯めるストアを作る。

```js
// 【2026-08-12】候補集合をバッチ応答に閉じていたのが「開けた水面が地面のまま残る」真因。
// Overpassはbboxと交差するwayしか返さないため、川・湾の内側に完全に収まるタイルの応答には
// 海岸線が1本も入らず、Phase2(最寄り区間の海側判定)が構造的に機能しなかった。
// 届いたwayはセッション中ずっと保持し、どのタイルの判定からも参照できるようにする。
const coastlineWayStore = new Map();   // el.id -> {pts,minX,maxX,minZ,maxZ}
const coastlineIslandStore = new Map(); // el.id -> 同上(閉じたリング=島)
```

`processCoastlineFill` の way 収集ループで、`openWays.push(...)` / `islands.push(...)` の代わりに
`coastlineWayStore.set(el.id, ...)` / `coastlineIslandStore.set(el.id, ...)` へ入れる
(`el.id` が無い場合だけ従来通りローカル配列に積む)。

タイル判定では**ストア全体**を候補にする:

```js
const allOpenWays = Array.from(coastlineWayStore.values());
const allIslands  = Array.from(coastlineIslandStore.values());
```

`nearWays` / `nearIslands` のフィルタは今のまま(`allOpenWays` を入力にするだけ)。

> **注意**: ストアは `recenterOrigin()`(原点付け替え)で座標系が変わると全部無効になる。
> `recenterOrigin` の中で両ストアを `clear()` すること。忘れると別都市の海岸線が混ざる。

### (2) 「見た」印を、実際に判定できたときだけ打つ

`seenCoastlineTiles.add(key)` を、早期returnより**後ろ**へ移す。

```js
if (seenCoastlineTiles.has(key)) continue;
const x0 = ..., x1 = ..., z0 = ..., z1 = ...;
const nearWays = allOpenWays.filter(...);
if (nearWays.length === 0) {
  pendingCoastlineTiles.set(key, { tx: t.tx, tz: t.tz });  // 保留(=回収対象)
  continue;
}
seenCoastlineTiles.add(key);   // ここで初めて確定
pendingCoastlineTiles.delete(key);
... Phase1 / Phase2 ...
```

### (3) 保留タイルの回収経路と滞留計器

```js
const pendingCoastlineTiles = new Map(); // key -> {tx,tz}
let _coastlineRetryFrame = 0;
function scanPendingCoastlineTiles() {
  _coastlineRetryFrame++;
  if (_coastlineRetryFrame % 90 !== 0) return;   // scanPendingAreaWaterPolysと同じ周期
  if (pendingCoastlineTiles.size === 0) return;
  const seaY = seaLevelY();
  for (const [key, t] of Array.from(pendingCoastlineTiles)) {
    _fillCoastlineTile(t.tx, t.tz, seaY);        // 下記(4)で切り出す関数
  }
  console.log('[coastline] pending=' + pendingCoastlineTiles.size +
    ' store=' + coastlineWayStore.size + ' seen=' + seenCoastlineTiles.size);
}
```

`js/legacy/part9.js` の 1129行目付近、`scanPendingAreaWaterPolys();` の**直後**に
`scanPendingCoastlineTiles();` を1行追加する。

### (4) タイル1枚ぶんの処理を関数へ切り出す

`processCoastlineFill` の `for (const t of tileList) { ... }` の中身を、そのまま
`function _fillCoastlineTile(tx, tz, seaY)` へ移す。**中のロジック(Phase1のribbon、
Phase2の5点投票、budget判定、ログ)は1文字も変えないこと。** 候補の取得元を
`allOpenWays` → ストア参照に変えるだけ。

`processCoastlineFill` はストアへの追加と `_fillCoastlineTile` の呼び出しだけになる。

---

## 4. やってはいけないこと

- **Phase1/Phase2 の判定ロジックそのものを触らない。** 今回の実測は「判定に到達していない」
  ことを示しただけで、判定が正しいかどうかは**まだ測っていない**。同時に触ると切り分け不能になる。
- `COASTLINE_SEA_FAR`(3000)を変えない。
- 予算(`areaPolyBudget.sea`)を変えない。実測で余っている(3877/4000)。
- coastline由来のポリゴンを地形マスクに使わない(構築物であって実測輪郭ではない。失敗確定済み)。
- 水面の高さ(`waterProfile` / `seaYOffset`)には**一切触らない**。別問題として別コミットで扱う。

---

## 5. 検証手順(実装者ではなくユーザーが実施)

1. デプロイ後、PC Chrome で本番URLを開き、DevTools を先に開く。
2. `DEBUG_PROBE_20260812_WATER_PERF.js` を貼る。
3. NY(ハドソン川の上)へジャンプ、60秒待つ。
4. `__cdReport()`。

**合格条件**

- `陸化候補` が 12 → **0〜1件**になる(残るなら、そのgmapsリンクが実際に陸であること)
- `budgetFail=0` のまま(予算切れに化けていないこと)
- `[coastline] pending=` のログが、時間とともに **0 に向かって減る**(増え続けるなら回収が回っていない)
- 見た目: ハドソン川・イーストリバーの川面が、岸から離れた沖でも水面になっている

**不合格の見分け**

- 陸が水面になる → Phase2 の投票が甘い。この修正のせいではなく、候補が増えたことで
  もともとの判定の甘さが露出した状態。**元に戻さず**、次コミットで Phase2 側を単独で調整する。
- `pending` が減らない → ストアに way が入っていない。`store=` の数を見る。

---

## 6. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "coastline: keep coastline ways in a session-wide store and retry tiles that had no candidate, fixing open-water tiles permanently rendered as land"; git push
```
