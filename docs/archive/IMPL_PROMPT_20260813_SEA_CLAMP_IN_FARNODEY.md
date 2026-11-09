# 修正指示 2026-08-13 — 海の高さを `farNodeY` で上書きする(v3)

対象ファイル: `js/legacy/part5.js`(地形ノード)、`js/legacy/part4.js`(判定とバージョン)、
`js/legacy/part6.js` と `js/legacy/part9.js`(**前版の削除**)
1変更 = 1コミット。**この指示以外のことは一切やらないこと。**

**`IMPL_PROMPT_20260813_TERRAIN_YIELDS_TO_SEA_V2.md` は破棄し、実装済みの部分も削除する。**

---

## 1. 前版がなぜ足りなかったか(実測)

```
NEAR: 10859m / 20分割 = 543m間隔
WIDE: 23528m / 28分割 = 840m間隔
FAR_STEP(描画メッシュ) = 200m
```

**標高データは543m間隔。** 「200m格子」は描画メッシュの刻みであって、元データはその2.7倍粗い。

前版は `nearElev` / `wideElev` の**ノード**を下げた。しかしノードが543m離れているため、
下げたノードと陸のノードの間が543mかけて補間され、海の大部分がその傾斜帯に入る。

```
海判定=true の地点での実測(seaY=11.30):
  0m: terrain=10.03   300m: terrain=14.11   800m: terrain=17.01   1500m: terrain=12.09
```

**海判定は全部 true。海面ポリゴンは正しい。地形が下がっていないだけ。**
543m間隔のノードを下げる限り、調整では直らない。方式の限界。

---

## 2. 方針

> **上書きする場所を、データ格子(543m)から描画格子(200m)へ移す。**

`farNodeY(i, j)` は、**地形メッシュの構築と `getGroundY` の両方が使う唯一の関数**。
part5.js のコメントにこう書いてある。

```
// 地形メッシュの高さは farNodeY / farSurfaceY に一本化する
// 「描画されるメッシュ表面」= farSurfaceY が返す値、が厳密に成り立つ
```

ここで上書きすれば、**見た目と当たり判定が構造的に一致する**。新しい前提を持ち込まない。

- 汀線の分解能 543m → **200m**
- 追加のネットワーク呼び出し **ゼロ**
- 標高データ(`nearElev`/`wideElev`)は**書き換えない**。判定が誤っても元に戻せる

---

## 3. 実装

### (3-1) `part4.js` — バージョン番号を足す

`rebuildCoastlineChains()` の**末尾**に1行。

```js
coastlineVersion++;   // part5.js の海判定キャッシュを無効化する
```

宣言は `coastlineChains` などと同じ場所に。

```js
let coastlineVersion = 0; // 海岸線が更新されるたびに++。part5.js のキャッシュ世代
```

`SEA_BED_INSET` を **150 → 60** に下げる。200m格子では150mの余裕は広すぎ、
汀線沿いに150m幅の「下がらない帯」が残る。

```js
const SEA_BED_INSET = 60;   // 海岸線からこの距離以内のノードは下げない(m)
```

`seaBedYAt` 本体は**そのまま**(前版で実装済み)。

### (3-2) `part5.js` — `farNodeY` で上書きする

```js
// 【2026-08-13】海の下の地形を海面下へ落とす。
// 標高データは543m(NEAR)/840m(WIDE)間隔しかないため、データ格子のノードを下げても
// 補間で海の大半が持ち上がる(実測: 海判定trueの地点で地形が海面より+5.71)。
// 描画格子(FAR_STEP=200m)のノードで上書きすることで、汀線の分解能を2.7倍にする。
// farNodeY はメッシュ構築と getGroundY の共通入口なので、両者は必ず一致する。
//
// seaBedYAt は区間5000本を走査するため、ノードごとに結果をキャッシュする。
// 海岸線が更新されると coastlineVersion が上がり、次に参照されたときだけ再計算される
// (全消しにすると海岸線バッチのたびに数千点を再計算することになる)。
const _seaNodeCache = new Map();   // key "i|j" -> { v: coastlineVersion, y: number|null }

function farNodeY(i, j) {
  if (typeof terrainY !== 'function') return 0;
  const base = terrainY(i * FAR_STEP, j * FAR_STEP) || 0;
  if (typeof seaBedYAt !== 'function' || typeof coastlineVersion === 'undefined') return base;
  const k = i + '|' + j;
  let e = _seaNodeCache.get(k);
  if (!e || e.v !== coastlineVersion) {
    e = { v: coastlineVersion, y: seaBedYAt(i * FAR_STEP, j * FAR_STEP) };
    if (_seaNodeCache.size > 40000) _seaNodeCache.clear(); // 移動し続けても際限なく増やさない
    _seaNodeCache.set(k, e);
  }
  return (e.y !== null && e.y < base) ? e.y : base;
}
```

**`farNodeYOrNull` は変更しない。** あれは生のDEM値を返す診断用。

### (3-3) `part4.js` — 海岸線が更新されたらメッシュを作り直す

キャッシュは遅延評価なので、放っておくと画面は古いまま。低頻度で1回だけ作り直す。
**前版の `scanSeaBed` をこれで置き換える**(関数名を流用してよい)。

```js
let _seaMeshDirty = true;      // rebuildCoastlineChains の末尾で true にする
let _seaMeshScanFrame = 0;
function scanSeaBed() {
  _seaMeshScanFrame++;
  if (_seaMeshScanFrame % 180 !== 0) return;   // 3秒に1回程度
  if (!_seaMeshDirty) return;
  _seaMeshDirty = false;
  const t0 = performance.now();
  updateFarMesh(true);
  console.log('[seabed] mesh rebuilt (' + (performance.now() - t0).toFixed(0) + 'ms) segs=' +
    (coastlineSegs ? coastlineSegs.length : 0));
}
```

`part9.js` の呼び出し行(`scanSeaBed();`)は**そのまま残す**。

### (3-4) 前版の削除(**必ず消すこと**)

| 削除対象 | 場所 |
|---|---|
| `arr` を埋めた後に `seaBedYAt` で下げるループ(`[seabed] WIDE lowered=.../...`) | part6.js `loadWideTerrain` |
| 同上(`[seabed] NEAR lowered=.../...`) | part6.js `loadNearTerrain` |
| `_lowerGridToSeaBed` | part4.js |
| `_seaBedDirty` / `_seaBedTurn` と、旧 `scanSeaBed` の中身 | part4.js |

**`nearElev` / `wideElev` を書き換えるコードが1行も残っていないこと**を grep で確認する。
残すと生のDEMが失われ、判定が誤ったときに戻せなくなる。

> 既にロード済みのグリッドは書き換わったままなので、**検証は必ずリロードしてから**行う。

---

## 4. 触ってはいけないもの

- `seaLevelY()` / `seaYOffset()` / `LAND_FLOOR_MARGIN_M` — 高さは動かさない
- `isSeaPoint` / `rebuildCoastlineChains` の中身 / `_fillCoastlineTile` / `COAST_CELL_M`
- 川・池の地形ドレープ、`waterSurfaceYAt`、橋
- `farSurfaceY` / `updateFarMesh` の三角形分割・オフセット `FAR_Y`
- 標高の取得解像度(`NEAR_SEGS` / `WIDE_SEGS`)— 海外は opentopodata の
  1日1000コール上限に当たるため上げない

---

## 5. 検証手順(ユーザーが実施)

デプロイ後、**必ず Ctrl+Shift+R**(前版の書き換え済みグリッドを捨てるため)。

### (a) NY

- **ニューヨーク湾・ハドソン川が水面に見えるか**
- **マンハッタン・ジャージーシティが水没していないか**
- 海岸線が階段状に見えないか(200m刻み。海面ポリゴンの下に隠れるはず)

### (b) 数値 — **`terrainYOrNull` ではなく `getGroundY` で見ること**

`terrainYOrNull` は生のDEMを返すので、この変更後は上書き前の値になる。

```js
(()=>{const px=player.position.x,pz=player.position.z;const st=seaLevelY()+seaYOffset();const r=[];for(const d of[0,300,800,1500]){const g=getGroundY(px+d,pz);const s=(typeof isSeaPoint==='function')?isSeaPoint(px+d,pz,coastlineSegs):'?';r.push(d+'m: ground='+g.toFixed(2)+' 海判定='+s);}return r.join(' | ')+' || seaY='+st.toFixed(2)})()
```

**合格条件: `海判定=true` の全地点で `ground < seaY`。**

### (c) 負荷

`[seabed] mesh rebuilt (XXms)` のログを見る。

- **100ms未満** → 問題なし
- **100msを超える** → 報告すること。区間の空間インデックス(1000m格子で区間をバケット化)が必要。
  **判定ロジックは触らずに済む**

### (d) 日本 — 退行チェック(省略しない)

**伊勢原**と**東京**で、陸が水没していないこと。

### 不合格の見分け

| 症状 | 対処 |
|---|---|
| 陸が水没する | `SEA_BED_INSET` を 60 → 200 へ。**それ以外は触らない** |
| 海がまだ陸のまま | `getGroundY` で測り直す。`terrainYOrNull` は上書き前の値 |
| 汀線が階段状に目立つ | 200m格子の限界。**高さでは直せない**。報告のみ |
| 動作が重い | (c) の ms を報告 |

---

## 6. 既知の限界(直さないこと)

- 汀線の分解能は 200m。これ以上は標高データの取得解像度を上げるしかないが、
  海外は opentopodata の 1日1000コール上限に当たるため現状では選べない
- DEMの生値(`terrainYOrNull` / `farNodeYOrNull`)は上書きされない。診断はこの差を意識する

---

## 7. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "terrain: clamp sea nodes at the 200m render grid in farNodeY instead of mutating the 543m elevation grid"; git push
```
