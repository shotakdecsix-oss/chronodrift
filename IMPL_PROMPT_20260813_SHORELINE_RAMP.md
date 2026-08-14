# 修正指示 2026-08-13 — 汀線ランプ(岸の地形を海面へ向けて寄せる)

対象ファイル: `js/legacy/part4.js`(判定)、`js/legacy/part5.js`(`farNodeY`)
1変更 = 1コミット。**この指示以外のことは一切やらないこと。**

前提: `IMPL_PROMPT_20260813_SEA_CLAMP_IN_FARNODEY.md` が実装・デプロイ済み。
「水面の陸化は大きく改善した」とユーザー確認済み。本書はその**続き**であり、置き換えではない。

---

## 1. 直す症状

海と陸の境界が、**大きな楔状**になっている(実機スクリーンショットで確認)。

見えている汀線は「地形メッシュが海面と交わる線」。その交点の位置は陸側ノードの高さで決まる。

```
陸ノードが海面+0.5  → 交点は陸ノードから  42m
陸ノードが海面+50   → 交点は陸ノードから 192m  ← 陸が海へ食い込む
```

隣接する三角形ごとに食い込み量が変わるため、200m格子より大きな楔に見える。

**この「岸がいきなり高い」地形はデータに存在しない。** 標高サンプルは543m間隔(実測)しかなく、
護岸の急な立ち上がりは記録されていない。今見えている斜面は、海中のサンプル点と543m内陸の
サンプル点を直線でつないだ**補間の産物**である。よってこれを平らにしても実測値は失われない。

---

## 2. 方針

> **海岸線から `SHORE_RAMP` 以内の陸側の地形を、岸で海面高、内陸で元の高さへ、連続的にブレンドする。**

```
cap(d) = seaTop + (base - seaTop) × (d / SHORE_RAMP)
  d      : その点から海岸線までの距離(m)
  base   : 元の地形高さ
  seaTop : seaLevelY() + seaYOffset()(実際に描かれている海面の高さ)
```

- `d = 0`(海岸線上)→ `cap = seaTop`。**汀線がOSMの海岸線に一致する**
- `d = SHORE_RAMP` → `cap = base`。**段差ができない**(ここが重要。切り捨てにすると内陸に壁ができる)
- `base <= seaTop` の場所では何もしない

---

## 3. 実装

### (3-1) `part4.js` — `seaBedYAt` を2つに割る

現在の `seaBedYAt(x, z)` は「距離と海側判定」(重い)と「返す高さ」(軽い)を1つにしている。
`farNodeY` のキャッシュは重い方だけを保持したいので分離する。
**軽い方は毎回計算する**(`base` は地形データの到着で変わるため、キャッシュしてはいけない)。

```js
// 【2026-08-13】海岸線からの距離と海/陸を返す。重い(区間を全走査する)のでキャッシュ対象。
// null = 近くに海岸線が無い(判定しない)
function coastGeomAt(x, z) {
  if (!coastlineSegs || coastlineSegs.length === 0) return null;
  let inRing = false;
  for (const r of coastlineRings) if (pointInPolygon(x, z, r)) { inRing = true; break; }
  let best = Infinity, dot = 0;
  for (const s of coastlineSegs) {
    if (s.minX - x > SEA_BED_FAR || x - s.maxX > SEA_BED_FAR ||
        s.minZ - z > SEA_BED_FAR || z - s.maxZ > SEA_BED_FAR) continue;
    const dx = s.bx - s.ax, dz = s.bz - s.az, len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - s.ax) * dx + (z - s.az) * dz) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = s.ax + dx * t, cz = s.az + dz * t;
    const d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
    if (d < best) { best = d; dot = (x - cx) * (-dz) + (z - cz) * dx; }
  }
  if (best === Infinity) return null;
  return { d: Math.sqrt(best), sea: (dot >= 0) && !inRing }; // 島の内側は必ず陸
}

// 【2026-08-13】上の判定と元の高さから、そのノードに使う高さを返す。軽い。毎回呼ぶこと。
// 海側 : 海面下に沈める
// 陸側 : 岸から SHORE_RAMP まで、海面高→元の高さへ連続的にブレンドする(汀線ランプ)
//        岸がいきなり高いと、地形と海面の交点が最大200m沖へずれて大きな楔になるため。
//        ここで潰れる斜面は543m間隔のサンプルを直線補間した産物であり、実測値ではない。
const SHORE_RAMP = 400;   // 汀線ランプの長さ(m)。唯一の調整つまみ
function seaClampY(base, g) {
  if (!g) return base;
  const seaTop = seaLevelY() + seaYOffset();
  if (g.sea) {
    if (g.d < SEA_BED_INSET) return base;      // 岸ぎりぎりの海側は触らない
    const y = seaLevelY() - SEA_BED_DROP;
    return y < base ? y : base;
  }
  if (g.d >= SHORE_RAMP || base <= seaTop) return base;
  const cap = seaTop + (base - seaTop) * (g.d / SHORE_RAMP);
  return cap < base ? cap : base;
}
```

`seaBedYAt` は**削除**する(この2つに置き換わる)。`SEA_BED_INSET`(60)と
`SEA_BED_DROP`(0.6)と `SEA_BED_FAR`(3000)はそのまま使う。

### (3-2) `part5.js` — `farNodeY` のキャッシュ対象を変える

```js
// キャッシュするのは coastGeomAt の結果(重い)だけ。高さの計算(seaClampY)は
// 元の地形高さ base に依存するため毎回行う。base は地形データの到着で変わる。
const _seaNodeCache = new Map();   // key "i|j" -> { v: coastlineVersion, g: {d,sea}|null }

function farNodeY(i, j) {
  if (typeof terrainY !== 'function') return 0;
  const base = terrainY(i * FAR_STEP, j * FAR_STEP) || 0;
  if (typeof coastGeomAt !== 'function' || typeof coastlineVersion === 'undefined') return base;
  const k = i + '|' + j;
  let e = _seaNodeCache.get(k);
  if (!e || e.v !== coastlineVersion) {
    e = { v: coastlineVersion, g: coastGeomAt(i * FAR_STEP, j * FAR_STEP) };
    if (_seaNodeCache.size > 40000) _seaNodeCache.clear();
    _seaNodeCache.set(k, e);
  }
  return seaClampY(base, e.g);
}
```

`farNodeYOrNull` は**変更しない**(生のDEM値を返す診断用)。

---

## 4. 触ってはいけないもの

- `seaLevelY()` / `seaYOffset()` / `LAND_FLOOR_MARGIN_M`
- `isSeaPoint` / `rebuildCoastlineChains` / `_fillCoastlineTile` / `COAST_CELL_M`
- 川・池の地形ドレープ、`waterSurfaceYAt`、橋
- `farSurfaceY` / `updateFarMesh` / `FAR_Y` / `FAR_STEP`
- 標高の取得解像度(`NEAR_SEGS` / `WIDE_SEGS`)— 海外は opentopodata の1日1000コール上限に当たる
- **`SHORE_RAMP` を「距離を超えたら何もしない」の切り捨てにしないこと。**
  `d = SHORE_RAMP` で `cap = base` になる連続なブレンドであることが要点。
  切り捨てると内陸に高さの壁ができる

---

## 5. 検証手順(ユーザーが実施)

デプロイ後 **Ctrl+Shift+R**。

### (a) NY

- **汀線が大きな楔状でなくなり、地図の海岸線の形に沿っているか**(これが今回の主目的)
- マンハッタン・ジャージーシティが水没していないか
- 岸から400mの帯がなだらかになっているのは**仕様**。段差の壁ができていないこと

### (b) 数値

```js
(()=>{const px=player.position.x,pz=player.position.z;const st=seaLevelY()+seaYOffset();const r=[];for(const d of[0,200,600,1200]){const g=getGroundY(px+d,pz);const s=(typeof isSeaPoint==='function')?isSeaPoint(px+d,pz,coastlineSegs):'?';r.push(d+'m: ground='+g.toFixed(2)+' 海判定='+s);}return r.join(' | ')+' || seaY='+st.toFixed(2)})()
```

`海判定=true` の全地点で `ground < seaY` であること(前回と同じ)。

### (c) 負荷

`[seabed] mesh rebuilt (XXms)` が100msを超えないこと。前回は32〜56msだった。

### (d) 日本 — 省略しない

**伊勢原**と**東京**で、陸が水没していないこと。海岸沿いの市街地がなだらかになるのは想定内。

### 不合格の見分け

| 症状 | 対処 |
|---|---|
| まだ楔状に食い込む | `SHORE_RAMP` を 400 → 800 へ |
| 岸の帯が広く平らすぎる | `SHORE_RAMP` を 400 → 200 へ(汀線は少し沖へずれる) |
| 内陸に高さの壁ができた | ブレンドが切り捨てになっている。§3 の式を確認 |
| 陸が水没する | `SEA_BED_INSET` を 60 → 200 へ |

**調整つまみは `SHORE_RAMP` 1つだけ。** 他を同時に動かさないこと。

---

## 6. デプロイ

```
cd C:\Users\Shoichi\Desktop\isehara-game; git add -A; git commit -m "terrain: blend shoreline terrain toward sea level within 400m so the waterline follows the OSM coastline instead of the interpolated slope"; git push
```
